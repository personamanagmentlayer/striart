import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import {
  closeConflictTicket,
  createConflictTicket,
  listConflictTickets,
} from '../../src/conflicts.js';
import { enqueueTask } from '../../src/queue.js';
import { collectDashboardState, startDashboard } from '../../src/dashboard.js';
import {
  awaitPermissionAnswer,
  createPermissionRequest,
  listPendingPermissions,
} from '../../src/permissions.ts';

describe('striart dashboard (intégration)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
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
    // poussé en SSE à chaque changement) : /api/ticket le sert à la demande.
    expect(state.tickets[0]).not.toHaveProperty('gateLog');
    expect(state.state).toMatchObject({ manualMode: false });
    expect(state.config.targetBranch).toBe('main');
    // Profils du mode autonome : exposés pour le sélecteur du formulaire.
    expect(Array.isArray(state.profiles)).toBe(true);
  });

  it('heatmap : croise verrous actifs, prédictions en file et historique des tickets', async () => {
    // agent-c verrouille src/db.ts (predictedFiles → locks.json) ;
    // agent-b (file d'attente) le prédit aussi ; le ticket du beforeEach
    // porte un conflit dessus → score = 1 (verrou) + 1 (file) + 2 (conflit).
    await createAgent({
      root: repo.root,
      name: 'agent-c',
      predictedFiles: ['src/db.ts', 'src/schema.ts'],
    });

    const state = await collectDashboardState(repo.root);
    const hot = state.heatmap.find((h) => h.file === 'src/db.ts');
    expect(hot).toMatchObject({ agents: ['agent-c'], queued: ['agent-b'], conflicts: 1, score: 4 });
    // Le fichier verrouillé mais jamais disputé est là aussi, score plus bas.
    const cold = state.heatmap.find((h) => h.file === 'src/schema.ts');
    expect(cold).toMatchObject({ agents: ['agent-c'], conflicts: 0, score: 1 });
    // Trié du plus chaud au plus froid.
    expect(state.heatmap[0].file).toBe('src/db.ts');
  });

  it('resolve --close : le ticket résolu sort de la liste mais reste sur disque', async () => {
    const [ticket] = await listConflictTickets(repo.root);
    const closed = await closeConflictTicket(repo.root, ticket.id);
    expect(closed.resolved).toBe(true);

    // Plus listé par défaut (CLI, dashboard)...
    expect(await listConflictTickets(repo.root)).toHaveLength(0);
    // ...mais conservé pour l'audit, marqué résolu.
    const all = await listConflictTickets(repo.root, { includeResolved: true });
    expect(all).toHaveLength(1);
    expect(all[0].resolved).toBe(true);
    const { readFile: rf } = await import('node:fs/promises');
    await expect(rf(`${ticket.dir}/RESOLVED`, 'utf8')).resolves.toMatch(/\d{4}-\d{2}-\d{2}T/);

    // Ticket inconnu → erreur claire.
    await expect(closeConflictTicket(repo.root, 'ticket-fantome')).rejects.toMatchObject({
      code: 'TICKET_UNKNOWN',
    });
  });

  it('sert la page HTML et l’API JSON sur 127.0.0.1', async () => {
    server = await startDashboard({ root: repo.root, port: 0 }); // port éphémère
    const { port } = server.address();

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('Striart');
    expect(html).toContain('/api/state');

    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(res.headers.get('content-type')).toContain('application/json');
    const state = await res.json();
    expect(state.agents[0].name).toBe('agent-a');
    expect(state.tickets[0].reason).toBe('GATE_FAILED');

    const notFound = await fetch(`http://127.0.0.1:${port}/inconnu`);
    expect(notFound.status).toBe(404);
  });

  it("sert le détail complet d'un ticket (3 versions + tentative LLM + log)", async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const [ticket] = await listConflictTickets(repo.root);

    const detail = await (await fetch(`http://127.0.0.1:${port}/api/ticket/${ticket.id}`)).json();
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

    // Ticket inconnu → 404 ; id malveillant (traversée) → jamais résolu en chemin.
    expect((await fetch(`http://127.0.0.1:${port}/api/ticket/fantome`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/ticket/..%2F..%2Fsecret`)).status).toBe(404);
  });

  it('actions de pilotage : CSRF refusé sans en-tête, ticket-close effectif, erreurs propagées', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const [ticket] = await listConflictTickets(repo.root);
    const url = (a) => `http://127.0.0.1:${port}/api/action/${a}`;
    const HEADERS = { 'Content-Type': 'application/json', 'X-Striart': '1' };

    // Sans l'en-tête custom : refus 403 (un site malveillant ne peut pas
    // le poser sans préflight CORS, que le serveur ne valide jamais).
    const csrf = await fetch(url('ticket-close'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ticket.id }),
    });
    expect(csrf.status).toBe(403);
    expect((await listConflictTickets(repo.root)).length).toBe(1); // rien n'a bougé

    // Avec l'en-tête : le ticket est clos pour de vrai.
    const ok = await fetch(url('ticket-close'), {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ id: ticket.id }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    expect(await listConflictTickets(repo.root)).toHaveLength(0);

    // Erreur métier (rollback sans merge Striart en tête) → 409 + code.
    const ko = await fetch(url('rollback'), { method: 'POST', headers: HEADERS, body: '{}' });
    expect(ko.status).toBe(409);
    expect(await ko.json()).toMatchObject({ ok: false, code: 'NOT_A_STRIART_MERGE' });

    // Action inconnue → 404, GET sur une action → 404.
    expect(
      (await fetch(url('detruire-tout'), { method: 'POST', headers: HEADERS, body: '{}' })).status,
    ).toBe(404);
    expect((await fetch(url('rollback'))).status).toBe(404);
  });

  it('DNS rebinding : un Host non local est refusé sur TOUTES les routes (403), lectures comprises', async () => {
    const http = await import('node:http');
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();

    // fetch (undici) interdit de forger l'en-tête Host : on descend au HTTP
    // brut pour simuler ce que le navigateur envoie sous DNS rebinding —
    // requête vers 127.0.0.1, mais Host: evil.example.
    const request = (routePath, { method = 'GET', headers = {} } = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: routePath,
            method,
            headers: { Host: 'evil.example', ...headers },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
        req.end();
      });

    // Les LECTURES exposent l'état du repo, le code des tickets, les logs de
    // session : elles DOIVENT refuser un Host tiers, pas seulement les actions.
    for (const route of ['/', '/api/state', '/api/events', '/api/ticket/x', '/api/session-log/a']) {
      expect(await request(route), `${route} doit refuser un Host tiers`).toBe(403);
    }
    // Action mutante : le contrôle d'hôte prime (sous rebinding l'origine
    // devient same-origin, X-Striart seul ne suffirait pas).
    expect(
      await request('/api/action/rollback', { method: 'POST', headers: { 'X-Striart': '1' } }),
    ).toBe(403);

    // Contrôle négatif : Host local → la route répond (200).
    expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(200);
  });

  it('action run : lance une tâche via le Router (LLM mocké), prompt vide refusé', async () => {
    const { vi } = await import('vitest');
    const realFetch = globalThis.fetch;
    // Le LLM du Router est mocké ; les requêtes du test vers le dashboard
    // (127.0.0.1) passent par le vrai fetch.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        if (String(url).includes('127.0.0.1')) return realFetch(url, options);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify({ files: ['src/db.ts'] }) }),
        };
      }),
    );
    try {
      server = await startDashboard({ root: repo.root, port: 0 });
      const { port } = server.address();
      const HEADERS = { 'Content-Type': 'application/json', 'X-Striart': '1' };
      const url = `http://127.0.0.1:${port}/api/action/run`;

      const empty = await realFetch(url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ prompt: '  ' }),
      });
      expect(empty.status).toBe(409);
      expect((await empty.json()).code).toBe('EMPTY_PROMPT');

      const ok = await realFetch(url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ prompt: 'Ajoute un index sur la table users' }),
      });
      expect(ok.status).toBe(200);
      const data = await ok.json();
      expect(data.result.status).toBe('STARTED');
      expect(data.result.predictedFiles).toEqual(['src/db.ts']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("l'état expose l'historique des merges", async () => {
    const state = await collectDashboardState(repo.root);
    expect(Array.isArray(state.history)).toBe(true);
  });

  it('action unlock : réactive la fusion sémantique et remet le compteur à zéro', async () => {
    const { readState, recordSemanticFailure } = await import('../../src/state.js');
    for (let i = 0; i < 3; i += 1) await recordSemanticFailure(repo.root);
    expect((await readState(repo.root)).manualMode).toBe(true);

    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/action/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await readState(repo.root)).toMatchObject({
      manualMode: false,
      semanticFailureStreak: 0,
    });
  });

  it('action run autonome : profil inconnu refusé DANS la requête, rien lancé en tâche de fond', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/action/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
      body: JSON.stringify({ prompt: 'x', mode: 'autonomous', profile: 'profil-fantome' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PROFILE_UNKNOWN');
    // Aucun clone créé : la validation précède toute création.
    expect((await collectDashboardState(repo.root)).agents).toHaveLength(1);
  });

  it('champ agent malformé : refusé en 4xx, jamais d’escalade silencieuse vers la portée globale', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const HEADERS = { 'Content-Type': 'application/json', 'X-Striart': '1' };

    // {agent: 0} ou {agent: [...]} sur sync/clean visait UN agent : le
    // requalifier en « tous les agents » serait une escalade de portée.
    for (const [action, agent] of [
      ['sync', 0],
      ['sync', ['agent-a']],
      ['clean', 0],
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/action/${action}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ agent }),
      });
      expect(res.status, `${action} avec agent ${JSON.stringify(agent)}`).toBe(409);
      expect((await res.json()).code).toBe('INVALID_AGENT_NAME');
    }
  });

  it('action run autonome : nom d’agent invalide refusé DANS la requête, pas en tâche de fond', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/action/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
      body: JSON.stringify({ prompt: 'x', mode: 'autonomous', agent: 'mon agent' }), // espace interdit
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_AGENT_NAME');
    // Rien lancé en arrière-plan : la validation précède le 200.
    expect((await collectDashboardState(repo.root)).agents).toHaveLength(1);
  });

  it('action sync sans agent : rebase en lot avec synthèse lisible', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/action/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result.results).toHaveLength(1); // agent-a du beforeEach
    expect(result.status).toContain('à jour');
  });

  it('/api/doctor : diagnostic servi en JSON (lecture, protégée par le contrôle Host global)', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/doctor`);
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(typeof report.healthy).toBe('boolean');
  });
});

describe('dashboard — visibilité du mode autonome (intégration)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
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
  });

  it('un registre antérieur au mode (sans champ) est affiché comme supervisé', async () => {
    // Rétrocompatibilité : les agents créés avant l'introduction du mode ne
    // doivent pas apparaître comme "autonome" par accident.
    const { readRegistry } = await import('../../src/clone.js');
    const { writeJsonAtomic } = await import('../../src/json-file.js');
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
    // Sans watcher, les commits des agents supervisés ne sont jamais mergés.
    // Le dashboard doit le dire, sinon l'utilisateur attend en vain.
    const state = await collectDashboardState(repo.root);
    expect(state.daemon.running).toBe(false);
    expect(state.daemon.stale).toBe(false);
    expect(state.daemon.logPath).toContain('watch.log');
  });

  it('sert le log de session d’un agent autonome, et 404 sinon', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { sessionLogPath } = await import('../../src/session.js');

    const info = await createAgent({
      root: repo.root,
      name: 'robot',
      mode: 'autonomous',
      profile: 'claude',
    });
    const logPath = sessionLogPath(repo.root, 'robot', info.taskId);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, 'trace de la session autonome', 'utf8');

    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();

    const ok = await fetch(`http://127.0.0.1:${port}/api/session-log/robot`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).log).toContain('trace de la session autonome');

    // Agent inexistant → 404, sans fuite d'information.
    const missing = await fetch(`http://127.0.0.1:${port}/api/session-log/fantome`);
    expect(missing.status).toBe(404);
  });

  it('refuse toute traversée de chemin sur la route des logs', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    for (const evil of ['..%2F..%2Fetc%2Fpasswd', 'a%2F..%2F..%2Fsecret', '.%2E%2Fx']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/session-log/${evil}`);
      expect(res.status).toBe(404);
    }
  });
});

describe('dashboard — temps réel (SSE)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo.cleanup();
  });

  /**
   * Lit le flux SSE jusqu'au prochain événement du type demandé.
   * Ignore les commentaires (battements :ping) et les autres événements.
   */
  function sseReader(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return async function nextEvent(wanted, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frameEnd = buffer.indexOf('\n\n');
        if (frameEnd !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (event === wanted && data) return JSON.parse(data);
          continue; // commentaire, retry:, ou autre événement — on passe
        }
        if (Date.now() > deadline) throw new Error(`événement SSE "${wanted}" jamais reçu`);
        const { value, done } = await reader.read();
        if (done) throw new Error('flux SSE terminé prématurément');
        buffer += decoder.decode(value, { stream: true });
      }
    };
  }

  it("pousse l'état initial à la connexion, puis à chaque changement disque", async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const nextEvent = sseReader(res.body);

    // État initial : dans le flux lui-même, sans requête séparée.
    const initial = await nextEvent('state');
    expect(initial.agents).toEqual([]);
    expect(initial.config.targetBranch).toBe('main');

    // Changement d'état SANS passer par le dashboard (autre process simulé) :
    // la création d'un agent écrit agents.json → le watcher disque doit
    // pousser un nouvel état. C'est le cœur du temps réel inter-process.
    await createAgent({ root: repo.root, name: 'agent-sse' });
    const deadline = Date.now() + 30_000;
    let updated;
    // Les écritures intermédiaires (locks) peuvent produire des pushes où
    // l'agent n'est pas encore visible : on attend CELUI qui le porte.
    do {
      updated = await nextEvent('state', Math.max(1000, deadline - Date.now()));
    } while (!updated.agents.some((a) => a.name === 'agent-sse') && Date.now() < deadline);
    expect(updated.agents.map((a) => a.name)).toContain('agent-sse');
  });

  it('server.close ferme le flux SSE sans attendre (pas de socket fantôme)', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    const nextEvent = sseReader(res.body);
    await nextEvent('state'); // connexion établie et servie

    // close() doit aboutir alors qu'un client SSE est encore connecté :
    // c'est le démontage (teardown) qui coupe les flux, pas le client.
    const closed = await Promise.race([
      new Promise((resolve) => server.close(() => resolve('closed'))),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
    ]);
    expect(closed).toBe('closed');
    server = null;
  });
});

describe('dashboard — permissions semi-autonomes et doctor', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    server = await startDashboard({ root: repo.root, port: 0 });
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await repo.cleanup();
  });

  const HEADERS = { 'Content-Type': 'application/json', 'X-Striart': '1' };
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;

  it("une demande en attente apparaît dans l'état, l'action permission la tranche, la session la lit", async () => {
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

    const state = await (await fetch(url('/api/state'))).json();
    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]).toMatchObject({ agent: 'agent-ask', title: 'Lancer npm test' });

    const res = await fetch(url('/api/action/permission'), {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ id: request.id, option: 'ok' }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
    // Côté session : la réponse est lisible et le fichier nettoyé.
    await expect(awaitPermissionAnswer(repo.root, request.id, 5_000)).resolves.toBe('ok');
    expect(await listPendingPermissions(repo.root)).toEqual([]);
  });

  it("refus typés : id invalide, demande inconnue, option non proposée — jamais d'accord par défaut", async () => {
    const post = (body) =>
      fetch(url('/api/action/permission'), {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      });

    for (const body of [
      {},
      { id: '../evasion', option: 'ok' },
      { id: 'perm-00000000-0000-0000-0000-000000000000', option: 'ok' },
    ]) {
      const res = await post(body);
      expect(res.ok).toBe(false);
      expect((await res.json()).ok).toBe(false);
    }

    const request = await createPermissionRequest(repo.root, {
      agent: 'a',
      taskId: 't',
      title: 'x',
      options: [{ optionId: 'ok', kind: 'allow_once' }],
      timeoutMs: 60_000,
    });
    const res = await post({ id: request.id, option: 'inventée' });
    expect((await res.json()).error).toMatch(/option inconnue/i);
    // La demande reste PENDING : un refus de forme ne consomme pas l'arbitrage.
    expect(await listPendingPermissions(repo.root)).toHaveLength(1);
  });

  it('GET /api/doctor sert le diagnostic complet (repo initialisé, checks présents)', async () => {
    const res = await fetch(url('/api/doctor'));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(3);
    const names = JSON.stringify(report.checks);
    expect(names).toMatch(/git/i);
  });
});
