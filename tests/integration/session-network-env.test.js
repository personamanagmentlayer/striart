// De bout en bout : un vrai process d'agent reçoit NODE_EXTRA_CA_CERTS issu de la
// config UTILISATEUR, les variables de proxy de l'orchestrateur, et jamais
// STRIART_PROXY_AUTH ; la config du DÉPÔT n'élargit rien.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initStriart } from '../../src/init.js';
import { runAgentSession } from '../../src/session.js';
import { createTempRepo } from '../helpers/temp-repo.js';

const PROBE =
  "for (const n of ['NODE_EXTRA_CA_CERTS','HTTPS_PROXY','NO_PROXY','STRIART_PROXY_AUTH']) console.log(n + '=' + (process.env[n] ?? 'absent'))";

describe('runAgentSession — environnement réseau de la session', () => {
  let repo;
  let home;
  let caFile;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    home = await mkdtemp(path.join(os.tmpdir(), 'striart-sess-net-'));
    caFile = path.join(home, 'corp-ca.pem');
    await writeFile(caFile, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
    vi.stubEnv('STRIART_CONFIG_HOME', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  const run = (env, profileEnv = {}) =>
    runAgentSession({
      root: repo.root,
      agent: 'agent-a',
      taskId: 'task-1',
      cwd: repo.root,
      profile: {
        command: process.execPath,
        args: ['-e', PROBE, '{{prompt}}'],
        env: profileEnv,
      },
      prompt: 'tâche',
      timeoutMs: 20_000,
      env,
    });

  it('network.caFile (utilisateur) → NODE_EXTRA_CA_CERTS ; proxy conservé ; STRIART_PROXY_AUTH jamais', async () => {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ network: { caFile } }));
    const result = await run({
      ...process.env,
      NODE_EXTRA_CA_CERTS: undefined,
      HTTPS_PROXY: 'http://proxy.corp:3128',
      NO_PROXY: 'localhost',
      STRIART_PROXY_AUTH: 'alice:s3cret-pw',
    });
    expect(result.status).toBe('COMPLETED');
    const { readFile } = await import('node:fs/promises');
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain(`NODE_EXTRA_CA_CERTS=${caFile}`);
    expect(log).toContain('HTTPS_PROXY=http://proxy.corp:3128');
    expect(log).toContain('NO_PROXY=localhost');
    expect(log).toContain('STRIART_PROXY_AUTH=absent');
    expect(log).not.toContain('s3cret-pw');
  });

  it('sans caFile dans la config utilisateur : NODE_EXTRA_CA_CERTS absent (le dépôt n’y peut rien)', async () => {
    const result = await run({ ...process.env, NODE_EXTRA_CA_CERTS: undefined });
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(result.logPath, 'utf8')).toContain('NODE_EXTRA_CA_CERTS=absent');
  });

  it('config utilisateur illisible : rien n’est ajouté (fail closed), la session démarre', async () => {
    await writeFile(path.join(home, 'config.json'), '{ not json');
    const result = await run({ ...process.env, NODE_EXTRA_CA_CERTS: undefined });
    expect(result.status).toBe('COMPLETED');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(result.logPath, 'utf8')).toContain('NODE_EXTRA_CA_CERTS=absent');
  });

  it('l’env d’un profil (config du dépôt) reste la seule façon pour le dépôt de poser sa variable, par profil', async () => {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ network: { caFile } }));
    const result = await run(
      { ...process.env, NODE_EXTRA_CA_CERTS: undefined },
      { NODE_EXTRA_CA_CERTS: '/profile/own-ca.pem' },
    );
    const { readFile } = await import('node:fs/promises');
    // Les valeurs d'env d'un profil sont caviardées du journal : la variable est
    // posée (la valeur du profil), et ce n'est pas celle de la config utilisateur.
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('NODE_EXTRA_CA_CERTS=[redacted]');
    expect(log).not.toContain(caFile);
  });
});
