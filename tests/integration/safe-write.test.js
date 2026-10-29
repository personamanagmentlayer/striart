import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePathInsideClone } from '../../src/acp/protocol.ts';
import { createAgent } from '../../src/clone.ts';
import { INBOX_FILE, deliverInbox } from '../../src/collab/files.ts';
import { createCollabGroup, postAgentMessage } from '../../src/collab/channel.ts';
import { ensureCloneExclude } from '../../src/git-exclude.ts';
import { initStriart } from '../../src/init.ts';
import { CLONE_MEMORY_FILE, syncMemoryToClone } from '../../src/memory.ts';
import { resolveCollabSettings } from '../../src/orchestration/settings.ts';
import {
  isSafeWriteError,
  safeCopyFile,
  safeReadText,
  safeRemove,
  safeWriteFile,
} from '../../src/safe-write.ts';
import { syncAgentInstructionsToClone } from '../../src/agents/instructions.ts';
import { createTempRepo } from '../helpers/temp-repo.js';

const SECRET = 'contenu extérieur au clone\n';

/** Lien vers un fichier ou un dossier ; false si la plateforme refuse (symlink sans privilège). */
async function tryLink(target, file, kind) {
  try {
    await symlink(target, file, kind === 'dir' ? 'junction' : 'file');
    return true;
  } catch {
    return false;
  }
}

describe('safe-write : primitive', () => {
  let dir;
  let clone;
  let outside;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-safew-'));
    clone = path.join(dir, 'clone');
    outside = path.join(dir, 'dehors');
    await mkdir(clone, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), SECRET);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('écrit, crée les dossiers un par un, idempotent', async () => {
    await safeWriteFile(clone, '.cursor/rules/x.mdc', 'a');
    await safeWriteFile(clone, '.cursor/rules/x.mdc', 'b');
    expect(await readFile(path.join(clone, '.cursor', 'rules', 'x.mdc'), 'utf8')).toBe('b');
  });

  it('refuse chemin absolu, "..", vide', async () => {
    for (const bad of ['/etc/x', '../x', 'a/../../x', '', 'C:\\x']) {
      await expect(safeWriteFile(clone, bad, 'x'), bad).rejects.toSatisfy(isSafeWriteError);
    }
  });

  it('feuille = lien symbolique : le lien est remplacé, la cible intacte', async () => {
    const victim = path.join(outside, 'secret.txt');
    if (!(await tryLink(victim, path.join(clone, 'inbox.md'), 'file'))) return;
    await safeWriteFile(clone, 'inbox.md', 'neuf');
    expect(await readFile(victim, 'utf8')).toBe(SECRET);
    expect(await readFile(path.join(clone, 'inbox.md'), 'utf8')).toBe('neuf');
    await expect(readlink(path.join(clone, 'inbox.md'))).rejects.toThrow();
  });

  it('feuille = lien dur vers un fichier extérieur : le fichier extérieur est intact', async () => {
    const victim = path.join(outside, 'secret.txt');
    await link(victim, path.join(clone, 'inbox.md'));
    await safeWriteFile(clone, 'inbox.md', 'neuf');
    expect(await readFile(victim, 'utf8')).toBe(SECRET);
    expect(await readFile(path.join(clone, 'inbox.md'), 'utf8')).toBe('neuf');
  });

  it('dossier intermédiaire = lien/jonction : refus, rien écrit dehors', async () => {
    if (!(await tryLink(outside, path.join(clone, '.claude'), 'dir'))) return;
    await expect(safeWriteFile(clone, '.claude/rules/s.md', 'x')).rejects.toSatisfy(
      isSafeWriteError,
    );
    await expect(stat(path.join(outside, 'rules'))).rejects.toThrow();
    await expect(safeRemove(clone, '.claude/secret.txt')).rejects.toSatisfy(isSafeWriteError);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
    expect(await safeReadText(clone, '.claude/secret.txt')).toBeNull();
  });

  it('ACP : un lien pendant vers l’extérieur n’est pas un chemin « à créer » dans le clone', async () => {
    const dangling = path.join(dir, 'nulle-part', 'nouveau.txt');
    if (!(await tryLink(dangling, path.join(clone, 'pendant.txt'), 'file'))) return;
    expect(await resolvePathInsideClone(clone, 'pendant.txt')).toBeNull();
    expect(await resolvePathInsideClone(clone, 'libre.txt')).toBe(path.resolve(clone, 'libre.txt'));
  });

  it('safeCopyFile / safeRemove / safeReadText', async () => {
    const source = path.join(outside, 'secret.txt');
    await safeCopyFile(clone, 'copie.md', source);
    expect(await safeReadText(clone, 'copie.md')).toBe(SECRET);
    await safeRemove(clone, 'copie.md');
    expect(await safeReadText(clone, 'copie.md')).toBeNull();
    await safeRemove(clone, 'absent/encore.md'); // rien, sans erreur
    await mkdir(path.join(clone, 'dossier'));
    await expect(safeRemove(clone, 'dossier')).rejects.toSatisfy(isSafeWriteError);
  });
});

