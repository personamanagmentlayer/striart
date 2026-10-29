import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent, readRegistry, updateAgentMeta } from '../../src/clone.ts';
import { applyTicketResolution, mergeAgentCommit, stopAgent } from '../../src/orchestrator.ts';
import { readState, recordSemanticFailure } from '../../src/state.ts';
import { listMergeHistory } from '../../src/history.ts';
import {
  createConflictTicket,
  listConflictTickets,
  prepareResolutionScaffold,
  readResolutionInputs,
  readTicketDetail,
  safeFileName,
} from '../../src/conflicts.ts';

const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'gate rouge\'); process.exit(1)"';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

async function commitInAgent(info, fileName, content, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
  return (await git.revparse(['HEAD'])).trim();
}

/** Conflit textuel classique sur app.js : main et l'agent divergent. */
async function makeConflict(repo, agent, { mainContent = 'main', agentContent = 'agent' } = {}) {
  await writeFile(path.join(repo.root, 'app.js'), `const version = "${mainContent}";\n`);
  await repo.git.add(['app.js']);
  await repo.git.commit('feat: version main');
  return commitInAgent(
    agent,
    'app.js',
    `const version = "${agentContent}";\n`,
    'feat: version agent',
  );
}

function resolvedPath(ticket, filePath) {
  return path.join(ticket.dir, `${safeFileName(filePath)}.resolved`);
}

describe('conflicts.js — readResolutionInputs / prepareResolutionScaffold (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('l’id d’un ticket est le nom de son dossier : un ticket.json falsifié ne redirige aucune écriture', async () => {
    await initStriart(repo.root);
    const first = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task-1',
      sha: 'abc1234',
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['app.js'],
      resolutions: [{ path: 'app.js', base: 'b', ours: 'o', theirs: 't' }],
    });
    const ticketFile = path.join(repo.root, '.striart', 'conflicts', first.id, 'ticket.json');
    const forged = { ...JSON.parse(await readFile(ticketFile, 'utf8')), id: '../../escaped' };
    await writeFile(ticketFile, JSON.stringify(forged));

    const [listed] = await listConflictTickets(repo.root);
    expect(listed.id).toBe(first.id);

    // Même commit re-tenté : le ticket existant est mis à jour EN PLACE.
    const again = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task-1',
      sha: 'abc1234',
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['app.js'],
      resolutions: [{ path: 'app.js', base: 'b', ours: 'o2', theirs: 't' }],
    });
    expect(again.id).toBe(first.id);
    await expect(stat(path.join(repo.root, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(repo.root, '.striart', 'escaped'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('distingue content / delete / missing pour un ticket à 3 fichiers', async () => {
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task',
      sha: 'deadbeef',
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['a.txt', 'b.txt', 'c.txt'],
      resolutions: [
        { path: 'a.txt', base: 'BASE-A', ours: 'OURS-A', theirs: 'THEIRS-A' },
        { path: 'b.txt', base: 'BASE-B', ours: 'OURS-B', theirs: 'THEIRS-B' },
        { path: 'c.txt', base: 'BASE-C', ours: 'OURS-C', theirs: 'THEIRS-C' },
      ],
    });

    await writeFile(resolvedPath(ticket, 'a.txt'), 'final A');
    await writeFile(path.join(ticket.dir, `${safeFileName('b.txt')}.delete`), '');
    // c.txt : rien de préparé.

    const inputs = await readResolutionInputs(repo.root, ticket.id);
    expect(inputs).toEqual([
      { path: 'a.txt', kind: 'content', content: Buffer.from('final A') },
      { path: 'b.txt', kind: 'delete' },
      { path: 'c.txt', kind: 'missing' },
    ]);
  });

  it("amorce depuis .theirs, retombe sur .ours puis .base si absent, et n'écrase jamais un fichier déjà marqué", async () => {
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task',
      sha: 'deadbeef',
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'],
      resolutions: [
        { path: 'f1.txt', base: 'BASE-1', ours: 'OURS-1', theirs: 'THEIRS-1' },
        { path: 'f2.txt', base: 'BASE-2', ours: 'OURS-2', theirs: 'THEIRS-2' },
        { path: 'f3.txt', base: 'BASE-3', ours: 'OURS-3', theirs: 'THEIRS-3' },
        { path: 'f4.txt', base: 'BASE-4', ours: 'OURS-4', theirs: 'THEIRS-4' },
      ],
    });

    // f2 : simule un .theirs absent (corruption / conflit hors de portée du LLM) → repli sur .ours.
    await unlink(path.join(ticket.dir, `${safeFileName('f2.txt')}.theirs`));
    // f3 : .theirs ET .ours absents → repli sur .base.
    await unlink(path.join(ticket.dir, `${safeFileName('f3.txt')}.theirs`));
    await unlink(path.join(ticket.dir, `${safeFileName('f3.txt')}.ours`));
    // f4 : l'humain a déjà préparé sa propre résolution AVANT d'amorcer.
    await writeFile(resolvedPath(ticket, 'f4.txt'), 'HUMAIN-4');

    const first = await prepareResolutionScaffold(repo.root, ticket.id);
    expect(first).toEqual([
      { path: 'f1.txt', created: true, source: 'theirs' },
      { path: 'f2.txt', created: true, source: 'ours' },
      { path: 'f3.txt', created: true, source: 'base' },
      { path: 'f4.txt', created: false, source: null },
    ]);

    await expect(readFile(resolvedPath(ticket, 'f1.txt'), 'utf8')).resolves.toBe('THEIRS-1');
    await expect(readFile(resolvedPath(ticket, 'f2.txt'), 'utf8')).resolves.toBe('OURS-2');
    await expect(readFile(resolvedPath(ticket, 'f3.txt'), 'utf8')).resolves.toBe('BASE-3');
    // Le fichier déjà marqué par l'humain n'a jamais été touché.
    await expect(readFile(resolvedPath(ticket, 'f4.txt'), 'utf8')).resolves.toBe('HUMAIN-4');

    // Deuxième appel : idempotent, plus rien à créer.
    const second = await prepareResolutionScaffold(repo.root, ticket.id);
    expect(second).toEqual([
      { path: 'f1.txt', created: false, source: null },
      { path: 'f2.txt', created: false, source: null },
      { path: 'f3.txt', created: false, source: null },
      { path: 'f4.txt', created: false, source: null },
    ]);
  });
});

