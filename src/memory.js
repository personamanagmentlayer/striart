/**
 * Memory Layer — mémoire sémantique partagée entre agents.
 *
 * Après chaque merge réussi, un LLM résume ce que le commit change dans les
 * API du projet (fonctions exportées, signatures, contrats). Le résumé est
 * ajouté à `.striart/memory.md` (repo principal, gitignoré) puis recopié
 * dans chaque clone agent sous `.striart-memory.md` — un fichier UNTRACKED
 * que l'outil de coding lit naturellement dans son contexte de travail.
 *
 * C'est la seule réponse au conflit sémantique *en amont* du Test Gate :
 * l'agent B qui travaille sur le signup voit que l'agent A vient de créer
 * `hashPassword()`, même sans conflit Git. Purement advisory : un échec du
 * LLM n'interrompt jamais un merge (signalé, pas bloquant).
 */
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { llmGenerate } from './llm.js';
import { striartDir } from './paths.js';
import { logger } from './logger.js';

/** Nom du fichier recopié à la racine de chaque clone agent. */
export const CLONE_MEMORY_FILE = '.striart-memory.md';

/** Diff maximal envoyé au LLM (au-delà : tronqué, le résumé reste utile). */
const MEMORY_DIFF_MAX_CHARS = 8000;

const HEADER = `# Mémoire partagée Striart

> Généré automatiquement après chaque merge. Les agents lisent ce fichier
> pour connaître les API ajoutées/modifiées par les autres agents.
> Ne pas éditer ni commiter.
`;

function memoryPath(root) {
  return path.join(striartDir(root), 'memory.md');
}

function memoryPrompt(diff) {
  return `Tu documentes les changements d'API d'un commit pour d'autres développeurs.
À partir du diff ci-dessous, liste en 1 à 5 puces UNIQUEMENT ce qu'un autre
développeur doit savoir pour ne pas entrer en contradiction avec ce commit :
fonctions/classes exportées ajoutées, modifiées ou supprimées (avec leur
signature), contrats de données changés, fichiers déplacés.
Ignore les détails d'implémentation internes. Réponds uniquement avec les
puces Markdown ("- ..."), sans titre ni conclusion.

Diff :
${diff}`;
}

/**
 * Résume un merge et l'ajoute en tête de la mémoire (fenêtre glissante).
 * Best effort : toute erreur (LLM injoignable, réponse vide) est loggée et
 * retourne { updated: false } — la mémoire est advisory, jamais bloquante.
 * @param {{root: string, config: import('./types.js').StriartConfig, agent: string, sha: string, diff: string}} params
 * @returns {Promise<{updated: boolean, entry?: string, error?: string}>}
 */
