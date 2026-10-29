import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import { runDoctor } from '../../src/doctor.ts';
import { collectRelaxations } from '../../src/doctor-relaxations.ts';
import { en } from '../../src/cli/i18n/en.ts';

const ofId = (result, id) => result.checks.filter((c) => c.id === id);

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

describe('striart doctor : performance, politique de livraison, ALL_PROXY (L8 + reliquats)', () => {
  let repo;
  let cfgHome;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    cfgHome = await mkdtemp(path.join(os.tmpdir(), 'striart-doctor-perf-'));
    vi.stubEnv('STRIART_CONFIG_HOME', cfgHome);
    for (const name of [
      'ALL_PROXY',
      'all_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await repo.cleanup();
    await rm(cfgHome, { recursive: true, force: true });
  });

  it('section « performance » : latence du verrou d’état, git status, taille, agents, âge du plus vieux verrou', async () => {
    await createAgent({ root: repo.root, name: 'agent-a' });
    const result = await runDoctor(repo.root);
    const perf = ofId(result, 'performance');
    const byKey = (key) => perf.find((c) => c.key === key);
    expect(perf.length).toBeGreaterThanOrEqual(5);

    const lock = byKey('performance.stateLock');
    expect(lock.params).toMatchObject({ budgetMs: 100, alertMs: 1000 });
    expect(lock.params.samples).toBeGreaterThanOrEqual(3);
    expect(typeof lock.params.medianMs).toBe('number');
    expect(typeof lock.params.maxMs).toBe('number');
    expect(['ok', 'warn']).toContain(lock.level);

    const status = byKey('performance.gitStatus');
    expect(typeof status.params.ms).toBe('number');
    expect(status.params.timedOut).toBe(false);

    const size = byKey('performance.stateDirSize');
    expect(size.params.sizeBytes).toBeGreaterThan(0);
    expect(size.params.complete).toBe(true);

    expect(byKey('performance.agentCount').params.count).toBe(1);
    const oldest = byKey('performance.oldestLock');
    expect(oldest.params.ageMs).toBeNull(); // aucun verrou tenu au repos
    for (const c of perf) {
      expect(c.label).toBeTruthy();
      expect(c.detail).toBeTruthy();
    }
  });

  it('la sonde ne laisse rien derrière elle dans .striart/ et ne perturbe pas le verrou d’état', async () => {
    const { readdir } = await import('node:fs/promises');
    const before = (await readdir(path.join(repo.root, '.striart'))).sort();
    await runDoctor(repo.root);
    const after = (await readdir(path.join(repo.root, '.striart'))).sort();
    expect(after).toEqual(before);
  });

  it('libellés anglais pour chaque constat de performance', async () => {
    const result = await runDoctor(repo.root);
    expect(en.doctorChecks.label('performance')).toBe('Performance');
    for (const c of ofId(result, 'performance')) {
      const detail = en.doctorChecks.detail(c.key, c.params);
      expect(detail, c.key).toBeTruthy();
      expect(detail).not.toMatch(/undefined|NaN/);
    }
  });

  it('politique de livraison : delivery, pushTimeoutMs et commitTimeoutMs affichés (information, pas relâchement)', async () => {
    await setConfig(repo.root, {
      autoPush: true,
      delivery: 'branch',
      pushTimeoutMs: 45_000,
      commitTimeoutMs: 90_000,
    });
    const result = await runDoctor(repo.root);
    const [delivery] = ofId(result, 'delivery');
    expect(delivery.level).toBe('ok');
    expect(delivery.key).toBe('delivery.branch');
    expect(delivery.params).toMatchObject({
      delivery: 'branch',
      autoPush: true,
      pushTimeoutMs: 45_000,
      commitTimeoutMs: 90_000,
    });
    expect(delivery.detail).toContain('45');
    expect(en.doctorChecks.detail(delivery.key, delivery.params)).toContain('45');
    // Politique : jamais comptée comme protection relâchée.
    const relax = ofId(result, 'relaxations')[0];
    expect(relax.params.names).not.toContain('delivery');
    expect(relax.params.policies).toContain('delivery:branch');
  });

  it('défauts de livraison : ligne présente, mode push, délais par défaut', async () => {
    const result = await runDoctor(repo.root);
    const [delivery] = ofId(result, 'delivery');
    expect(delivery.key).toBe('delivery.push');
    expect(delivery.params).toMatchObject({
      delivery: 'push',
      pushTimeoutMs: 120_000,
      commitTimeoutMs: 300_000,
    });
    expect(ofId(result, 'relaxations')[0].params.policies).toEqual([]);
  });

  it('collectRelaxations : delivery:branch est une POLITIQUE, pas une clé relâchée', () => {
    const report = collectRelaxations({ config: { autoPush: true, delivery: 'branch' } });
    expect(report.names).toEqual([]);
    expect(report.policies).toEqual(['delivery:branch']);
    expect(collectRelaxations({ config: { delivery: 'push' } }).policies).toEqual([]);
    expect(collectRelaxations({ config: null }).policies).toEqual([]);
  });

  it('ALL_PROXY posé : constat « non supporté » (warn), sans jamais afficher la valeur', async () => {
    vi.stubEnv('ALL_PROXY', 'socks5://user:pa55w0rd@proxy.corp.example:1080');
    const result = await runDoctor(repo.root);
    const c = ofId(result, 'network').find((x) => x.key === 'network.allProxyIgnored');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('ALL_PROXY');
    expect(JSON.stringify(result)).not.toContain('pa55w0rd');
    expect(en.doctorChecks.detail(c.key, c.params)).toContain('ALL_PROXY');
    expect(en.doctorChecks.hint(c.key, c.params)).toContain('HTTPS_PROXY');
  });

  it('all_proxy (minuscules) est aussi signalé ; absent → aucun constat', async () => {
    const none = await runDoctor(repo.root);
    expect(ofId(none, 'network').find((x) => x.key === 'network.allProxyIgnored')).toBeUndefined();
    vi.stubEnv('all_proxy', 'http://p.example:3128');
    const lower = await runDoctor(repo.root);
    expect(ofId(lower, 'network').find((x) => x.key === 'network.allProxyIgnored')).toBeDefined();
  });
});
