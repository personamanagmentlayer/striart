import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StriartError } from './errors.js';
import { validateEnvAllowPattern } from './cli/env-file.ts';

/**
 * Config UTILISATEUR de Striart — distincte de la config d'un dépôt
 * (striart.config.*), qu'un dépôt hostile pourrait fournir. Elle porte les
 * décisions de confiance propres à l'utilisateur, aujourd'hui une seule :
 *
 *   { "hooks": { "trustedRoots": ["/chemin/absolu/du/depot", …] },
 *     "env": { "allow": ["MON_FOURNISSEUR_*", "*_SECRET_ID"] } }
 *
 * Pour une racine listée, un hook installé pour l'utilisateur charge la
 * config COMPLÈTE du dépôt (y compris un striart.config.mjs exécutable) ;
 * ailleurs il ne lit que les configs données.
 *
 * Emplacement : `$STRIART_CONFIG_HOME/config.json` s'il est défini (absolu),
 * sinon `%APPDATA%\striart\config.json` (Windows), sinon
 * `${XDG_CONFIG_HOME:-~/.config}/striart/config.json` (Linux, macOS).
 *
 * Données seules (JSON), jamais exécutées ; validation stricte (clé
 * inconnue refusée). Le fichier élargit l'exécution de code : sous POSIX il
 * doit appartenir à l'utilisateur et n'être modifiable ni par le groupe ni
 * par les autres (USER_CONFIG_UNSAFE). Toute anomalie → aucune confiance
 * (fail closed) et l'appelant avertit.
 */

export interface UserConfig {
  hooks: { trustedRoots: string[] };
  /**
   * `env.allow` : noms (ou `PREFIXE_*` / `*_SUFFIXE`) que le `.env` de la
   * racine d'un dépôt peut ajouter à l'environnement EN PLUS de la liste
   * blanche intégrée (clés d'API, STRIART_LANG…). La liste noire (NODE_*,
   * LD_*, PATH…) n'est jamais relâchable. Décision de l'utilisateur, donc
   * ici et jamais dans la config du dépôt (qu'un dépôt hostile fournirait).
   */
  env: { allow: string[] };
  /**
   * `native.trustedKeyIds` : identifiants de clés de signature (minisign,
   * 16 chiffres hexadécimaux majuscules) acceptés EN PLUS de la clé épinglée
   * dans le code (`PINNED_NATIVE_KEY_IDS`, src/native.ts) pour vérifier le
   * binaire natif d'un paquet — organisation qui re-signe ses propres
   * archives. Décision de l'utilisateur : ici, jamais dans la config du dépôt.
   */
  native: { trustedKeyIds: string[] };
}

export const DEFAULT_USER_CONFIG: Readonly<UserConfig> = Object.freeze({
  hooks: Object.freeze({ trustedRoots: [] as string[] }),
  env: Object.freeze({ allow: [] as string[] }),
  native: Object.freeze({ trustedKeyIds: [] as string[] }),
}) as Readonly<UserConfig>;

const MAX_TRUSTED_KEY_IDS = 16;

const MAX_ENV_ALLOW = 128;

const MAX_TRUSTED_ROOTS = 256;

interface Where {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

export function userConfigPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
}: Where = {}): string {
  const p = pathFor(platform);
  const absolute = (v: string | undefined) => (v && p.isAbsolute(v) ? v : null);
  const explicit = absolute(env.STRIART_CONFIG_HOME);
  if (explicit) return p.join(explicit, 'config.json');
  if (platform === 'win32') {
    const appData = absolute(env.APPDATA);
    return appData
      ? p.join(appData, 'striart', 'config.json')
      : p.join(home, 'AppData', 'Roaming', 'striart', 'config.json');
  }
  return p.join(absolute(env.XDG_CONFIG_HOME) ?? p.join(home, '.config'), 'striart', 'config.json');
}

