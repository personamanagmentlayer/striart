import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { runDoctor } from '../../src/doctor.js';

const networkChecks = (result) => result.checks.filter((c) => c.id === 'network');
const byKey = (result, key) => networkChecks(result).find((c) => c.key === key);

/**
 * `striart doctor` rend la couche réseau d'entreprise : proxy actif/inactif, CA,
 * hôtes autorisés, offline, relâchements — depuis l'environnement du shell et la
 * config UTILISATEUR, jamais depuis le dépôt.
 */
describe('striart doctor : couche réseau', () => {
  let repo;
  let cfgHome;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    cfgHome = await mkdtemp(path.join(os.tmpdir(), 'striart-doctor-net-'));
    vi.stubEnv('STRIART_CONFIG_HOME', cfgHome);
    for (const name of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'NO_PROXY',
      'no_proxy',
      'STRIART_OFFLINE',
      'STRIART_ALLOWED_HOSTS',
      'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
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

  it('défauts : connexions directes, aucune politique, rien de relâché', async () => {
    const result = await runDoctor(repo.root);
    expect(byKey(result, 'network.direct')?.level).toBe('ok');
    expect(byKey(result, 'network.policy')).toBeUndefined();
    expect(result.checks.find((c) => c.id === 'relaxations').level).toBe('ok');
  });

  it('offline + hôtes autorisés + HTTP en clair autorisé : politique nommée, relâchement agrégé', async () => {
    await writeFile(
      path.join(cfgHome, 'config.json'),
      JSON.stringify({
        network: {
          offline: true,
          allowedHosts: ['api.anthropic.com'],
          allowInsecureHosts: ['gpu.corp.example'],
          tlsMinVersion: 'TLSv1.3',
        },
      }),
    );
    const result = await runDoctor(repo.root);
    const policy = byKey(result, 'network.policy');
    expect(policy.detail).toContain('hors ligne');
    expect(policy.detail).toContain('api.anthropic.com');
    expect(byKey(result, 'network.tls').detail).toContain('TLSv1.3');
    const insecure = byKey(result, 'network.insecure');
    expect(insecure.level).toBe('warn');
    expect(insecure.detail).toContain('gpu.corp.example');
    const relax = result.checks.find((c) => c.id === 'relaxations');
    expect(relax.detail).toContain('network.allowInsecureHosts');
  });

  it('proxy configuré : actif ou inactif selon Node, jamais les identifiants', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://alice:hunter2x@proxy.corp.example:3128');
    const result = await runDoctor(repo.root);
    const line = networkChecks(result).find((c) => c.key.startsWith('network.proxy'));
    expect(line).toBeDefined();
    expect(['network.proxyActive', 'network.proxyInactive']).toContain(line.key);
    expect(JSON.stringify(result)).not.toContain('hunter2x');
    expect(line.detail).toContain('proxy.corp.example:3128');
  });

  it('CA : fichier de la config utilisateur introuvable → avertissement', async () => {
    await writeFile(
      path.join(cfgHome, 'config.json'),
      JSON.stringify({ network: { caFile: path.join(cfgHome, 'absent.pem') } }),
    );
    const result = await runDoctor(repo.root);
    const tlsLine = byKey(result, 'network.tls');
    expect(tlsLine.level).toBe('warn');
    expect(tlsLine.detail).toContain('absent.pem');
  });

  it('config utilisateur illisible : avertissement dédié, jamais « réseau sain » en silence', async () => {
    await writeFile(path.join(cfgHome, 'config.json'), '{ pas du json');
    const result = await runDoctor(repo.root);
    expect(byKey(result, 'network.userConfigUnreadable')?.level).toBe('warn');
    expect(result.checks.find((c) => c.id === 'relaxations').detail).toContain('network');
  });

  it('NODE_TLS_REJECT_UNAUTHORIZED=0 : relâchement affiché', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    const result = await runDoctor(repo.root);
    expect(byKey(result, 'network.insecure').detail).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(result.checks.find((c) => c.id === 'relaxations').detail).toContain(
      'env.NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });

  it('Ollama distant en http:// : doctor dit POURQUOI (NET_INSECURE_TRANSPORT), pas « injoignable »', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ ollamaHost: 'http://gpu.corp.example:11434' }),
    );
    const result = await runDoctor(repo.root);
    const llm = result.checks.find((c) => c.id === 'llm');
    expect(llm.key).toBe('llm.networkRefused');
    expect(llm.detail).toContain('NET_INSECURE_TRANSPORT');
  });
});
