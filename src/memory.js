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
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { llmGenerate } from './llm.js';
import { sha256 } from './tokens/cache.ts';
import { resolveTokensSettings } from './tokens/settings.ts';
import { striartDir } from './paths.js';
import { withStateLock } from './state-lock.ts';
import { ensureCloneExclude } from './git-exclude.ts';
import { logger } from './logger.js';
import { safeReadText, safeWriteFile } from './safe-write.ts';
import { fenceUntrusted, sanitizeAgentText } from './collab/message.ts';

/** Nom du fichier recopié à la racine de chaque clone agent. */
export const CLONE_MEMORY_FILE = '.striart-memory.md';

/** Version du gabarit de prompt de la mémoire : à incrémenter si memoryPrompt change (invalide le cache). */
const MEMORY_PROMPT_VERSION = 'memory-v2';

/** Sortie maximale d'un résumé (1 à 5 puces). */
const MEMORY_MAX_OUTPUT_TOKENS = 1024;

/** Sections de diff sans valeur pour un résumé d'API : lockfiles, ressources, tests. */
const MEMORY_SKIP_PATH_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$|\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|mp[34]|zip|gz|tgz|map|snap)$|\.min\.js$|(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;

/**
 * Réduit un diff aux lignes qui disent quelque chose d'une API : en-têtes de
 * fichier et de hunk, lignes ajoutées/supprimées — sans le contexte, les
 * lockfiles, les ressources binaires ni les tests. Au-delà de `maxChars`
 * il est coupé à une frontière de ligne ET le dit (`[… N lignes omises]`) :
 * le LLM ne croit jamais lire le diff entier. Pure.
 * @param {string} diff @param {number} maxChars
 * @returns {{text: string, truncated: boolean, omittedLines: number}}
 */
export function compactMemoryDiff(diff, maxChars) {
  // Texte qui n'est pas un diff git (appel direct, outil tiers) : transmis tel
  // quel, seulement borné — on ne devine pas ce qu'on ne sait pas lire.
  const isGitDiff = diff.includes('diff --git ') || /^@@ /m.test(diff);
  const kept = isGitDiff ? [] : diff.split('\n');
  if (!isGitDiff) return boundLines(kept, maxChars);
  let skipping = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      skipping = match ? MEMORY_SKIP_PATH_RE.test(match[2]) : false;
      if (!skipping) kept.push(line);
      continue;
    }
    if (skipping) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@')) {
      if (!line.startsWith('--- ')) kept.push(line);
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) kept.push(line);
    else if (line.startsWith('Binary files')) kept.pop();
  }
  return boundLines(kept, maxChars);
}

function boundLines(kept, maxChars) {
  let used = 0;
  let count = 0;
  for (const line of kept) {
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    count += 1;
  }
  if (count === kept.length) return { text: kept.join('\n'), truncated: false, omittedLines: 0 };
  const omittedLines = kept.length - count;
  return {
    text: `${kept.slice(0, count).join('\n')}\n[… ${omittedLines} lignes omises : texte plus long que ${maxChars} caractères]`,
    truncated: true,
    omittedLines,
  };
}

/** Clé d'une puce : le premier identifiant entre accents graves (sans arguments), sinon le texte normalisé. */
function bulletKey(bullet) {
  const code = /`([^`]+)`/.exec(bullet);
  if (code) return code[1].replace(/\(.*$/s, '').trim().toLowerCase();
  return bullet.toLowerCase().replace(/\s+/g, ' ').trim();
}

const bulletsOf = (text) => text.split('\n').filter((l) => /^\s*[-*]\s+/.test(l));

/**
 * Intègre une nouvelle entrée à la mémoire : les puces des entrées plus
 * anciennes qui parlent du MÊME symbole (ou qui sont identiques) sont
 * RETIRÉES — remplacées, pas empilées —, les entrées vidées disparaissent, la
 * mémoire est ensuite bornée en nombre d'entrées et en taille. Pure.
 * @param {string[]} entries entrées existantes (plus récente d'abord), titre `## …` inclus
 * @param {string} entry nouvelle entrée
 * @param {{maxEntries: number, maxTotalChars: number, dedupe: boolean}} limits
 * @returns {string[]}
 */
