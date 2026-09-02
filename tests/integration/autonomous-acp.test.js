import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { runAutonomousTask } from '../../src/orchestrator.js';

const FAKE_ACP = fileURLToPath(new URL('../helpers/fake-acp-agent.cjs', import.meta.url));
const GATE_OK = 'node -e "process.exit(0)"';

/**
 * Profil ACP pointant sur le faux agent ACP : même contrat qu'un vrai
 * adaptateur (claude-agent-acp, gemini --experimental-acp…). Pas de
 * {{prompt}} : le prompt passe par le protocole.
 */
const acpProfile = { command: process.execPath, args: [FAKE_ACP], acp: true };

async function setConfig(root, config) {
  await writeFile(
    path.join(root, '.striartrc.json'),
    JSON.stringify({ agentProfiles: { 'fake-acp': acpProfile }, ...config }),
  );
}

function mockRouter(files) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ files }) }) })),
  );
}

const exists = async (p) => Boolean(await stat(p).catch(() => null));

describe('mode autonome en transport ACP — cycle complet (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    mockRouter(['feature.js']);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.FAKE_ACP_MODE;
    await repo.cleanup();
  });

  const run = (extra = {}) =>
    runAutonomousTask({
      root: repo.root,
      agent: 'agent-acp',
      prompt: 'ajoute une feature',
      profile: 'fake-acp',
      ...extra,
    });

  it('chemin vert ACP : session (protocole) → merge → gate → clone supprimé', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_ACP_MODE = 'commit';

    const result = await run();

    // Même contrat que le transport argv : l'orchestrateur ne voit pas la
    // différence — c'est l'invariant central de l'intégration ACP.
    expect(result.status).toBe('MERGED');
    expect(result.session.status).toBe('COMPLETED');
    expect(result.session.stopReason).toBe('end_turn');
    expect(result.merge.status).toBe('MERGED');
    expect(result.cleaned).toBe(true);

    const merged = await readFile(path.join(repo.root, 'feature.js'), 'utf8');
    expect(merged).toContain('export const feature');
    expect(await readRegistry(repo.root)).toEqual({});
    expect(await exists(result.clonePath)).toBe(false);

    // Le log de session survit au clone et raconte le déroulé protocolaire.
    const log = await readFile(result.session.logPath, 'utf8');
    expect(log).toContain('handshake ok');
    expect(log).toContain('[outil] git commit');
  });

  it('refusal ACP → SESSION_FAILED, clone conservé pour diagnostic', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_ACP_MODE = 'refusal';

    const result = await run();

    expect(result.status).toBe('SESSION_FAILED');
    expect(result.session.status).toBe('FAILED');
    expect(result.session.stopReason).toBe('refusal');
    expect(result.cleaned).toBe(false);
    expect(result.keptReason).toMatch(/FAILED/);
    expect(await exists(result.clonePath)).toBe(true);
  });

  it('délai dépassé → cancel protocolaire puis kill, SESSION_FAILED (TIMEOUT)', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_ACP_MODE = 'hang';

    const result = await run({ timeoutMs: 2_000 });

    expect(result.status).toBe('SESSION_FAILED');
    expect(result.session.status).toBe('TIMEOUT');
    expect(result.session.timedOut).toBe(true);
    expect(await exists(result.clonePath)).toBe(true);
    // Le PID de session est dépublié même sur échec : pas de session fantôme.
    const registry = await readRegistry(repo.root);
    expect(registry['agent-acp'].sessionPid).toBeNull();
  });
});