describe('safe-write : appelants dans un clone', () => {
  let repo;
  let outside;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    outside = await mkdtemp(path.join(os.tmpdir(), 'striart-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), SECRET);
  });
  afterEach(async () => {
    await repo.cleanup();
    await rm(outside, { recursive: true, force: true, maxRetries: 5 });
  });

  it('inbox : un lien planté sur .striart-inbox.md ne fait pas écrire hors du clone', async () => {
    const settings = resolveCollabSettings({});
    const g = await createCollabGroup(repo.root, {
      kind: 'review',
      members: [
        { agent: 'auth', role: 'author' },
        { agent: 'other', role: 'peer' },
      ],
    });
    await postAgentMessage(
      { root: repo.root, agent: 'other', to: 'author', kind: 'note', body: 'salut' },
      settings,
    );
    const victim = path.join(outside, 'secret.txt');
    if (!(await tryLink(victim, path.join(repo.root, INBOX_FILE), 'file'))) return;
    await deliverInbox(
      { root: repo.root, clonePath: repo.root, group: g.id, roles: ['author'] },
      settings,
    );
    expect(await readFile(victim, 'utf8')).toBe(SECRET);
  });

  it('mémoire : un lien planté sur .striart-memory.md ne fait pas écrire hors du clone', async () => {
    await writeFile(path.join(repo.root, '.striart', 'memory.md'), '# mémoire\n');
    const clone = await mkdtemp(path.join(os.tmpdir(), 'striart-clone-'));
    try {
      await mkdir(path.join(clone, '.git', 'info'), { recursive: true });
      const victim = path.join(outside, 'secret.txt');
      if (!(await tryLink(victim, path.join(clone, CLONE_MEMORY_FILE), 'file'))) return;
      await syncMemoryToClone(repo.root, clone);
      expect(await readFile(victim, 'utf8')).toBe(SECRET);
    } finally {
      await rm(clone, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('.git/info remplacé par une jonction : exclude non écrit à l’extérieur', async () => {
    const clone = await mkdtemp(path.join(os.tmpdir(), 'striart-clone-'));
    try {
      await mkdir(path.join(clone, '.git'), { recursive: true });
      if (!(await tryLink(outside, path.join(clone, '.git', 'info'), 'dir'))) return;
      await expect(ensureCloneExclude(clone, '/x')).rejects.toSatisfy(isSafeWriteError);
      await expect(stat(path.join(outside, 'exclude'))).rejects.toThrow();
    } finally {
      await rm(clone, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('consignes injectées : un .claude remplacé par une jonction n’écrit pas dehors', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ agentCommand: 'claude' }),
    );
    const info = await createAgent({ root: repo.root, name: 'agent-a', command: null });
    await rm(path.join(info.path, '.claude'), { recursive: true, force: true });
    if (!(await tryLink(outside, path.join(info.path, '.claude'), 'dir'))) return;
    const result = await syncAgentInstructionsToClone({
      root: repo.root,
      agent: 'agent-a',
      clonePath: info.path,
    });
    await expect(stat(path.join(outside, 'rules', 'striart.md'))).rejects.toThrow();
    expect(result.written).not.toContain('.claude/rules/striart.md');
  });
});
