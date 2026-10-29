/**
 * Nature des erreurs du verrou principal (revue L1, second tour) : classées
 * EXPLICITEMENT dans ERROR_KINDS (source unique du code de sortie), pas par
 * le défaut — un code absent de la table est un oubli, pas un choix. Les
 * messages anglais correspondants existent.
 */
import { describe, expect, it } from 'vitest';
import { ERROR_KINDS, errorKindOf } from '../../src/errors.ts';
import { en } from '../../src/cli/i18n/en.ts';

describe('codes du verrou principal — classement explicite', () => {
  it.each(['LOCK_WAIT_CANCELLED', 'LOCK_IO_FAILED', 'LOCK_TIMEOUT'])(
    '%s : entrée explicite de ERROR_KINDS (échec d’exécution relançable)',
    (code) => {
      expect(Object.hasOwn(ERROR_KINDS, code)).toBe(true);
      expect(errorKindOf(code)).toBe('failure');
    },
  );

  it('LOCK_LOST reste un refus (exclusivité perdue : décision humaine)', () => {
    expect(errorKindOf('LOCK_LOST')).toBe('refusal');
  });

  // K-M8 : la famille STATE_* (fichiers d'état, verrou d'état) est classée
  // explicitement elle aussi — des échecs d'exécution relançables.
  it.each([
    'STATE_READ_FAILED',
    'STATE_WRITE_FAILED',
    'STATE_LOCK_TIMEOUT',
    'STATE_LOCK_LOST',
    'STATE_LOCK_FAILED',
  ])('%s : entrée explicite de ERROR_KINDS (échec d’exécution relançable)', (code) => {
    expect(Object.hasOwn(ERROR_KINDS, code)).toBe(true);
    expect(errorKindOf(code)).toBe('failure');
    expect(en.errors(code, {})).not.toBeNull();
  });

  // Une garde qui dit non : relancer telle quelle ne changera rien.
  it.each(['UNSUPPORTED_RESOLUTION_KIND', 'STRIART_COMMIT_UNSAFE', 'TICKET_PATH_UNSAFE'])(
    '%s : refus (décision humaine requise)',
    (code) => {
      expect(Object.hasOwn(ERROR_KINDS, code)).toBe(true);
      expect(errorKindOf(code)).toBe('refusal');
    },
  );

  it.each(['MERGE_COMMIT_FAILED', 'DAEMON_SPAWN_FAILED', 'TICKETS_UNREADABLE'])(
    '%s : échec d’exécution classé et traduit',
    (code) => {
      expect(Object.hasOwn(ERROR_KINDS, code)).toBe(true);
      expect(errorKindOf(code)).toBe('failure');
      expect(en.errors(code, {})).not.toBeNull();
    },
  );

  it('DAEMON_PIDFILE_CORRUPT : refus (inspecter puis supprimer le PID file)', () => {
    expect(errorKindOf('DAEMON_PIDFILE_CORRUPT')).toBe('refusal');
    expect(en.errors('DAEMON_PIDFILE_CORRUPT', { name: 'watch' })).toMatch(/watch/);
  });

  it('messages anglais actionnables', () => {
    expect(en.errors('LOCK_WAIT_CANCELLED', { operation: 'merge:a' })).toMatch(/cancelled/);
    expect(en.errors('LOCK_IO_FAILED', { operation: 'remove', path: 'x', cause: 'EPERM' })).toMatch(
      /antivirus/,
    );
    expect(
      en.errors('LOCK_TIMEOUT', { reason: 'BREAK_FAILED', holder: 'x', pid: 1, cause: 'EPERM' }),
    ).toMatch(/cannot be deleted \(EPERM\)/);
    expect(
      en.errors('MERGE_STATE_CHANGED', {
        agent: 'a',
        expectedHead: 'abcdef012345',
        markerWritten: false,
      }),
    ).toMatch(/could not be recorded/);
  });
});
