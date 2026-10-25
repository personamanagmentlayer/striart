import { StriartError } from './errors.js';
import { fillPromptTemplate, llmGenerate } from './llm.js';
import {
  assemble,
  conflictRegions,
  diff3Merge,
  hasFinalNewline,
  splitLines,
} from './merge-hunks.ts';
import { sha256 } from './tokens/cache.ts';
import { estimateTokens } from './tokens/estimate.ts';
import { resolveTokensSettings } from './tokens/settings.ts';

const LANGUAGE_BY_EXTENSION = {
  ts: 'TypeScript',
  tsx: 'TypeScript (React)',
  js: 'JavaScript',
  jsx: 'JavaScript (React)',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  c: 'C',
  cpp: 'C++',
  h: 'C/C++',
  vue: 'Vue',
  svelte: 'Svelte',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  sql: 'SQL',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  md: 'Markdown',
  sh: 'Shell',
  ps1: 'PowerShell',
};

/** Détecte le langage depuis l'extension, pour spécialiser le prompt du Merger. */
export function detectLanguage(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

function mergerInstructions(filePath) {
  const language = detectLanguage(filePath);
  const expert = language ? `expert en fusion de code ${language}` : 'expert en fusion de code';
  return `Tu es un ${expert}. Voici 3 versions d'un fichier.
Génère le code fusionné qui préserve la logique des deux versions.${
    language ? `\nLe résultat doit être du ${language} syntaxiquement valide.` : ''
  }
Ne rajoute aucune explication. Réponds uniquement avec le code.`;
}

/**
 * Lockfiles générés : les fusionner ligne à ligne (humain ou LLM) produit
 * un fichier incohérent — la bonne résolution est de le régénérer.
 */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
]);

/**
 * Taille max cumulée (base + ours + theirs) envoyée au Merger.
 * Au-delà, le prompt déborde la context window des modèles locaux :
 * le LLM tronque ou hallucine — ticket humain direct.
 */
export const MAX_MERGE_INPUT_CHARS = 120_000;

/** Octet NUL — heuristique binaire de git (jamais présent dans du texte). */
const NUL_BYTE = String.fromCharCode(0);

/** U+FFFD : marque d'un octet non UTF-8 (voir decodeBlob). */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** Modes Git non fusionnables par contenu : gitlink (submodule) et symlink. */
const MODE_GITLINK = '160000';
const MODE_SYMLINK = '120000';
const MODE_EXECUTABLE = '100755';

/**
 * Classifie un conflit AVANT tout appel LLM. Seul `{ kind: 'text' }` part en
 * fusion sémantique ; tout le reste est une décision humaine (ticket direct) :
 *  - 'submodule' : gitlink (mode 160000) — un SHA de sous-module ne se fusionne pas.
 *  - 'symlink'   : lien symbolique (mode 120000) — la cible ne se fusionne pas.
 *  - 'mode'      : le bit exécutable diffère entre main et l'agent — décision
 *                  humaine (le garder ou non change le comportement au runtime).
 *  - 'delete'    : suppression/modification — la résolution peut être "supprimer",
 *                  ce que le Merger ne sait pas produire (il écrit toujours un fichier).
 *                  Un fichier vidé à zéro octet est indistinguable d'un supprimé via
 *                  `git show` : on classe en 'delete' par prudence (au pire un ticket).
 *  - 'path'      : conflit de chemin (renommage/renommage, renommage/ajout) — une
 *                  version OURS ou THEIRS manque alors que le fichier n'est pas un
 *                  simple supprimé/modifié. Fusionner le contenu ne résoudrait pas
 *                  la question "sous quel nom le fichier doit-il vivre ?".
 *  - 'binary'    : octet NUL détecté — même heuristique que git ; une réécriture
 *                  utf8 corromprait le fichier.
 *  - 'encoding'  : une version n'est pas de l'UTF-8 valide (U+FFFD après
 *                  décodage) — réécrire le fichier le corromprait.
 *  - 'lockfile'  : fichier généré, à régénérer plutôt qu'à fusionner.
 *  - 'oversized' : dépasse MAX_MERGE_INPUT_CHARS.
 *  - 'opaque'    : aucune version lisible (objet non-blob sans mode connu).
 * `modes` (facultatif) : modes Git des stages 1/2/3 issus de `git ls-files -u`.
 * `maxInputChars` (facultatif) : plafond d'entrée ; défaut MAX_MERGE_INPUT_CHARS,
 * `maxMergeInputChars(config)` le relève quand la fusion par régions s'applique.
 * @param {{filePath: string, base: string, ours: string, theirs: string, modes?: import('./types.js').StageModes, maxInputChars?: number}} versions
 * @returns {import('./types.js').ConflictClass}
 */
