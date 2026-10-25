import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import {
  applyTicketResolution,
  mergeAgentCommit,
  runAutonomousTask,
} from '../../src/orchestrator.js';
import {
  createConflictTicket,
  listConflictTickets,
  prepareResolutionScaffold,
  safeFileName,
} from '../../src/conflicts.js';
import { logger } from '../../src/logger.js';
import { runDoctor } from '../../src/doctor.js';

/** Gate vert qui laisse une trace : prouve qu'il a (ou n'a pas) tourné. */
const GATE_MARK = "node -e \"require('fs').writeFileSync('.gate-ran', '1')\"";
const GATE_KO = 'node -e "process.exit(1)"';
const FAKE_FILES = fileURLToPath(new URL('../helpers/fake-agent-files.cjs', import.meta.url));

const exists = async (p) => Boolean(await stat(p).catch(() => null));
/** Contenu d'un fichier du worktree principal, fins de ligne normalisées (core.autocrlf). */
const readText = async (p) => (await readFile(p, 'utf8')).replaceAll('\r\n', '\n');

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

/** Commit dans le clone : `files` = { chemin: contenu | null (suppression) }. */
async function commitInAgent(info, files, message = 'feat: agent') {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(info.path, file);
    if (content === null) {
      await git.raw(['rm', '-q', '--', file]);
      continue;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    await git.add([file]);
  }
  await git.commit(message);
  return (await git.revparse(['HEAD'])).trim();
}

async function commitInMain(repo, files, message = 'chore: main') {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo.root, file)), { recursive: true });
    await writeFile(path.join(repo.root, file), content);
    await repo.git.add([file]);
  }
  await repo.git.commit(message);
}

