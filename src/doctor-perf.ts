/**
 * Mesures de PERFORMANCE de `striart doctor` (L8) : lecture seule du point de vue de l'utilisateur,
 * chacune BORNÉE dans le temps (un diagnostic qui gèle sur la machine qu'il diagnostique est pire
 * que pas de diagnostic).
 *
 * Budgets documentés (docs : « Performance et fiabilité sous charge continue ») :
 *  - verrou d'état : une écriture atomique sous verrou < 100 ms au repos ; au-delà d'une seconde
 *    c'est une ALERTE (les opérations mutantes s'empilent derrière) ;
 *  - `git status` du dépôt principal : > 2 s est signalé (il tourne à chaque `status`, chaque
 *    rafraîchissement du dashboard, chaque garde de merge).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { writeJsonAtomic } from './json-file.ts';
import { withStateLock } from './state-lock.ts';

export const STATE_LOCK_BUDGET_MS = 100;
export const STATE_LOCK_ALERT_MS = 1000;
export const GIT_STATUS_WARN_MS = 2000;

/** Nombre d'échantillons de la sonde du verrou d'état, et son délai total. */
const DEFAULT_SAMPLES = 5;
const DEFAULT_PROBE_DEADLINE_MS = 3000;
const PROBE_FILE = 'doctor-perf-probe.json';

const elapsed = (since: number): number => performance.now() - since;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type LatencyLevel = 'ok' | 'slow' | 'alert';

/**
 * Niveau d'une latence mesurée. La médiane dit l'état habituel ; le PIRE échantillon dit ce que
 * subit l'opération la moins chanceuse — c'est lui qui gèle une file : un seul échantillon
 * au-delà d'une seconde suffit pour l'alerte.
 */
export function latencyLevel({
  medianMs,
  maxMs,
}: {
  medianMs: number;
  maxMs: number;
}): LatencyLevel {
  if (maxMs > STATE_LOCK_ALERT_MS || medianMs > STATE_LOCK_ALERT_MS) return 'alert';
  if (medianMs > STATE_LOCK_BUDGET_MS) return 'slow';
  return 'ok';
}

export interface StateLockLatency {
  /** Durée de chaque échantillon réussi (acquisition du verrou + écriture atomique + libération). */
  samples: number[];
  medianMs: number;
  maxMs: number;
  /** Le délai global est écoulé avant la fin des échantillons (verrou tenu par un autre, disque lent). */
  timedOut: boolean;
}

/**
 * Latence RÉELLE du verrou d'état : N fois, prendre `state.lock`, écrire atomiquement un fichier
 * de sonde, relâcher. Le fichier de sonde (et ses temporaires) est retiré à la fin ; aucun fichier
 * d'état réel n'est touché. Borné : un échantillon qui n'obtient pas le verrou avant l'échéance
 * globale interrompt la mesure (`timedOut`) plutôt que d'attendre le délai d'acquisition (10 s).
 */
export async function measureStateLockLatency(
  stateDir: string,
  {
    samples = DEFAULT_SAMPLES,
    deadlineMs = DEFAULT_PROBE_DEADLINE_MS,
  }: { samples?: number; deadlineMs?: number } = {},
): Promise<StateLockLatency> {
  const probe = path.join(stateDir, PROBE_FILE);
  const startedAt = performance.now();
  const durations: number[] = [];
  let timedOut = false;
  try {
    for (let i = 0; i < samples; i += 1) {
      const remaining = deadlineMs - elapsed(startedAt);
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const sampleStarted = performance.now();
      // `withStateLock` borne l'attente INTER-process (timeoutMs) mais pas celle de la file locale
      // du process : la course contre l'échéance garantit la borne dans tous les cas. Un échantillon
      // abandonné n'écrira rien s'il obtient le verrou plus tard (`abandoned`).
      let abandoned = false;
      const attempt = withStateLock(
        stateDir,
        async () => {
          if (!abandoned) await writeJsonAtomic(probe, { probe: i, at: new Date().toISOString() });
        },
        { timeoutMs: Math.max(50, Math.ceil(remaining)) },
      );
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), Math.ceil(remaining));
      });
      try {
        const outcome = await Promise.race([attempt.then(() => 'done' as const), late]);
        if (outcome === 'late') {
          abandoned = true;
          attempt.catch(() => {
            // Échantillon abandonné : son échec tardif n'intéresse plus personne.
          });
          timedOut = true;
          break;
        }
      } catch (error) {
        // Verrou non obtenu dans le temps restant : la mesure s'arrête, elle n'échoue pas.
        if ((error as { code?: string }).code === 'STATE_LOCK_TIMEOUT') {
          timedOut = true;
          break;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      durations.push(Math.round(elapsed(sampleStarted) * 100) / 100);
    }
  } finally {
    await rm(probe, { force: true }).catch(() => {
      // Sonde déjà absente ou verrouillée par un antivirus : sans conséquence, jamais lue.
    });
  }
  return {
    samples: durations,
    medianMs: median(durations),
    maxMs: durations.length > 0 ? Math.max(...durations) : 0,
    timedOut,
  };
}

/** Durée d'un `git status --porcelain` du dépôt principal, bornée (`timeoutMs`). */
export async function measureGitStatus(
  root: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<{ ms: number; timedOut: boolean; failed: boolean }> {
  const started = performance.now();
  try {
    const git = simpleGit(root, { timeout: { block: timeoutMs } });
    await git.raw(['status', '--porcelain', '--untracked-files=no']);
    return { ms: Math.round(elapsed(started)), timedOut: false, failed: false };
  } catch (error) {
    const timedOut = /block timeout|timed? ?out/i.test((error as Error)?.message ?? '');
    return { ms: Math.round(elapsed(started)), timedOut, failed: !timedOut };
  }
}

/**
 * Taille ADDITIONNELLE d'un dossier (les fichiers hardlinkés — objets git des clones — comptent 0,
 * comme `dirStats`), parcours BORNÉ par `deadlineMs` : au-delà, `complete: false` et la taille
 * partielle. Les liens symboliques ne sont pas suivis.
 */
export async function boundedDirSize(
  dir: string,
  { deadlineMs = 4000 }: { deadlineMs?: number } = {},
): Promise<{ sizeBytes: number; complete: boolean }> {
  const startedAt = performance.now();
  let sizeBytes = 0;
  let complete = true;
  const walk = async (current: string): Promise<void> => {
    if (elapsed(startedAt) >= deadlineMs) {
      complete = false;
      return;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (elapsed(startedAt) >= deadlineMs) {
        complete = false;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        if (!complete) return;
      } else if (entry.isFile()) {
        const stats = await stat(full).catch(() => null);
        if (stats && stats.nlink <= 1) sizeBytes += stats.size;
      }
    }
  };
  await walk(dir);
  return { sizeBytes, complete };
}
