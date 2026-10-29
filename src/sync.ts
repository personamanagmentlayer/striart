/**
 * Synchronisation clones agents ↔ repo principal.
 *
 * Deux mécanismes complémentaires (aucun ne touche un worktree occupé) :
 *  - checkAgentsBehind : fetch silencieux périodique — mesure le retard des
 *    agents sur targetBranch sans JAMAIS modifier leur working tree ;
 *  - syncAgentWithMain : rebase effectif, déclenché au moment du merge
 *    (le worktree est alors normalement propre, l'agent vient de commiter).
 *
 * Stash auto GARDÉ par un check de disjonction : si le worktree agent a des
 * modifications en cours, on ne stash/rebase/pop QUE si ces fichiers sont
 * strictement disjoints des fichiers touchés par les commits entrants —
 * dans ce cas le pop est prouvablement sans conflit (le pari "le Router a
 * bien fait son travail" est vérifié, pas supposé). Au moindre
 * chevauchement, ou si autoStash est désactivé : SKIPPED_DIRTY, on ne
 * touche pas à une session active (règle d'or n°3), le merge sémantique
 * rattrapera au prochain commit.
 */
import { simpleGit } from 'simple-git';
import { StriartError, agentUnknownError } from './errors.ts';
import { loadConfig } from './config.ts';
import { assertInitialized, cloneGit, readRegistry, updateAgentMeta } from './clone.ts';
import { emitStriartEvent } from './events.ts';
import { withMainLock } from './lock.ts';
import { syncMemoryToClone } from './memory.ts';
import { syncAgentInstructionsToClone } from './agents/instructions.ts';
import { isProcessAlive } from './process-tree.ts';
import { logger } from './logger.ts';

/**
 * Tête d'une branche du repo principal, ou refus explicite si elle n'existe
 * pas. Sans ce contrôle, une `targetBranch` mal configurée remontait en
 * « Erreur inattendue : fatal: couldn't find remote ref … » depuis le fetch
 * d'un clone — sans dire quelle branche, ni où la corriger.
 * @param {import('simple-git').SimpleGit} mainGit
 * @param {string} branch
 * @param {string} [setting] clé de config qui désigne cette branche
 * @returns {Promise<string>}
 */