describe('applyTicketResolution (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, semanticMerge: false });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it(
    'chemin heureux : résolution manuelle appliquée sous withMainLock/Test Gate, ferme le ticket, ' +
      'remet le streak sémantique à zéro (même monté par des échecs LLM sans rapport)',
    async () => {
      await makeConflict(repo, agent);
      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(result.status).toBe('CONFLICT');
      expect(result.reason).toBe('MERGE_CONFLICT');
      const ticketId = result.ticket.id;

      // Deux échecs sémantiques LLM antérieurs, sans rapport avec ce ticket.
      await recordSemanticFailure(repo.root);
      await recordSemanticFailure(repo.root);
      expect((await readState(repo.root)).semanticFailureStreak).toBe(2);

      const scaffold = await prepareResolutionScaffold(repo.root, ticketId);
      expect(scaffold).toEqual([{ path: 'app.js', created: true, source: 'theirs' }]);
      await writeFile(
        resolvedPath(result.ticket, 'app.js'),
        'const version = "resolved by human";\n',
      );

      const applied = await applyTicketResolution({ root: repo.root, ticketId });
      expect(applied).toMatchObject({
        status: 'MERGED',
        ticketId,
        agent: 'agent-a',
        sha: result.sha,
        resolvedFiles: ['app.js'],
        closedTickets: [ticketId],
      });
      expect(applied.gate.success).toBe(true);

      await expect(readFile(path.join(repo.root, 'app.js'), 'utf8')).resolves.toBe(
        'const version = "resolved by human";\n',
      );
      const log = await repo.git.log({ maxCount: 1 });
      expect(log.latest.message).toContain('résolution manuelle');
      expect(log.latest.message).toContain(ticketId);
      // `sha` reste le commit de l'agent ; `mergeSha` est le commit créé sur la cible.
      expect(applied.mergeSha).toBe(log.latest.hash);
      expect(applied.mergeSha).not.toBe(applied.sha);

      // Le merge manuel apparaît dans l'historique (il en disparaissait : la
      // regex de history.js ne reconnaissait que la note de fusion sémantique).
      const [entry] = await listMergeHistory({ root: repo.root });
      expect(entry).toMatchObject({
        type: 'merge',
        sha: log.latest.hash,
        agent: 'agent-a',
        resolution: 'manual',
        ticketId,
        semantic: false,
      });

      const registry = await readRegistry(repo.root);
      expect(registry['agent-a'].lastMergedCommit).toBe(result.sha);

      const openTickets = await listConflictTickets(repo.root);
      expect(openTickets.find((t) => t.id === ticketId)).toBeUndefined();
      const detail = await readTicketDetail(repo.root, ticketId);
      expect(detail.resolved).toBe(true);

      // Succès manuel → remet le compteur à zéro, quelle que soit son origine.
      expect(await readState(repo.root)).toMatchObject({
        semanticFailureStreak: 0,
        manualMode: false,
      });

      // Rejouer sur un ticket déjà résolu est refusé.
      await expect(applyTicketResolution({ root: repo.root, ticketId })).rejects.toMatchObject({
        code: 'TICKET_ALREADY_RESOLVED',
      });
    },
  );

  it('refuse (TICKET_NOT_APPLICABLE) un ticket GATE_FAILED sans conflit de fichiers', async () => {
    await setConfig(repo.root, { testCommand: GATE_KO });
    await commitInAgent(agent, 'broken.js', 'export const y = 2;\n', 'feat: y');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('GATE_FAILED');
    expect(result.ticket.conflictedFiles).toEqual([]);

    await expect(
      applyTicketResolution({ root: repo.root, ticketId: result.ticket.id }),
    ).rejects.toMatchObject({
      code: 'TICKET_NOT_APPLICABLE',
      details: { reason: 'GATE_FAILED' },
    });
  });

  it("refuse (RESOLUTION_INCOMPLETE) tant qu'aucune résolution n'a été préparée, sans toucher au repo", async () => {
    await makeConflict(repo, agent);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    const ticketId = result.ticket.id;

    await expect(applyTicketResolution({ root: repo.root, ticketId })).rejects.toMatchObject({
      code: 'RESOLUTION_INCOMPLETE',
      details: { missing: ['app.js'] },
    });

    // Rien n'a bougé : le ticket reste ouvert, le repo principal reste propre.
    expect((await readTicketDetail(repo.root, ticketId)).resolved).toBe(false);
    const status = await repo.git.status();
    expect(status.conflicted).toEqual([]);
    expect(status.staged).toEqual([]);
    expect(status.modified).toEqual([]);
  });

  it('refuse (AGENT_UNKNOWN) si le clone a été retiré du registre depuis la création du ticket', async () => {
    await makeConflict(repo, agent);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    const ticketId = result.ticket.id;
    await prepareResolutionScaffold(repo.root, ticketId);

    await stopAgent({ root: repo.root, agent: 'agent-a', force: true });

    await expect(applyTicketResolution({ root: repo.root, ticketId })).rejects.toMatchObject({
      code: 'AGENT_UNKNOWN',
    });
  });

  it('refuse (SESSION_LIVE) tant que la session autonome du clone est vivante ; un PID mort laisse passer', async () => {
    await makeConflict(repo, agent);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    const ticketId = result.ticket.id;
    await prepareResolutionScaffold(repo.root, ticketId);

    await updateAgentMeta(repo.root, 'agent-a', { sessionPid: process.pid });
    await expect(applyTicketResolution({ root: repo.root, ticketId })).rejects.toMatchObject({
      code: 'SESSION_LIVE',
    });

    await updateAgentMeta(repo.root, 'agent-a', { sessionPid: 999_999_999 });
    const applied = await applyTicketResolution({ root: repo.root, ticketId });
    expect(applied.status).toBe('MERGED');
  });

  it('STALE_TICKET : le repo principal a bougé (le conflit rejoué diffère du ticket), merge annulé', async () => {
    await writeFile(path.join(repo.root, 'other.js'), 'export const o = "base";\n');
    await repo.git.add(['other.js']);
    await repo.git.commit('feat: other.js');
    const agentG = await createAgent({ root: repo.root, name: 'agent-g' });

    // L'agent modifie app.js ET other.js dans un même commit.
    const agentGit = simpleGit(agentG.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(agentG.path, 'app.js'), 'const version = "agent";\n');
    await writeFile(path.join(agentG.path, 'other.js'), 'export const o = "agent";\n');
    await agentGit.add(['app.js', 'other.js']);
    await agentGit.commit('feat: agent édite app.js et other.js');

    // Main ne modifie QUE app.js pour l'instant → other.js merge proprement.
    await writeFile(path.join(repo.root, 'app.js'), 'const version = "main";\n');
    await repo.git.add(['app.js']);
    await repo.git.commit('feat: version main');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-g' });
    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('MERGE_CONFLICT');
    expect(result.ticket.conflictedFiles).toEqual(['app.js']);
    const ticketId = result.ticket.id;
    await prepareResolutionScaffold(repo.root, ticketId);
    await writeFile(resolvedPath(result.ticket, 'app.js'), 'const version = "resolved";\n');

    // Main avance encore : other.js change aussi maintenant → en rejouant le
    // ticket, le conflit s'étend à un fichier que le ticket ne connaît pas.
    await writeFile(path.join(repo.root, 'other.js'), 'export const o = "main-later";\n');
    await repo.git.add(['other.js']);
    await repo.git.commit('feat: main édite other.js après coup');

    await expect(applyTicketResolution({ root: repo.root, ticketId })).rejects.toMatchObject({
      code: 'STALE_TICKET',
    });

    // Merge annulé : repo principal propre.
    const status = await repo.git.status();
    expect(status.conflicted).toEqual([]);
    expect(status.staged).toEqual([]);
    expect(status.modified).toEqual([]);
  });

  it('ALREADY_CLEAN : le contenu attendu est déjà présent côté main, rien à appliquer, ticket fermé', async () => {
    const sha = await makeConflict(repo, agent, { agentContent: 'convergé' });
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('CONFLICT');
    const ticketId = result.ticket.id;

    // Entre-temps, main a été mis à jour (par une autre voie) avec EXACTEMENT
    // le même contenu que celui du commit de l'agent : rejouer le merge exact
    // du ticket ne produit alors plus aucun conflit.
    await writeFile(path.join(repo.root, 'app.js'), 'const version = "convergé";\n');
    await repo.git.add(['app.js']);
    await repo.git.commit('fix: main converge vers le même contenu que agent-a');

    // La résolution reste requise même si le merge rejoué s'avérera trivial :
    // readResolutionInputs est vérifié avant de rejouer le merge.
    await prepareResolutionScaffold(repo.root, ticketId);

    const applied = await applyTicketResolution({ root: repo.root, ticketId });
    expect(applied).toMatchObject({ status: 'ALREADY_CLEAN', ticketId, agent: 'agent-a', sha });

    // Le conflit ne se reproduit plus : rien à traiter, mais le ticket n'a
    // plus de raison de rester listé comme ouvert pour autant.
    expect((await readTicketDetail(repo.root, ticketId)).resolved).toBe(true);
    await expect(readFile(path.join(repo.root, 'app.js'), 'utf8')).resolves.toBe(
      'const version = "convergé";\n',
    );
  });

  it(
    'Test Gate rouge sur la résolution proposée : le ticket reste ouvert, PAS de nouveau ticket, ' +
      'streak et manualMode INTACTS (une résolution manuelle ratée ne pousse jamais en mode manuel)',
    async () => {
      await setConfig(repo.root, { testCommand: 'node app.js', semanticMerge: false });
      await makeConflict(repo, agent);
      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      const ticketId = result.ticket.id;

      await recordSemanticFailure(repo.root);
      await recordSemanticFailure(repo.root);
      expect(await readState(repo.root)).toMatchObject({
        semanticFailureStreak: 2,
        manualMode: false,
      });

      await prepareResolutionScaffold(repo.root, ticketId);
      await writeFile(resolvedPath(result.ticket, 'app.js'), 'process.exit(1);\n');

      const failed = await applyTicketResolution({ root: repo.root, ticketId });
      expect(failed).toMatchObject({ status: 'GATE_FAILED', ticketId, agent: 'agent-a' });
      expect(failed.gate.success).toBe(false);

      // Ni régression ni progression du streak : une résolution manuelle
      // ratée n'est pas un échec sémantique du LLM.
      expect(await readState(repo.root)).toMatchObject({
        semanticFailureStreak: 2,
        manualMode: false,
      });
      // Toujours un seul ticket : aucun doublon créé pour ce gate rouge.
      const allTickets = await listConflictTickets(repo.root, { includeResolved: true });
      expect(allTickets).toHaveLength(1);
      expect((await readTicketDetail(repo.root, ticketId)).resolved).toBe(false);

      // Le repo principal est propre après l'échec.
      const status = await repo.git.status();
      expect(status.conflicted).toEqual([]);
      expect(status.staged).toEqual([]);
      expect(status.modified).toEqual([]);

      // L'humain corrige sa résolution : le même ticket repasse au vert.
      await writeFile(resolvedPath(result.ticket, 'app.js'), 'process.exit(0);\n');
      const succeeded = await applyTicketResolution({ root: repo.root, ticketId });
      expect(succeeded.status).toBe('MERGED');
      expect((await readState(repo.root)).semanticFailureStreak).toBe(0);
    },
  );

  it(
    'ferme aussi les autres tickets ouverts du même agent qui portent sur le même fichier ' +
      '(doublons du même conflit après recommit)',
    async () => {
      await makeConflict(repo, agent, { agentContent: 'v1' });
      const first = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(first.status).toBe('CONFLICT');
      const ticket1 = first.ticket.id;

      // L'agent recommite avant que le ticket précédent soit traité : un
      // second merge produit un second ticket, sha différent, même fichier.
      await commitInAgent(agent, 'app.js', 'const version = "v2";\n', 'feat: v2');
      const second = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(second.status).toBe('CONFLICT');
      const ticket2 = second.ticket.id;
      expect(ticket2).not.toBe(ticket1);

      await prepareResolutionScaffold(repo.root, ticket2);
      await writeFile(resolvedPath(second.ticket, 'app.js'), 'const version = "final";\n');

      const applied = await applyTicketResolution({ root: repo.root, ticketId: ticket2 });
      expect(applied.status).toBe('MERGED');
      expect(applied.closedTickets.sort()).toEqual([ticket1, ticket2].sort());

      // Le ticket le plus ancien, jamais appliqué directement, est fermé au passage.
      expect((await readTicketDetail(repo.root, ticket1)).resolved).toBe(true);
      expect((await readTicketDetail(repo.root, ticket2)).resolved).toBe(true);
      expect(await listConflictTickets(repo.root)).toEqual([]);
    },
  );

  it(
    "résolution par suppression (kind delete) : le fichier disparaît du worktree ET de l'index " +
      'après le merge (pas seulement vidé de contenu)',
    async () => {
      await makeConflict(repo, agent);
      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(result.status).toBe('CONFLICT');
      expect(result.reason).toBe('MERGE_CONFLICT');
      const ticketId = result.ticket.id;

      // La résolution humaine est de supprimer le fichier plutôt que de fusionner
      // son contenu : marqueur ".delete" au lieu de ".resolved" — contenu ignoré,
      // seule l'existence du fichier compte (readResolutionInputs, conflicts.js).
      await writeFile(path.join(result.ticket.dir, `${safeFileName('app.js')}.delete`), '');

      const applied = await applyTicketResolution({ root: repo.root, ticketId });
      expect(applied).toMatchObject({
        status: 'MERGED',
        ticketId,
        agent: 'agent-a',
        resolvedFiles: ['app.js'],
      });

      // Absent du worktree.
      await expect(readFile(path.join(repo.root, 'app.js'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // Absent de l'index / HEAD (pas juste supprimé sur disque).
      await expect(repo.git.raw(['show', 'HEAD:app.js'])).rejects.toThrow();
      const tracked = (await repo.git.raw(['ls-files', 'app.js'])).trim();
      expect(tracked).toBe('');
    },
  );

  it('restaure le bit exécutable sur la résolution appliquée quand ours ou theirs porte le mode 100755', async () => {
    // Base partagée avant divergence, pour un vrai conflit modify/modify
    // (contenu ET mode) plutôt qu'un simple add/add.
    await writeFile(path.join(repo.root, 'app.js'), 'const version = "base";\n');
    await repo.git.add(['app.js']);
    await repo.git.commit('feat: app.js base');

    const agentX = await createAgent({ root: repo.root, name: 'agent-x' });
    const agentGit = simpleGit(agentX.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(agentX.path, 'app.js'), 'const version = "agent";\n');
    await agentGit.add(['app.js']);
    // Le bit exécutable se pose dans l'INDEX (writeFile ne le préserve pas,
    // et il n'existe pas sur NTFS) : c'est ce que la résolution doit restaurer.
    await agentGit.raw(['update-index', '--chmod=+x', '--', 'app.js']);
    await agentGit.commit('feat: agent édite app.js et le rend exécutable');

    await writeFile(path.join(repo.root, 'app.js'), 'const version = "main";\n');
    await repo.git.add(['app.js']);
    await repo.git.commit('feat: main édite app.js');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-x' });
    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('UNMERGEABLE_CONFLICT');
    expect(result.unmergeable).toEqual([
      { path: 'app.js', kind: 'mode', ours: '100644', theirs: '100755' },
    ]);
    const ticketId = result.ticket.id;

    await writeFile(resolvedPath(result.ticket, 'app.js'), 'const version = "resolved";\n');

    const applied = await applyTicketResolution({ root: repo.root, ticketId });
    expect(applied).toMatchObject({ status: 'MERGED', ticketId, agent: 'agent-x' });

    // Vérification au niveau de l'index Git (portable, contrairement à
    // fs.stat().mode qui ne reflète pas le bit exécutable sur NTFS).
    const staged = (await repo.git.raw(['ls-files', '-s', 'app.js'])).trim();
    expect(staged.startsWith('100755')).toBe(true);
  });

  it(
    'refuse (UNSUPPORTED_RESOLUTION_KIND) un ticket UNMERGEABLE_CONFLICT de kind symlink, ' +
      'sans avoir touché au repo principal (le refus a lieu avant tout git merge)',
    async () => {
      await writeFile(path.join(repo.root, 'linky'), 'base\n');
      await repo.git.add(['linky']);
      await repo.git.commit('feat: linky base');

      const agentS = await createAgent({ root: repo.root, name: 'agent-s' });
      const agentGit = simpleGit(agentS.path);
      await agentGit.addConfig('user.name', 'Agent');
      await agentGit.addConfig('user.email', 'agent@example.com');
      await writeFile(path.join(agentS.path, 'linky'), 'agent-target\n');
      await agentGit.add(['linky']);
      const blobSha = (await agentGit.raw(['hash-object', '-w', 'linky'])).trim();
      // Transforme linky en lien symbolique (mode 120000) directement via
      // l'index : pas besoin d'un vrai symlink OS, seul le mode de l'arbre
      // compte pour classifyConflict (src/merger.js).
      await agentGit.raw(['update-index', '--cacheinfo', `120000,${blobSha},linky`]);
      await agentGit.commit('feat: linky devient un symlink côté agent');

      await writeFile(path.join(repo.root, 'linky'), 'main content\n');
      await repo.git.add(['linky']);
      await repo.git.commit('feat: main édite linky');

      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-s' });
      expect(result.status).toBe('CONFLICT');
      expect(result.reason).toBe('UNMERGEABLE_CONFLICT');
      expect(result.unmergeable.find((u) => u.path === 'linky')).toMatchObject({
        path: 'linky',
        kind: 'symlink',
      });
      const ticketId = result.ticket.id;

      const error = await applyTicketResolution({ root: repo.root, ticketId }).catch((e) => e);
      expect(error.code).toBe('UNSUPPORTED_RESOLUTION_KIND');
      expect(error.message).toMatch(/symlink/);

      // Le refus a lieu AVANT tout git merge : le repo principal n'a pas bougé.
      const status = await repo.git.status();
      expect(status.conflicted).toEqual([]);
      expect(status.staged).toEqual([]);
      expect(status.modified).toEqual([]);
      // Pas de MERGE_HEAD : simple-git ne rejette pas de façon fiable
      // "rev-parse -q --verify" sur un ref absent (stderr vide avec -q), donc
      // on vérifie directement l'absence du fichier sur disque.
      await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // Le ticket reste ouvert : le refus n'a pas fermé quoi que ce soit.
      expect((await readTicketDetail(repo.root, ticketId)).resolved).toBe(false);
    },
  );

  it(
    "exception pendant la boucle d'application (écriture bloquée) : le merge est annulé, " +
      'jamais laissé en état "merging", et une résolution suivante repasse au vert',
    async () => {
      // Conflit modify/delete réel : main modifie x.txt, l'agent le supprime.
      // Git ne réécrit alors PAS x.txt (« Version HEAD... left in tree ») :
      // un verrou lecture-seule posé sur ce fichier survit donc intact au
      // rejeu du merge et fait échouer réellement l'écriture de la boucle
      // d'application — une vraie panne fs, pas une simulation.
      await writeFile(path.join(repo.root, 'x.txt'), 'base content\n');
      await repo.git.add(['x.txt']);
      await repo.git.commit('feat: x.txt base');

      const agentD = await createAgent({ root: repo.root, name: 'agent-d' });
      const agentGit = simpleGit(agentD.path);
      await agentGit.addConfig('user.name', 'Agent');
      await agentGit.addConfig('user.email', 'agent@example.com');
      await agentGit.rm(['x.txt']);
      await agentGit.commit('feat: agent supprime x.txt');

      await writeFile(path.join(repo.root, 'x.txt'), 'main modifie x.txt\n');
      await repo.git.add(['x.txt']);
      await repo.git.commit('feat: main modifie x.txt');

      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-d' });
      expect(result.status).toBe('CONFLICT');
      expect(result.reason).toBe('UNMERGEABLE_CONFLICT');
      expect(result.unmergeable).toEqual([{ path: 'x.txt', kind: 'delete', deletedBy: 'theirs' }]);
      const ticketId = result.ticket.id;

      // Résolution humaine : garder le fichier, avec un contenu édité.
      await writeFile(resolvedPath(result.ticket, 'x.txt'), 'résolution humaine éditée\n');

      await chmod(path.join(repo.root, 'x.txt'), 0o444);
      try {
        await expect(applyTicketResolution({ root: repo.root, ticketId })).rejects.toThrow();

        // Le repo principal n'est pas resté en état "merging".
        const status = await repo.git.status();
        expect(status.conflicted).toEqual([]);
        expect(status.staged).toEqual([]);
        expect(status.modified).toEqual([]);
        await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        // Le ticket n'a pas été fermé par l'échec.
        expect((await readTicketDetail(repo.root, ticketId)).resolved).toBe(false);
      } finally {
        // Nettoyage : lève le verrou lecture-seule pour que le helper de
        // suppression du repo temporaire (afterEach) ne se heurte pas dessus.
        await chmod(path.join(repo.root, 'x.txt'), 0o666).catch(() => {});
      }

      // Une fois la panne fs levée, la même résolution repasse au vert : le
      // repo n'est pas resté bloqué durablement par l'échec précédent.
      const recovered = await applyTicketResolution({ root: repo.root, ticketId });
      expect(recovered.status).toBe('MERGED');
    },
  );
});
