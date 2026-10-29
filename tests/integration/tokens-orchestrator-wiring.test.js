/**
 * Branchements du lot T dans l'orchestrateur (intégration : vrais repos Git,
 * LLM mocké) : attribution des appels du Router / Merger / Memory Layer à
 * l'agent et à la tâche, cache du Router lié à HEAD, plafond d'entrée du
 * Merger relevé pour la fusion par régions, et refus de budget qui ne
 * comptent PAS comme des échecs sémantiques (pas de mode manuel).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import { mergeAgentCommit, runTask } from '../../src/orchestrator.ts';
import { readState } from '../../src/state.ts';
import { readRecords, resetUsageIndex } from '../../src/tokens/ledger.ts';
import { resetRootCache } from '../../src/tokens/call.ts';

const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'gate rouge\'); process.exit(1)"';

const reply = (response, extra = {}) => ({
  ok: true,
  json: async () => ({ response, done_reason: 'stop', ...extra }),
});

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

/** Conflit à trois voies sur app.js entre main et le clone. */
async function makeConflict(repo, agent) {
  await writeFile(path.join(repo.root, 'app.js'), 'const version = "main";\n');
  await repo.git.add(['app.js']);
  await repo.git.commit('feat: version main');
  const agentGit = simpleGit(agent.path);
  await agentGit.addConfig('user.name', 'Agent');
  await agentGit.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(agent.path, 'app.js'), 'const version = "agent";\n');
  await agentGit.add(['app.js']);
  await agentGit.commit('feat: version agent');
}

