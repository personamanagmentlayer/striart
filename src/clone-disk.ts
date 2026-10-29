/**
 * Parcours disque d'un clone agent — deux mesures de STATUTS DIFFÉRENTS :
 *
 *  - `cloneWorkActivityMs` est un SIGNAL DE SÉCURITÉ (`sessionActive`, gardes
 *    de `cleanClones` et de `reuseAgent`) : exact, jamais mis en cache, FAIL
 *    CLOSED. Il ne parcourt PAS `.git` (Striart y écrit en continu : fetch,
 *    status ; et c'est de loin le plus gros arbre du clone) mais, dans le
 *    worktree, chaque entrée est lue — un mtime de dossier ne suffit pas, une
 *    écriture en place ne le change pas ;
 *  - `cloneDiskSize` est de l'AFFICHAGE (taille additionnelle sur disque) ;
 *    son cache vit dans `clone-size-cache.ts`.
 *
 * Aucun des deux ne suit un lien symbolique (ni une jonction Windows) : le
 * parcours ne sort jamais du clone. Le système de fichiers est injectable
 * (tests hermétiques, y compris les erreurs impossibles à provoquer sous
 * Windows comme EACCES).
 */
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

export interface DiskEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface DiskStats {
  mtimeMs: number;
  size: number;
  nlink: number;
}

export interface DiskFs {
  readdir(dir: string): Promise<DiskEntry[]>;
  lstat(p: string): Promise<DiskStats>;
}

const realFs: DiskFs = {
  readdir: (dir) => nodeFs.readdir(dir, { withFileTypes: true }),
  lstat: (p) => nodeFs.lstat(p),
};

/** Opérations disque simultanées, tous parcours confondus (le pool libuv n'en fait que 4 de front). */
const MAX_IN_FLIGHT = 48;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function limited<T>(op: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
  try {
    return await op();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

const isGone = (error: unknown): boolean => (error as { code?: string })?.code === 'ENOENT';

interface WalkOptions {
  fs: DiskFs;
  /** Noms de premier niveau ignorés (jamais lus, jamais descendus). */
  skipTop: ReadonlySet<string>;
  onEntry: (stats: DiskStats, entry: DiskEntry) => void;
}

/**
 * Parcours en profondeur sans suivre les liens. `ok` est faux dès qu'une entrée
 * existante n'a pu être lue (autre erreur que ENOENT) ; `missing` si la racine
 * elle-même n'existe pas. Une entrée disparue entre le listage et la lecture
 * (ENOENT) est ignorée : son départ a déjà mis à jour le mtime du parent.
 */
async function walk(
  root: string,
  { fs, skipTop, onEntry }: WalkOptions,
): Promise<{ ok: boolean; missing: boolean }> {
  let ok = true;

  async function visit(dir: string, top: boolean): Promise<void> {
    let entries: DiskEntry[];
    try {
      entries = await limited(() => fs.readdir(dir));
    } catch (error) {
      if (!isGone(error)) ok = false;
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) return;
        if (top && skipTop.has(entry.name)) return;
        const full = path.join(dir, entry.name);
        let stats: DiskStats;
        try {
          stats = await limited(() => fs.lstat(full));
        } catch (error) {
          if (!isGone(error)) ok = false;
          return;
        }
        onEntry(stats, entry);
        if (entry.isDirectory()) await visit(full, false);
      }),
    );
  }

  try {
    await limited(() => fs.readdir(root));
  } catch (error) {
    if (isGone(error)) return { ok: true, missing: true };
    return { ok: false, missing: false };
  }
  await visit(root, true);
  return { ok, missing: false };
}

export interface ActivityOptions {
  /** Noms de premier niveau qui ne signalent pas une session (`.git`, fichier de mémoire). */
  skipTop?: Iterable<string>;
  fs?: DiskFs;
  now?: () => number;
}

export interface WorkScan {
  /** Dernière activité du worktree (ms) — fail closed : « maintenant » si une partie est illisible. */
  workActivityMs: number;
  /** Octets additionnels des fichiers parcourus (nlink 1) : sous-produit gratuit du même parcours. */
  bytes: number;
  /** Faux si une partie du worktree n'a pas pu être lue (`bytes` est alors un minorant). */
  complete: boolean;
}

/**
 * Un SEUL parcours du worktree pour deux usages : l'activité (sécurité, exacte)
 * et les octets (affichage, réutilisés si le cache des tailles doit se
 * rafraîchir — le worktree n'est jamais parcouru deux fois).
 */
export async function cloneWorkScan(
  clonePath: string,
  { skipTop = [], fs = realFs, now = () => Date.now() }: ActivityOptions = {},
): Promise<WorkScan> {
  let latest = 0;
  let bytes = 0;
  const result = await walk(clonePath, {
    fs,
    skipTop: new Set(skipTop),
    onEntry: (stats, entry) => {
      if (stats.mtimeMs > latest) latest = stats.mtimeMs;
      if (entry.isFile() && stats.nlink <= 1) bytes += stats.size;
    },
  });
  return { workActivityMs: result.ok ? latest : now(), bytes, complete: result.ok };
}

/**
 * Dernière activité (mtime le plus récent, fichiers et dossiers) du worktree.
 * Rend 0 si le dossier n'existe pas. FAIL CLOSED : si une partie du clone n'a
 * pas pu être lue, on ne sait pas qu'il est inactif — on rend « maintenant ».
 */
export async function cloneWorkActivityMs(
  clonePath: string,
  options: ActivityOptions = {},
): Promise<number> {
  return (await cloneWorkScan(clonePath, options)).workActivityMs;
}

/**
 * Espace ADDITIONNEL d'un clone (worktree + .git) : les fichiers hardlinkés
 * (`nlink > 1`, objets git partagés avec le principal) comptent 0. `complete`
 * est faux si une partie n'a pas pu être lue : la taille est alors un minorant.
 */
export async function cloneDiskSize(
  clonePath: string,
  { fs = realFs }: { fs?: DiskFs } = {},
): Promise<{ sizeBytes: number; complete: boolean }> {
  let sizeBytes = 0;
  const result = await walk(clonePath, {
    fs,
    skipTop: new Set(),
    onEntry: (stats, entry) => {
      if (entry.isFile() && stats.nlink <= 1) sizeBytes += stats.size;
    },
  });
  return { sizeBytes, complete: result.ok };
}
