/**
 * Cache local de résultats LLM IDEMPOTENTS (lot T).
 *
 * Clé = sha256 de (version du prompt, rôle, fournisseur, modèle, entrées) :
 * toute différence d'entrée, de modèle ou de gabarit produit une autre clé —
 * l'invalidation est structurelle, jamais un état à purger à la main. TTL
 * configurable, taille bornée, désactivable.
 *
 * Garde-fous :
 *  - JAMAIS pour une décision de sécurité ou d'arbitrage : la config n'admet
 *    que router/merger/memory (settings.ts), et le Merger n'y figure pas par
 *    défaut ; le résultat mis en cache reste validé par l'appelant à chaque
 *    lecture (le `transform` de llmGenerate rejoue sur l'entrée de cache).
 *  - Le cache vit sous `.striart/usage/cache/` (gitignoré avec `.striart/`),
 *    jamais dans un clone d'agent ni dans le registre d'usage.
 *  - Best effort : une lecture/écriture qui échoue se comporte comme un
 *    manque (miss) et est journalisée, jamais une erreur de l'appel.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../json-file.js';
import { logger } from '../logger.js';
import { mkdirPrivate } from '../private-fs.ts';
import { usageDir } from './ledger.ts';

const KEY_RE = /^[0-9a-f]{64}$/;

export function cacheDir(root: string): string {
  return path.join(usageDir(root), 'cache');
}

export interface CacheKeyParts {
  role: string;
  provider: string | null;
  model: string | null;
  /** Version du gabarit de prompt : l'incrémenter invalide toutes les entrées du rôle. */
  promptVersion: string;
  /** Entrées déterministes du prompt (déjà normalisées par l'appelant). */
  material: readonly string[];
}

export function cacheKey(parts: CacheKeyParts): string {
  const hash = createHash('sha256');
  // Encodage injectif (longueur + contenu) : deux listes différentes ne
  // peuvent pas produire la même séquence d'octets.
  for (const piece of [
    parts.promptVersion,
    parts.role,
    parts.provider ?? '',
    parts.model ?? '',
    ...parts.material,
  ]) {
    hash.update(`${Buffer.byteLength(piece, 'utf8')}:`);
    hash.update(piece, 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Empreinte d'un texte (pour composer `material` sans le recopier). */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Entry {
  v: 1;
  role: string;
  createdAt: number;
  expiresAt: number;
  response: string;
}

export async function cacheGet(
  root: string,
  key: string,
  now = Date.now(),
): Promise<string | null> {
  if (!KEY_RE.test(key)) return null;
  const file = path.join(cacheDir(root), `${key}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null; // absence normale d'une entrée
  }
  try {
    const entry = JSON.parse(raw) as Partial<Entry>;
    if (
      entry.v === 1 &&
      typeof entry.response === 'string' &&
      typeof entry.expiresAt === 'number' &&
      entry.expiresAt > now
    ) {
      return entry.response;
    }
  } catch {
    // Entrée corrompue : purgée ci-dessous, comptée comme un manque.
  }
  await rm(file, { force: true }).catch(() => undefined);
  return null;
}

export async function cacheDelete(root: string, key: string): Promise<void> {
  if (!KEY_RE.test(key)) return;
  await rm(path.join(cacheDir(root), `${key}.json`), { force: true }).catch(() => undefined);
}

export async function cachePut(
  root: string,
  key: string,
  role: string,
  response: string,
  { ttlMs, maxEntries, now = Date.now() }: { ttlMs: number; maxEntries: number; now?: number },
): Promise<void> {
  if (!KEY_RE.test(key)) return;
  const dir = cacheDir(root);
  try {
    await mkdirPrivate(dir);
    const entry: Entry = { v: 1, role, createdAt: now, expiresAt: now + ttlMs, response };
    await writeFileAtomic(path.join(dir, `${key}.json`), JSON.stringify(entry));
    await enforceLimit(dir, maxEntries);
  } catch (error) {
    logger.warn({ err: error }, 'Cache LLM : écriture impossible (ignorée)');
  }
}

async function enforceLimit(dir: string, maxEntries: number): Promise<void> {
  const names = (await readdir(dir).catch(() => [])).filter(
    (n) => n.endsWith('.json') && KEY_RE.test(n.slice(0, -5)),
  );
  if (names.length <= maxEntries) return;
  const withTimes = await Promise.all(
    names.map(async (n) => ({
      n,
      t: (await stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0,
    })),
  );
  withTimes.sort((a, b) => a.t - b.t);
  for (const { n } of withTimes.slice(0, names.length - maxEntries)) {
    await rm(path.join(dir, n), { force: true }).catch(() => undefined);
  }
}

/** Supprime les entrées expirées ou illisibles ; rend le nombre d'entrées retirées (pour prune). */
export async function sweepCache(
  root: string,
  { dryRun = false, now = Date.now() }: { dryRun?: boolean; now?: number } = {},
): Promise<{ removed: number; freedBytes: number }> {
  const dir = cacheDir(root);
  let removed = 0;
  let freedBytes = 0;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json') || !KEY_RE.test(name.slice(0, -5))) continue;
    const file = path.join(dir, name);
    let expired = true;
    try {
      const entry = JSON.parse(await readFile(file, 'utf8')) as Partial<Entry>;
      expired = !(entry.v === 1 && typeof entry.expiresAt === 'number' && entry.expiresAt > now);
    } catch {
      // illisible → purgé
    }
    if (!expired) continue;
    const st = await stat(file).catch(() => null);
    if (!dryRun) await rm(file, { force: true }).catch(() => undefined);
    removed += 1;
    freedBytes += st?.size ?? 0;
  }
  return { removed, freedBytes };
}