function invalid(reason: string, key: string | null = null): StriartError {
  return new StriartError(`Config utilisateur de Striart invalide : ${reason}.`, {
    code: 'USER_CONFIG_INVALID',
    details: { reason, ...(key ? { key } : {}) },
    hint: 'striart doctor',
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isAbsoluteAnyOs(v: string): boolean {
  return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\');
}

/** Valide une valeur lue (données JSON) et la complète des défauts. */
export function validateUserConfig(value: unknown): UserConfig {
  if (!isObject(value)) throw invalid('la racine doit être un objet JSON');
  for (const key of Object.keys(value)) {
    if (key !== 'hooks' && key !== 'env' && key !== 'native') throw invalid('clé inconnue', key);
  }
  const nativeBlock = value.native ?? {};
  if (!isObject(nativeBlock)) throw invalid('« native » doit être un objet', 'native');
  for (const key of Object.keys(nativeBlock)) {
    if (key !== 'trustedKeyIds') throw invalid('clé inconnue', `native.${key}`);
  }
  const keyIds = nativeBlock.trustedKeyIds ?? [];
  if (!Array.isArray(keyIds) || keyIds.length > MAX_TRUSTED_KEY_IDS) {
    throw invalid(
      `« native.trustedKeyIds » doit être un tableau (au plus ${MAX_TRUSTED_KEY_IDS})`,
      'native.trustedKeyIds',
    );
  }
  for (const id of keyIds) {
    if (typeof id !== 'string' || !/^[0-9A-F]{16}$/.test(id)) {
      throw invalid(
        'chaque identifiant de clé doit être 16 chiffres hexadécimaux majuscules (cf. striart doctor)',
        'native.trustedKeyIds',
      );
    }
  }
  const envBlock = value.env ?? {};
  if (!isObject(envBlock)) throw invalid('« env » doit être un objet', 'env');
  for (const key of Object.keys(envBlock)) {
    if (key !== 'allow') throw invalid('clé inconnue', `env.${key}`);
  }
  const allow = envBlock.allow ?? [];
  if (!Array.isArray(allow) || allow.length > MAX_ENV_ALLOW) {
    throw invalid(`« env.allow » doit être un tableau (au plus ${MAX_ENV_ALLOW})`, 'env.allow');
  }
  for (const pattern of allow) {
    const problem =
      typeof pattern === 'string' ? validateEnvAllowPattern(pattern) : 'doit être une chaîne';
    if (problem) throw invalid(`« env.allow » : ${problem}`, 'env.allow');
  }
  const hooks = value.hooks ?? {};
  if (!isObject(hooks)) throw invalid('« hooks » doit être un objet', 'hooks');
  for (const key of Object.keys(hooks)) {
    if (key !== 'trustedRoots') throw invalid('clé inconnue', `hooks.${key}`);
  }
  const roots = hooks.trustedRoots ?? [];
  if (!Array.isArray(roots) || roots.length > MAX_TRUSTED_ROOTS) {
    throw invalid(
      `« hooks.trustedRoots » doit être un tableau (au plus ${MAX_TRUSTED_ROOTS})`,
      'hooks.trustedRoots',
    );
  }
  for (const root of roots) {
    if (typeof root !== 'string' || /[\0\r\n]/.test(root) || !isAbsoluteAnyOs(root)) {
      throw invalid('chaque racine de confiance doit être un chemin absolu', 'hooks.trustedRoots');
    }
    // Faire confiance à la racine du système de fichiers reviendrait à tout autoriser.
    if (/^(\/+|[A-Za-z]:[\\/]*|\\\\+)$/.test(root)) {
      throw invalid(
        'la racine du système de fichiers ne peut pas être de confiance',
        'hooks.trustedRoots',
      );
    }
  }
  return {
    hooks: { trustedRoots: [...roots] },
    env: { allow: [...(allow as string[])] },
    native: { trustedKeyIds: [...(keyIds as string[])] },
  };
}

/** Clé de comparaison d'une racine : résolue, sans séparateur final, sans casse sous Windows/macOS. */
export function rootKey(root: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  let resolved = p.resolve(root);
  while (resolved.length > 1 && /[\\/]$/.test(resolved) && !/^[A-Za-z]:[\\/]$/.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/**
 * Lit la config utilisateur. Absente → défauts. Illisible, invalide, ou
 * modifiable par d'autres (POSIX) → erreur (l'appelant n'accorde alors
 * aucune confiance).
 */
export async function readUserConfig(where: Where = {}): Promise<UserConfig> {
  const platform = where.platform ?? process.platform;
  const file = userConfigPath(where);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hooks: { trustedRoots: [] }, env: { allow: [] }, native: { trustedKeyIds: [] } };
    }
    throw invalid(`lecture impossible (${(error as NodeJS.ErrnoException).code ?? 'erreur'})`);
  }
  if (platform !== 'win32' && typeof process.getuid === 'function') {
    const info = await stat(file);
    if ((info.mode & 0o022) !== 0 || info.uid !== process.getuid()) {
      throw new StriartError(
        `Config utilisateur de Striart ignorée : ${file} est modifiable par le groupe ou les autres, ou n'appartient pas à l'utilisateur (chmod 600).`,
        { code: 'USER_CONFIG_UNSAFE', details: { path: file }, hint: `chmod 600 ${file}` },
      );
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (error) {
    throw invalid(`JSON invalide (${(error as Error).message})`);
  }
  return validateUserConfig(value);
}

async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // Racine absente : comparée sous sa forme résolue.
    return target;
  }
}

/** `root` figure-t-il parmi les racines de confiance (chemins réels comparés) ? */
export async function isTrustedRoot(
  root: string,
  trustedRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (trustedRoots.length === 0) return false;
  const target = rootKey(await canonical(root), platform);
  for (const trusted of trustedRoots) {
    if (rootKey(await canonical(trusted), platform) === target) return true;
  }
  return false;
}
