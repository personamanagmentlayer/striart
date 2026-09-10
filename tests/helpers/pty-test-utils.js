import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectAttachClient } from '../../src/pty-attach.ts';

/**
 * Écrit une entrée minimale dans `.striart/agents.json` — `ensurePtyHost`
 * refuse désormais un agent absent du registre (défense en profondeur,
 * SECURITY.md). Écrit le fichier directement plutôt que de passer par
 * `createAgent` (clonage git réel) : ces tests portent sur la couche pty,
 * pas sur le cycle de vie complet d'un agent — un registre minimal suffit
 * à exercer le vrai chemin de code.
 */
export async function seedAgentRegistry(root, agent, overrides = {}) {
  const dir = path.join(root, '.striart');
  await mkdir(dir, { recursive: true });
  const registry = {
    [agent]: {
      branch: `striart/${agent}/task-test`,
      taskId: 'test',
      path: overrides.path ?? root,
      baseCommit: '0000000000000000000000000000000000000000',
      prompt: null,
      predictedFiles: [],
      command: overrides.command ?? null,
      createdAt: new Date().toISOString(),
      mode: overrides.mode ?? 'attended',
    },
  };
  await writeFile(path.join(dir, 'agents.json'), JSON.stringify(registry), 'utf8');
}

/** Poll générique — attend qu'un prédicat synchrone devienne vrai. */
export async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor: délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Un process hôte détaché (pty-host-run) met un instant à réellement
 * écouter (spawn Node + import de node-pty) — contrairement à
 * `startOwnedSession` en direct, le canal d'attache n'existe pas encore à
 * l'instant où `ensurePtyHost()`/`routeAgentMessage()` résolvent (elles
 * attendent le spawn, pas l'écoute effective côté enfant). Retente la
 * connexion à intervalle raisonnable plutôt que de spammer un connect
 * toutes les 20ms.
 */
export async function connectWithRetry(root, agent, options, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise((resolve) => {
      const conn = connectAttachClient(root, agent, {
        ...options,
        onConnect: () => {
          options.onConnect?.();
          resolve(conn);
        },
        onError: () => resolve(null),
      });
    });
    if (connected) return connected;
    if (Date.now() >= deadline) throw new Error('connectWithRetry: délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const REAL_PTY_LOCK_PATH = path.join(os.tmpdir(), 'striart-real-pty-tests.lock');
// Marge large : sous charge (plusieurs fichiers en file d'attente), un test
// individuel réel reste de l'ordre de quelques secondes une fois le verrou
// obtenu — jamais 45 s à lui seul, cf. STALE_MS ci-dessous.
const REAL_PTY_LOCK_STALE_MS = 45_000;

/**
 * Sérialise les spawns RÉELS de pty (ConPTY/powershell, éventuellement un
 * hôte détaché node.exe en plus via `ensurePtyHost`) entre `pty-attach.test.js`,
 * `pty-host.test.js` et le bloc `routeAgentMessage` de `watch-ui.test.js` —
 * vitest lance chaque fichier de test dans son propre process forké, donc
 * ces trois fichiers spawnent chacun plusieurs vrais shells SANS coordination
 * entre eux dès qu'ils tournent en parallèle. Constaté en pratique : la suite
 * `unit` complète OOM le worker (chaque pty réel = powershell.exe + 2
 * conhost.exe, parfois un node.exe hôte détaché de plus, empilés).
 *
 * Un verrou fichier partagé (même idiome que `src/lock.js` : `wx` +
 * détection stale par mtime) borne à UNE seule session réelle à la fois,
 * tous fichiers/process confondus — sans toucher au reste de la suite
 * unitaire (mockée, jamais concernée, donc jamais ralentie). Volontairement
 * ici plutôt que dans `vitest.config.js` : un `maxForks` global ralentirait
 * les ~240 autres tests mockés pour un problème qui ne concerne que ce trio.
 */
export async function withRealPtySlot(fn) {
  await acquireRealPtyLock();
  try {
    return await fn();
  } finally {
    await rm(REAL_PTY_LOCK_PATH, { force: true }).catch(() => {});
  }
}

async function acquireRealPtyLock(deadline = Date.now() + 120_000) {
  for (;;) {
    try {
      const fd = await open(REAL_PTY_LOCK_PATH, 'wx');
      await fd.close();
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await isRealPtyLockStale()) {
        await rm(REAL_PTY_LOCK_PATH, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('withRealPtySlot: verrou non obtenu à temps', { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function isRealPtyLockStale() {
  try {
    const info = await stat(REAL_PTY_LOCK_PATH);
    return Date.now() - info.mtimeMs > REAL_PTY_LOCK_STALE_MS;
  } catch {
    return true; // disparu entre-temps (libéré par son détenteur) : plus rien à considérer périmé
  }
}
