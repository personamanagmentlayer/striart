import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acpHostSocketPath, assertSocketDirPrivate } from '../../src/acp/host-ipc.ts';

/**
 * S-M9 (POSIX) : le repli du socket dans le dossier temporaire ne se fait que
 * dans un dossier privé de l'utilisateur, contrôlé avant tout usage.
 */
describe.skipIf(process.platform === 'win32')(
  'hôte ACP — dossier de repli du socket (S-M9)',
  () => {
    let tmp;
    let previous;
    beforeEach(async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), 'striart-sock-'));
      previous = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
    });
    afterEach(async () => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(tmp, { recursive: true, force: true });
    });

    const longRoot = () => path.join(tmp, 'x'.repeat(120));

    it('repli : sous striart-<uid>/, jamais un nom prévisible à la racine du dossier temporaire', () => {
      const socket = acpHostSocketPath(longRoot(), 'agent-a');
      expect(path.dirname(socket)).toBe(path.join(tmp, `striart-${process.getuid()}`));
    });

    it('crée le dossier en 0700 puis l’accepte', async () => {
      const socket = acpHostSocketPath(longRoot(), 'agent-a');
      await assertSocketDirPrivate(socket, { create: true });
      expect((await stat(path.dirname(socket))).mode & 0o777).toBe(0o700);
      await expect(assertSocketDirPrivate(socket, { create: false })).resolves.toBeUndefined();
    });

    it('refuse un dossier ouvert aux autres, ou un lien symbolique (squat)', async () => {
      const socket = acpHostSocketPath(longRoot(), 'agent-a');
      const dir = path.dirname(socket);
      await mkdir(dir, { mode: 0o777 });
      await chmod(dir, 0o777);
      await expect(assertSocketDirPrivate(socket, { create: true })).rejects.toMatchObject({
        code: 'ACP_SOCKET_DIR_UNSAFE',
      });
      await rm(dir, { recursive: true });
      await symlink(tmp, dir);
      await expect(assertSocketDirPrivate(socket, { create: true })).rejects.toMatchObject({
        code: 'ACP_SOCKET_DIR_UNSAFE',
      });
    });
  },
);
