import { execa } from 'execa';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Détection des outils de coding installés (`striart profiles --detect`).
 *
 * Deux sondes, et rien d'autre :
 *  1. recherche du binaire dans le PATH, par le système de fichiers (aucun
 *     process, aucun shell — `which`/`where` ne sont pas appelés) ;
 *  2. `<binaire> <versionArgs>` en argv (shell: false), lancé dans un
 *     dossier temporaire VIDE créé pour l'occasion : un outil qui lit la
 *     config de son dossier courant (`.claude/settings.json`, `.mcp.json`,
 *     `.gemini/`, `opencode.json`…) n'y trouve rien — la sonde n'exécute
 *     jamais la config du dépôt. Délai court, sortie bornée, stdin fermé.
 */

/** Délai max d'une sonde de version (un binaire qui attend stdin ne bloque pas la commande). */
export const VERSION_PROBE_TIMEOUT_MS = 5000;
/** Sortie max lue d'une sonde de version. */
const VERSION_PROBE_MAX_BUFFER = 64 * 1024;

export interface DetectionTarget {
  /** Identifiant du preset (catalogue). */
  id: string;
  /** Noms de binaires candidats, par ordre de préférence. */
  binaries: readonly string[];
  /** Arguments de la sonde de version (défaut `--version`). */
  versionArgs?: readonly string[];
  /** Version minimale exigée par le preset (sémantique x.y.z), si connue. */
  minVersion?: string | null;
}

export type DetectionStatus = 'found' | 'outdated' | 'missing' | 'unknown-version';

export interface DetectionResult {
  id: string;
  status: DetectionStatus;
  /** Nom du binaire trouvé (premier candidat présent dans le PATH). */
  binary: string | null;
  /** Chemin absolu résolu. */
  path: string | null;
  version: string | null;
  minVersion: string | null;
  /** Message court de la sonde quand la version n'a pas pu être lue. */
  probeError: string | null;
}

/** Extensions exécutables à essayer : PATHEXT sous Windows, aucune ailleurs. */
function executableExtensions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [''];
  const raw = env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  // Un nom déjà suffixé (`claude.exe`) se teste aussi tel quel.
  return ['', ...exts];
}

async function isExecutableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) return false;
  if (platform === 'win32') return true; // pas de bit x : l'extension (PATHEXT) fait foi
  return access(candidate, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * Cherche un binaire dans le PATH sans lancer de process. Un nom contenant
 * un séparateur de chemin est refusé : la détection ne sonde que des NOMS
 * du catalogue, jamais un chemin arbitraire.
 */
export async function findOnPath(
  binary: string,
  {
    env = process.env,
    platform = process.platform,
  }: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(binary)) return null;
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = pathVar
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const exts = executableExtensions(platform, env);
  for (const dir of dirs) {
    // Un PATH relatif (`.`, `node_modules/.bin`) dépendrait du dossier
    // courant — c'est-à-dire du dépôt : exactement ce que la sonde exclut.
    if (!path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      if (await isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** Première version `x.y[.z][-suffixe]` trouvée dans une sortie. */
export function parseVersion(output: string): string | null {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output);
  return match ? match[1] : null;
}

/** Compare deux versions numériques x.y.z (suffixes ignorés). <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Lance la sonde de version d'un binaire résolu, dans un dossier vide.
 * Ne throw pas : une sonde qui échoue rend `version: null` et son motif.
 */
export async function probeVersion(
  executable: string,
  versionArgs: readonly string[] = ['--version'],
  { env = process.env }: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ version: string | null; error: string | null }> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'striart-detect-'));
  try {
    const result = await execa(executable, [...versionArgs], {
      cwd: sandbox,
      shell: false,
      reject: false,
      stdin: 'ignore',
      all: true,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: VERSION_PROBE_MAX_BUFFER,
      // Un outil qui s'auto-met-à-jour ou ouvre un navigateur au premier
      // lancement ne doit pas le faire pendant une simple détection.
      env: { ...env, CI: '1', NO_COLOR: '1', STRIART_DETECT: '1' },
      windowsHide: true,
    });
    const version = parseVersion(result.all ?? '');
    if (version) return { version, error: null };
    return {
      version: null,
      error: result.timedOut
        ? `timeout ${VERSION_PROBE_TIMEOUT_MS} ms`
        : (result.shortMessage ?? 'version illisible'),
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      logger.warn({ err: error, sandbox }, 'Détection : dossier temporaire non supprimé');
    });
  }
}

/** Détecte un outil : PATH puis version. */
export async function detectTarget(
  target: DetectionTarget,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    probe?: typeof probeVersion;
  } = {},
): Promise<DetectionResult> {
  const probe = options.probe ?? probeVersion;
  const minVersion = target.minVersion ?? null;
  for (const binary of target.binaries) {
    const resolved = await findOnPath(binary, options);
    if (!resolved) continue;
    const { version, error } = await probe(resolved, target.versionArgs ?? ['--version'], {
      env: options.env,
    });
    let status: DetectionStatus = version ? 'found' : 'unknown-version';
    if (version && minVersion && compareVersions(version, minVersion) < 0) status = 'outdated';
    return {
      id: target.id,
      status,
      binary,
      path: resolved,
      version,
      minVersion,
      probeError: error,
    };
  }
  return {
    id: target.id,
    status: 'missing',
    binary: null,
    path: null,
    version: null,
    minVersion,
    probeError: null,
  };
}

/** Détecte une liste d'outils, en parallèle borné (les sondes lancent des process). */
export async function detectTargets(
  targets: readonly DetectionTarget[],
  options: Parameters<typeof detectTarget>[1] & { concurrency?: number } = {},
): Promise<DetectionResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: DetectionResult[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next;
      next += 1;
      results[index] = await detectTarget(targets[index], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results;
}
