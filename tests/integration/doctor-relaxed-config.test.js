import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { runDoctor } from '../../src/doctor.ts';

const check = (result, id) => result.checks.find((c) => c.id === id);

/**
 * Un réglage de config-as-code qui DÉSACTIVE une protection ne se rend jamais
 * en « ignoré » neutre ni sous un « défauts sûrs partout » : doctor le nomme.
 */
describe('striart doctor : protections relâchées par la config (C-I3)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('secretPatterns: [] → secrets en warn ET agrégé dans relaxations', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ secretPatterns: [] }),
    );
    await initStriart(repo.root);

    const result = await runDoctor(repo.root);

    const secrets = check(result, 'secrets');
    expect(secrets.level).toBe('warn');
    expect(secrets.detail).toContain('secretPatterns: []');
    expect(secrets.hint).toContain('secretPatterns');
    const relaxations = check(result, 'relaxations');
    expect(relaxations.level).toBe('warn');
    expect(relaxations.detail).toContain('secretPatterns');
  });

  it('terminal.launcher custom → relaxations le nomme', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        terminal: { launcher: 'custom', custom: { command: 'xterm', args: ['-e', '{{argv}}'] } },
      }),
    );
    await initStriart(repo.root);

    const relaxations = check(await runDoctor(repo.root), 'relaxations');

    expect(relaxations.level).toBe('warn');
    expect(relaxations.detail).toContain('terminal.launcher');
  });

  it('défauts : aucune relaxation, secrets ok', async () => {
    await initStriart(repo.root);

    const result = await runDoctor(repo.root);

    expect(check(result, 'secrets').level).toBe('ok');
    expect(check(result, 'relaxations').level).toBe('ok');
  });

  it('clé de premier niveau inconnue (faute de frappe) → config en warn, sans refuser la config', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      // `unknownConfigKeys: 'warn'` : la clé est tolérée (politique du noyau de
      // config) ; doctor ne la tait pas pour autant.
      JSON.stringify({ testTimeoutMz: 5000, targetBranch: 'master', unknownConfigKeys: 'warn' }),
    );
    await initStriart(repo.root);

    const config = check(await runDoctor(repo.root), 'config');

    expect(config.level).toBe('warn');
    expect(config.detail).toContain('testTimeoutMz');
    expect(config.detail).not.toContain('targetBranch');
    expect(config.hint).toContain('docs');
  });

  it('config sans clé inconnue : ok', async () => {
    await initStriart(repo.root);
    expect(check(await runDoctor(repo.root), 'config').level).toBe('ok');
  });
});
