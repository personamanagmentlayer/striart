/**
 * Test Gate à ORPHELIN, de bout en bout (conteneur natif réel) : la commande de
 * test sort en 0 mais laisse un descendant vivant au-delà du délai de grâce
 * (`gateOrphanGraceMs`). Le gate est ROUGE (GATE_ORPHAN_PROCESS), l'orphelin est
 * tué, le merge est annulé, et le ticket garde la cause et les PID.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { mergeAgentCommit } from '../../src/orchestrator.js';
import { readTicketDetail } from '../../src/conflicts.js';
import { isProcessAlive } from '../../src/process-tree.js';
import { nativeDiagnostic } from '../../src/native.ts';

const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());
const native = await nativeDiagnostic();
const nativeAvailable = Boolean(native.binary);

describe.skipIf(!nativeAvailable)('Test Gate à orphelin (conteneur natif réel)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    const script = path.join(repo.root, '.striart', 'leaky-test.cjs');
    await writeFile(
      script,
      "const { spawn } = require('node:child_process');\n" +
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });\n" +
        "require('node:fs').writeFileSync(process.argv[2], String(child.pid));\n" +
        'child.unref();\n',
    );
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        testCommand: `node ${JSON.stringify(script)} ${JSON.stringify(path.join(repo.root, '.striart', 'orphan.pid'))}`,
        gateOrphanGraceMs: 300,
        semanticMerge: false,
      }),
    );
  });

  afterEach(async () => {
    try {
      const pid = Number(await readFile(path.join(repo.root, '.striart', 'orphan.pid'), 'utf8'));
      if (isProcessAlive(pid)) process.kill(pid);
    } catch {
      // Déjà tué par le gate, ou jamais lancé.
    }
    await repo.cleanup();
  });

  it('gate rouge GATE_ORPHAN_PROCESS : orphelin tué, merge annulé, ticket portant code et PID', async () => {
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    await writeFile(path.join(agent.path, 'f.js'), 'export const f = 1;\n');
    await git(agent.path, 'add', 'f.js');
    await git(
      agent.path,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: f',
    );
    const before = await git(repo.root, 'rev-parse', 'HEAD');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('GATE_FAILED');
    expect(result.gate).toMatchObject({ success: false, code: 'GATE_ORPHAN_PROCESS' });
    expect(result.gate.orphanPids.length).toBeGreaterThan(0);
    // Le merge est annulé, l'orphelin est mort.
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
    for (const pid of result.gate.orphanPids) expect(isProcessAlive(pid)).toBe(false);
    // Le ticket garde la cause stable et les PID tués.
    const detail = await readTicketDetail(repo.root, result.ticket.id);
    expect(detail.reason).toBe('GATE_FAILED');
    expect(detail.gate).toMatchObject({ code: 'GATE_ORPHAN_PROCESS' });
    expect(detail.gate.orphanPids).toEqual(result.gate.orphanPids);
  });
});