export function classifyConflict({
  filePath,
  base,
  ours,
  theirs,
  modes = {},
  maxInputChars = MAX_MERGE_INPUT_CHARS,
}) {
  const allModes = [modes.base, modes.ours, modes.theirs].filter(Boolean);
  if (allModes.includes(MODE_GITLINK)) return { kind: 'submodule' };
  if (allModes.includes(MODE_SYMLINK)) return { kind: 'symlink' };
  if (!base && !ours && !theirs) return { kind: 'opaque' };
  if (base && !ours !== !theirs) {
    return { kind: 'delete', deletedBy: ours ? 'theirs' : 'ours' };
  }
  // Version manquante hors du schéma supprimé/modifié : artefact d'un conflit
  // de chemin (rename/rename : l'ancien nom n'a que BASE, chaque nouveau nom
  // n'a qu'un côté). Sans ce garde, le LLM recevrait une version vide et
  // inventerait le contenu manquant.
  if (!ours || !theirs) return { kind: 'path' };
  if ([base, ours, theirs].some((v) => v.includes(NUL_BYTE))) return { kind: 'binary' };
  if ([base, ours, theirs].some((v) => v.includes(REPLACEMENT_CHAR))) return { kind: 'encoding' };
  const name = filePath.split('/').pop() ?? filePath;
  if (LOCKFILES.has(name)) return { kind: 'lockfile' };
  const chars = base.length + ours.length + theirs.length;
  if (chars > maxInputChars) return { kind: 'oversized', chars };
  if (modes.ours && modes.theirs && modes.ours !== modes.theirs) {
    return { kind: 'mode', ours: modes.ours, theirs: modes.theirs };
  }
  return { kind: 'text' };
}

/** Le bit exécutable doit-il être posé sur le fichier fusionné ? */
export function isExecutableMode(mode) {
  return mode === MODE_EXECUTABLE;
}

/**
 * Proportion des lignes non vides de `a` retrouvées dans `b` (0..1).
 * Similarité par LIGNES, volontairement différente de celle de git (chunks
 * d'octets) : sur un petit fichier, une ligne modifiée suffit à faire tomber
 * la similarité git à zéro — c'est précisément le cas où un renommage devient
 * invisible pour le merge, alors que le recouvrement de lignes reste évident.
 * Utilisée pour repérer l'héritier probable d'un fichier "supprimé des deux
 * côtés" (double-renommage non détecté par git).
 */
export function lineOverlap(a, b) {
  const linesOf = (text) =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const aLines = linesOf(a);
  if (aLines.length === 0) return 0;
  const bSet = new Set(linesOf(b));
  const common = aLines.filter((l) => bSet.has(l)).length;
  return common / aLines.length;
}

/**
 * Retire les éventuelles fences markdown (\`\`\`lang ... \`\`\`) dont
 * les LLM entourent souvent le code malgré les instructions.
 */
export function stripCodeFences(text) {
  // Seules les lignes vides de tête et les blancs de queue sont retirés : un
  // trim() complet désindenterait la 1re ligne (Python, YAML : indentation = sens).
  const trimmed = text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  const match = trimmed.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return match ? match[1] : trimmed;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LOSSY_UTF8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/**
 * Décode un blob. UTF-8 strict d'abord ; un blob qui ne l'est pas (latin1,
 * UTF-16…) est décodé avec perte : les octets invalides deviennent U+FFFD, que
 * classifyConflict traduit en décision humaine (kind 'encoding'). Réécrire ce
 * texte corromprait silencieusement le fichier.
 * @param {Uint8Array} bytes
 */
export function decodeBlob(bytes) {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    // Octets non UTF-8 : repli explicite, signalé en aval par U+FFFD.
    return LOSSY_UTF8.decode(bytes);
  }
}

