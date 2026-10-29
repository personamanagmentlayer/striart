import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import {
  closeConflictTicket,
  createConflictTicket,
  listConflictTickets,
} from '../../src/conflicts.ts';
import { enqueueTask } from '../../src/queue.ts';
import { collectDashboardState, startDashboard } from '../../src/dashboard.ts';
import {
  awaitElicitationAnswer,
  awaitPermissionAnswer,
  createElicitationRequest,
  createPermissionRequest,
  listPendingElicitations,
  listPendingPermissions,
} from '../../src/permissions.ts';
import { SCHEMA_ROOT, methodSpec, resultSchema } from '../../src/control/schema.ts';
import { createValidator } from '../../src/control/validate.ts';
import {
  baseUrl,
  call,
  rawRequest,
  rpc,
  signIn,
  sseReader,
  useLoopbackDashboard,
} from '../helpers/control-client.js';

/** Document d'erreur du contrat (`error.data.error`) d'une réponse JSON-RPC. */
const errorOf = (response) => response.body.error?.data?.error;

describe('striart dashboard (intégration)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
    await createAgent({ root: repo.root, name: 'agent-a', command: 'claude' });
    await enqueueTask(repo.root, {
      agent: 'agent-b',
      prompt: 'tâche en attente',
      predictedFiles: ['src/db.ts'],
      collisions: [{ agent: 'agent-a', files: ['src/db.ts'] }],
    });
    await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task-x',
      sha: 'a'.repeat(40),
      reason: 'GATE_FAILED',
      log: 'FAIL: 3 tests rouges',
      conflictedFiles: ['src/db.ts'],
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
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo.cleanup();
  });

  it('collectDashboardState agrège agents, queue, tickets, état et config', async () => {
    const state = await collectDashboardState(repo.root);
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({ name: 'agent-a', command: 'claude', status: 'ACTIVE' });
    expect(state.tasks.some((t) => t.status === 'WAITING' && t.agent === 'agent-b')).toBe(true);
    expect(state.tickets).toHaveLength(1);
    // Le log du Test Gate n'est PAS dans l'état de liste (poids mort relu et
    // poussé à chaque changement) : ticket.get le sert à la demande.
    expect(state.tickets[0]).not.toHaveProperty('gateLog');
    expect(state.state).toMatchObject({ manualMode: false });
    expect(state.config.targetBranch).toBe('main');
    expect(Array.isArray(state.profiles)).toBe(true);
  });

  it('heatmap : croise verrous actifs, prédictions en file et historique des tickets', async () => {
    await createAgent({
      root: repo.root,
      name: 'agent-c',
      predictedFiles: ['src/db.ts', 'src/schema.ts'],
    });

    const state = await collectDashboardState(repo.root);
    const hot = state.heatmap.find((h) => h.file === 'src/db.ts');
    expect(hot).toMatchObject({ agents: ['agent-c'], queued: ['agent-b'], conflicts: 1, score: 4 });
    const cold = state.heatmap.find((h) => h.file === 'src/schema.ts');
    expect(cold).toMatchObject({ agents: ['agent-c'], conflicts: 0, score: 1 });
    expect(state.heatmap[0].file).toBe('src/db.ts');
  });

  it('resolve --close : le ticket résolu sort de la liste mais reste sur disque', async () => {
    const [ticket] = await listConflictTickets(repo.root);
    const closed = await closeConflictTicket(repo.root, ticket.id);
    expect(closed.resolved).toBe(true);
    expect(await listConflictTickets(repo.root)).toHaveLength(0);
    const all = await listConflictTickets(repo.root, { includeResolved: true });
    expect(all).toHaveLength(1);
    expect(all[0].resolved).toBe(true);
    const { readFile: rf } = await import('node:fs/promises');
    await expect(rf(`${ticket.dir}/RESOLVED`, 'utf8')).resolves.toMatch(/\d{4}-\d{2}-\d{2}T/);
    await expect(closeConflictTicket(repo.root, 'ticket-fantome')).rejects.toMatchObject({
      code: 'TICKET_UNKNOWN',
    });
  });

  it('sert la page et le protocole (state.get) sur la boucle locale, une fois connecté', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);

    const html = await (await fetch(`${baseUrl(server)}/`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Striart');
    expect(html).toContain('/rpc');

    const doc = await call(server, cookie, 'state.get');
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'state.get', ok: true, outcome: 'ok' });
    expect(doc.data.agents[0].name).toBe('agent-a');
    expect(doc.data.tickets[0].reason).toBe('GATE_FAILED');
    expect(doc.data.instanceId).toMatch(/^[0-9a-f-]{36}$/);

    const notFound = await fetch(`${baseUrl(server)}/inconnu`, { headers: { Cookie: cookie } });
    expect(notFound.status).toBe(404);
    // /rpc n'accepte que POST.
    expect((await fetch(`${baseUrl(server)}/rpc`, { headers: { Cookie: cookie } })).status).toBe(
      405,
    );
  });

  it.each([[-1], [70_000], [1.5], [Number.NaN]])(
    'port invalide (%s) → INVALID_ARGUMENT, avant toute mise en place',
    async (port) => {
      await expect(startDashboard({ root: repo.root, port })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        kind: 'usage',
      });
    },
  );

  it('port déjà occupé → PORT_IN_USE avec un port alternatif proposé', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    await expect(startDashboard({ root: repo.root, port })).rejects.toMatchObject({
      code: 'PORT_IN_USE',
      details: { port },
      hint: `striart dashboard --port ${port + 1}`,
    });
  });

  it('sans port explicite : celui de la config (dashboardPort)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      `${repo.root}/.striartrc.json`,
      JSON.stringify({
        testCommand: 'node -e "process.exit(0)"',
        dashboardPort: 0,
        dashboardHostname: 'localhost',
      }),
    );
    server = await startDashboard({ root: repo.root });
    expect(server.address().port).toBeGreaterThan(0);
  });

  it('ticket.get : vue 3-way complète (3 versions + tentative LLM + log), id validé', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const [ticket] = await listConflictTickets(repo.root);

    const { data: detail } = await call(server, cookie, 'ticket.get', { id: ticket.id });
    expect(detail.id).toBe(ticket.id);
    expect(detail.reason).toBe('GATE_FAILED');
    expect(detail.log).toContain('3 tests rouges');
    expect(detail.resolutions).toEqual([
      {
        path: 'src/db.ts',
        base: 'const v = 0;\n',
        ours: 'const v = 1;\n',
        theirs: 'const v = 2;\n',
        llmAttempt: 'const v = 3;\n',
      },
    ]);
    expect(detail.resolutionInputs).toEqual([{ path: 'src/db.ts', kind: 'missing' }]);

    expect(errorOf(await rpc(server, cookie, 'ticket.get', { id: 'fantome' }))).toMatchObject({
      code: 'TICKET_UNKNOWN',
    });
    // Id malveillant : refusé par le schéma, jamais résolu en chemin.
    const evil = await rpc(server, cookie, 'ticket.get', { id: '../../secret' });
    expect(evil.body.error.code).toBe(-32602);
    expect(errorOf(evil)).toMatchObject({ code: 'INVALID_ARGUMENT', kind: 'usage' });
  });

  it('actions : anti-CSRF, ticket.close effectif, erreurs métier dans l’enveloppe du contrat', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const [ticket] = await listConflictTickets(repo.root);

    const csrf = await rpc(
      server,
      cookie,
      'ticket.close',
      { id: ticket.id },
      { headers: { 'X-Striart': '' } },
    );
    expect(csrf.status).toBe(403);
    expect((await listConflictTickets(repo.root)).length).toBe(1);

    const ok = await call(server, cookie, 'ticket.close', { id: ticket.id });
    expect(ok).toMatchObject({
      ok: true,
      data: { action: 'close', ticket: { id: ticket.id, resolved: true } },
    });
    expect(await listConflictTickets(repo.root)).toHaveLength(0);

    // Erreur métier (rollback sans merge Striart en tête) : refus typé.
    const ko = await rpc(server, cookie, 'merge.rollback');
    expect(ko.status).toBe(200);
    expect(ko.body.error.code).toBe(-32001);
    expect(ko.body.error.data).toMatchObject({
      schemaVersion: 1,
      command: 'merge.rollback',
      ok: false,
      error: { code: 'NOT_A_STRIART_MERGE', kind: 'refusal' },
    });

    // Méthode inconnue → -32601.
    const unknown = await rpc(server, cookie, 'detruire.tout');
    expect(unknown.body.error.code).toBe(-32601);
    expect(errorOf(unknown).code).toBe('CONTROL_METHOD_UNKNOWN');
    // Abonnement par RPC : réservé au transport à flux (stdio).
    expect(errorOf(await rpc(server, cookie, 'state.subscribe')).code).toBe(
      'CONTROL_METHOD_UNAVAILABLE',
    );
  });

  it('JSON-RPC : lot ordonné, notification sans réponse, JSON illisible', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const post = (body) =>
      fetch(`${baseUrl(server)}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Striart': '1',
          Origin: baseUrl(server),
          Cookie: cookie,
        },
        body,
      });
    const batch = await post(
      JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'control.initialize', params: { protocolVersion: 1 } },
        { jsonrpc: '2.0', method: 'state.get' },
        { jsonrpc: '2.0', id: 'b', method: 'state.get' },
      ]),
    );
    const responses = await batch.json();
    expect(responses.map((r) => r.id)).toEqual(['a', 'b']);
    expect(responses[0].result.data).toMatchObject({
      protocolVersion: 1,
      schemaVersion: 1,
      transport: 'http',
    });

    const notification = await post(JSON.stringify({ jsonrpc: '2.0', method: 'state.get' }));
    expect(notification.status).toBe(204);

    const garbage = await (await post('{not json')).json();
    expect(garbage.error.code).toBe(-32700);
    expect(garbage.error.data.error.code).toBe('CONTROL_PARSE_ERROR');
  });

  it('task.run : lance une tâche via le Router (LLM mocké), prompt vide refusé par le schéma', async () => {
    const { vi } = await import('vitest');
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        // Seul le LLM (Ollama, port 11434) est simulé ; le dashboard passe par le vrai fetch.
        if (!String(url).includes(':11434')) return realFetch(url, options);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify({ files: ['src/db.ts'] }) }),
        };
      }),
    );
    try {
      server = await startDashboard({ root: repo.root, port: 0 });
      const { cookie } = await signIn(server);

      const empty = await rpc(server, cookie, 'task.run', { prompt: '  ' });
      expect(errorOf(empty)).toMatchObject({ code: 'EMPTY_PROMPT', kind: 'usage' });

      const ok = await call(server, cookie, 'task.run', {
        prompt: 'Ajoute un index sur la table users',
      });
      expect(ok.data.mode).toBe('attended');
      expect(ok.data.session).toBeNull();
      expect(ok.data.run.status).toBe('STARTED');
      expect(ok.data.run.predictedFiles).toEqual(['src/db.ts']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("l'état expose l'historique des merges", async () => {
    const state = await collectDashboardState(repo.root);
    expect(Array.isArray(state.history)).toBe(true);
  });

  it('semantic.unlock : réactive la fusion sémantique et remet le compteur à zéro', async () => {
    const { readState, recordSemanticFailure } = await import('../../src/state.ts');
    for (let i = 0; i < 3; i += 1) await recordSemanticFailure(repo.root);
    expect((await readState(repo.root)).manualMode).toBe(true);

    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    expect((await call(server, cookie, 'semantic.unlock')).data).toEqual({ action: 'unlock' });
    expect(await readState(repo.root)).toMatchObject({
      manualMode: false,
      semanticFailureStreak: 0,
    });
  });

  it('task.run autonome : profil inconnu refusé DANS la requête, rien lancé en tâche de fond', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const res = await rpc(server, cookie, 'task.run', {
      prompt: 'x',
      mode: 'autonomous',
      profile: 'profil-fantome',
    });
    expect(errorOf(res).code).toBe('PROFILE_UNKNOWN');
    expect((await collectDashboardState(repo.root)).agents).toHaveLength(1);
  });

  it('champ agent malformé : refusé, jamais d’escalade silencieuse vers la portée globale', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    for (const [method, agent] of [
      ['agent.sync', 0],
      ['agent.sync', ['agent-a']],
      ['clones.clean', 0],
      ['agent.merge', '../x'],
    ]) {
      const res = await rpc(server, cookie, method, { agent });
      expect(errorOf(res)?.code, `${method} ${JSON.stringify(agent)}`).toBe('INVALID_AGENT_NAME');
    }
    // Paramètre inconnu : refusé (objet fermé), jamais ignoré.
    expect(errorOf(await rpc(server, cookie, 'agent.sync', { agnet: 'agent-a' }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { param: 'params.agnet', keyword: 'additionalProperties' },
    });
  });

  it('task.run autonome : nom d’agent invalide refusé DANS la requête', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const res = await rpc(server, cookie, 'task.run', {
      prompt: 'x',
      mode: 'autonomous',
      agent: 'mon agent',
    });
    expect(errorOf(res).code).toBe('INVALID_AGENT_NAME');
    expect((await collectDashboardState(repo.root)).agents).toHaveLength(1);
  });

  it('agent.sync sans agent : rebase en lot, mêmes données que `striart sync --json`', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const doc = await call(server, cookie, 'agent.sync');
    expect(doc.data.results).toHaveLength(1);
    expect(doc.data.results[0]).toMatchObject({ agent: 'agent-a', status: 'UP_TO_DATE' });
  });

  it('doctor.run : diagnostic servi dans le document', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const { data: report } = await call(server, cookie, 'doctor.run');
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(3);
    expect(typeof report.healthy).toBe('boolean');
    expect(JSON.stringify(report.checks)).toMatch(/git/i);
  });

  it('Host non local refusé sur toutes les routes, lectures comprises (DNS rebinding)', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    for (const route of ['/', '/rpc', '/events', '/auth']) {
      const res = await rawRequest(port, route, { headers: { Host: 'evil.example' } });
      expect(res.status, `${route} doit refuser un Host tiers`).toBe(403);
    }
  });
});

describe('dashboard — mode autonome et logs de session (intégration)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo.cleanup();
  });

  it('distingue un agent autonome d’un agent supervisé, profil compris', async () => {
    await createAgent({ root: repo.root, name: 'humain', command: 'claude' });
    await createAgent({ root: repo.root, name: 'robot', mode: 'autonomous', profile: 'codex' });
    const state = await collectDashboardState(repo.root);
    const byName = Object.fromEntries(state.agents.map((a) => [a.name, a]));
    expect(byName.humain.mode).toBe('attended');
    expect(byName.robot.mode).toBe('autonomous');
    expect(byName.robot.profile).toBe('codex');
    // Hôte de session ACP : exposé pour les autonomes seulement.
    expect(byName.robot.acpHost).toMatchObject({ running: false, listening: false, pid: null });
    expect(byName.humain).not.toHaveProperty('acpHost');
  });

  it('un registre antérieur au mode (sans champ) est affiché comme supervisé', async () => {
    const { readRegistry } = await import('../../src/clone.ts');
    const { writeJsonAtomic } = await import('../../src/json-file.ts');
    const path = await import('node:path');
    await createAgent({ root: repo.root, name: 'ancien' });
    const registry = await readRegistry(repo.root);
    delete registry.ancien.mode;
    delete registry.ancien.profile;
    await writeJsonAtomic(path.join(repo.root, '.striart', 'agents.json'), registry);
    const state = await collectDashboardState(repo.root);
    expect(state.agents[0].mode).toBe('attended');
    expect(state.agents[0].profile).toBeNull();
  });

  it('expose l’état du watcher : rien ne le lance automatiquement', async () => {
    const state = await collectDashboardState(repo.root);
    expect(state.daemon.running).toBe(false);
    expect(state.daemon.stale).toBe(false);
    expect(state.daemon.logPath).toContain('watch.log');
  });

  it('session.log : sert le log d’un agent autonome ; agent inconnu ou nom malveillant refusés', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { sessionLogPath } = await import('../../src/session.ts');
    const info = await createAgent({
      root: repo.root,
      name: 'robot',
      mode: 'autonomous',
      profile: 'claude',
    });
    const logPath = sessionLogPath(repo.root, 'robot', info.taskId);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, 'trace de la session autonome', 'utf8');
    await createAgent({ root: repo.root, name: 'sans-log', mode: 'autonomous', profile: 'claude' });

    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    expect((await call(server, cookie, 'session.log', { agent: 'robot' })).data.log).toContain(
      'trace de la session autonome',
    );
    expect(errorOf(await rpc(server, cookie, 'session.log', { agent: 'fantome' })).code).toBe(
      'AGENT_UNKNOWN',
    );
    expect(errorOf(await rpc(server, cookie, 'session.log', { agent: 'sans-log' }))).toMatchObject({
      code: 'SESSION_LOG_UNAVAILABLE',
      details: { agent: 'sans-log' },
    });
    for (const evil of ['../../etc/passwd', 'a/../../secret', '.%2E/x']) {
      expect(errorOf(await rpc(server, cookie, 'session.log', { agent: evil })).code).toBe(
        'INVALID_AGENT_NAME',
      );
    }
  });
});

describe('dashboard — temps réel (SSE)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo.cleanup();
  });

  it("pousse l'état initial à la connexion, puis à chaque changement disque (autre process simulé)", async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const res = await fetch(`${baseUrl(server)}/events`, { headers: { Cookie: cookie } });
    const next = sseReader(res.body);
    const initial = await next('state.changed');
    expect(initial.message.params.state.agents).toEqual([]);
    expect(initial.message.params.state.config.targetBranch).toBe('main');

    await createAgent({ root: repo.root, name: 'agent-sse' });
    let updated;
    do {
      updated = await next('state.changed');
    } while (!updated.message.params.state.agents.some((a) => a.name === 'agent-sse'));
    await next.cancel();
  });

  it('server.close ferme le flux SSE sans attendre (pas de socket fantôme)', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const res = await fetch(`${baseUrl(server)}/events`, { headers: { Cookie: cookie } });
    await sseReader(res.body)('state.changed');
    const closed = await Promise.race([
      new Promise((resolve) => server.close(() => resolve('closed'))),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
    ]);
    expect(closed).toBe('closed');
    server = null;
  });
});

describe('dashboard — permissions semi-autonomes', () => {
  let repo;
  let server;
  let cookie;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
    server = await startDashboard({ root: repo.root, port: 0 });
    ({ cookie } = await signIn(server));
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await repo.cleanup();
  });

  it("une demande en attente apparaît dans l'état, permission.answer la tranche, la session la lit", async () => {
    const request = await createPermissionRequest(repo.root, {
      agent: 'agent-ask',
      taskId: 't1',
      title: 'Lancer npm test',
      options: [
        { optionId: 'ok', name: 'Autoriser', kind: 'allow_once' },
        { optionId: 'no', name: 'Refuser', kind: 'reject_once' },
      ],
      timeoutMs: 60_000,
    });

    const { data: state } = await call(server, cookie, 'state.get');
    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]).toMatchObject({ agent: 'agent-ask', title: 'Lancer npm test' });

    const doc = await call(server, cookie, 'permission.answer', { id: request.id, option: 'ok' });
    expect(doc.data).toMatchObject({ id: request.id, status: 'ANSWERED', answer: 'ok' });
    await expect(awaitPermissionAnswer(repo.root, request.id, 5_000)).resolves.toBe('ok');
    expect(await listPendingPermissions(repo.root)).toEqual([]);
  });

  it("refus typés : id invalide, demande inconnue, option non proposée — jamais d'accord par défaut", async () => {
    for (const [params, code] of [
      [{}, 'PERMISSION_ID_INVALID'],
      [{ id: '../evasion', option: 'ok' }, 'PERMISSION_ID_INVALID'],
      [{ id: 'perm-00000000-0000-0000-0000-000000000000', option: 'ok' }, 'PERMISSION_NOT_PENDING'],
    ]) {
      const res = await rpc(server, cookie, 'permission.answer', params);
      expect(errorOf(res)?.code, JSON.stringify(params)).toBe(code);
    }
    const request = await createPermissionRequest(repo.root, {
      agent: 'a',
      taskId: 't',
      title: 'x',
      options: [{ optionId: 'ok', kind: 'allow_once' }],
      timeoutMs: 60_000,
    });
    const res = await rpc(server, cookie, 'permission.answer', {
      id: request.id,
      option: 'inventée',
    });
    expect(errorOf(res).code).toBe('PERMISSION_OPTION_UNKNOWN');
    expect(await listPendingPermissions(repo.root)).toHaveLength(1);
  });

  it('elicitation : visible dans l’état (schéma publié), réponse validée contre requestedSchema, demande gardée ouverte si invalide', async () => {
    const validate = createValidator(SCHEMA_ROOT);
    const request = await createElicitationRequest(repo.root, {
      agent: 'agent-ask',
      taskId: 't1',
      mode: 'form',
      message: '<img src=x onerror=alert(1)> Quel environnement ?',
      requestedSchema: {
        type: 'object',
        properties: {
          env: { type: 'string', enum: ['staging', 'prod'] },
          replicas: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['env'],
      },
      timeoutMs: 60_000,
    });
    const state = await call(server, cookie, 'state.get');
    expect(validate(resultSchema(methodSpec('state.get')), state)).toBeNull();
    expect(state.data.elicitations).toHaveLength(1);
    expect(state.data.permissions).toHaveLength(0);

    const bad = await rpc(server, cookie, 'elicitation.answer', {
      id: request.id,
      action: 'accept',
      content: { env: 'dev' },
    });
    expect(errorOf(bad)).toMatchObject({ code: 'ELICITATION_CONTENT_INVALID', kind: 'usage' });
    expect(await listPendingElicitations(repo.root)).toHaveLength(1);

    const ok = await call(server, cookie, 'elicitation.answer', {
      id: request.id,
      action: 'accept',
      content: { env: 'prod', replicas: 2 },
    });
    expect(ok.data).toMatchObject({ status: 'ANSWERED', answer: { action: 'accept' } });
    await expect(awaitElicitationAnswer(repo.root, request.id, 5_000)).resolves.toMatchObject({
      action: 'accept',
      content: { env: 'prod', replicas: 2 },
    });
    // Rejouée : plus en attente.
    const again = await rpc(server, cookie, 'elicitation.answer', {
      id: request.id,
      action: 'decline',
    });
    expect(errorOf(again).code).toBe('ELICITATION_NOT_PENDING');
    // Id hors motif : refusé par le schéma.
    const evil = await rpc(server, cookie, 'elicitation.answer', { id: '../x', action: 'cancel' });
    expect(errorOf(evil).code).toBe('INVALID_ARGUMENT');
  });

  it('mainSession.release : libère la session principale déclarée (lock --stop), plan humain seulement', async () => {
    const { startMainSession } = await import('../../src/main-session.ts');
    await startMainSession(repo.root, { pid: process.pid, reason: 'édition manuelle' });
    const doc = await call(server, cookie, 'mainSession.release');
    expect(doc.data).toMatchObject({
      action: 'stop',
      released: { reason: 'édition manuelle', alive: true },
    });
    expect((await call(server, cookie, 'state.get')).data.mainSession).toBeNull();
  });
});