describe('lot T dans l’orchestrateur : attribution, cache, plafonds', () => {
  let repo;

  beforeEach(async () => {
    resetUsageIndex();
    resetRootCache();
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  describe('attribution des appels (withTokenContext)', () => {
    it('Merger : l’appel de fusion sémantique porte l’agent ET la tâche du clone', async () => {
      await setConfig(repo.root, { testCommand: GATE_OK });
      const agent = await createAgent({ root: repo.root, name: 'agent-a' });
      await makeConflict(repo, agent);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('const merged = true;\n')));

      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(result.status).toBe('MERGED');

      const merger = (await readRecords(repo.root)).records.filter((r) => r.role === 'merger');
      expect(merger).toHaveLength(1);
      expect(merger[0]).toMatchObject({ agent: 'agent-a', taskId: agent.taskId });
    });

    it('Memory Layer : le résumé du merge porte l’agent et la tâche', async () => {
      await setConfig(repo.root, { testCommand: GATE_OK, memoryLayer: true });
      const agent = await createAgent({ root: repo.root, name: 'agent-m' });
      const agentGit = simpleGit(agent.path);
      await agentGit.addConfig('user.name', 'Agent');
      await agentGit.addConfig('user.email', 'agent@example.com');
      await writeFile(path.join(agent.path, 'api.js'), 'export function hello() {}\n');
      await agentGit.add(['api.js']);
      await agentGit.commit('feat: api');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('- hello() ajouté dans api.js')));

      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-m' });
      expect(result.status).toBe('MERGED');
      expect(result.memory).toMatchObject({ updated: true });

      const memory = (await readRecords(repo.root)).records.filter((r) => r.role === 'memory');
      expect(memory).toHaveLength(1);
      expect(memory[0]).toMatchObject({ agent: 'agent-m', taskId: agent.taskId });
    });

    it('Router : la prédiction est relevée dans le registre de CE dépôt, au nom de l’agent', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('{"files": ["README.md"]}')));
      const started = await runTask({
        root: repo.root,
        agent: 'agent-r',
        prompt: 'édite le README',
      });
      expect(started.status).toBe('STARTED');

      const router = (await readRecords(repo.root)).records.filter((r) => r.role === 'router');
      expect(router).toHaveLength(1);
      expect(router[0]).toMatchObject({ agent: 'agent-r' });
    });
  });

  describe('cache du Router lié à HEAD', () => {
    it('un nouveau commit sur la cible invalide la prédiction en cache ; sans changement de HEAD elle est servie du cache', async () => {
      const fetchMock = vi.fn().mockResolvedValue(reply('{"files": ["README.md"]}'));
      vi.stubGlobal('fetch', fetchMock);

      await runTask({ root: repo.root, agent: 'c1', prompt: 'même tâche' });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Même HEAD, même arbre, même tâche : cache.
      await runTask({ root: repo.root, agent: 'c2', prompt: 'même tâche' });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // HEAD change SANS changer la liste des fichiers : la prédiction ne doit
      // plus être resservie (le contenu a pu changer, donc ce que la tâche touche).
      await writeFile(path.join(repo.root, 'README.md'), '# test modifié\n');
      await repo.git.add(['README.md']);
      await repo.git.commit('docs: readme');
      await runTask({ root: repo.root, agent: 'c3', prompt: 'même tâche' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('plafond d’entrée du Merger (fusion par régions)', () => {
    it('un conflit de plus de 120 000 caractères n’est plus « oversized » : seule la région part au LLM', async () => {
      const lines = (n, edits = {}) =>
        `${Array.from({ length: n }, (_, i) => edits[i + 1] ?? `// ligne ${i + 1} : du code existant pour faire du volume`).join('\n')}\nprocess.exit(0);\n`;
      await setConfig(repo.root, { testCommand: 'node big.js' });
      await writeFile(path.join(repo.root, 'big.js'), lines(1500));
      await repo.git.add(['big.js', '.striartrc.json']);
      await repo.git.commit('chore: big file');
      const agent = await createAgent({ root: repo.root, name: 'agent-big' });

      await writeFile(path.join(repo.root, 'big.js'), lines(1500, { 700: 'const side = "main";' }));
      await repo.git.add(['big.js']);
      await repo.git.commit('feat: main');
      const agentGit = simpleGit(agent.path);
      await agentGit.addConfig('user.name', 'Agent');
      await agentGit.addConfig('user.email', 'agent@example.com');
      await writeFile(
        path.join(agent.path, 'big.js'),
        lines(1500, { 700: 'const side = "agent";' }),
      );
      await agentGit.add(['big.js']);
      await agentGit.commit('feat: agent');
      expect((await readFile(path.join(agent.path, 'big.js'), 'utf8')).length * 3).toBeGreaterThan(
        120_000,
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(reply('<<<REGION 1>>>\nconst side = "both";\n<<<END 1>>>')),
      );
      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-big' });
      expect(result.reason).not.toBe('UNMERGEABLE_CONFLICT');
      expect(result.status).toBe('MERGED');
      expect(result.semantic).toBe(true);
    });
  });

  describe('un refus de budget n’est pas un échec sémantique', () => {
    const overBudget = { tokens: { budgets: { perCall: { maxInputTokens: 10 } } } };

    it('3 refus TOKEN_BUDGET_EXCEEDED d’affilée : tickets SEMANTIC_MERGE_FAILED, mais ni compteur d’échecs ni mode manuel', async () => {
      await setConfig(repo.root, { testCommand: GATE_OK, ...overBudget });
      const agent = await createAgent({ root: repo.root, name: 'agent-b' });
      await makeConflict(repo, agent);
      const fetchMock = vi.fn().mockResolvedValue(reply('const merged = true;\n'));
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 3; i += 1) {
        const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-b' });
        expect(result).toMatchObject({
          status: 'CONFLICT',
          reason: 'SEMANTIC_MERGE_FAILED',
          manualMode: false,
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readState(repo.root)).toMatchObject({
        semanticFailureStreak: 0,
        manualMode: false,
      });
    }, 300_000); // 3 merges en conflit séquentiels : voir vitest.config.js (budget propre > défaut)

    it('MERGE_WINDOW_EXCEEDED : ticket humain SEMANTIC_MERGE_FAILED, sans compter d’échec', async () => {
      const lines = (n, edits = {}) =>
        `${Array.from({ length: n }, (_, i) => edits[i + 1] ?? `// ligne ${i + 1} : du code existant pour faire du volume`).join('\n')}\n`;
      await setConfig(repo.root, {
        testCommand: GATE_OK,
        tokens: { merger: { mode: 'full', maxWindowTokens: 1000 } },
      });
      await writeFile(path.join(repo.root, 'big.js'), lines(300));
      await repo.git.add(['big.js', '.striartrc.json']);
      await repo.git.commit('chore: big');
      const agent = await createAgent({ root: repo.root, name: 'agent-w' });
      await writeFile(path.join(repo.root, 'big.js'), lines(300, { 10: '// main' }));
      await repo.git.add(['big.js']);
      await repo.git.commit('feat: main');
      const agentGit = simpleGit(agent.path);
      await agentGit.addConfig('user.name', 'Agent');
      await agentGit.addConfig('user.email', 'agent@example.com');
      await writeFile(path.join(agent.path, 'big.js'), lines(300, { 10: '// agent' }));
      await agentGit.add(['big.js']);
      await agentGit.commit('feat: agent');
      const fetchMock = vi.fn().mockResolvedValue(reply('x\n'));
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 3; i += 1) {
        const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-w' });
        expect(result).toMatchObject({ status: 'CONFLICT', reason: 'SEMANTIC_MERGE_FAILED' });
        expect(result.error).toMatch(/window/i);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readState(repo.root)).toMatchObject({
        semanticFailureStreak: 0,
        manualMode: false,
      });
    });

    it('retry post-gate refusé par le budget : le gate rouge garde son ticket, sans compter d’échec sémantique', async () => {
      // Fusion initiale acceptée (5 100 jetons relevés, au-delà du plafond), puis le plafond du jour
      // refuse le retry : le gate reste rouge, le ticket est ouvert, mais le
      // refus de budget ne fait pas avancer le compteur du mode manuel.
      await setConfig(repo.root, {
        testCommand: GATE_KO,
        semanticGateRetries: 1,
        tokens: { budgets: { perDay: { maxTokens: 5000 } } },
      });
      const agent = await createAgent({ root: repo.root, name: 'agent-r2' });
      await makeConflict(repo, agent);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          reply('const merged = true;\n', { prompt_eval_count: 5000, eval_count: 100 }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-r2' });
      expect(result.status).toBe('GATE_FAILED');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const ticket = JSON.parse(
        await readFile(path.join(result.ticket.dir, 'ticket.json'), 'utf8'),
      );
      expect(ticket.reason).toBe('SEMANTIC_GATE_FAILED');
      expect(await readState(repo.root)).toMatchObject({
        semanticFailureStreak: 0,
        manualMode: false,
      });
    });
  });
});
