import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StriartError } from './errors.ts';
import { validateEnvAllowPattern } from './cli/env-file.ts';
import { validateGateEnvPattern } from './gate-env.ts';

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

/**
 * `network` : couche réseau d'entreprise (src/net.ts). Décisions de l'UTILISATEUR
 * uniquement — jamais la config d'un dépôt ni son `.env` (un dépôt hostile
 * pourrait sinon dérouter le trafic vers son proxy, ajouter sa propre CA ou
 * rouvrir une liste blanche). Défauts : aucune restriction, aucun relâchement.
 *
 *  - `proxy` / `noProxy` : proxy HTTP(S) d'entreprise (URL SANS identifiants :
 *    l'authentification se donne par la variable d'environnement
 *    `STRIART_PROXY_AUTH=utilisateur:motdepasse`, jamais ici) ;
 *  - `caFile` : fichier PEM de l'autorité d'entreprise, AJOUTÉ aux CA par défaut ;
 *  - `allowedHosts` : liste blanche de noms d'hôte (`exemple.com` ou
 *    `*.exemple.com`) appliquée à tous les appels sortants non locaux ;
 *  - `allowInsecureHosts` : hôtes joignables en HTTP en clair (relâchement
 *    journalisé, affiché par `striart doctor`) ;
 *  - `offline` : refuse tout appel non local (NET_OFFLINE) ;
 *  - `tlsMinVersion` : version TLS minimale.
 */
export interface NetworkConfig {
  proxy: string | null;
  noProxy: string | null;
  caFile: string | null;
  allowedHosts: string[];
  allowInsecureHosts: string[];
  offline: boolean;
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3' | null;
}

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
  network: NetworkConfig;
  /**
   * `gate.envAllow` : plafond des variables d'environnement que la config du
   * DÉPÔT (`gateEnv`) peut demander pour le Test Gate, EN PLUS de la liste
   * blanche intégrée (src/gate-env.ts). Noms, `PREFIXE_*` ou `*_SUFFIXE` ; les
   * clés d'API et webhooks restent toujours retirés. Décision de l'utilisateur,
   * donc ici et jamais dans la config du dépôt : une demande non couverte est
   * écartée, annoncée en tête du journal du gate et loguée.
   */
  gate: { envAllow: string[] };
  /**
   * `idle.closeRoots` : racines de dépôts pour lesquelles le GC d'inactivité
   * (src/idle/) est AUTORISÉ à fermer une session restée sans usage. La config
   * du dépôt choisit la politique (`idle.action: 'close'`) ; l'autorisation de
   * terminer des process sur CETTE machine est une décision de l'utilisateur,
   * donc ici et jamais dans un fichier qu'un dépôt hostile fournirait. Sans
   * autorisation, la fermeture dégrade en avertissement (fail closed).
   */
  idle: { closeRoots: string[] };
}

export const DEFAULT_USER_CONFIG: Readonly<UserConfig> = Object.freeze({
  hooks: Object.freeze({ trustedRoots: [] as string[] }),
  env: Object.freeze({ allow: [] as string[] }),
  native: Object.freeze({ trustedKeyIds: [] as string[] }),
  network: Object.freeze({
    proxy: null,
    noProxy: null,
    caFile: null,
    allowedHosts: [] as string[],
    allowInsecureHosts: [] as string[],
    offline: false,
    tlsMinVersion: null,
  }) as NetworkConfig,
  gate: Object.freeze({ envAllow: [] as string[] }),
  idle: Object.freeze({ closeRoots: [] as string[] }),
}) as Readonly<UserConfig>;

const MAX_NETWORK_HOSTS = 128;
const HOST_PATTERN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const NO_PROXY_RE = /^[A-Za-z0-9.*:[\],\-_ /]{1,2048}$/;

