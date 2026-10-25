import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadBinaryAgent } from '../../src/agents/acp-registry.ts';

let work;
beforeEach(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'striart-acp-dl-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true, maxRetries: 5 });
});

/** Fabrique une archive tar à partir d'un dossier préparé par `prepare`. */
async function makeTar(prepare) {
  const src = path.join(work, 'src');
  await mkdir(src, { recursive: true });
  await prepare(src);
  const archive = path.join(work, 'agent.tar');
  await execa('tar', ['-cf', 'agent.tar', '-C', 'src', '.'], { shell: false, cwd: work });
  return readFile(archive);
}

const agentFor = (bytes, version = '1.0.0') => ({
  id: 'bin-agent',
  name: 'Bin',
  version,
  distribution: {
    binary: {
      'linux-x86_64': {
        archive: 'https://example.invalid/agent.tar',
        cmd: './agent',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    },
  },
});

const run = (bytes, agent, root) =>
  downloadBinaryAgent({
    root,
    agent,
    result: { profile: { command: 'agent' }, installation: {} },
    platform: 'linux-x86_64',
    fetchImpl: async () => new Response(bytes, { status: 200 }),
  });

describe('downloadBinaryAgent : extraction sûre', () => {
  it('archive saine : extraite sous .striart/acp-agents/<id>/<version>', async () => {
    const bytes = await makeTar(async (src) => writeFile(path.join(src, 'agent'), 'binaire'));
    const out = await run(bytes, agentFor(bytes), work);
    expect(out.installation.downloaded).toBe(true);
    expect((await stat(out.profile.command)).isFile()).toBe(true);
  });

  it('archive avec un lien dur : refus ACP_EXTRACT_UNSAFE, dossier retiré', async () => {
    const bytes = await makeTar(async (src) => {
      await writeFile(path.join(src, 'agent'), 'binaire');
      await link(path.join(src, 'agent'), path.join(src, 'copie'));
    });
    await expect(run(bytes, agentFor(bytes), work)).rejects.toMatchObject({
      code: 'ACP_EXTRACT_UNSAFE',
    });
    await expect(
      stat(path.join(work, '.striart', 'acp-agents', 'bin-agent', '1.0.0')),
    ).rejects.toThrow();
  });

  it('archive avec un lien symbolique : refus ACP_EXTRACT_UNSAFE', async () => {
    let bytes;
    try {
      bytes = await makeTar(async (src) => {
        await writeFile(path.join(src, 'agent'), 'binaire');
        await symlink('/etc', path.join(src, 'etc-link'));
      });
    } catch {
      return; // symlinks non créables (Windows sans privilège) : couvert ailleurs
    }
    await expect(run(bytes, agentFor(bytes), work)).rejects.toMatchObject({
      code: 'ACP_EXTRACT_UNSAFE',
    });
  });

  it('version de registre en traversée : refus avant toute suppression', async () => {
    const victim = path.join(work, 'victime');
    await mkdir(victim, { recursive: true });
    await writeFile(path.join(victim, 'important.txt'), 'à garder');
    const bytes = await makeTar(async (src) => writeFile(path.join(src, 'agent'), 'binaire'));
    await expect(
      run(bytes, agentFor(bytes, '../../../../victime'), path.join(work, 'proj')),
    ).rejects.toMatchObject({ code: 'ACP_REGISTRY_INVALID' });
    expect(await readFile(path.join(victim, 'important.txt'), 'utf8')).toBe('à garder');
  });
});