async function showStage(git, stage, filePath) {
  try {
    // Octets bruts (Buffer), pas la chaîne de git.show : sa conversion UTF-8
    // sans contrôle perdrait les fichiers non UTF-8 sans que personne le sache.
    return decodeBlob(await git.binaryCatFile(['blob', `:${stage}:${filePath}`]));
  } catch {
    // Pas de stage pour ce fichier (ex: ajouté des deux côtés → pas de BASE).
    return '';
  }
}

/**
 * Extrait les 3 versions d'un fichier en conflit depuis l'index Git :
 * :1: = BASE (ancêtre commun), :2: = OURS (branche cible), :3: = THEIRS (agent).
 * À appeler pendant le conflit, avant tout merge --abort.
 */
export async function extractConflictVersions(git, filePath) {
  const [base, ours, theirs] = await Promise.all([
    showStage(git, 1, filePath),
    showStage(git, 2, filePath),
    showStage(git, 3, filePath),
  ]);
  return { base, ours, theirs };
}

/** Version du gabarit de prompt du Merger : à incrémenter si les instructions changent (invalide le cache). */
const MERGER_PROMPT_VERSION = 'merger-v2';

/**
 * Plafond d'entrée d'un conflit quand la fusion par régions est possible :
 * seul le diff local lit le fichier entier (pas le LLM), donc la limite de
 * fenêtre du modèle ne s'applique plus au fichier mais aux RÉGIONS en
 * conflit (voir tokens.merger.maxWindowTokens).
 */
export const MAX_HUNK_MODE_INPUT_CHARS = 4_000_000;

/**
 * Taille maximale (base + ours + theirs) acceptée par classifyConflict pour
 * cette config : 120 000 caractères pour la fusion « fichier entier » (gabarit
 * surchargé ou mode 'full'), bien plus quand la fusion par régions s'applique.
 * @param {import('./types.js').StriartConfig} config
 */
export function maxMergeInputChars(config) {
  const mode = resolveTokensSettings(config).merger.mode;
  if (mode === 'full' || config.prompts?.merger) return MAX_MERGE_INPUT_CHARS;
  return MAX_HUNK_MODE_INPUT_CHARS;
}

const lineOf = (l) => l.replace(/\r$/, '');
const block = (lines) => lines.map(lineOf).join('\n');

function hunkInstructions(filePath, count) {
  const language = detectLanguage(filePath);
  const expert = language ? `expert en fusion de code ${language}` : 'expert en fusion de code';
  const plural = count > 1 ? 's' : '';
  const validity = language
    ? `\nLe résultat doit être du ${language} syntaxiquement valide dans son contexte.`
    : '';
  return `Tu es un ${expert}. Un fichier a été modifié différemment sur deux branches, sur ${count} région${plural} en conflit ; le reste du fichier est déjà fusionné.
Pour CHAQUE région, produis le code fusionné qui préserve la logique de A (branche principale) et de B (branche agent) par rapport à BASE.${validity}
Les lignes de contexte ne servent qu'à t'orienter : NE LES REPRODUIS PAS.
Format de réponse STRICT, sans aucune explication — pour chaque région k :
<<<REGION k>>>
(code fusionné de la région, sans le contexte)
<<<END k>>>`;
}

function regionBlock(region) {
  const parts = [`##### Région ${region.index}`];
  if (region.before.length > 0) parts.push('Contexte avant :', block(region.before));
  parts.push('BASE :', block(region.base), 'A (branche principale) :', block(region.ours));
  parts.push('B (branche agent) :', block(region.theirs));
  if (region.after.length > 0) parts.push('Contexte après :', block(region.after));
  return parts.join('\n');
}

/**
 * Extrait la résolution de chaque région d'une réponse au format strict
 * <<<REGION k>>> … <<<END k>>>. Toute région manquante, dupliquée ou encore
 * porteuse de marqueurs de conflit invalide la réponse (retentée, puis
 * SEMANTIC_MERGE_FAILED) — jamais un fichier partiellement fusionné.
 * @param {string} response
 * @param {Array<{index: number, ours: string[], theirs: string[]}>} regions
 * @returns {Map<number, string[]>}
 */
