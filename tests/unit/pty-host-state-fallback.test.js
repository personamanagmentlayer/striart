import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

/**
 * Repli de `ptyHostStateDir` quand le chemin naturel sous `.striart/pty/`
 * dépasse la limite des sockets Unix (MAX_UNIX_SOCKET_PATH) : reproduit le
 * rouge CI macOS (prune-pty-host.test.js / idle-hosts.test.js, nativeCode
 * USAGE) sans dépendre de la longueur réelle de `os.tmpdir()` sur la machine
 * qui exécute ce test — `node:os` est mocké pour un dossier temporaire connu.
 */
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, tmpdir: () => '/private/var/folders/tmp' } };
});

const { ptyHostStateDir } = await import('../../src/pty-host-state.ts');

const WIN = process.platform === 'win32';
// Racine volontairement profonde : dépasse la limite des sockets Unix sous
// `.striart/pty/<agent>/attach.sock` (104 octets macOS / 108 Linux).
const DEEP_ROOT = '/private/var/folders/n6/hn37q6pj7sj_9dmqqc2113800000gn/T/striart-test-deepdir';

describe.skipIf(WIN)('ptyHostStateDir — repli de chemin trop long (POSIX)', () => {
  it('le dossier de repli se termine par le nom de l’agent (contrat du binaire natif)', () => {
    // cli.rs::parse_pty_host refuse tout --state-dir qui ne se termine pas
    // EXACTEMENT par --agent (USAGE) : un repli nommé autrement (un hash,
    // par exemple) serait rejeté par le binaire natif à chaque appel.
    const dir = ptyHostStateDir(DEEP_ROOT, 'agent-t');
    expect(dir.endsWith('/agent-t')).toBe(true);
    expect(dir).not.toBe(path.join(DEEP_ROOT, '.striart', 'pty', 'agent-t'));
  });

  it('le chemin complet du socket reste sous la limite des sockets Unix', () => {
    const dir = ptyHostStateDir(DEEP_ROOT, 'agent-t');
    const socket = `${dir}/attach.sock`;
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100);
  });

  it('deux agents du même dépôt reçoivent des dossiers distincts', () => {
    const a = ptyHostStateDir(DEEP_ROOT, 'agent-a');
    const b = ptyHostStateDir(DEEP_ROOT, 'agent-b');
    expect(a).not.toBe(b);
  });

  it('un nom d’agent trop long pour laisser une marge de hash utile est refusé (fail closed)', () => {
    // 64 caractères : longueur maximale admise par validateAgentName.
    const longAgent = 'a'.repeat(64);
    expect(() => ptyHostStateDir(DEEP_ROOT, longAgent)).toThrowError(
      expect.objectContaining({ code: 'PTY_STATE_PATH_TOO_LONG' }),
    );
  });
});
