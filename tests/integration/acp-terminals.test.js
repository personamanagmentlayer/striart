import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalManager } from '../../src/acp/terminals.ts';

const LIMITS = { enabled: true, timeoutMs: 60_000, outputByteLimit: 100_000, maxTerminals: 2 };

describe('ACP terminaux : plafond maxTerminals', () => {
  let dir;
  let manager;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-term-'));
    manager = new TerminalManager({
      cloneRoot: dir,
      env: process.env,
      limits: LIMITS,
      log: () => undefined,
    });
  });
  afterEach(async () => {
    await manager.releaseAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const quick = () => manager.create({ command: process.execPath, args: ['-e', '0'] });
  const forever = () =>
    manager.create({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });

  it('des terminaux terminés mais non libérés ne bloquent pas les suivants', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { terminalId } = await quick();
      await manager.waitForExit({ terminalId });
    }
  });

  it('le plafond reste appliqué aux terminaux VIVANTS', async () => {
    await forever();
    await forever();
    await expect(forever()).rejects.toThrow(/at most 2 terminals/);
  });

  it('les terminaux terminés conservés sont bornés (le plus ancien est libéré)', async () => {
    const first = await quick();
    await manager.waitForExit({ terminalId: first.terminalId });
    for (let i = 0; i < 3; i += 1) {
      const { terminalId } = await quick();
      await manager.waitForExit({ terminalId });
    }
    expect(() => manager.output({ terminalId: first.terminalId })).toThrow(/released/);
  });
});
