import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../json-file.js';
import { striartDir } from '../paths.js';
import { normalizeFilePath } from '../router.js';
import { inferCloneContext } from '../terminal/clone-context.ts';
import type { AgentMeta, AgentRegistry } from '../types.js';

/**
 * Avis d'un hook : à quel agent appartient la session, et quels fichiers
 * qu'elle écrit sont prédits (Router) ou verrouillés (locks.json) par un
 * AUTRE agent. Lecture seule : un hook ne mute jamais l'état de Striart (il
 * tourne hors du verrou principal, en parallèle de tout).
 */

export interface HookAgentContext {
  root: string;
  agent: string;
  clonePath: string;
  meta: AgentMeta;
  registry: AgentRegistry;
}

export interface FileCollision {
  file: string;
  agents: string[];
}

const caseInsensitive = (platform: NodeJS.Platform) =>
  platform === 'win32' || platform === 'darwin';

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const x = p.resolve(a);
  const y = p.resolve(b);
  return caseInsensitive(platform) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // Chemin absent ou illisible : comparé tel quel (le registre fera foi).
    return target;
  }
}

/**
 * Agent propriétaire du répertoire `cwd`, CONFIRMÉ par le registre : la
 * forme du chemin (`.striart/agents/<agent>`) ne suffit pas, l'entrée du
 * registre doit désigner ce même clone. `trustedRoot` (installation dans le
 * clone) impose en plus la racine attendue.
 */
export async function resolveHookAgent(
  cwd: string,
  {
    trustedRoot = null,
    platform = process.platform,
  }: { trustedRoot?: string | null; platform?: NodeJS.Platform } = {},
): Promise<HookAgentContext | null> {
  const context = inferCloneContext(await canonical(cwd), { platform });
  if (!context) return null;
  if (trustedRoot && !samePath(await canonical(trustedRoot), context.root, platform)) return null;
  const registry = (await readJson(path.join(striartDir(context.root), 'agents.json'), {
    fallback: {},
    code: 'REGISTRY_CORRUPT',
  })) as AgentRegistry;
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) return null;
  const meta = Object.hasOwn(registry, context.agent) ? registry[context.agent] : null;
  if (!meta || typeof meta.path !== 'string') return null;
  if (!samePath(await canonical(meta.path), context.clonePath, platform)) return null;
  return { ...context, meta, registry };
}

/**
 * Chemin relatif au clone (séparateurs `/`), ou null s'il sort du clone ou
 * désigne le clone lui-même. `file` absolu, ou relatif à `baseDir`.
 */
export function toCloneRelative(
  file: string,
  baseDir: string,
  clonePath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const absolute = p.resolve(baseDir, file);
  let rel = p.relative(clonePath, absolute);
  if (caseInsensitive(platform) && rel.startsWith('..')) {
    // Casse différente (lecteur `c:` contre `C:`) : nouvelle tentative sans casse.
    const lowered = p.relative(clonePath.toLowerCase(), absolute.toLowerCase());
    if (!lowered.startsWith('..') && !p.isAbsolute(lowered)) {
      rel = absolute.slice(absolute.length - lowered.length);
    }
  }
  if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel)) return null;
  return normalizeFilePath(rel.split(p.sep).join('/'));
}

/**
 * Fichiers de `files` (relatifs au clone) prédits par un autre agent du
 * registre ou verrouillés par un autre agent dans locks.json.
 */
export async function findCollisions(
  context: HookAgentContext,
  files: string[],
  platform: NodeJS.Platform = process.platform,
): Promise<FileCollision[]> {
  if (files.length === 0) return [];
  const key = (f: string) => {
    const n = normalizeFilePath(f);
    return caseInsensitive(platform) ? n.toLowerCase() : n;
  };
  const owners = new Map<string, Set<string>>();
  const claim = (file: unknown, agent: string) => {
    if (typeof file !== 'string' || agent === context.agent) return;
    const k = key(file);
    if (!owners.has(k)) owners.set(k, new Set());
    owners.get(k)!.add(agent);
  };
  for (const [name, meta] of Object.entries(context.registry)) {
    for (const file of Array.isArray(meta?.predictedFiles) ? meta.predictedFiles : [])
      claim(file, name);
  }
  const locks = await readJson(path.join(striartDir(context.root), 'locks.json'), {
    fallback: {},
    code: 'LOCKS_CORRUPT',
  });
  if (typeof locks === 'object' && locks !== null && !Array.isArray(locks)) {
    for (const [file, owner] of Object.entries(locks as Record<string, unknown>)) {
      if (typeof owner === 'string') claim(file, owner);
    }
  }
  const collisions: FileCollision[] = [];
  for (const file of files) {
    const agents = owners.get(key(file));
    if (agents && agents.size > 0) collisions.push({ file, agents: [...agents].sort() });
  }
  return collisions;
}
