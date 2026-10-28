import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyNetworkSettings,
  readCaFile,
  resetNetState,
  resolveNetworkPolicy,
} from '../../src/net.ts';
import { DEFAULT_USER_CONFIG } from '../../src/user-config.ts';

/**
 * CA d'entreprise et version TLS minimale. Les certificats sont générés à la volée avec
 * `openssl` (argv, sans shell) : aucune clé privée n'est versionnée. Sans openssl exploitable
 * sur la machine, les tests de bout en bout sont sautés (les autres restent actifs).
 */
let dir = '';
let pki = null;

function openssl(...args) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'striart-net-tls-'));
  try {
    await writeFile(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost');
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=StriartTestCA',
    );
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'srv.key',
      '-out',
      'srv.csr',
      '-subj',
      '/CN=localhost',
    );
    openssl(
      'x509',
      '-req',
      '-in',
      'srv.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'srv.pem',
      '-days',
      '2',
      '-extfile',
      'ext.cnf',
    );
    pki = {
      caFile: path.join(dir, 'ca.pem'),
      key: await readFile(path.join(dir, 'srv.key')),
      cert: await readFile(path.join(dir, 'srv.pem')),
    };
  } catch {
    pki = null; // openssl absent ou non configuré
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => resetNetState());

const policyWith = (network) =>
  resolveNetworkPolicy({ ...DEFAULT_USER_CONFIG.network, ...network }, {});

describe('net — CA d’entreprise et TLS minimal', () => {
  it.skipIf(process.env.STRIART_SKIP_OPENSSL_TESTS === '1')(
    'network.caFile ajoute la CA : un serveur signé par elle est accepté, puis refusé après reset',
    async (ctx) => {
      if (!pki) return ctx.skip();
      const server = https.createServer({ key: pki.key, cert: pki.cert }, (_q, r) => r.end('ok'));
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const url = `https://localhost:${server.address().port}/`;
      try {
        const untrusted = await fetch(url).catch((e) => e);
        expect(untrusted.cause?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/);

        await applyNetworkSettings(policyWith({ caFile: pki.caFile }));
        expect(await (await fetch(url)).text()).toBe('ok');

        resetNetState();
        const after = await fetch(url).catch((e) => e);
        expect(after.cause?.code).toBeDefined();
      } finally {
        await new Promise((r) => server.close(r));
      }
    },
  );

  it('tlsMinVersion est appliqué au défaut du processus, puis restauré', async () => {
    const before = tls.DEFAULT_MIN_VERSION;
    await applyNetworkSettings(policyWith({ tlsMinVersion: 'TLSv1.3' }));
    expect(tls.DEFAULT_MIN_VERSION).toBe('TLSv1.3');
    resetNetState();
    expect(tls.DEFAULT_MIN_VERSION).toBe(before);
  });

  it('caFile inutilisable : NET_CA_INVALID typé (absent, vide de certificat, trop gros)', async () => {
    const empty = path.join(dir, 'empty.pem');
    await writeFile(empty, 'pas un certificat');
    for (const file of [path.join(dir, 'absent.pem'), empty, dir]) {
      await expect(readCaFile(file)).rejects.toMatchObject({ code: 'NET_CA_INVALID' });
    }
    await expect(applyNetworkSettings(policyWith({ caFile: empty }))).rejects.toMatchObject({
      code: 'NET_CA_INVALID',
    });
  });

  it('un échec de CA ne laisse rien d’appliqué (tout ou rien)', async () => {
    const before = tls.DEFAULT_MIN_VERSION;
    await expect(
      applyNetworkSettings(
        policyWith({ caFile: path.join(dir, 'absent.pem'), tlsMinVersion: 'TLSv1.3' }),
      ),
    ).rejects.toMatchObject({ code: 'NET_CA_INVALID' });
    expect(tls.DEFAULT_MIN_VERSION).toBe(before);
  });
});
