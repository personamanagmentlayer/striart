/**
 * Serveur de test du dashboard pour la suite de bout en bout (Playwright).
 *
 * Lancé comme PROCESS séparé (`node tests/e2e/support/serve.ts <scénario JSON>`)
 * pour que la mesure de la page ne soit pas faussée par le serveur et que le
 * vrai chemin de production soit exercé : nom d'hôte d'instance
 * `<id>.localhost`, jeton, lien à usage unique, CSP, SSE.
 *
 * Protocole : une ligne JSON par message. Sur stdout : `{event:'ready',…}` puis
 * les réponses `{id, ok, result|error}`. Sur stdin : `{id, cmd, …}`.
 */
import { createInterface } from 'node:readline';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backdateDir, createTempRepo } from '../../helpers/temp-repo.js';
import { outputBeatPath } from '../../../src/idle/paths.ts';
import { recordMark } from '../../../src/idle/state.ts';
import { initStriart } from '../../../src/init.ts';
import { createAgent, readRegistry } from '../../../src/clone.ts';
import { writeJsonAtomic } from '../../../src/json-file.ts';
import { createConflictTicket } from '../../../src/conflicts.ts';
import { enqueueTask, readQueue, removeTask } from '../../../src/queue.ts';
import { startDashboard } from '../../../src/dashboard.ts';
import { createElicitationRequest, createPermissionRequest } from '../../../src/permissions.ts';
import { startMainSession } from '../../../src/main-session.ts';

interface Scenario {
  /** Nombre d'agents (clones réels). */
  agents?: number;
  tickets?: number;
  queue?: number;
  /** Textes très longs (noms, chemins, messages). */
  long?: boolean;
  permissions?: number;
  elicitation?: boolean;
  mainSession?: boolean;
  /** Déclare un profil d'agent (formulaire du mode autonome). */
  profiles?: boolean;
  /** Jeu de démonstration : un agent avec un commit en attente, une session autonome vivante, des états variés. */
  demo?: boolean;
  /** Nombre d'agents dont le clone a disparu (statut MISSING). */
  missing?: number;
  /** Agents inactifs (GC d'inactivité) : agent-00 dormant, agent-01 session vivante avertie. */
  idle?: boolean;
  /** Port fixe du dashboard (défaut : aléatoire). */
  port?: number;
}

const scenario: Scenario = JSON.parse(process.argv[2] ?? '{}');
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const repo = await createTempRepo();
await initStriart(repo.root);
await writeFile(
  path.join(repo.root, '.striartrc.json'),
  JSON.stringify({
    testCommand: 'node -e "process.exit(0)"',
    // Router injoignable et immédiat : task.run échoue vite, l'état d'erreur est testable.
    llm: { provider: 'ollama', model: 'e2e', baseUrl: 'http://127.0.0.1:9' },
    // Seuils minimaux autorisés : le scénario `idle` antidate tout de quelques heures.
    ...(scenario.idle
      ? { idle: { action: 'warn', warnAfterMs: 60_000, closeAfterMs: 120_000, graceMs: 600_000 } }
      : {}),
    ...(scenario.profiles
      ? { agentProfiles: { 'e2e-profile': { command: 'node', args: ['-e', '{{prompt}}'] } } }
      : {}),
  }),
);