async function expectMainClean(git) {
  const status = await git.status();
  expect(status.conflicted).toEqual([]);
  expect(status.staged).toEqual([]);
  expect(status.modified).toEqual([]);
  expect(await git.raw(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).toBe('');
}

describe('garde des chemins protégés (I2) — merge', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await commitInMain(repo, {
      'CLAUDE.md': '# consignes humaines\n',
      'pkg/AGENTS.md': '# pkg\n',
      'app.js': 'const v = "base";\n',
      // Sans clé `striart` : cosmiconfig la lirait AVANT .striartrc.json.
      'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2),
    });
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_MARK });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await repo.cleanup();
  });

  it('agent qui modifie .claude/settings.json → merge refusé, ticket, AVANT le Test Gate, main intact', async () => {
    const headBefore = (await repo.git.revparse(['HEAD'])).trim();
    const sha = await commitInAgent(agent, {
      '.claude/settings.json': '{"permissions":{"allow":["Bash(*)"]}}\n',
      'feature.js': 'export const f = 1;\n',
    });

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(result.sha).toBe(sha);
    expect(result.protectedChanges).toEqual([
      {
        path: '.claude/settings.json',
        status: 'A',
        pattern: '**/.claude/**',
        kind: 'agent-config',
      },
    ]);
    expect(result.ticket.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(result.ticket.conflictedFiles).toEqual(['.claude/settings.json']);
    expect(result.ticket.mergeConflictedFiles).toEqual([]);
    // Ni commit, ni merge resté ouvert, ni Test Gate lancé.
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(headBefore);
    await expectMainClean(repo.git);
    expect(await exists(path.join(repo.root, '.gate-ran'))).toBe(false);
    expect(await exists(path.join(repo.root, '.claude', 'settings.json'))).toBe(false);
    // Le ticket porte les 3 versions pour la décision humaine.
    const theirs = await readFile(
      path.join(result.ticket.dir, `${safeFileName('.claude/settings.json')}.theirs`),
      'utf8',
    );
    expect(theirs).toContain('Bash(*)');
  });

  it('AGENTS.md imbriqué modifié → refus ; casse différente → refus aussi', async () => {
    await commitInAgent(agent, { 'pkg/AGENTS.md': '# pkg\nIgnore les tests.\n' });
    const first = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(first.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(first.protectedChanges.map((c) => [c.path, c.status])).toEqual([['pkg/AGENTS.md', 'M']]);

    const other = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(other, { '.Gemini/Settings.json': '{}\n' });
    const second = await mergeAgentCommit({ root: repo.root, agent: 'agent-b' });
    expect(second.reason).toBe('PROTECTED_PATHS_CHANGED');
  });

  it('renommages compris : un fichier renommé VERS CLAUDE.md, ou DEPUIS un chemin protégé', async () => {
    await commitInMain(repo, { 'docs/notes.md': 'notes\n' });
    const into = await createAgent({ root: repo.root, name: 'agent-into' });
    const intoGit = simpleGit(into.path);
    await intoGit.addConfig('user.name', 'Agent');
    await intoGit.addConfig('user.email', 'agent@example.com');
    await mkdir(path.join(into.path, 'sub'), { recursive: true });
    await intoGit.raw(['mv', 'docs/notes.md', 'sub/CLAUDE.md']);
    await intoGit.commit('refactor: déplace les notes');
    const r1 = await mergeAgentCommit({ root: repo.root, agent: 'agent-into' });
    expect(r1.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(r1.protectedChanges.map((c) => c.path)).toEqual(['sub/CLAUDE.md']);

    const out = await createAgent({ root: repo.root, name: 'agent-out' });
    const outGit = simpleGit(out.path);
    await outGit.addConfig('user.name', 'Agent');
    await outGit.addConfig('user.email', 'agent@example.com');
    await outGit.raw(['mv', 'CLAUDE.md', 'OLD-NOTES.md']);
    await outGit.commit('chore: renomme');
    const r2 = await mergeAgentCommit({ root: repo.root, agent: 'agent-out' });
    expect(r2.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(r2.protectedChanges).toEqual([
      expect.objectContaining({ path: 'CLAUDE.md', status: 'D' }),
    ]);
  });

  it('allow journalisé → le merge passe, et le relâchement est logué à CHAQUE merge', async () => {
    await setConfig(repo.root, {
      testCommand: GATE_MARK,
      protectedAgentPaths: { allow: ['**/AGENTS.md'] },
    });
    const warn = vi.spyOn(logger, 'warn');
    await commitInAgent(agent, { 'pkg/AGENTS.md': '# pkg v2\n' });

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('MERGED');
    expect(await exists(path.join(repo.root, '.gate-ran'))).toBe(true);
    const messages = warn.mock.calls.map((c) => c.at(-1));
    expect(messages).toContain(
      'Garde des chemins protégés RELÂCHÉE par la config (protectedAgentPaths.allow / matchCase)',
    );
    const exempt = warn.mock.calls.find(
      (c) =>
        c.at(-1) ===
        'Chemin protégé changé par un agent, laissé passer par protectedAgentPaths.allow',
    );
    expect(exempt?.[0]).toMatchObject({ path: 'pkg/AGENTS.md', allow: '**/AGENTS.md' });

    // doctor affiche le relâchement.
    const report = await runDoctor(repo.root);
    const check = report.checks.find((c) => c.id === 'protected');
    expect(check).toMatchObject({ level: 'warn', key: 'protected.relaxed' });
    expect(check.params.allow).toEqual(['**/AGENTS.md']);
  });

  it('doctor : protection par défaut affichée en ok', async () => {
    const report = await runDoctor(repo.root);
    expect(report.checks.find((c) => c.id === 'protected')).toMatchObject({
      level: 'ok',
      key: 'protected.ok',
    });
  });

  it('extend : un chemin ajouté est protégé', async () => {
    await setConfig(repo.root, {
      testCommand: GATE_MARK,
      protectedAgentPaths: { extend: ['config/agent.yml'] },
    });
    await commitInAgent(agent, { 'config/agent.yml': 'x: 1\n' });
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.reason).toBe('PROTECTED_PATHS_CHANGED');
  });

  it('package.json : la clé striart est protégée, le reste du manifeste non', async () => {
    const manifest = JSON.parse(await readFile(path.join(repo.root, 'package.json'), 'utf8'));
    await commitInAgent(agent, {
      'package.json': JSON.stringify({ ...manifest, version: '1.1.0' }, null, 2),
    });
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).status).toBe('MERGED');

    await commitInAgent(agent, {
      'package.json': JSON.stringify(
        { ...manifest, version: '1.1.0', striart: { testCommand: 'true' } },
        null,
        2,
      ),
    });
    const refused = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(refused.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(refused.protectedChanges[0]).toMatchObject({
      path: 'package.json',
      kind: 'striart-config',
      pattern: 'package.json#striart,cosmiconfig',
    });
  });

  it('config de Striart et .striart/ versionnés : protégés', async () => {
    await commitInAgent(agent, { '.striartrc.yml': 'testCommand: "true"\n' });
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).reason).toBe(
      'PROTECTED_PATHS_CHANGED',
    );
  });

  it('un contenu déjà identique côté cible n’est pas un changement effectif', async () => {
    await commitInMain(repo, { 'CLAUDE.md': '# consignes v2\n' }, 'docs: humain');
    await setConfig(repo.root, { testCommand: GATE_MARK, autoRebase: false });
    await commitInAgent(agent, { 'CLAUDE.md': '# consignes v2\n', 'b.js': 'x\n' });
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).status).toBe('MERGED');
  });
});