export function parseRegionResponse(response, regions) {
  const out = new Map();
  const expected = new Set(regions.map((r) => r.index));
  let current = null;
  let buffer = [];
  for (const line of response.split(/\r?\n/)) {
    if (current === null) {
      const open = /^<<<REGION (\d+)>>>$/.exec(line.trim());
      if (open) {
        const k = Number(open[1]);
        if (!expected.has(k) || out.has(k)) throw new Error(`région ${k} inattendue ou dupliquée`);
        current = k;
        buffer = [];
      }
      continue; // texte hors région (préambule) : ignoré
    }
    if (line.trim() === `<<<END ${current}>>>`) {
      const code = stripCodeFences(buffer.join('\n'));
      const region = regions.find((r) => r.index === current);
      // Une région peut légitimement se résoudre à « rien » seulement si un côté
      // l'a supprimée ; sinon une réponse vide est un oubli du modèle.
      if (code.trim().length === 0 && region.ours.length > 0 && region.theirs.length > 0) {
        throw new Error(`région ${current} vide`);
      }
      if (code.includes('<<<<<<<') || code.includes('>>>>>>>')) {
        throw new Error('la réponse contient encore des marqueurs de conflit');
      }
      out.set(current, code.length === 0 ? [] : code.split('\n'));
      current = null;
      continue;
    }
    buffer.push(line);
  }
  if (current !== null) throw new Error(`région ${current} non terminée (réponse coupée)`);
  const missing = [...expected].filter((k) => !out.has(k));
  if (missing.length > 0) throw new Error(`régions manquantes : ${missing.join(', ')}`);
  return out;
}

/** Sortie maximale utile : la plus grande version × 1,5 + marge, bornée. */
function outputBudget(texts, estimator) {
  const longest = Math.max(...texts.map((t) => estimateTokens(t, estimator)), 0);
  return Math.min(128_000, Math.max(1024, Math.ceil(longest * 1.5) + 512));
}

/**
 * Plan de fusion par régions. null : la borne de Myers est dépassée (chemin
 * fichier entier). `regions` vide : diff3 fusionne proprement sans modèle.
 */
function planHunkMerge({ base, ours, theirs, contextLines }) {
  const segments = diff3Merge(splitLines(base), splitLines(ours), splitLines(theirs));
  if (!segments) return null;
  return { segments, regions: conflictRegions(segments, contextLines) };
}

/**
 * Fusion sémantique d'un fichier en conflit via le LLM configuré.
 * Une réponse vide ou contenant encore des marqueurs de conflit compte
 * comme une tentative échouée (retentée puis SEMANTIC_MERGE_FAILED).
 *
 * Lot T : au-delà de tokens.merger.hunkThresholdChars (mode 'auto'), seules
 * les régions EN CONFLIT (diff3 local + contexte) partent au LLM ; le reste du
 * fichier est fusionné sans modèle. Une fenêtre estimée au-delà de
 * tokens.merger.maxWindowTokens lève MERGE_WINDOW_EXCEEDED (ticket humain) —
 * jamais de troncature. Un gabarit surchargé (config.prompts.merger) force
 * la fusion « fichier entier » : le gabarit de l'utilisateur est respecté.
 */