const LONG = 'très-long-segment-de-chemin-'.repeat(6);
// Clones Git réels pour les premiers agents (lents sous Windows) ; au-delà, des
// entrées de registre qui réutilisent le premier clone : la page ne voit que le
// registre, et 50 vrais clones ne diraient rien de plus sur le client.
const REAL_CLONES = scenario.demo ? (scenario.agents ?? 0) : 1;
for (let i = 0; i < Math.min(scenario.agents ?? 0, REAL_CLONES); i += 1) {
  const name =
    scenario.long && i === 0 ? `agent-${'x'.repeat(50)}` : `agent-${String(i).padStart(2, '0')}`;
  await createAgent({
    root: repo.root,
    name,
    command: 'claude',
    prompt: scenario.long ? `Prompt ${LONG}` : `Tâche ${i}`,
    predictedFiles: [`src/mod-${i % 7}.ts`, 'src/shared.ts'],
  });
}
if ((scenario.agents ?? 0) > REAL_CLONES) {
  const registry = await readRegistry(repo.root);
  const template = registry['agent-00'];
  for (let i = REAL_CLONES; i < (scenario.agents ?? 0); i += 1) {
    const name = `agent-${String(i).padStart(2, '0')}`;
    registry[name] = {
      ...template,
      name,
      branch: `striart/${name}/task-${i}`,
      lastMessage: `feat: tâche ${i}`,
    };
  }
  await writeJsonAtomic(path.join(repo.root, '.striart', 'agents.json'), registry);
}
if (scenario.demo || scenario.missing) {
  const registry = await readRegistry(repo.root);
  const names = Object.keys(registry);
  if (scenario.demo) {
    // agent-00 : un commit en attente de merge ; agent-01 : session autonome vivante.
    const clone = registry['agent-00'];
    if (clone) {
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-C',
            clone.path,
            '-c',
            'user.name=e2e',
            '-c',
            'user.email=e2e@example.invalid',
            ...args,
          ],
          { stdio: 'ignore' },
        );
      await writeFile(path.join(clone.path, 'src-demo.txt'), 'demo\n');
      git('add', '-A');
      git('commit', '-m', 'feat: ajoute le panier persistant');
    }
    if (registry['agent-01']) {
      registry['agent-01'].mode = 'autonomous';
      registry['agent-01'].profile = 'claude-code';
      registry['agent-01'].sessionPid = process.pid;
      registry['agent-01'].command = 'claude';
    }
  }
  for (let i = 0; i < (scenario.missing ?? 0); i += 1) {
    const victim = names[names.length - 1 - i];
    if (victim && registry[victim])
      registry[victim].path = path.join(repo.root, '.striart', 'agents', 'disparu-' + victim);
  }
  await writeJsonAtomic(path.join(repo.root, '.striart', 'agents.json'), registry);
}
if (scenario.idle) {
  const registry = await readRegistry(repo.root);
  const old = new Date(Date.now() - 3 * 3_600_000);
  const dormant = registry['agent-00'];
  if (dormant) {
    // Les deux agents partagent le même clone : toutes ses traces d'activité sont antidatées.
    await backdateDir(dormant.path, 3 * 3_600_000);
  }
  for (const name of ['agent-00', 'agent-01']) {
    if (registry[name]) registry[name].createdAt = old.toISOString();
  }
  if (registry['agent-01']) {
    Object.assign(registry['agent-01'], {
      mode: 'autonomous',
      profile: 'claude-code',
      sessionPid: process.pid,
      sessionStartedAt: old.toISOString(),
    });
  }
  await writeJsonAtomic(path.join(repo.root, '.striart', 'agents.json'), registry);
  // Sortie de la session vivante : un battement ancien, puis l'avertissement déjà émis.
  const beat = outputBeatPath(repo.root, 'agent-01');
  await mkdir(path.dirname(beat), { recursive: true });
  await writeFile(beat, '');
  await utimes(beat, old, old);
  await recordMark(repo.root, 'agent-01', 'warnedAt', { at: Date.now(), lastActivityAt: null });
}
for (let i = 0; i < (scenario.queue ?? 0); i += 1) {
  await enqueueTask(repo.root, {
    agent: `queued-${i}`,
    prompt: `tâche en attente ${i}`,
    predictedFiles: ['src/shared.ts', scenario.long ? `${LONG}/${LONG}.ts` : `src/q${i}.ts`],
    collisions: [{ agent: 'agent-00', files: ['src/shared.ts'] }],
  });
}
for (let i = 0; i < (scenario.tickets ?? 0); i += 1) {
  await createConflictTicket(repo.root, {
    agent: 'agent-00',
    branch: `striart/agent-00/task-${i}`,
    sha: String(i).padStart(2, '0').repeat(20),
    reason: i % 2 === 0 ? 'GATE_FAILED' : 'SEMANTIC_MERGE_FAILED',
    log: 'FAIL: 3 tests rouges\n<script>window.__pwned = 1</script>',
    conflictedFiles: ['src/db.ts', scenario.long ? `${LONG}.ts` : 'src/shared.ts'],
    resolutions: [
      {
        path: 'src/db.ts',
        base: 'const v = 0;\n',
        ours: 'const v = 1;\n',
        theirs: 'const v = 2;\n',
        llmAttempt: 'const v = 3;\n',
      },
    ],
  });
}
for (let i = 0; i < (scenario.permissions ?? 0); i += 1) {
  await createPermissionRequest(repo.root, {
    agent: 'agent-00',
    taskId: `t${i}`,
    title: scenario.long ? `Lancer ${LONG} ${LONG}` : `Lancer npm test (${i})`,
    options: [
      { optionId: 'ok', name: 'Autoriser', kind: 'allow_once' },
      { optionId: 'no', name: 'Refuser', kind: 'reject_once' },
    ],
    timeoutMs: 600_000,
  });
}
if (scenario.elicitation) {
  await createElicitationRequest(repo.root, {
    agent: 'agent-00',
    taskId: 'te',
    mode: 'form',
    message: '<img src=x onerror=alert(1)> Quel environnement ?',
    requestedSchema: {
      type: 'object',
      properties: {
        env: { type: 'string', title: 'Environnement', enum: ['staging', 'prod'] },
        replicas: { type: 'integer', title: 'Réplicas', minimum: 1, maximum: 5 },
      },
      required: ['env'],
    },
    timeoutMs: 600_000,
  });
}
if (scenario.mainSession) {
  await startMainSession(repo.root, { pid: process.pid, reason: 'édition manuelle e2e' });
}

