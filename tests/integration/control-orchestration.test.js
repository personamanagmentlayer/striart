import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { compareAndUpdateAgentMeta, createAgent } from '../../src/clone.ts';
import { createHumanReview } from '../../src/orchestration/human-review.ts';
import { createGroupState } from '../../src/orchestration/store.ts';
import { collectStatus } from '../../src/status.ts';
import { startDashboard } from '../../src/dashboard.ts';
import { striartDir } from '../../src/paths.ts';
import { baseUrl, call, rpc, signIn, useLoopbackDashboard } from '../helpers/control-client.js';

const GROUP_ID = 'review-0123456789ab';
const REVIEW = {
  group: GROUP_ID,
  agent: 'agent-a',
  reviewer: 'reviewer-1',
  round: 1,
  branch: 'striart/agent-a/task-1',
  sha: 'a'.repeat(40),
  baseCommit: 'b'.repeat(40),
  diffstat: ' src/a.js | 2 +-\u001b[31m‮ evil\n 1 file changed',
};

/** Ouvre une relecture humaine EN ATTENTE, portée par ce process (donc vivant). */
const openReview = (root) => createHumanReview(root, REVIEW, { timeoutMs: 600_000, keep: 20 });

describe('Control Protocol — revues humaines, orchestration, tickets illisibles, clones en suppression', () => {
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
    server = null;
    await repo.cleanup();
  });

  describe('review.list / orchestration.state / état', () => {
    it('une revue en attente est listée avec alive=true, son diffstat NEUTRALISÉ', async () => {
      const created = await openReview(repo.root);
      const list = await call(server, cookie, 'review.list');
      expect(list.data.reviews).toHaveLength(1);
      const [review] = list.data.reviews;
      expect(review).toMatchObject({
        id: created.id,
        status: 'PENDING',
        alive: true,
        agent: 'agent-a',
      });
      // Contrôles C0 et surcharge bidirectionnelle retirés du texte non fiable.
      for (const ch of [String.fromCharCode(0x1b), String.fromCharCode(0x202e)])
        expect(review.diffstat).not.toContain(ch);
      expect(review.diffstat).toContain('src/a.js');
    });

    it('state.get embarque les revues et l’orchestration (pour le dashboard)', async () => {
      await openReview(repo.root);
      const state = await call(server, cookie, 'state.get');
      expect(state.data.reviews.map((r) => r.status)).toEqual(['PENDING']);
      expect(state.data.orchestration).toEqual({ runs: [], groups: [] });
    });

    it('orchestration.state : runs, groupes (alive calculé) et revues', async () => {
      await createGroupState(
        repo.root,
        { id: GROUP_ID, kind: 'review', runId: null, nodeId: null, agents: ['agent-a'] },
        20,
      );
      await openReview(repo.root);
      const result = await call(server, cookie, 'orchestration.state');
      expect(result.data.runs).toEqual([]);
      expect(result.data.groups).toHaveLength(1);
      expect(result.data.groups[0]).toMatchObject({ id: GROUP_ID, status: 'running', alive: true });
      expect(result.data.reviews).toHaveLength(1);
    });
  });

  describe('review.answer — plan humain', () => {
    it('approuve avec une remarque : verdict validé et enregistré, demande ANSWERED', async () => {
      const created = await openReview(repo.root);
      const answered = await call(server, cookie, 'review.answer', {
        id: created.id,
        verdict: 'approve',
        summary: 'looks good',
        comments: [{ file: 'src/a.js', line: 1, severity: 'minor', body: 'nit' }],
      });
      expect(answered.data.review).toMatchObject({
        id: created.id,
        status: 'ANSWERED',
        verdict: {
          verdict: 'approve',
          summary: 'looks good',
          comments: [{ file: 'src/a.js', line: 1, severity: 'minor', body: 'nit' }],
        },
      });
      const list = await call(server, cookie, 'review.list');
      expect(list.data.reviews[0].status).toBe('ANSWERED');
    });

    it('request-changes et reject sont acceptés', async () => {
      for (const verdict of ['request-changes', 'reject']) {
        const created = await openReview(repo.root);
        const answered = await call(server, cookie, 'review.answer', {
          id: created.id,
          verdict,
          summary: 'x',
        });
        expect(answered.data.review.verdict.verdict).toBe(verdict);
      }
    });

    it('une seconde réponse est refusée (REVIEW_NOT_PENDING), la première reste', async () => {
      const created = await openReview(repo.root);
      await call(server, cookie, 'review.answer', { id: created.id, verdict: 'approve' });
      const second = await rpc(server, cookie, 'review.answer', {
        id: created.id,
        verdict: 'reject',
      });
      expect(second.body.error.data.error.code).toBe('REVIEW_NOT_PENDING');
      const list = await call(server, cookie, 'review.list');
      expect(list.data.reviews[0].verdict.verdict).toBe('approve');
    });

    it('validation positive : verdict inconnu, clé inconnue, id mal formé, chemin non sûr → refus, rien d’écrit', async () => {
      const created = await openReview(repo.root);
      const bad = [
        { id: created.id, verdict: 'maybe' },
        { id: created.id, verdict: 'approve', extra: 1 },
        { id: '../../etc/passwd', verdict: 'approve' },
        { id: 'rev-ZZZZZZZZZZZZ', verdict: 'approve' },
        {
          id: created.id,
          verdict: 'approve',
          comments: [{ file: '../../x', severity: 'info', body: 'b' }],
        },
        { id: created.id, verdict: 'approve', comments: [{ severity: 'catastrophic', body: 'b' }] },
        { id: created.id, verdict: 'approve', summary: 42 },
      ];
      for (const params of bad) {
        const res = await rpc(server, cookie, 'review.answer', params);
        expect(res.body.error, JSON.stringify(params)).toBeTruthy();
      }
      const list = await call(server, cookie, 'review.list');
      expect(list.data.reviews[0].status).toBe('PENDING');
    });

    it('sans session : 401, la revue reste en attente', async () => {
      const created = await openReview(repo.root);
      const res = await rpc(server, null, 'review.answer', { id: created.id, verdict: 'approve' });
      expect(res.status).toBe(401);
      const list = await call(server, cookie, 'review.list');
      expect(list.data.reviews[0].status).toBe('PENDING');
    });

    it('les méthodes sont publiées dans le schéma (rpc.discover)', async () => {
      const doc = await call(server, cookie, 'rpc.discover');
      const names = (doc.methods ?? doc.data?.methods ?? []).map((m) => m.name);
      expect(names).toEqual(
        expect.arrayContaining(['review.list', 'review.answer', 'orchestration.state']),
      );
    });
  });

  describe('tickets illisibles (CORRUPT)', () => {
    async function corruptTicket(id = 'agent-x-deadbeef') {
      const dir = path.join(striartDir(repo.root), 'conflicts', id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'ticket.json'), '{nope');
      await writeFile(path.join(dir, 'secret.theirs'), 'TOP-SECRET-CONTENT');
      await utimes(dir, new Date(), new Date());
      return id;
    }

    it('state.get liste le ticket CORRUPT avec sa cause, sans aucun contenu de fichier', async () => {
      const id = await corruptTicket();
      const state = await call(server, cookie, 'state.get');
      const entry = state.data.tickets.find((t) => t.id === id);
      expect(entry).toMatchObject({
        status: 'CORRUPT',
        cause: 'INVALID_JSON',
        agent: null,
        reason: null,
      });
      expect(JSON.stringify(state)).not.toContain('TOP-SECRET-CONTENT');
    });

    it('ticket.get / prepare / apply refusent (TICKET_CORRUPT) ; ticket.close le ferme', async () => {
      const id = await corruptTicket();
      for (const method of ['ticket.get', 'ticket.prepare', 'ticket.apply']) {
        const res = await rpc(server, cookie, method, { id });
        expect(res.body.error.data.error.code, method).toBe('TICKET_CORRUPT');
      }
      const closed = await call(server, cookie, 'ticket.close', { id });
      expect(closed.data).toMatchObject({
        action: 'close',
        ticket: { id, status: 'CORRUPT', resolved: true },
      });
      const state = await call(server, cookie, 'state.get');
      expect(state.data.tickets.find((t) => t.id === id)).toBeUndefined();
    });
  });

  describe('clones en cours de suppression', () => {
    it('REMOVING dans le Control Protocol et dans le statut CLI/MCP — jamais actif ni BROKEN', async () => {
      await createAgent({ root: repo.root, name: 'agent-gone', command: 'claude' });
      await compareAndUpdateAgentMeta(
        repo.root,
        'agent-gone',
        {},
        {
          removing: true,
          removingSince: new Date().toISOString(),
        },
      );
      const state = await call(server, cookie, 'state.get');
      const agent = state.data.agents.find((a) => a.name === 'agent-gone');
      expect(agent.status).toBe('REMOVING');
      const status = await collectStatus(repo.root);
      expect(status.agents.find((a) => a.name === 'agent-gone').status).toBe('REMOVING');
    });

    it('le tableau de bord n’offre aucune action sur un clone en suppression', async () => {
      const page = await fetch(`${baseUrl(server)}/`, { headers: { Cookie: cookie } });
      const html = await page.text();
      // Le script servi est compacté : on cherche la garde, pas sa mise en forme.
      expect(html).toMatch(/a\.status\s*===\s*['"]REMOVING['"]/);
    });

    it('le script de la page est syntaxiquement valide (revues, orchestration, tickets illisibles)', async () => {
      const page = await fetch(`${baseUrl(server)}/`, { headers: { Cookie: cookie } });
      const html = await page.text();
      const start = html.indexOf('<script>') + '<script>'.length;
      const script = html.slice(start, html.indexOf('</script>', start));
      expect(() => new Function(script)).not.toThrow();
      expect(html).toContain('review.answer');
      expect(html).toContain('id="reviews"');
    });
  });
});
