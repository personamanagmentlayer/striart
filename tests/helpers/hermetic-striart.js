/**
 * Garde d'hermétisme des tests unitaires vis-à-vis du `.striart/` du DÉPÔT DE
 * DÉVELOPPEMENT.
 *
 * Striart s'initialise sur son propre dépôt (dogfooding). Un test unitaire qui
 * appelle `llmGenerate` (Router, Merger, Memory) sans racine explicite remonte
 * depuis le répertoire courant, trouve ce `.striart/` et y écrirait du registre
 * d'usage et du cache de résultats : pollution des vraies statistiques et des
 * vrais budgets de l'utilisateur. Deux protections :
 *
 *  1. le projet vitest `unit` pose `STRIART_TOKENS_NO_DISCOVERY=1` (la
 *     découverte implicite de la racine est coupée — voir resolveRoot) ;
 *  2. ce module prend l'empreinte de `.striart/usage` (registre ET cache, qui
 *     en est un sous-dossier) avant et après chaque fichier de test : toute
 *     écriture échoue le fichier, avec le nom des fichiers touchés.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Dossiers que la comptabilité de tokens écrit sous la racine d'un dépôt. */
export const GUARDED_SUBPATH = path.join('.striart', 'usage');

/**
 * Empreinte (chemin relatif → taille:mtime) de tout fichier sous
 * `<root>/.striart/usage`. Un dossier absent donne une empreinte vide.
 * @param {string} root
 * @returns {Promise<Map<string, string>>}
 */
export async function snapshotUsageTree(root) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const base = path.join(root, GUARDED_SUBPATH);
  /** @param {string} dir */
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const st = await stat(full).catch(() => null);
      if (st) out.set(path.relative(root, full), `${st.size}:${st.mtimeMs}`);
    }
  }
  await walk(base);
  return out;
}

/**
 * Fichiers ajoutés, supprimés ou modifiés entre deux empreintes.
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {string[]}
 */
export function diffSnapshots(before, after) {
  const touched = new Set();
  for (const [file, sig] of after) if (before.get(file) !== sig) touched.add(file);
  for (const file of before.keys()) if (!after.has(file)) touched.add(file);
  return [...touched].sort();
}