export async function updateMemoryAfterMerge({ root, config, agent, sha, diff }) {
  try {
    const summary = await llmGenerate({
      config,
      prompt: memoryPrompt(diff.slice(0, MEMORY_DIFF_MAX_CHARS)),
      timeoutMs: 60_000,
      retries: 1,
      errorCode: 'MEMORY_FAILED',
      errorMessage: 'La génération de la mémoire partagée a échoué',
      transform: (response) => {
        const text = response.trim();
        if (text.length === 0) throw new Error('résumé vide');
        return text;
      },
    });
    const entry = `## ${new Date().toISOString()} — agent ${agent} (${sha.slice(0, 8)})\n\n${summary}\n`;
    const existing = await readFile(memoryPath(root), 'utf8').catch(() => `${HEADER}\n`);
    const [header, ...entries] = existing.split(/\n(?=## )/);
    const kept = [entry, ...entries].slice(0, config.memoryMaxEntries);
    await writeFile(memoryPath(root), `${header.trimEnd()}\n\n${kept.join('\n')}`, 'utf8');
    return { updated: true, entry };
  } catch (error) {
    logger.warn({ err: error }, 'Memory Layer : résumé du merge impossible (ignoré)');
    return { updated: false, error: error.message };
  }
}

/**
 * Recopie la mémoire dans un clone agent (`.striart-memory.md`, untracked :
 * jamais commité par l'agent, jamais mergé). Silencieux si pas de mémoire.
 * @param {string} root @param {string} clonePath
 * @returns {Promise<boolean>} true si le fichier a été (re)copié
 */
export async function syncMemoryToClone(root, clonePath) {
  const source = memoryPath(root);
  if (!(await stat(source).catch(() => null))) return false;
  if (!(await stat(clonePath).catch(() => null))) return false;
  try {
    // Ignore locale (.git/info/exclude, jamais partagée) : sans elle, le
    // fichier untracked rendrait le worktree "dirty" en permanence et
    // bloquerait le rebase auto (SKIPPED_DIRTY à chaque cycle).
    await ensureLocalExclude(clonePath);
    await copyFile(source, path.join(clonePath, CLONE_MEMORY_FILE));
    return true;
  } catch (error) {
    logger.warn({ err: error }, `Memory Layer : copie vers ${clonePath} impossible (ignorée)`);
    return false;
  }
}

/** Ajoute CLONE_MEMORY_FILE à .git/info/exclude du clone (idempotent). */
async function ensureLocalExclude(clonePath) {
  const excludePath = path.join(clonePath, '.git', 'info', 'exclude');
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  if (current.split('\n').includes(CLONE_MEMORY_FILE)) return;
  await writeFile(excludePath, `${current.trimEnd()}\n${CLONE_MEMORY_FILE}\n`, 'utf8');
}

/** Longueur max du prompt cité dans la section temps réel (une ligne). */
const LIVE_PROMPT_MAX_CHARS = 140;

function excerpt(prompt) {
  const oneLine = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= LIVE_PROMPT_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, LIVE_PROMPT_MAX_CHARS - 1)}…`;
}

/**
 * Section « qui travaille sur quoi » : les fichiers PRÉDITS par le Router
 * pour les tâches actives et en file, vus depuis un agent donné (lui-même
 * exclu — il connaît sa propre tâche). Pure fonction, aucune E/S : les
 * données existent déjà (registre + file), zéro appel LLM.
 *
 * Advisory strict, comme le reste de la mémoire : informer l'agent qu'une
 * zone est travaillée ailleurs, jamais l'en empêcher — le Test Gate tranche.
 *
 * @param {import('./types.js').AgentRegistry} registry
 * @param {import('./types.js').QueueTask[]} queue
 * @param {string} forAgent Nom de l'agent destinataire.
 * @returns {string} Section Markdown, chaîne vide si rien à signaler.
 */
export function renderLiveSection(registry, queue, forAgent) {
  const lines = [];
  for (const [name, meta] of Object.entries(registry)) {
    if (name === forAgent) continue;
    const files = (meta.predictedFiles ?? []).map((f) => `\`${f}\``).join(', ') || '(aucun prédit)';
    const mode = meta.mode === 'autonomous' ? 'autonome' : 'supervisé';
    const task = excerpt(meta.prompt);
    lines.push(`- **${name}** (en cours, ${mode})${task ? ` : « ${task} »` : ''} — ${files}`);
  }
  for (const task of queue) {
    if (task.agent === forAgent) continue;
    const files = (task.predictedFiles ?? []).map((f) => `\`${f}\``).join(', ') || '(aucun prédit)';
    const after = task.after ? `, après ${task.after}` : '';
    lines.push(
      `- **${task.agent}** (en file, ${task.id}${after}) : « ${excerpt(task.prompt)} » — ${files}`,
    );
  }
  if (lines.length === 0) return '';
  return [
    '## Travaux en cours (temps réel)',
    '',
    '> Fichiers PRÉDITS par le Router pour les autres tâches actives ou en',
    '> file — prédictions, pas des faits. Évite de modifier ces zones sans',
    '> nécessité ; en cas de chevauchement le Test Gate tranchera.',
    '',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Réécrit `.striart-memory.md` dans chaque clone : mémoire persistante des
 * merges (si elle existe) + section temps réel « qui travaille sur quoi »,
 * calculée PAR destinataire (chacun voit les autres, pas lui-même).
 *
 * Best effort et advisory : toute erreur est loggée et n'interrompt rien.
 * Les données sont passées en paramètres (pas relues ici) — l'appelant les a
 * déjà, et ce module ne doit dépendre ni du registre ni de la file.
 *
 * @param {string} root
 * @param {import('./types.js').AgentRegistry} registry
 * @param {import('./types.js').QueueTask[]} queue
 * @returns {Promise<number>} Nombre de clones mis à jour.
 */
export async function refreshCloneMemories(root, registry, queue) {
  const persistent = await readFile(memoryPath(root), 'utf8').catch(() => '');
  let updated = 0;
  for (const [name, meta] of Object.entries(registry)) {
    if (!(await stat(meta.path).catch(() => null))) continue;
    const live = renderLiveSection(registry, queue, name);
    const target = path.join(meta.path, CLONE_MEMORY_FILE);
    try {
      // Rien à dire ET pas de fichier → ne pas en créer un vide ; mais un
      // fichier existant doit être ramené au neutre (une section « travaux en
      // cours » périmée serait une désinformation, pire que rien).
      const exists = Boolean(await stat(target).catch(() => null));
      if (!live && !persistent && !exists) continue;
      const [header, ...entries] = (persistent || `${HEADER}\n`).split(/\n(?=## )/);
      const parts = [header.trimEnd(), live.trimEnd(), entries.join('\n').trimEnd()].filter(
        Boolean,
      );
      const content = `${parts.join('\n\n')}\n`;
      // Idempotent : pas d'écriture si rien ne change. Indispensable — le
      // fichier vit dans le worktree, et une écriture par tick de watch
      // fausserait la détection de présence (mtime) en plus d'user le disque.
      const current = await readFile(target, 'utf8').catch(() => null);
      if (current === content) continue;
      await ensureLocalExclude(meta.path);
      await writeFile(target, content, 'utf8');
      updated += 1;
    } catch (error) {
      logger.warn(
        { err: error },
        `Memory Layer : rafraîchissement de ${target} impossible (ignoré)`,
      );
    }
  }
  return updated;
}