export async function semanticMerge({
  filePath,
  base,
  ours,
  theirs,
  config,
  feedback = null,
  timeoutMs = 120_000,
  retries = 1,
  retryDelayMs = null,
  root = null,
  agent = null,
  taskId = null,
}) {
  const settings = resolveTokensSettings(config);
  const customTemplate = Boolean(config.prompts?.merger);
  // Retry post-gate : le log d'échec des tests est réinjecté dans le prompt
  // pour que le Merger corrige sa propre fusion au lieu d'un ticket immédiat.
  const feedbackSection = feedback
    ? `

IMPORTANT : une précédente fusion de ce fichier a été rejetée car les tests
du projet échouent avec cette sortie :
${feedback}

Produis une fusion corrigée qui fait passer ces tests.`
    : '';

  const totalChars = base.length + ours.length + theirs.length;
  const wantHunks =
    !customTemplate &&
    (settings.merger.mode === 'hunk' ||
      (settings.merger.mode === 'auto' && totalChars > settings.merger.hunkThresholdChars));
  const plan = wantHunks
    ? planHunkMerge({ base, ours, theirs, contextLines: settings.merger.contextLines })
    : null;

  if (plan && plan.regions.length === 0) {
    // diff3 résout tout sans conflit : fusion locale, aucun appel au modèle.
    // Le Test Gate garde le dernier mot comme pour toute fusion.
    return assemble(plan.segments, new Map(), hasFinalNewline(ours) || hasFinalNewline(theirs));
  }

  let prompt;
  let stablePrefix = null;
  let maxOutputTokens;
  let transform;
  if (plan) {
    stablePrefix = `${hunkInstructions(filePath, plan.regions.length)}

Fichier : ${filePath}

${plan.regions.map(regionBlock).join('\n\n')}`;
    prompt = stablePrefix + feedbackSection;
    maxOutputTokens = outputBudget(
      plan.regions.flatMap((r) => [block(r.base), block(r.ours), block(r.theirs)]),
      settings.estimator,
    );
    const crlf = ours.includes('\r\n');
    const finalNewline = hasFinalNewline(ours) || hasFinalNewline(theirs);
    transform = (response) => {
      const resolutions = parseRegionResponse(response, plan.regions);
      for (const [k, lines] of resolutions) {
        resolutions.set(
          k,
          lines.map((l) => (crlf ? `${lineOf(l)}\r` : lineOf(l))),
        );
      }
      const merged = assemble(plan.segments, resolutions, finalNewline);
      // Sans newline final, le \r ajouté à la dernière ligne résolue serait parasite.
      const lastIsRegion = plan.segments[plan.segments.length - 1]?.kind !== 'stable';
      return crlf && !finalNewline && lastIsRegion && merged.endsWith('\r')
        ? merged.slice(0, -1)
        : merged;
    };
  } else {
    if (customTemplate) {
      // Template surchargé (config.prompts.merger, placeholders validés au
      // chargement). {{feedback}} reçoit la section COMPLÈTE (vide au premier
      // essai) : le retry post-gate doit survivre à la surcharge. Surcharger
      // fait perdre l'adaptation au langage de mergerInstructions : choix
      // assumé de l'auteur du template.
      prompt = fillPromptTemplate(config.prompts.merger, {
        file: filePath,
        base,
        ours,
        theirs,
        feedback: feedbackSection,
      });
    } else {
      stablePrefix = `${mergerInstructions(filePath)}

Fichier : ${filePath}

Version BASE (commune) :
${base}

Version A (branche principale) :
${ours}

Version B (branche agent) :
${theirs}`;
      prompt = stablePrefix + feedbackSection;
    }
    maxOutputTokens = outputBudget([base, ours, theirs], settings.estimator);
    transform = (response) => {
      const code = stripCodeFences(response);
      if (code.trim().length === 0) throw new Error('réponse vide');
      if (code.includes('<<<<<<<') || code.includes('>>>>>>>')) {
        throw new Error('la réponse contient encore des marqueurs de conflit');
      }
      return code.endsWith('\n') ? code : `${code}\n`;
    };
  }

  // Fenêtre : jamais de troncature silencieuse — au-delà, ticket humain.
  const windowTokens = estimateTokens(prompt, settings.estimator);
  if (windowTokens > settings.merger.maxWindowTokens) {
    throw new StriartError(
      `Conflict in ${filePath} needs about ${windowTokens} tokens, above the Merger window (tokens.merger.maxWindowTokens = ${settings.merger.maxWindowTokens}): resolve it by hand instead of letting the model truncate it.`,
      {
        code: 'MERGE_WINDOW_EXCEEDED',
        hint: 'striart resolve',
        details: {
          file: filePath,
          estimatedTokens: windowTokens,
          maxWindowTokens: settings.merger.maxWindowTokens,
          mode: plan ? 'hunk' : 'full',
        },
      },
    );
  }

  return llmGenerate({
    config,
    prompt,
    stablePrefix,
    timeoutMs,
    retries,
    retryDelayMs,
    role: 'merger',
    root,
    agent,
    taskId,
    maxOutputTokens,
    resultCache: {
      promptVersion: MERGER_PROMPT_VERSION,
      material: [
        plan ? 'hunk' : 'full',
        filePath,
        sha256(base),
        sha256(ours),
        sha256(theirs),
        sha256(feedbackSection),
        customTemplate ? sha256(config.prompts.merger) : '',
      ],
    },
    errorCode: 'SEMANTIC_MERGE_FAILED',
    errorMessage: `La fusion sémantique de ${filePath} a échoué`,
    transform,
  });
}
