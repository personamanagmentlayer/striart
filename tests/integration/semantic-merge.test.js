import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { mergeAgentCommit } from '../../src/orchestrator.js';
import { readState, resetManualMode } from '../../src/state.js';

const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'gate rouge\'); process.exit(1)"';

const LLM_MERGED = '// fusion sémantique\nconst merged = true;\n';

function mockMergerLLM(response) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ response }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockMergerLLMFailure() {
  const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Crée un conflit : main et l'agent modifient différemment app.js. */
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

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

describe('fusion sémantique (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
    // app.js doit exister avant le clone... il est créé après : makeConflict gère les deux côtés.
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('résout un conflit via le LLM quand le Test Gate passe', async () => {
    await makeConflict(repo, agent);
    mockMergerLLM(LLM_MERGED);

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('MERGED');
    expect(result.semantic).toBe(true);
    expect(result.resolvedFiles).toEqual(['app.js']);

    // Le fichier mergé est celui produit par le LLM, commit de merge annoté.
    await expect(readFile(path.join(repo.root, 'app.js'), 'utf8')).resolves.toBe(LLM_MERGED);
    const log = await repo.git.log({ maxCount: 1 });
    expect(log.latest.message).toContain('fusion sémantique: app.js');

    // Succès → compteur d'échecs remis à zéro.
    expect(await readState(repo.root)).toMatchObject({
      semanticFailureStreak: 0,
      manualMode: false,
    });

    // Le prompt envoyé contenait bien les 3 versions.
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('const version = "main"');
    expect(body.prompt).toContain('const version = "agent"');
  });

  it('retry post-gate : la fusion échoue aux tests, le Merger corrige avec le feedback → MERGED', async () => {
    // Le gate exécute le fichier fusionné : la 1re fusion LLM plante les
    // tests, la 2e (nourrie du log d'erreur) les fait passer.
    await setConfig(repo.root, { testCommand: 'node app.js', semanticGateRetries: 1 });
    await makeConflict(repo, agent);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'console.error("BOOM du gate"); process.exit(1);' }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'const merged = true;\nprocess.exit(0);' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('MERGED');
    expect(result.semantic).toBe(true);
    expect(result.gateRetries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Le 2e prompt du Merger contient le log du gate rouge.
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.prompt).toContain('BOOM du gate');
    // C'est la fusion corrigée qui est commitée.
    await expect(readFile(path.join(repo.root, 'app.js'), 'utf8')).resolves.toContain(
      'process.exit(0)',
    );
    // Succès final → pas d'échec sémantique compté.
    expect(await readState(repo.root)).toMatchObject({
      semanticFailureStreak: 0,
      manualMode: false,
    });
  });

  it('retry épuisé → ticket SEMANTIC_GATE_FAILED (le retry ne masque pas un vrai échec)', async () => {
    await setConfig(repo.root, { testCommand: GATE_KO, semanticGateRetries: 1 });
    await makeConflict(repo, agent);
    const fetchMock = mockMergerLLM(LLM_MERGED);

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('GATE_FAILED');
    // 1 fusion initiale + 1 retry, puis ticket.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ticket = JSON.parse(await readFile(path.join(result.ticket.dir, 'ticket.json'), 'utf8'));
    expect(ticket.reason).toBe('SEMANTIC_GATE_FAILED');
    expect((await readState(repo.root)).semanticFailureStreak).toBe(1);
  });

  it('gate rouge après fusion LLM → abort + ticket SEMANTIC_GATE_FAILED + échec compté', async () => {
    await setConfig(repo.root, { testCommand: GATE_KO });
    await makeConflict(repo, agent);
    mockMergerLLM(LLM_MERGED);

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('GATE_FAILED');
    expect(result.semantic).toBe(true);

    // Merge annulé : app.js restauré côté main.
    const appJs = await readFile(path.join(repo.root, 'app.js'), 'utf8');
    expect(appJs.replaceAll('\r\n', '\n')).toBe('const version = "main";\n');

    // Ticket avec les 3 versions + la tentative LLM + le log du gate.
    const files = await readdir(result.ticket.dir);
    expect(files).toEqual(
      expect.arrayContaining([
        'ticket.json',
        'test-output.log',
        'app.js.base',
        'app.js.ours',
        'app.js.theirs',
        'app.js.llm-attempt',
      ]),
    );
    await expect(
      readFile(path.join(result.ticket.dir, 'app.js.llm-attempt'), 'utf8'),
    ).resolves.toBe(LLM_MERGED);
    const ticket = JSON.parse(await readFile(path.join(result.ticket.dir, 'ticket.json'), 'utf8'));
    expect(ticket.reason).toBe('SEMANTIC_GATE_FAILED');

    expect((await readState(repo.root)).semanticFailureStreak).toBe(1);
  });

  it('LLM injoignable → abort + ticket SEMANTIC_MERGE_FAILED avec les 3 versions', async () => {
    await makeConflict(repo, agent);
    mockMergerLLMFailure();

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('SEMANTIC_MERGE_FAILED');

    const files = await readdir(result.ticket.dir);
    expect(files).toEqual(
      expect.arrayContaining(['ticket.json', 'app.js.base', 'app.js.ours', 'app.js.theirs']),
    );
    expect(files).not.toContain('app.js.llm-attempt');
    expect((await readState(repo.root)).semanticFailureStreak).toBe(1);
  });

  it("règle d'or n°4 : 3 échecs → mode manuel, le LLM n'est plus appelé, --unlock réactive", async () => {
    await makeConflict(repo, agent);
    const failingFetch = mockMergerLLMFailure();

    // 3 échecs consécutifs (le conflit persiste : chaque tentative échoue).
    for (let i = 0; i < 3; i += 1) {
      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(result.reason).toBe('SEMANTIC_MERGE_FAILED');
    }
    expect((await readState(repo.root)).manualMode).toBe(true);

    // 4e tentative : ticket direct, sans appel LLM.
    failingFetch.mockClear();
    const manual = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(manual.reason).toBe('MERGE_CONFLICT');
    expect(manual.manualMode).toBe(true);
    expect(failingFetch).not.toHaveBeenCalled();

    // Unlock + LLM réparé → la fusion repasse.
    await resetManualMode(repo.root);
    mockMergerLLM(LLM_MERGED);
    const fixed = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(fixed.status).toBe('MERGED');
    expect(fixed.semantic).toBe(true);
  });

  it('semanticMerge désactivé en config → ticket MERGE_CONFLICT sans appel LLM', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, semanticMerge: false });
    await makeConflict(repo, agent);
    const fetchMock = mockMergerLLM(LLM_MERGED);

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('MERGE_CONFLICT');
    expect(fetchMock).not.toHaveBeenCalled();
    // Pas un échec sémantique : le compteur n'est pas incrémenté.
    expect((await readState(repo.root)).semanticFailureStreak).toBe(0);
  });

  it('suppression (main) vs modification (agent) → ticket UNMERGEABLE_CONFLICT sans appel LLM', async () => {
    // lib.js doit exister AVANT le clone pour être l'ancêtre commun.
    await writeFile(path.join(repo.root, 'lib.js'), 'export const lib = 1;\n');
    await repo.git.add(['lib.js']);
    await repo.git.commit('feat: lib');
    const agentB = await createAgent({ root: repo.root, name: 'agent-b' });

    await repo.git.rm(['lib.js']);
    await repo.git.commit('refactor: supprime lib.js');

    const agentGit = simpleGit(agentB.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(agentB.path, 'lib.js'), 'export const lib = 2;\n');
    await agentGit.add(['lib.js']);
    await agentGit.commit('feat: lib v2');

    const fetchMock = mockMergerLLM(LLM_MERGED);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-b' });

    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('UNMERGEABLE_CONFLICT');
    expect(result.unmergeable).toEqual([{ path: 'lib.js', kind: 'delete', deletedBy: 'ours' }]);
    expect(fetchMock).not.toHaveBeenCalled();
    // Pas un échec du LLM : le compteur sémantique reste à zéro.
    expect((await readState(repo.root)).semanticFailureStreak).toBe(0);

    // Merge annulé : lib.js reste supprimé côté main, la nature du conflit est dans le ticket.
    await expect(readFile(path.join(repo.root, 'lib.js'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const ticket = JSON.parse(await readFile(path.join(result.ticket.dir, 'ticket.json'), 'utf8'));
    expect(ticket.reason).toBe('UNMERGEABLE_CONFLICT');
    expect(ticket.unmergeable).toEqual([{ path: 'lib.js', kind: 'delete', deletedBy: 'ours' }]);
  });

  it('conflit sur fichier binaire → ticket UNMERGEABLE_CONFLICT sans appel LLM', async () => {
    const binary = (marker) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, marker, 0x00, 0xff]);
    await writeFile(path.join(repo.root, 'logo.bin'), binary(1));
    await repo.git.add(['logo.bin']);
    await repo.git.commit('feat: logo');
    const agentC = await createAgent({ root: repo.root, name: 'agent-c' });

    await writeFile(path.join(repo.root, 'logo.bin'), binary(2));
    await repo.git.add(['logo.bin']);
    await repo.git.commit('feat: logo main');

    const agentGit = simpleGit(agentC.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(agentC.path, 'logo.bin'), binary(3));
    await agentGit.add(['logo.bin']);
    await agentGit.commit('feat: logo agent');

    const fetchMock = mockMergerLLM(LLM_MERGED);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-c' });

    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('UNMERGEABLE_CONFLICT');
    expect(result.unmergeable).toEqual([{ path: 'logo.bin', kind: 'binary' }]);
    expect(fetchMock).not.toHaveBeenCalled();

    // Merge annulé : le binaire de main est intact (pas de réécriture utf8).
    const bytes = await readFile(path.join(repo.root, 'logo.bin'));
    expect([...bytes]).toEqual([...binary(2)]);
  });

  it('renommage/renommage → ticket UNMERGEABLE_CONFLICT (path), sans appel LLM', async () => {
    // Fichier assez long pour que git détecte les DEUX renommages malgré une
    // édition de chaque côté (similarité au-dessus du seuil de rename detection).
    const lines = (edit) =>
      Array.from({ length: 20 }, (_, i) => `export const l${i} = ${i};`)
        .concat(edit)
        .join('\n') + '\n';
    await writeFile(path.join(repo.root, 'old.js'), lines('// base'));
    await repo.git.add(['old.js']);
    await repo.git.commit('feat: old.js');
    const agentD = await createAgent({ root: repo.root, name: 'agent-d' });

    await repo.git.mv('old.js', 'renamed-main.js');
    await writeFile(path.join(repo.root, 'renamed-main.js'), lines('// main'));
    await repo.git.add(['renamed-main.js']);
    await repo.git.commit('refactor: renomme côté main');

    const agentGit = simpleGit(agentD.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await agentGit.mv('old.js', 'renamed-agent.js');
    await writeFile(path.join(agentD.path, 'renamed-agent.js'), lines('// agent'));
    await agentGit.add(['renamed-agent.js']);
    await agentGit.commit('refactor: renomme côté agent');

    const fetchMock = mockMergerLLM(LLM_MERGED);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-d' });

    expect(result.status).toBe('CONFLICT');
    expect(result.reason).toBe('UNMERGEABLE_CONFLICT');
    // Au moins un des chemins du rename est classé conflit de chemin,
    // et surtout : aucun contenu inventé par LLM, aucun appel réseau.
    expect((result.unmergeable ?? []).some((c) => c.kind === 'path')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await readState(repo.root)).semanticFailureStreak).toBe(0);
  });

  it('bit exécutable identique des deux côtés → préservé après fusion sémantique', async () => {
    await writeFile(path.join(repo.root, 'run.sh'), '#!/bin/sh\necho base\n');
    await repo.git.add(['run.sh']);
    await repo.git.raw(['update-index', '--chmod=+x', '--', 'run.sh']);
    await repo.git.commit('feat: run.sh exécutable');
    const agentE = await createAgent({ root: repo.root, name: 'agent-e' });

    await writeFile(path.join(repo.root, 'run.sh'), '#!/bin/sh\necho main\n');
    await repo.git.add(['run.sh']);
    await repo.git.commit('feat: run.sh main');

    const agentGit = simpleGit(agentE.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(agentE.path, 'run.sh'), '#!/bin/sh\necho agent\n');
    await agentGit.add(['run.sh']);
    await agentGit.commit('feat: run.sh agent');

    mockMergerLLM('#!/bin/sh\necho merged\n');
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-e' });

    expect(result.status).toBe('MERGED');
    expect(result.semantic).toBe(true);
    // Le mode 100755 survit à la réécriture writeFile (qui l'aurait perdu).
    const lsFiles = await repo.git.raw(['ls-files', '-s', '--', 'run.sh']);
    expect(lsFiles).toContain('100755');
  });

  it('double-renommage invisible pour git → merge propre MAIS avertissement renameHazards', async () => {
    // Fichier assez petit pour que la similarité par chunks de git tombe à
    // zéro dès qu'une ligne change : les deux renommages passent inaperçus,
    // le merge est "propre" et le fichier ressort en double.
    const content = (last) => `a\nb\n${last}\n`;
    await writeFile(path.join(repo.root, 'tiny.js'), content('c'));
    await repo.git.add(['tiny.js']);
    await repo.git.commit('feat: tiny.js');
    const agentF = await createAgent({ root: repo.root, name: 'agent-f' });

    await repo.git.mv('tiny.js', 'renamed-main.js');
    await writeFile(path.join(repo.root, 'renamed-main.js'), content('MAIN'));
    await repo.git.add(['renamed-main.js']);
    await repo.git.commit('refactor: renomme côté main');

    const agentGit = simpleGit(agentF.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await agentGit.mv('tiny.js', 'renamed-agent.js');
    await writeFile(path.join(agentF.path, 'renamed-agent.js'), content('AGENT'));
    await agentGit.add(['renamed-agent.js']);
    await agentGit.commit('refactor: renomme côté agent');

    const fetchMock = mockMergerLLM(LLM_MERGED);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-f' });

    // Aucun conflit signalé par git : le merge passe... mais pas en silence.
    expect(result.status).toBe('MERGED');
    expect(result.renameHazards).toEqual([
      { source: 'tiny.js', ours: 'renamed-main.js', theirs: 'renamed-agent.js' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    // La signature du danger : le fichier existe bien en double après merge.
    await expect(readFile(path.join(repo.root, 'renamed-main.js'), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(path.join(repo.root, 'renamed-agent.js'), 'utf8')).resolves.toBeTruthy();
  });
});