const server = await startDashboard({ root: repo.root, port: scenario.port ?? 0 });
const { port } = server.address() as { port: number };

const handlers: Record<string, (msg: any) => Promise<unknown> | unknown> = {
  link: () => server.striart.signInUrl(),
  linkWithTtl: (m) => server.striart.signInUrl({ ttlMs: m.ttlMs }),
  stats: () => server.striart.stats(),
  root: () => repo.root,
  permission: (m) =>
    createPermissionRequest(repo.root, {
      agent: m.agent ?? 'agent-live',
      taskId: `t-${Date.now()}`,
      title: m.title ?? 'Écrire dans .env',
      options: [
        { optionId: 'ok', name: 'Autoriser', kind: 'allow_once' },
        { optionId: 'no', name: 'Refuser', kind: 'reject_once' },
      ],
      timeoutMs: 600_000,
    }),
  mainSession: () =>
    startMainSession(repo.root, { pid: process.pid, reason: 'édition manuelle e2e' }),
  ticket: (m) =>
    createConflictTicket(repo.root, {
      agent: 'agent-00',
      branch: `striart/agent-00/task-live-${m.n}`,
      sha: 'b'.repeat(40),
      reason: 'GATE_FAILED',
      log: 'FAIL',
      conflictedFiles: ['src/live.ts'],
      resolutions: [],
    }),
  enqueue: (m) =>
    enqueueTask(repo.root, {
      agent: `live-${m.n}`,
      prompt: 'live',
      predictedFiles: ['src/live.ts'],
      collisions: [],
    }),
  /** Fait varier la file (au plus 10 tâches) : le DOM rendu change réellement. */
  churn: async (m) => {
    const task = await enqueueTask(repo.root, {
      agent: `churn-${m.n}`,
      prompt: 'churn',
      predictedFiles: [`src/churn-${m.n}.ts`],
      collisions: [{ agent: 'agent-00', files: [`src/churn-${m.n}.ts`] }],
    });
    const queue = await readQueue(repo.root);
    const waiting = queue.filter((t: { status: string }) => t.status === 'WAITING');
    for (const old of waiting.slice(0, Math.max(0, waiting.length - 10))) {
      await removeTask(repo.root, old.id);
    }
    return task.id;
  },
  /** Bruit d'état : n écritures d'un fichier d'état (déclenche des state.changed). */
  touch: async (m) => {
    const dir = path.join(repo.root, '.striart');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < m.n; i += 1) {
      await writeFile(path.join(dir, 'noise.json'), JSON.stringify({ i, t: Date.now() }));
    }
    return m.n;
  },
};

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  await repo.cleanup();
  process.exit(0);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    let msg: any;
    try {
      msg = JSON.parse(line);
      if (msg.cmd === 'close') {
        out({ id: msg.id, ok: true });
        await shutdown();
        return;
      }
      const handler = handlers[msg.cmd];
      if (!handler) throw new Error(`commande inconnue : ${msg.cmd}`);
      out({ id: msg.id, ok: true, result: await handler(msg) });
    } catch (error) {
      out({ id: msg?.id, ok: false, error: String((error as Error).message ?? error) });
    }
  })();
});
process.stdin.on('end', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

out({ event: 'ready', port, baseUrl: server.striart.baseUrl, root: repo.root });
