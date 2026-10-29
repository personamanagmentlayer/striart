import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { runDoctor } from '../../src/doctor.ts';
import { en } from '../../src/cli/i18n/en.ts';

const one = (result, id) => result.checks.find((c) => c.id === id);

describe('striart doctor : contrôles de durcissement (state-privacy, gate-env)', () => {
  let repo;
  let cfgHome;

  // Le module de config est mis en cache par chemin dès le premier chargement :
  // le fichier se pose AVANT `initStriart`.
  const setup = async (source = null) => {
    repo = await createTempRepo();
    if (source) await writeFile(path.join(repo.root, 'striart.config.mjs'), source);
    await initStriart(repo.root);
  };

  beforeEach(async () => {
    cfgHome = await mkdtemp(path.join(os.tmpdir(), 'striart-doctor-hard-'));
    vi.stubEnv('STRIART_CONFIG_HOME', cfgHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo?.cleanup();
    repo = undefined;
    await rm(cfgHome, { recursive: true, force: true });
  });

  it('défauts : .striart/ réservé et environnement du gate filtré, libellés fr + en', async () => {
    await setup();
    const result = await runDoctor(repo.root);
    const privacy = one(result, 'state-privacy');
    const gateEnv = one(result, 'gate-env');
    expect(privacy).toMatchObject({ level: 'ok', key: 'state-privacy.ok' });
    expect(gateEnv).toMatchObject({ level: 'ok', key: 'gate-env.filtered' });
    expect(privacy.label).toBeTruthy();
    expect(en.doctorChecks.label('state-privacy')).toBe('Local data (.striart/)');
    expect(en.doctorChecks.label('gate-env')).toBe('Test Gate environment');
    expect(en.doctorChecks.detail(privacy.key, privacy.params)).toMatch(/restricted/);
    expect(en.doctorChecks.detail(gateEnv.key, gateEnv.params)).toMatch(/filtered environment/);
    // Ordre : avant la synthèse des relâchements, qui reste la dernière des lignes de config.
    const ids = result.checks.map((c) => c.id);
    expect(ids.indexOf('state-privacy')).toBeLessThan(ids.indexOf('relaxations'));
    expect(ids.indexOf('gate-env')).toBeLessThan(ids.indexOf('relaxations'));
  });

  it('gateEnv demandé sans gate.envAllow : avertissement avec les noms, correction citée', async () => {
    await setup("export default { testCommand: 'npm test', gateEnv: ['MYAPP_*'] };\n");
    const result = await runDoctor(repo.root);
    const check = one(result, 'gate-env');
    expect(check).toMatchObject({ level: 'warn', key: 'gate-env.refused' });
    expect(check.params.names).toEqual(['MYAPP_*']);
    expect(en.doctorChecks.hint(check.key, check.params)).toMatch(/gate\.envAllow/);
  });

  it('gateEnv demandé ET autorisé par la config utilisateur : ok, relâchement gate.envAllow affiché', async () => {
    await setup("export default { testCommand: 'npm test', gateEnv: ['MYAPP_*'] };\n");
    await writeFile(
      path.join(cfgHome, 'config.json'),
      JSON.stringify({ gate: { envAllow: ['MYAPP_*'] } }),
    );
    const result = await runDoctor(repo.root);
    expect(one(result, 'gate-env').level).toBe('ok');
    expect(one(result, 'relaxations').params.names).toContain('gate.envAllow');
  });

  it('gateEnv: inherit et privateStateDir: false : deux avertissements et la ligne relaxations', async () => {
    await setup(
      "export default { testCommand: 'npm test', gateEnv: 'inherit', privateStateDir: false };\n",
    );
    const result = await runDoctor(repo.root);
    expect(one(result, 'gate-env')).toMatchObject({ level: 'warn', key: 'gate-env.inherit' });
    expect(one(result, 'state-privacy')).toMatchObject({
      level: 'warn',
      key: 'state-privacy.relaxed',
    });
    expect(one(result, 'relaxations').params.names).toEqual(
      expect.arrayContaining(['gateEnv', 'privateStateDir']),
    );
  });

  it('dépôt non initialisé : pas de contrôle de .striart/', async () => {
    const bare = await createTempRepo();
    try {
      const result = await runDoctor(bare.root);
      expect(one(result, 'state-privacy')).toBeUndefined();
    } finally {
      await bare.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    '.striart/ ouvert aux autres : avertissement et correction striart init',
    async () => {
      await setup();
      const { chmod } = await import('node:fs/promises');
      await chmod(path.join(repo.root, '.striart', 'queue.json'), 0o644);
      const result = await runDoctor(repo.root);
      const check = one(result, 'state-privacy');
      expect(check).toMatchObject({ level: 'warn', key: 'state-privacy.open' });
      expect(check.hint).toMatch(/striart init/);
    },
  );
});
