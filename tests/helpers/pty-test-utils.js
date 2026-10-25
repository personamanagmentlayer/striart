import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectAttachClient } from '../../src/pty-attach.ts';
import { defaultShell } from '../../src/pty-host.ts';

/**
 * Fin de ligne d'un écho dans un pty : le line discipline (ONLCR) convertit LF
 * en CRLF sur TOUS les systèmes, pas seulement Windows.
 */
export const ECHO_EOL = '\r\n';

/**
 * Shell des tests pty qui NE testent PAS le profil du shell : même programme
 * que le produit, mais PowerShell lancé sans profil (`-NoProfile -NoLogo`).
 * Windows PowerShell 5.1 charge sinon les profils utilisateur (en échec sur
 * une politique d'exécution restrictive) puis ses modules : mesuré 8,5-12,7 s
 * contre 3-3,8 s sous charge pour `powershell -Command exit` — le démarrage
 * interactif dépassait le délai des tests. cmd/bash/sh : rien à ajouter.
 * À passer via `{ shell, args }` à ensurePtyHost/startOwnedSession ; les
 * assertions des tests ne changent pas.
 */
export function quietShell(shell = defaultShell()) {
  const name = path.win32
    .basename(shell.replace(/\//g, '\\'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  const isPowerShell = name === 'powershell' || name === 'pwsh';
  return { shell, args: isPowerShell ? ['-NoProfile', '-NoLogo'] : [] };
}

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

/**
 * Délai des attentes sur un VRAI pty : ces tests vérifient qu'un événement
 * ARRIVE (écho, diffusion d'un resize), pas sa vitesse. Isolé, PowerShell
 * sous ConPTY répond en 1 à 2 s ; sous la charge de la suite d'intégration
 * complète (Windows, antivirus), son démarrage a dépassé les 8 s du délai
 * par défaut — échecs intermittents. 30 s reste très en dessous du budget
 * de 90 s par test (vitest.config.js).
 */
export const REAL_PTY_WAIT_MS = 30_000;

/** Poll générique — attend qu'un prédicat synchrone devienne vrai. */
export async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor: délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Retente la connexion à intervalle raisonnable plutôt que de spammer un
 * connect toutes les 20 ms. Depuis l'hôte natif (lot R2), `ensurePtyHost()`
 * résout une fois le canal ouvert (PID file publié par l'hôte) ; le retry
 * reste la défense contre une instance de named pipe pas encore recréée
 * entre deux clients.
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
 * Sérialise les spawns RÉELS de pty (ConPTY/powershell et leur hôte
 * striart-native) entre `pty-attach.test.js`,
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

/**
 * Écrit dans le dépôt de test la config `pty.shellArgs` « sans profil » :
 * pour les chemins du produit qui choisissent eux-mêmes le shell (hôte lancé
 * par `routeAgentMessage`), la config est le seul levier — et c'est
 * précisément la fonctionnalité `pty.shellArgs` qui est ainsi exercée.
 */
export async function writeQuietPtyConfig(root) {
  await writeFile(
    path.join(root, '.striartrc.json'),
    JSON.stringify({ pty: { shellArgs: quietShell().args } }),
    'utf8',
  );
}
