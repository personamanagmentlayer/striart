import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertPrivate, restrictToCurrentUser } from '../../src/control/auth.ts';

const run = promisify(execFile);
const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');

/**
 * ACL du fichier de jeton du dashboard (Windows). Le DACL par défaut du jeton
 * d'une session élevée (administrateur, runneradmin des CI) donne au fichier
 * des ACE EXPLICITES pour SYSTEM et les Administrateurs : `/inheritance:r` ne
 * retire que l'héritage, `/grant:r` ne remplace que le compte visé — ces ACE
 * restaient, et le fichier « restreint à l'utilisateur » ne l'était pas.
 */
describe.skipIf(process.platform !== 'win32')(
  'restrictToCurrentUser — ACE explicites (Windows)',
  () => {
    let dir;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'striart-acl-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    it('retire SYSTEM, Administrateurs et tout autre compte, même quand leurs ACE sont explicites', async () => {
      const file = path.join(dir, 'dashboard.token');
      await writeFile(file, 'jeton');
      // Rend explicites les ACE héritées : la situation du DACL par défaut d'un
      // jeton élevé.
      await run(icacls, [file, '/inheritance:d']);

      await restrictToCurrentUser(file);

      await expect(assertPrivate(file)).resolves.toBeUndefined();
      const { stdout } = await run(icacls, [file]);
      // Le chemin du fichier (qui contient « Users ») est retiré de la sortie
      // avant la recherche des comptes.
      expect(stdout.replace(file, '')).not.toMatch(/SYSTEM|Administrators|Users/i);
    });
  },
);