function validateNetwork(value: unknown): NetworkConfig {
  if (value === undefined)
    return { ...DEFAULT_USER_CONFIG.network, allowedHosts: [], allowInsecureHosts: [] };
  if (!isObject(value)) throw invalid('« network » doit être un objet', 'network');
  const known = [
    'proxy',
    'noProxy',
    'caFile',
    'allowedHosts',
    'allowInsecureHosts',
    'offline',
    'tlsMinVersion',
  ];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw invalid('clé inconnue', `network.${key}`);
  }
  let proxy: string | null = null;
  if (value.proxy !== undefined && value.proxy !== null) {
    const bad = () =>
      invalid(
        '« network.proxy » doit être une URL http(s) SANS identifiants (authentification : variable STRIART_PROXY_AUTH)',
        'network.proxy',
      );
    if (typeof value.proxy !== 'string') throw bad();
    let url: URL;
    try {
      url = new URL(value.proxy);
    } catch {
      throw bad();
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
      throw bad();
    proxy = value.proxy;
  }
  let noProxy: string | null = null;
  if (value.noProxy !== undefined && value.noProxy !== null) {
    if (typeof value.noProxy !== 'string' || !NO_PROXY_RE.test(value.noProxy)) {
      throw invalid(
        '« network.noProxy » doit être une liste d’hôtes séparés par des virgules',
        'network.noProxy',
      );
    }
    noProxy = value.noProxy;
  }
  let caFile: string | null = null;
  if (value.caFile !== undefined && value.caFile !== null) {
    if (
      typeof value.caFile !== 'string' ||
      /[\0\r\n]/.test(value.caFile) ||
      !isAbsoluteAnyOs(value.caFile)
    ) {
      throw invalid('« network.caFile » doit être un chemin absolu', 'network.caFile');
    }
    caFile = value.caFile;
  }
  const hostList = (key: 'allowedHosts' | 'allowInsecureHosts'): string[] => {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > MAX_NETWORK_HOSTS) {
      throw invalid(
        `« network.${key} » doit être un tableau (au plus ${MAX_NETWORK_HOSTS})`,
        `network.${key}`,
      );
    }
    return list.map((host) => {
      const normalized = typeof host === 'string' ? host.toLowerCase() : '';
      if (!HOST_PATTERN_RE.test(normalized)) {
        throw invalid(
          `« network.${key} » : nom d'hôte ou *.suffixe attendu (ni schéma, ni port, ni « * » seul)`,
          `network.${key}`,
        );
      }
      return normalized;
    });
  };
  const allowedHosts = hostList('allowedHosts');
  const allowInsecureHosts = hostList('allowInsecureHosts');
  const offline = value.offline ?? false;
  if (typeof offline !== 'boolean')
    throw invalid('« network.offline » doit être un booléen', 'network.offline');
  const tls = (value.tlsMinVersion ?? null) as NetworkConfig['tlsMinVersion'];
  if (tls !== null && tls !== 'TLSv1.2' && tls !== 'TLSv1.3') {
    throw invalid('« network.tlsMinVersion » : TLSv1.2 ou TLSv1.3', 'network.tlsMinVersion');
  }
  return { proxy, noProxy, caFile, allowedHosts, allowInsecureHosts, offline, tlsMinVersion: tls };
}

const MAX_TRUSTED_KEY_IDS = 16;

const MAX_ENV_ALLOW = 128;

const MAX_GATE_ENV_ALLOW = 128;

function validateGate(value: unknown): { envAllow: string[] } {
  if (value === undefined) return { envAllow: [] };
  if (!isObject(value)) throw invalid('« gate » doit être un objet', 'gate');
  for (const key of Object.keys(value)) {
    if (key !== 'envAllow') throw invalid('clé inconnue', `gate.${key}`);
  }
  const list = value.envAllow ?? [];
  if (!Array.isArray(list) || list.length > MAX_GATE_ENV_ALLOW) {
    throw invalid(
      `« gate.envAllow » doit être un tableau (au plus ${MAX_GATE_ENV_ALLOW})`,
      'gate.envAllow',
    );
  }
  for (const pattern of list) {
    const problem = validateGateEnvPattern(pattern);
    if (problem) throw invalid(`« gate.envAllow » : ${problem}`, 'gate.envAllow');
  }
  return { envAllow: [...(list as string[])] };
}

const MAX_TRUSTED_ROOTS = 256;

function validateIdle(value: unknown): { closeRoots: string[] } {
  if (value === undefined) return { closeRoots: [] };
  if (!isObject(value)) throw invalid('« idle » doit être un objet', 'idle');
  for (const key of Object.keys(value)) {
    if (key !== 'closeRoots') throw invalid('clé inconnue', `idle.${key}`);
  }
  const roots = value.closeRoots ?? [];
  if (!Array.isArray(roots) || roots.length > MAX_TRUSTED_ROOTS) {
    throw invalid(
      `« idle.closeRoots » doit être un tableau (au plus ${MAX_TRUSTED_ROOTS})`,
      'idle.closeRoots',
    );
  }
  for (const root of roots) {
    if (typeof root !== 'string' || /[\0\r\n]/.test(root) || !isAbsoluteAnyOs(root)) {
      throw invalid('chaque racine doit être un chemin absolu', 'idle.closeRoots');
    }
    if (/^(\/+|[A-Za-z]:[\\/]*|\\\\+)$/.test(root)) {
      throw invalid(
        'la racine du système de fichiers ne peut pas autoriser la fermeture',
        'idle.closeRoots',
      );
    }
  }
  return { closeRoots: [...(roots as string[])] };
}

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
    if (
      key !== 'hooks' &&
      key !== 'env' &&
      key !== 'native' &&
      key !== 'network' &&
      key !== 'gate' &&
      key !== 'idle'
    )
      throw invalid('clé inconnue', key);
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
    network: validateNetwork(value.network),
    gate: validateGate(value.gate),
    idle: validateIdle(value.idle),
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
      return validateUserConfig({});
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