export async function resolveBranchHead(mainGit, branch, setting = 'targetBranch') {
  // simple-git ne lève pas sur un code de sortie 1 sans stderr (le cas de
  // `--quiet`) : c'est la forme de la sortie qui fait foi, pas l'exception.
  // Une VRAIE erreur (git absent, dépôt illisible) lève avec son stderr et
  // remonte telle quelle : la déguiser en UNKNOWN_BRANCH enverrait corriger
  // une config qui n'y est pour rien.
  const sha = (
    await mainGit.revparse(['--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  ).trim();
  if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
  throw new StriartError(
    `La branche « ${branch} » (${setting}) n'existe pas dans le repo principal.`,
    {
      code: 'UNKNOWN_BRANCH',
      details: { branch, setting },
      hint: `corrige ${setting} dans striart.config (branches existantes : git branch --list)`,
    },
  );
}

/**
 * Refs PRIVÉES où atterrissent les fetchs de Striart, une par usage —
 * jamais `FETCH_HEAD`, fichier unique par dépôt que tout fetch concurrent
 * (autre contexte, autre process, humain ou agent dans le clone) réécrit :
 * lire FETCH_HEAD après son propre fetch, c'est lire peut-être celui d'un
 * autre (audit L1). Chaque fetch écrit sa ref (`--no-write-fetch-head`), le
 * SHA en est relu, et c'est CE SHA exact qui est rebasé, mergé et enregistré.
 *
 * Hors de `refs/heads/` : le watcher (qui ne surveille que les branches des
 * clones) ne les voit pas, et aucun push de Striart (`push origin <branche>`)
 * ne les emporte.
 */
/** Dans un clone : tête de la branche cible, pour son rebase (sous verrou). */
export const CLONE_TARGET_REF = 'refs/striart/target';

/**
 * Dans un clone : tête de la branche cible pour la mesure de retard
 * (`checkAgentsBehind`, HORS verrou) — distincte de CLONE_TARGET_REF pour ne
 * jamais disputer la ref d'un rebase en cours, et suffixée du PID pour que
 * deux process qui mesurent en même temps (watch + dashboard) ne se
 * bloquent pas sur le verrou de ref de git. Supprimée après lecture.
 */
function behindProbeRef() {
  return `refs/striart/behind/${process.pid}`;
}

/** Dans le principal : tête de la branche de tâche d'un agent, pour son merge. */
export function incomingRef(agent) {
  return `refs/striart/incoming/${agent}`;
}

/**
 * Fetch `refs/heads/<branch>` de `source` vers la ref privée `ref` de `git`,
 * puis rend le SHA exact déposé. `+` : la branche de l'agent est réécrite
 * par chaque rebase, la ref privée suit sans refus de non-fast-forward.
 * @param {import('simple-git').SimpleGit} git
 * @param {string} source  Chemin du dépôt source.
 * @param {string} branch
 * @param {string} ref
 * @returns {Promise<string>}
 */
export async function fetchBranchToRef(git, source, branch, ref) {
  await git.raw([
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    source,
    `+refs/heads/${branch}:${ref}`,
  ]);
  return (await git.revparse(['--verify', `${ref}^{commit}`])).trim();
}

/**
 * Rebase le clone d'un agent sur la branche cible du repo principal.
 * Un rebase en conflit est annulé (REBASE_CONFLICT) : le merge classique
 * + fusion sémantique prendra le relais.
 */
/** @param {{root: string, agent: string, config?: import('./types.js').StriartConfig|null, signal?: AbortSignal|null}} params @returns {Promise<import('./types.js').SyncResult>} */
export async function syncAgentWithMain(params) {
  return withMainLock(params.root, `sync:${params.agent}`, () => syncAgentWithMainImpl(params), {
    signal: params.signal ?? null,
  });
}

/**
 * `verifyTarget` : vérification de la branche cible partagée par une passe
 * (syncAllAgents) — sans elle, chaque agent relançait le même
 * `rev-parse --verify` sur le repo principal. Interne : les appelants
 * publics passent par syncAgentWithMain, qui vérifie toujours.
 * @param {{root: string, agent: string, config?: import('./types.js').StriartConfig|null, verifyTarget?: (() => Promise<string>)|null}} params
 * @returns {Promise<import('./types.js').SyncResult>}
 */
async function syncAgentWithMainImpl({ root, agent, config = null, verifyTarget = null }) {
  await assertInitialized(root);
  const cfg = config ?? (await loadConfig(root));
  const registry = await readRegistry(root);
  const meta = registry[agent];
  if (!meta) {
    throw agentUnknownError(agent);
  }

  // Session autonome en cours : le clone est intouchable.
  //
  // Les garde-fous habituels du rebase (worktree sale + fichiers qui se
  // recoupent) supposent un humain aux commandes, capable de voir ses
  // fichiers bouger et de réagir. Une session autonome n'a personne pour
  // réagir, et surtout elle lance ses PROPRES commandes git : rebaser
  // dessous, c'est se disputer l'index avec elle, et lui faire lire un
  // arbre de travail qui change entre deux de ses opérations.
  //
  // Ne rien perdre au change : `mergeAgentCommit` rebase de toute façon en
  // fin de cycle (autoRebase). On ne renonce pas au rebase, on l'ajourne
  // jusqu'au moment où le clone est de nouveau au repos.
  //
  // Le garde vit ICI, dans la primitive : `striart sync <agent>`, le bouton
  // Sync du dashboard et la boucle syncAllAgents en héritent tous — un garde
  // posé seulement dans la boucle laisserait les chemins unitaires rebaser
  // sous une session vivante.
  if (isProcessAlive(meta.sessionPid)) {
    return { status: 'SKIPPED_SESSION', agent, pid: meta.sessionPid ?? null };
  }

  await (verifyTarget ? verifyTarget() : resolveBranchHead(simpleGit(root), cfg.targetBranch));
  const agentGit = cloneGit(meta.path);
  const mainHead = await fetchBranchToRef(agentGit, root, cfg.targetBranch, CLONE_TARGET_REF);
  const behind = Number.parseInt(
    (await agentGit.raw(['rev-list', '--count', `HEAD..${mainHead}`])).trim(),
    10,
  );
  if (behind === 0) return { status: 'UP_TO_DATE', agent, mainHead };

  // Worktree occupé : stash auto uniquement si la disjonction est PROUVÉE.
  const status = await agentGit.status();
  let stashed = false;
  if (!status.isClean()) {
    // Le "dirty" inclut aussi les anciens chemins des renommages locaux :
    // si main touche le fichier d'origine d'un rename en cours, c'est un overlap.
    const dirtyFiles = [
      ...status.files.map((f) => f.path),
      ...status.renamed.map((r) => r.from),
    ].map((f) => f.replaceAll('\\', '/'));
    if (!cfg.autoStash) {
      return { status: 'SKIPPED_DIRTY', agent, files: dirtyFiles };
    }
    // Fichiers touchés par les commits entrants (merge-base → tête de main).
    // --no-renames : un rename côté main apparaît comme suppression + ajout,
    // les DEUX chemins comptent comme entrants — le check reste conservateur
    // (au pire un skip inutile, jamais un faux "safe to rebase").
    const incoming = (
      await agentGit.raw(['diff', '--name-only', '--no-renames', `HEAD...${mainHead}`])
    )
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    const overlap = dirtyFiles.filter((f) => incoming.includes(f));
    if (overlap.length > 0) {
      // Le Router s'est trompé quelque part : le stash pop pourrait conflicter.
      return { status: 'SKIPPED_DIRTY', agent, files: dirtyFiles, overlap };
    }
    await agentGit.stash(['push', '-u', '-m', `striart-autostash-${agent}`]);
    stashed = true;
  }

  try {
    await agentGit.rebase([mainHead]);
  } catch (error) {
    try {
      await agentGit.rebase(['--abort']);
    } catch {
      // Pas de rebase en cours.
    }
    if (stashed) {
      try {
        await agentGit.stash(['pop']);
        stashed = false;
      } catch {
        // Stash conservé : rien n'est perdu, signalé dans le résultat.
      }
    }
    return { status: 'REBASE_CONFLICT', agent, mainHead, error: error.message, stashKept: stashed };
  }

  /** @type {string | null} */
  let stashConflict = null;
  if (stashed) {
    try {
      await agentGit.stash(['pop']);
    } catch (error) {
      // Rare (la disjonction par chemins est vérifiée, pas celle des types
      // fichier/dossier) — le travail reste en sécurité dans le stash,
      // résolution humaine dans le clone. Mais le REBASE, lui, a réussi : la
      // suite (base de comptage, mémoire, consignes) s'applique quand même, sans
      // quoi le registre mentirait sur l'état réel du clone.
      stashConflict = error.message;
    }
  }

  // Memory Layer : le clone fraîchement rebasé reçoit la mémoire à jour.
  await syncMemoryToClone(root, meta.path);
  // Consignes Striart régénérées : un AGENTS.md du commit a pu changer (le
  // composite AGENTS.override.md en dérive — D11). Advisory, ne throw pas.
  await syncAgentInstructionsToClone({
    root,
    agent,
    clonePath: meta.path,
    mode: meta.mode ?? 'attended',
    command: meta.command ?? null,
    config: cfg,
  });

  // Le rebase réécrit les SHAs : la base de comptage des commits
  // en attente devient la tête de main (les commits déjà mergés
  // ont été dédupliqués par le rebase).
  const patch: { baseCommit: string; lastMergedCommit?: string } = { baseCommit: mainHead };
  if (meta.lastMergedCommit) patch.lastMergedCommit = mainHead;
  await updateAgentMeta(root, agent, patch);

  if (stashConflict !== null) {
    return { status: 'STASH_CONFLICT', agent, mainHead, error: stashConflict };
  }
  return { status: 'REBASED', agent, mainHead, rebasedCommits: behind, stashed };
}

/** Rebase tous les agents actifs (appelé après chaque merge réussi en mode watch). */
/** @param {{root: string, config?: import('./types.js').StriartConfig|null, except?: string[], signal?: AbortSignal|null}} params @returns {Promise<import('./types.js').SyncResult[]>} */
export async function syncAllAgents(params) {
  // `signal` n'annule que l'ATTENTE du verrou, jamais un lot commencé.
  return withMainLock(params.root, 'sync-all', () => syncAllAgentsImpl(params), {
    signal: params.signal ?? null,
  });
}

async function syncAllAgentsImpl({ root, config = null, except = [] }) {
  await assertInitialized(root);
  const cfg = config ?? (await loadConfig(root));
  const registry = await readRegistry(root);
  const results = [];
  // Une seule vérification de la branche cible pour toute la passe, faite au
  // premier agent qui en a besoin (même comportement qu'avant : rien n'est
  // vérifié si aucun agent n'est à synchroniser).
  /** @type {Promise<string>|null} */
  let targetCheck = null;
  const verifyTarget = () => (targetCheck ??= resolveBranchHead(simpleGit(root), cfg.targetBranch));
  for (const agent of Object.keys(registry)) {
    if (except.includes(agent)) continue;

    // Le garde « session autonome vivante » (SKIPPED_SESSION) est dans
    // syncAgentWithMainImpl : la primitive protège tous ses appelants.
    // Verrou déjà tenu (sync-all) : appel direct de la primitive.
    const result = await syncAgentWithMainImpl({ root, agent, config: cfg, verifyTarget });
    if (result.status === 'REBASE_CONFLICT') {
      await emitStriartEvent(cfg, {
        type: 'sync:rebase-conflict',
        agent,
        message: `⚠️ [Striart] Rebase de l'agent ${agent} en conflit avec ${cfg.targetBranch} — il sera résolu au merge.`,
      });
    }
    if (result.status === 'STASH_CONFLICT') {
      await emitStriartEvent(cfg, {
        type: 'sync:stash-conflict',
        agent,
        message: `🔒 [Striart] Stash de l'agent ${agent} en conflit après rebase — travail en sécurité dans le stash, résolution manuelle requise dans le clone.`,
      });
    }
    if (result.status === 'SKIPPED_DIRTY' && result.overlap) {
      // L'agent code sur une base obsolète ET touche les mêmes fichiers que
      // les commits entrants : plus il attend, plus le conflit grossit.
      await emitStriartEvent(cfg, {
        type: 'sync:overlap',
        agent,
        files: result.overlap,
        message: `⚠️ [Striart] Agent ${agent} : ${cfg.targetBranch} a modifié ${result.overlap.join(', ')} que l'agent touche aussi (travail non commité). Clone non resynchronisé par sécurité — conflit probable à son prochain commit.`,
      });
    }
    results.push(result);
  }
  return results;
}

/**
 * Fetch silencieux : mesure le retard de chaque agent sur targetBranch
 * sans toucher aux working trees (seule une ref privée temporaire du clone
 * est écrite, puis supprimée — jamais FETCH_HEAD).
 * Utilisé par le watcher pour la visibilité proactive ; le rebase
 * effectif reste déclenché au merge.
 */
/** @param {{root: string, config?: import('./types.js').StriartConfig|null}} params @returns {Promise<Array<{agent: string, behind: number|null, error?: string}>>} */
export async function checkAgentsBehind({ root, config = null }) {
  await assertInitialized(root);
  const cfg = config ?? (await loadConfig(root));
  // Une fois pour tous les agents : une branche absente est une erreur de
  // configuration, pas un échec de fetch propre à chaque clone.
  await resolveBranchHead(simpleGit(root), cfg.targetBranch);
  const registry = await readRegistry(root);
  const results = [];
  for (const [agent, meta] of Object.entries(registry)) {
    try {
      const agentGit = cloneGit(meta.path);
      const probe = behindProbeRef();
      try {
        const mainHead = await fetchBranchToRef(agentGit, root, cfg.targetBranch, probe);
        const behind = Number.parseInt(
          (await agentGit.raw(['rev-list', '--count', `HEAD..${mainHead}`])).trim(),
          10,
        );
        results.push({ agent, behind });
      } finally {
        // Mesure ponctuelle : la ref ne doit pas retenir d'objets. Un échec
        // ici est sans conséquence (réécrite au prochain passage, `+`).
        await agentGit.raw(['update-ref', '-d', probe]).catch((error) => {
          logger.warn({ agent, err: error.message }, 'Ref de mesure du retard non supprimée');
        });
      }
    } catch (error) {
      results.push({ agent, behind: null, error: error.message });
    }
  }
  return results;
}