export function integrateMemoryEntry(entries, entry, { maxEntries, maxTotalChars, dedupe }) {
  let older = entries;
  if (dedupe) {
    const fresh = new Set(bulletsOf(entry).map(bulletKey));
    older = entries
      .map((e) => {
        const [title, ...body] = e.split('\n');
        const lines = body.filter((l) => !(/^\s*[-*]\s+/.test(l) && fresh.has(bulletKey(l))));
        return lines.some((l) => /^\s*[-*]\s+/.test(l)) ? [title, ...lines].join('\n') : null;
      })
      .filter((e) => e !== null);
  }
  const kept = [entry, ...older].slice(0, maxEntries);
  let total = 0;
  const bounded = [];
  for (const e of kept) {
    total += e.length + 1;
    // La plus récente est toujours conservée (déjà bornée par maxEntryChars).
    if (bounded.length > 0 && total > maxTotalChars) break;
    bounded.push(e);
  }
  return bounded;
}

/** Garde les puces tant que l'entrée tient dans `maxChars` (jamais de puce coupée en deux). */
function boundSummary(summary, maxChars) {
  if (summary.length <= maxChars) return summary;
  const out = [];
  let used = 0;
  for (const line of summary.split('\n')) {
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

/**
 * Le résumé est une sortie de LLM sur le diff d'un AGENT : du texte non fiable
 * que les autres agents liront (S-M8). Contrôles, bidi, zéro-largeur et
 * caractères Tag retirés (instructions invisibles), et toute ligne qui
 * ressemble à un titre d'entrée (`## `) est neutralisée : elle ne peut pas
 * forger une entrée distincte au prochain découpage du fichier.
 */
function neutralizeSummary(summary) {
  const clean = sanitizeAgentText(summary, 64 * 1024).text;
  return clean.replace(/^(#+)/gm, '\\$1');
}

/** Libellé de l'enceinte autour des entrées lues par les agents. */
const MEMORY_FENCE_LABEL = 'shared memory: LLM summaries of other agents’ merged diffs';

/**
 * Contenu du fichier lu par un agent : en-tête et section « temps réel »
 * (écrits par Striart) en clair, entrées (résumés LLM de diffs d'agents) dans
 * une ENCEINTE de contenu non fiable. Nonce DÉTERMINISTE (empreinte du
 * contenu) : le fichier reste identique d'un tick à l'autre, l'écriture
 * idempotente (voir refreshCloneMemories) ; une ligne qui contient le
 * marqueur est de toute façon neutralisée par fenceUntrusted.
 * @param {string} persistent @param {string} live
 */
function renderCloneMemory(persistent, live) {
  const [header, ...entries] = (persistent || `${HEADER}\n`).split(/\n(?=## )/);
  const body = entries.join('\n').trimEnd();
  const fenced = body
    ? fenceUntrusted(body, MEMORY_FENCE_LABEL, sha256(persistent).slice(0, 12))
    : '';
  const parts = [header.trimEnd(), live.trimEnd(), fenced].filter(Boolean);
  return `${parts.join('\n\n')}\n`;
}

const HEADER = `# Mémoire partagée Striart

> Généré automatiquement après chaque merge. Les agents lisent ce fichier
> pour connaître les API ajoutées/modifiées par les autres agents.
> Ne pas éditer ni commiter.
`;

function memoryPath(root) {
  return path.join(striartDir(root), 'memory.md');
}

/** Consignes (préfixe STABLE du prompt : identique d'un merge à l'autre, donc cacheable). */
const MEMORY_PROMPT_PREFIX = `Tu documentes les changements d'API d'un commit pour d'autres développeurs.
À partir du diff ci-dessous (réduit à ses lignes ajoutées/supprimées : lockfiles, ressources et tests
sont retirés), liste en 1 à 5 puces UNIQUEMENT ce qu'un autre
développeur doit savoir pour ne pas entrer en contradiction avec ce commit :
fonctions/classes exportées ajoutées, modifiées ou supprimées (avec leur
signature), contrats de données changés, fichiers déplacés.
Ignore les détails d'implémentation internes. Réponds uniquement avec les
puces Markdown ("- ..."), sans titre ni conclusion.
Mets le nom de chaque symbole entre accents graves.

Diff :
`;

function memoryPrompt(diff) {
  return `${MEMORY_PROMPT_PREFIX}${diff}`;
}

/**
 * Résume un merge et l'ajoute en tête de la mémoire (fenêtre glissante).
 * Best effort : toute erreur (LLM injoignable, réponse vide) est loggée et
 * retourne { updated: false } — la mémoire est advisory, jamais bloquante.
 * @param {{root: string, config: import('./types.js').StriartConfig, agent: string, sha: string, diff: string}} params
 * @returns {Promise<{updated: boolean, entry?: string, error?: string, skipped?: string}>}
 */
export async function updateMemoryAfterMerge({ root, config, agent, sha, diff }) {
  try {
    const settings = resolveTokensSettings(config);
    const compact = compactMemoryDiff(diff, settings.memory.diffMaxChars);
    if (compact.text.trim().length === 0) {
      // Rien qui parle d'API (lockfiles, ressources, tests seulement) : pas d'appel.
      return { updated: false, skipped: 'NO_API_CHANGES' };
    }
    if (compact.truncated) {
      logger.info(
        { agent, omittedLines: compact.omittedLines },
        'Memory Layer : diff réduit pour le résumé (le LLM en est informé)',
      );
    }
    const summary = await llmGenerate({
      config,
      prompt: memoryPrompt(compact.text),
      stablePrefix: MEMORY_PROMPT_PREFIX,
      timeoutMs: 60_000,
      retries: 1,
      role: 'memory',
      root,
      agent,
      maxOutputTokens: MEMORY_MAX_OUTPUT_TOKENS,
      resultCache: { promptVersion: MEMORY_PROMPT_VERSION, material: [sha256(compact.text)] },
      errorCode: 'MEMORY_FAILED',
      errorMessage: 'La génération de la mémoire partagée a échoué',
      transform: (response) => {
        const text = response.trim();
        if (text.length === 0) throw new Error('résumé vide');
        return neutralizeSummary(boundSummary(text, settings.memory.maxEntryChars));
      },
    });
    const entry = `## ${new Date().toISOString()} — agent ${agent} (${sha.slice(0, 8)})\n\n${summary}\n`;
    // Lecture-modification-écriture sous le verrou d'ÉTAT (court : quelques ms,
    // jamais pendant l'appel LLM ci-dessus). Le résumé d'un merge est désormais
    // écrit APRÈS la libération du verrou principal : sans ce verrou, deux
    // résumés concurrents perdraient l'une des deux entrées.
    await withStateLock(striartDir(root), async () => {
      const existing = await readFile(memoryPath(root), 'utf8').catch(() => `${HEADER}\n`);
      const [header, ...entries] = existing.split(/\n(?=## )/);
      const kept = integrateMemoryEntry(entries, entry, {
        maxEntries: config.memoryMaxEntries,
        maxTotalChars: settings.memory.maxTotalChars,
        dedupe: settings.memory.dedupe,
      });
      await writeFile(memoryPath(root), `${header.trimEnd()}\n\n${kept.join('\n')}`, 'utf8');
    });
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
    await ensureCloneExclude(clonePath, CLONE_MEMORY_FILE);
    // Jamais à travers un lien planté dans le clone (src/safe-write.ts). Les
    // entrées passent par l'enceinte (même rendu que refreshCloneMemories).
    const persistent = await readFile(source, 'utf8');
    await safeWriteFile(clonePath, CLONE_MEMORY_FILE, renderCloneMemory(persistent, ''));
    return true;
  } catch (error) {
    logger.warn({ err: error }, `Memory Layer : copie vers ${clonePath} impossible (ignorée)`);
    return false;
  }
}

/**
 * Ajoute un motif à .git/info/exclude du clone (idempotent) : ignore LOCALE,
 * jamais partagée ni commitée. Implémentation unique dans src/git-exclude.ts
 * (mémoire, consignes injectées, collab, hooks) ; ré-exportée ici pour les
 * importeurs historiques.
 */
export { ensureCloneExclude };

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
      const content = renderCloneMemory(persistent, live);
      // Idempotent : pas d'écriture si rien ne change. Indispensable — le
      // fichier vit dans le worktree, et une écriture par tick de watch
      // fausserait la détection de présence (mtime) en plus d'user le disque.
      const current = await safeReadText(meta.path, CLONE_MEMORY_FILE);
      if (current === content) continue;
      await ensureCloneExclude(meta.path, CLONE_MEMORY_FILE);
      await safeWriteFile(meta.path, CLONE_MEMORY_FILE, content);
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
