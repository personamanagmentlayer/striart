/**
 * `striart doctor` : clés de confiance du binaire natif (épinglée + celles de la
 * config UTILISATEUR `native.trustedKeyIds`) et conteneur du Test Gate
 * (`gateContainer`, relâchement 'process' affiché).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { runDoctor } from '../../src/doctor.js';
import { PINNED_NATIVE_KEY_IDS } from '../../src/native.ts';

const check = (result, id) => result.checks.find((c) => c.id === id);

describe('doctor — clés natives et conteneur du Test Gate (intégration)', () => {
  let repo;
  let configHome;

  beforeEach(async () => {
    repo = await createTempRepo();
    configHome = await mkdtemp(path.join(os.tmpdir(), 'striart-cfghome-'));
    vi.stubEnv('STRIART_CONFIG_HOME', configHome);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(configHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    await repo.cleanup();
  });

  it('constat native : clé épinglée et clés de l’utilisateur dans les paramètres et le détail', async () => {
    await writeFile(
      path.join(configHome, 'config.json'),
      JSON.stringify({ native: { trustedKeyIds: ['0123456789ABCDEF'] } }),
    );
    await initStriart(repo.root);

    const native = check(await runDoctor(repo.root), 'native');

    expect(native.params.pinnedKeyIds).toEqual([...PINNED_NATIVE_KEY_IDS]);
    expect(native.params.trustedKeyIds).toEqual(['0123456789ABCDEF']);
    if (native.level !== 'fail') {
      expect(native.detail).toContain(PINNED_NATIVE_KEY_IDS[0]);
      expect(native.detail).toContain('0123456789ABCDEF');
    }
  });

  it('sans config utilisateur : « aucune » clé ajoutée', async () => {
    await initStriart(repo.root);

    const native = check(await runDoctor(repo.root), 'native');

    expect(native.params.trustedKeyIds).toEqual([]);
    expect(native.params.pinnedKeyIds).toEqual([...PINNED_NATIVE_KEY_IDS]);
  });

  it('gateContainer par défaut (native) : constat ok, aucune protection relâchée à ce titre', async () => {
    await initStriart(repo.root);

    const result = await runDoctor(repo.root);

    expect(check(result, 'gate')).toMatchObject({
      level: 'ok',
      key: 'gate.native',
      params: { container: 'native' },
    });
    expect(check(result, 'relaxations')?.params?.names ?? []).not.toContain('gateContainer');
  });

  it('gateContainer "process" : avertissement et relâchement affiché', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ gateContainer: 'process' }),
    );
    await initStriart(repo.root);

    const result = await runDoctor(repo.root);

    expect(check(result, 'gate')).toMatchObject({
      level: 'warn',
      key: 'gate.process',
      params: { container: 'process' },
    });
    expect(check(result, 'relaxations').params.names).toContain('gateContainer');
  });
});
