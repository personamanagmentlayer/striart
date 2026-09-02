import { readFile, rename, writeFile } from 'node:fs/promises';
import { StriartError } from './errors.js';

/**
 * Lit un fichier JSON. Retourne `fallback` si le fichier n'existe pas,
 * throw StriartError(code) s'il est corrompu.
 */
export async function readJson(filePath, { fallback, code = 'JSON_CORRUPT' }) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new StriartError(`Fichier JSON corrompu (${filePath}) : ${error.message}`, {
      code,
      details: { path: filePath },
    });
  }
}

/**
 * Écriture atomique : un crash au milieu du write ne doit jamais
 * laisser un fichier d'état à moitié écrit.
 */
export async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}
