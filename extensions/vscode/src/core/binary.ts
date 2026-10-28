/**
 * Résolution du binaire `striart` (et de `git`) AVANT tout lancement.
 *
 * Pourquoi ne pas laisser `spawn` chercher lui-même ? Sous Windows, libuv
 * cherche l'exécutable dans le RÉPERTOIRE COURANT avant le PATH : un dépôt
 * qui contient un `striart.exe` serait exécuté (« binary planting »). Nous
 * résolvons donc nous-mêmes, contre le PATH seulement, en ignorant les
 * entrées relatives et tout dossier du workspace, et nous ne lançons que des
 * chemins ABSOLUS, en argv, `shell: false`.
 *
 * Sous Windows, npm installe un shim `striart.cmd` : Node refuse de lancer un
 * `.cmd` sans shell (CVE-2024-27980) et nous n'en voulons pas. Le shim est
 * donc ramené au script d'entrée du paquet (`node_modules/@jumsay/striart`,
 * voisin du shim) exécuté par `node` ; si ce script est introuvable, l'échec
 * est explicite et indique le réglage à poser.
 */
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { BinaryError } from './errors.ts';

export interface LaunchSpec {
  /** Chemin absolu de l'exécutable à lancer. */
  file: string;
  /** Arguments à placer AVANT les arguments de la commande Striart. */
  prefixArgs: string[];
  /** Forme affichable (journal), sans secret. */
  display: string;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Dossiers non fiables (workspace) : exclus de la recherche dans le PATH. */
  untrustedDirs?: readonly string[];
}

const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts']);
const PACKAGE_ENTRY = [
  ['node_modules', '@jumsay', 'striart', 'src', 'cli.js'],
  ['node_modules', 'striart', 'src', 'cli.js'],
];

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isBareName(value: string): boolean {
  return !value.includes('/') && !value.includes('\\');
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    // Absent ou illisible : pas un fichier utilisable.
    return false;
  }
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!(await isFile(file))) return false;
  if (platform === 'win32') return true;
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    // Présent mais non exécutable : ignoré dans la recherche.
    return false;
  }
}

function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function canonicalDir(dir: string, platform: NodeJS.Platform): Promise<string> {
  try {
    return normalizeForCompare(await realpath(dir), platform);
  } catch {
    // Dossier inexistant : sa forme normalisée suffit pour la comparaison.
    return normalizeForCompare(dir, platform);
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Cherche `name` dans le PATH, hors entrées relatives et hors dossiers non fiables. */
export async function findOnPath(name: string, options: ResolveOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const entries = (env[pathKey] ?? '').split(platform === 'win32' ? ';' : ':');
  const untrusted = await Promise.all((options.untrustedDirs ?? []).map((d) => canonicalDir(d, platform)));
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  // Sous Windows on préfère .exe/.cmd à un fichier sans extension (script sh de npm).
  const ordered = platform === 'win32' ? [...exts.slice(1), ''] : exts;
  for (const raw of entries) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const canonical = await canonicalDir(dir, platform);
    if (untrusted.some((u) => isInside(canonical, u))) continue;
    for (const ext of ordered) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

async function resolveCommand(setting: string, label: string, options: ResolveOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const value = setting.trim();
  if (value === '' || hasControlChars(value)) {
    throw new BinaryError('BINARY_INVALID', `The ${label} setting is empty or contains control characters.`);
  }
  if (path.isAbsolute(value)) {
    if (!(await isFile(value))) {
      throw new BinaryError('BINARY_NOT_FOUND', `${label}: "${value}" is not a file.`);
    }
    return value;
  }
  if (!isBareName(value)) {
    throw new BinaryError(
      'BINARY_RELATIVE',
      `${label}: "${value}" is a relative path. Use a bare command name (looked up in PATH) or an absolute path.`,
    );
  }
  const found = await findOnPath(value, { ...options, platform });
  if (!found) {
    throw new BinaryError('BINARY_NOT_FOUND', `${label}: "${value}" was not found in PATH.`);
  }
  return found;
}

/** Remonte du shim npm (`<prefix>/striart.cmd`) au script d'entrée du paquet, s'il existe. */
async function packageEntryNextTo(shim: string): Promise<string | null> {
  const dir = path.dirname(shim);
  for (const parts of PACKAGE_ENTRY) {
    const candidate = path.join(dir, ...parts);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Détermine comment lancer Striart. `binaryPath` et `nodePath` viennent des
 * réglages UTILISATEUR (jamais du workspace — voir config.ts).
 */
export async function resolveStriartLaunch(
  binaryPath: string,
  nodePath: string,
  options: ResolveOptions = {},
): Promise<LaunchSpec> {
  const platform = options.platform ?? process.platform;
  const target = await resolveCommand(binaryPath, 'striart.binaryPath', options);
  const ext = path.extname(target).toLowerCase();

  let script: string | null = null;
  if (SCRIPT_EXT.has(ext)) {
    script = target;
  } else if (platform === 'win32' && (ext === '.cmd' || ext === '.bat' || ext === '.ps1')) {
    script = await packageEntryNextTo(target);
    if (!script) {
      throw new BinaryError(
        'BINARY_UNSUPPORTED_SHIM',
        `"${target}" is an npm shell shim that cannot be started safely without a shell. ` +
          'Set striart.binaryPath to the package entry script (…/node_modules/@jumsay/striart/src/cli.js).',
      );
    }
  }

  if (script) {
    const node = await resolveCommand(nodePath, 'striart.nodePath', options);
    if (path.extname(node).toLowerCase() === '.cmd') {
      throw new BinaryError(
        'BINARY_UNSUPPORTED_SHIM',
        `striart.nodePath "${node}" must be a node executable, not a shim.`,
      );
    }
    return { file: node, prefixArgs: [script], display: `${node} ${script}` };
  }
  if (!(await isExecutable(target, platform))) {
    throw new BinaryError('BINARY_INVALID', `"${target}" is not executable.`);
  }
  return { file: target, prefixArgs: [], display: target };
}