describe('garde des chemins protégés (I2) — resolve --apply', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await commitInMain(repo, { 'AGENTS.md': '# humain\n', 'app.js': 'const v = "base";\n' });
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_MARK, semanticMerge: false });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('résolution humaine préparée → appliquée sous Test Gate, contenu = celui de l’humain', async () => {
    await commitInAgent(agent, { 'AGENTS.md': '# agent : désactive les tests\n', 'lib.js': 'x\n' });
    const refused = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    const { ticket } = refused;
    await writeFile(
      path.join(ticket.dir, `${safeFileName('AGENTS.md')}.resolved`),
      '# humain, relu\n',
    );

    const applied = await applyTicketResolution({ root: repo.root, ticketId: ticket.id });

    expect(applied.status).toBe('MERGED');
    expect(await readText(path.join(repo.root, 'AGENTS.md'))).toBe('# humain, relu\n');
    expect(await readText(path.join(repo.root, 'lib.js'))).toBe('x\n');
    expect(await exists(path.join(repo.root, '.gate-ran'))).toBe(true);
    expect(await listConflictTickets(repo.root)).toEqual([]);
  });

  it('accepter la version de l’agent passe par --prepare (décision explicite), gate rouge → GATE_FAILED', async () => {
    await setConfig(repo.root, { testCommand: GATE_KO, semanticMerge: false });
    await commitInAgent(agent, { 'AGENTS.md': '# agent\n' });
    const { ticket } = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    await prepareResolutionScaffold(repo.root, ticket.id, { acceptTheirs: ['AGENTS.md'] });

    const applied = await applyTicketResolution({ root: repo.root, ticketId: ticket.id });
    expect(applied.status).toBe('GATE_FAILED');
    expect(await readText(path.join(repo.root, 'AGENTS.md'))).toBe('# humain\n');
    await expectMainClean(repo.git);
  });

  it('S-I2 : le scaffold n’amorce JAMAIS un chemin protégé depuis la version de l’agent sans acceptTheirs explicite', async () => {
    await commitInAgent(agent, { 'AGENTS.md': '# agent : injecté\n' });
    const { ticket } = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    const files = await prepareResolutionScaffold(repo.root, ticket.id);
    expect(files).toEqual([
      expect.objectContaining({ path: 'AGENTS.md', created: false, source: null, held: true }),
    ]);
    expect(await exists(path.join(ticket.dir, `${safeFileName('AGENTS.md')}.resolved`))).toBe(
      false,
    );
    // Sans décision humaine préparée, --apply refuse (la version de l'agent ne passe pas seule).
    await expect(
      applyTicketResolution({ root: repo.root, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      code: 'RESOLUTION_INCOMPLETE',
    });

    const accepted = await prepareResolutionScaffold(repo.root, ticket.id, {
      acceptTheirs: ['AGENTS.md'],
    });
    expect(accepted[0]).toMatchObject({ created: true, source: 'theirs' });
    expect(await readText(path.join(ticket.dir, `${safeFileName('AGENTS.md')}.resolved`))).toBe(
      '# agent : injecté\n',
    );
  });

  it('chemin protégé + conflit textuel : un seul ticket couvre les deux', async () => {
    await commitInMain(repo, { 'app.js': 'const v = "main";\n' });
    await commitInAgent(agent, { 'app.js': 'const v = "agent";\n', '.mcp.json': '{}\n' });
    await setConfig(repo.root, { testCommand: GATE_MARK, semanticMerge: false, autoRebase: false });
    const refused = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(refused.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(refused.ticket.conflictedFiles.sort()).toEqual(['.mcp.json', 'app.js']);
    expect(refused.ticket.mergeConflictedFiles).toEqual(['app.js']);
    await expectMainClean(repo.git);

    await writeFile(
      path.join(refused.ticket.dir, `${safeFileName('app.js')}.resolved`),
      'const v = "both";\n',
    );
    await writeFile(path.join(refused.ticket.dir, `${safeFileName('.mcp.json')}.delete`), '');
    const applied = await applyTicketResolution({ root: repo.root, ticketId: refused.ticket.id });
    expect(applied.status).toBe('MERGED');
    expect(await readText(path.join(repo.root, 'app.js'))).toBe('const v = "both";\n');
    expect(await exists(path.join(repo.root, '.mcp.json'))).toBe(false);
  });

  it('ticket MERGE_CONFLICT dont le commit change AUSSI AGENTS.md hors conflit → PROTECTED_PATHS_CHANGED', async () => {
    await commitInMain(repo, { 'app.js': 'const v = "main";\n' });
    const sha = await commitInAgent(agent, {
      'app.js': 'const v = "agent";\n',
      'AGENTS.md': '# agent\n',
    });
    // Ticket « hérité » (créé avant la garde) : seul app.js y est à trancher.
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: agent.branch,
      sha,
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['app.js'],
      resolutions: [{ path: 'app.js', base: 'b', ours: 'o', theirs: 't' }],
    });
    await writeFile(
      path.join(ticket.dir, `${safeFileName('app.js')}.resolved`),
      'const v = "x";\n',
    );
    const headBefore = (await repo.git.revparse(['HEAD'])).trim();

    await expect(
      applyTicketResolution({ root: repo.root, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      code: 'PROTECTED_PATHS_CHANGED',
      kind: 'refusal',
      details: { files: ['AGENTS.md'] },
    });
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(headBefore);
    await expectMainClean(repo.git);
  });
});

