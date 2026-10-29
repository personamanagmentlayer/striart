/**
 * `striart doctor` — état RÉEL du verrou principal (revue L1, I3) : un
 * main.lock présent n'est plus qualifié d'« orphelin récupéré » quand son
 * détenteur vit et bat. Détenteur, âge du battement, file, détenteur figé,
 * récupération bloquée et relâchement configuré sont rapportés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { runDoctor } from '../../src/doctor.ts';
import { en } from '../../src/cli/i18n/en.ts';

const HOLDER = fileURLToPath(new URL('../helpers/lock-holder.mjs', import.meta.url));

async function holder(root, mode) {
  const child = execa('node', [HOLDER, root, '30000', 'merge:occupant', mode], { reject: false });
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('READY')) resolve();
    });
    child.on('exit', () => reject(new Error(`sorti avant READY : ${out}`)));
  });
  // execa rend un enfant « thenable » : l'envelopper, sinon `await` attendrait sa fin.
  return { child };
}

const lockCheck = async (root) => (await runDoctor(root)).checks.find((c) => c.id === 'lock');

describe('doctor — verrou principal (intégration)', () => {
  let repo;
  let lockFile;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    lockFile = path.join(repo.root, '.striart', 'main.lock');
    // Aucun LLM joignable : le check LLM échoue vite, sans réseau.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('libre → ok', async () => {
    expect(await lockCheck(repo.root)).toMatchObject({ level: 'ok', key: 'lock.free' });
  });

  it('détenteur vivant qui bat → « opération en cours » (détenteur, âge du battement, file), pas « orphelin »', async () => {
    const { child } = await holder(repo.root, 'hold');
    try {
      const check = await lockCheck(repo.root);
      expect(check).toMatchObject({
        level: 'ok',
        key: 'lock.held',
        params: { holder: 'merge:occupant', pid: child.pid, queued: 0 },
      });
      expect(check.params.heartbeatAgeMs).toBeLessThan(60_000);
      const detail = en.doctorChecks.detail(check.key, check.params);
      expect(detail).toMatch(/merge:occupant/);
      expect(detail).not.toMatch(/orphan/i);
    } finally {
      child.kill();
      await child;
    }
  });

  it('détenteur figé → warn, piste exacte (arrêter le PID)', async () => {
    const { child } = await holder(repo.root, 'freeze');
    try {
      await sleep(300);
      const info = JSON.parse(await readFile(lockFile, 'utf8'));
      const old = new Date(Date.now() - 5 * 60_000);
      await writeFile(lockFile, JSON.stringify({ ...info, heartbeatAt: old.toISOString() }));
      await utimes(lockFile, old, old);
      const check = await lockCheck(repo.root);
      expect(check).toMatchObject({ level: 'warn', key: 'lock.frozen' });
      expect(en.doctorChecks.hint(check.key, check.params)).toContain(String(child.pid));
    } finally {
      child.kill();
      await child;
    }
  });

  it('récupération bloquée (MERGE_STATE_CHANGED + merge tiers ouvert) → fail, git merge --abort', async () => {
    const head = (await execa('git', ['-C', repo.root, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(repo.root, '.git', 'MERGE_HEAD'), `${head}\n`);
    await writeFile(
      path.join(repo.root, '.striart', 'merge-state-changed.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        operation: 'merge:agent-a',
        agent: 'agent-a',
      }),
    );
    const check = await lockCheck(repo.root);
    expect(check).toMatchObject({ level: 'fail', key: 'lock.recoveryBlocked' });
    expect(en.doctorChecks.hint(check.key, check.params)).toBe('git merge --abort');
  });

  it('relâchement configuré (lock.breakFrozenHolderAfterMs) → toujours affiché, en avertissement', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ lock: { breakFrozenHolderAfterMs: 120_000 } }),
    );
    await mkdir(path.join(repo.root, '.striart'), { recursive: true });
    const check = await lockCheck(repo.root);
    expect(check).toMatchObject({ level: 'warn', params: { breakFrozenHolderAfterMs: 120_000 } });
    expect(en.doctorChecks.detail(check.key, check.params)).toMatch(/breakFrozenHolderAfterMs/);
  });
});
