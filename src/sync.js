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
import { StriartError } from './errors.js';
import { loadConfig } from './config.js';
import { assertInitialized, readRegistry, updateAgentMeta } from './clone.js';
import { emitStriartEvent } from './events.js';
import { withMainLock } from './lock.js';
import { syncMemoryToClone } from './memory.js';
import { isProcessAlive } from './process-tree.js';

/**
 * Rebase le clone d'un agent sur la branche cible du repo principal.
 * Un rebase en conflit est annulé (REBASE_CONFLICT) : le merge classique
 * + fusion sémantique prendra le relais.
 */
/** @param {{root: string, agent: string, config?: import('./types.js').StriartConfig|null}} params @returns {Promise<import('./types.js').SyncResult>} */
export async function syncAgentWithMain(params) {
  return withMainLock(params.root, `sync:${params.agent}`, () => syncAgentWithMainImpl(params));
}

/** @returns {Promise<import('./types.js').SyncResult>} */
async function syncAgentWithMainImpl({ root, agent, config = null }) {
  await assertInitialized(root);
  const cfg = config ?? (await loadConfig(root));
  const registry = await readRegistry(root);
  const meta = registry[agent];
  if (!meta) {
    throw new StriartError(`Agent inconnu : "${agent}".`, {
      code: 'AGENT_UNKNOWN',
      details: { agent },
    });
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

  const agentGit = simpleGit(meta.path);
  await agentGit.fetch(root, cfg.targetBranch);
  const mainHead = (await agentGit.revparse(['FETCH_HEAD'])).trim();
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

  if (stashed) {
    try {
      await agentGit.stash(['pop']);
    } catch (error) {
      // Théoriquement impossible (disjonction vérifiée) — le travail reste
      // en sécurité dans le stash, résolution humaine dans le clone.
      return { status: 'STASH_CONFLICT', agent, mainHead, error: error.message };
    }
  }

  // Memory Layer : le clone fraîchement rebasé reçoit la mémoire à jour.
  await syncMemoryToClone(root, meta.path);

  // Le rebase réécrit les SHAs : la base de comptage des commits
  // en attente devient la tête de main (les commits déjà mergés
  // ont été dédupliqués par le rebase).
  const patch = { baseCommit: mainHead };
  if (meta.lastMergedCommit) patch.lastMergedCommit = mainHead;
  await updateAgentMeta(root, agent, patch);

  return { status: 'REBASED', agent, mainHead, rebasedCommits: behind, stashed };
}

/** Rebase tous les agents actifs (appelé après chaque merge réussi en mode watch). */
/** @param {{root: string, config?: import('./types.js').StriartConfig|null, except?: string[]}} params @returns {Promise<import('./types.js').SyncResult[]>} */
export async function syncAllAgents(params) {
  return withMainLock(params.root, 'sync-all', () => syncAllAgentsImpl(params));
}

async function syncAllAgentsImpl({ root, config = null, except = [] }) {
  await assertInitialized(root);
  const cfg = config ?? (await loadConfig(root));
  const registry = await readRegistry(root);
  const results = [];
  for (const agent of Object.keys(registry)) {
    if (except.includes(agent)) continue;

    // Le garde « session autonome vivante » (SKIPPED_SESSION) est dans
    // syncAgentWithMainImpl : la primitive protège tous ses appelants.
    const result = await syncAgentWithMain({ root, agent, config: cfg });
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
 * sans toucher aux working trees (seul FETCH_HEAD est mis à jour).
 * Utilisé par le watcher pour la visibilité proactive ; le rebase
 * effectif reste déclenché au merge.
 */
/** @param {{root: string, config?: import('./types.js').StriartConfig|null}} params @returns {Promise<Array<{agent: string, behind: number|null, error?: string}>>} */
export async function checkAgentsBehind({ root, config = null }) {
  await assertInitialized(root);
  const cfg = config ?? (await loadConfig(root));
  const registry = await readRegistry(root);
  const results = [];
  for (const [agent, meta] of Object.entries(registry)) {
    try {
      const agentGit = simpleGit(meta.path);
      await agentGit.fetch(root, cfg.targetBranch);
      const behind = Number.parseInt(
        (await agentGit.raw(['rev-list', '--count', 'HEAD..FETCH_HEAD'])).trim(),
        10,
      );
      results.push({ agent, behind });
    } catch (error) {
      results.push({ agent, behind: null, error: error.message });
    }
  }
  return results;
}