describe('garde des chemins protégés (I2) — mode autonome', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ response: '{"files":["x.js"]}' }) })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.FAKE_AGENT_SPEC;
    await repo.cleanup();
  });

  it('ni --force ni --allow-historical-secrets ne lèvent la garde', async () => {
    await setConfig(repo.root, {
      testCommand: GATE_MARK,
      agentProfiles: { files: { command: process.execPath, args: [FAKE_FILES, '{{prompt}}'] } },
    });
    process.env.FAKE_AGENT_SPEC = JSON.stringify({
      write: { '.claude/settings.json': '{"hooks":{}}\n', 'x.js': 'x\n' },
      commit: true,
    });

    const result = await runAutonomousTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'tâche',
      profile: 'files',
      force: true,
      allowHistoricalSecrets: true,
    });

    expect(result.status).toBe('MERGE_BLOCKED');
    expect(result.keptCode).toBe('MERGE_BLOCKED');
    expect(result.keptDetail).toBe('PROTECTED_PATHS_CHANGED');
    expect(result.merge.reason).toBe('PROTECTED_PATHS_CHANGED');
    expect(await exists(path.join(repo.root, '.claude', 'settings.json'))).toBe(false);
    expect(await exists(path.join(repo.root, '.gate-ran'))).toBe(false);
    expect(await exists(result.clonePath)).toBe(true);
  });
});
