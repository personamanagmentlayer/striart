import path from 'node:path';
import { fillPromptTemplate, llmGenerate } from './llm.js';

const ROUTER_INSTRUCTIONS = `Tu es un analyste de code. Voici une tâche de développement et la liste des fichiers d'un projet.
Liste UNIQUEMENT les fichiers que cette tâche va réellement modifier (1 à 5 maximum).
N'inclus PAS les fichiers voisins ou improbables : chaque fichier listé bloque les autres agents qui le touchent.
Un fichier de test n'est inclus que s'il teste directement le code modifié.
Réponds UNIQUEMENT en JSON : {"files": ["src/..."]}`;

export function normalizeFilePath(p) {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

/**
 * Un chemin prédit par le LLM est-il un chemin de projet légitime (relatif,
 * dans l'arbre) ? Le Router n'utilise ces chemins que comme clés de verrou,
 * de collision et d'affichage — jamais pour écrire — mais un `../` ou un
 * chemin absolu hallucinés n'ont aucun sens ici et pollueraient l'état :
 * on les écarte à la source. Défense en profondeur, pas dernière ligne.
 */
export function isSafeProjectPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false; // absolu POSIX ou lettre de lecteur Windows
  return !p.split('/').includes('..');
}

/**
 * Prédit via Ollama les fichiers qu'une tâche va toucher.
 * Throw StriartError(ROUTER_FAILED) si toutes les tentatives échouent.
 */
export async function predictFiles({
  prompt,
  projectFiles,
  config,
  timeoutMs = 60_000,
  retries = 2,
  retryDelayMs = 500,
}) {
  // Template surchargé (config.prompts.router, placeholders validés au
  // chargement) ou prompt par défaut — même contrat de sortie dans les deux
  // cas : le transform ci-dessous valide {"files": [...]} quoi qu'il arrive.
  const fullPrompt = config.prompts?.router
    ? fillPromptTemplate(config.prompts.router, {
        task: prompt,
        files: projectFiles.join('\n'),
      })
    : `${ROUTER_INSTRUCTIONS}

Tâche : ${prompt}

Fichiers du projet :
${projectFiles.join('\n')}`;

  return llmGenerate({
    config,
    prompt: fullPrompt,
    format: 'json',
    timeoutMs,
    retries,
    retryDelayMs,
    errorCode: 'ROUTER_FAILED',
    errorMessage: `Le Router n'a pas pu prédire les fichiers`,
    transform: (response) => {
      const parsed = JSON.parse(response);
      if (!Array.isArray(parsed.files)) {
        throw new Error('la réponse ne contient pas de tableau "files"');
      }
      return [
        ...new Set(
          parsed.files
            .filter((f) => typeof f === 'string')
            .map(normalizeFilePath)
            .filter(Boolean)
            // Écarte les chemins hallucinés hors de l'arbre (absolus, `..`) :
            // ils n'ont pas de sens comme clés de verrou/collision.
            .filter(isSafeProjectPath),
        ),
      ];
    },
  });
}

/**
 * Intersection entre les fichiers prédits d'une nouvelle tâche
 * et ceux des agents déjà actifs.
 * Retourne [{ agent, files }] — vide si aucun chevauchement.
 */
export function detectCollisions(predictedFiles, agents) {
  const mine = new Set(predictedFiles.map(normalizeFilePath));
  const collisions = [];
  for (const agent of agents) {
    const files = (agent.predictedFiles ?? []).map(normalizeFilePath).filter((f) => mine.has(f));
    if (files.length > 0) collisions.push({ agent: agent.name, files });
  }
  return collisions;
}
