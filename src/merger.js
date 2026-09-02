import { fillPromptTemplate, llmGenerate } from './llm.js';

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
 *  - 'lockfile'  : fichier généré, à régénérer plutôt qu'à fusionner.
 *  - 'oversized' : dépasse MAX_MERGE_INPUT_CHARS.
 *  - 'opaque'    : aucune version lisible (objet non-blob sans mode connu).
 * `modes` (facultatif) : modes Git des stages 1/2/3 issus de `git ls-files -u`.
 * @param {{filePath: string, base: string, ours: string, theirs: string, modes?: import('./types.js').StageModes}} versions
 * @returns {import('./types.js').ConflictClass}
 */
export function classifyConflict({ filePath, base, ours, theirs, modes = {} }) {
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
  const name = filePath.split('/').pop() ?? filePath;
  if (LOCKFILES.has(name)) return { kind: 'lockfile' };
  const chars = base.length + ours.length + theirs.length;
  if (chars > MAX_MERGE_INPUT_CHARS) return { kind: 'oversized', chars };
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
  const trimmed = text.trim();
  const match = trimmed.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return match ? match[1] : trimmed;
}

async function showStage(git, stage, filePath) {
  try {
    return await git.show([`:${stage}:${filePath}`]);
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

/**
 * Fusion sémantique d'un fichier en conflit via Ollama.
 * Une réponse vide ou contenant encore des marqueurs de conflit compte
 * comme une tentative échouée (retentée puis SEMANTIC_MERGE_FAILED).
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
  retryDelayMs = 500,
}) {
  // Retry post-gate : le log d'échec des tests est réinjecté dans le prompt
  // pour que le Merger corrige sa propre fusion au lieu d'un ticket immédiat.
  const feedbackSection = feedback
    ? `

IMPORTANT : une précédente fusion de ce fichier a été rejetée car les tests
du projet échouent avec cette sortie :
${feedback}

Produis une fusion corrigée qui fait passer ces tests.`
    : '';
  // Template surchargé (config.prompts.merger, placeholders validés au
  // chargement) ou prompt par défaut. {{feedback}} reçoit la section
  // formatée COMPLÈTE (vide au premier essai) : le retry post-gate doit
  // survivre à la surcharge — un template qui perdrait le feedback
  // referait exactement la même fusion rejetée. Surcharger fait perdre
  // l'adaptation au langage de mergerInstructions : choix assumé de
  // l'auteur du template, qui écrit ses propres instructions.
  const prompt = config.prompts?.merger
    ? fillPromptTemplate(config.prompts.merger, {
        file: filePath,
        base,
        ours,
        theirs,
        feedback: feedbackSection,
      })
    : `${mergerInstructions(filePath)}

Fichier : ${filePath}

Version BASE (commune) :
${base}

Version A (branche principale) :
${ours}

Version B (branche agent) :
${theirs}${feedbackSection}`;

  return llmGenerate({
    config,
    prompt,
    timeoutMs,
    retries,
    retryDelayMs,
    errorCode: 'SEMANTIC_MERGE_FAILED',
    errorMessage: `La fusion sémantique de ${filePath} a échoué`,
    transform: (response) => {
      const code = stripCodeFences(response);
      if (code.trim().length === 0) throw new Error('réponse vide');
      if (code.includes('<<<<<<<') || code.includes('>>>>>>>')) {
        throw new Error('la réponse contient encore des marqueurs de conflit');
      }
      return code.endsWith('\n') ? code : `${code}\n`;
    },
  });
}
