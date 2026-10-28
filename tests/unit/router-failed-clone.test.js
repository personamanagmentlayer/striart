import { describe, expect, it } from 'vitest';
import { detectCollisions, detectCollisionsDetailed, WHOLE_REPO } from '../../src/router.js';
import {
  failedKeptSessionStatus,
  isFailedSessionStatus,
  sessionFailureMarker,
} from '../../src/session-failure.ts';

const FAILED = {
  mode: 'autonomous',
  sessionPid: null,
  sessionStartedAt: '2026-10-27T10:00:00.000Z',
  sessionFailure: {
    status: 'FAILED',
    at: '2026-10-27T10:01:00.000Z',
    hasCommits: false,
    sessionStartedAt: '2026-10-27T10:00:00.000Z',
  },
};

describe('failedKeptSessionStatus — clone en échec inerte', () => {
  it('rend le statut pour un clone autonome échoué, sans commit, sans session', () => {
    expect(failedKeptSessionStatus(FAILED)).toBe('FAILED');
  });

  it.each([
    ['aucun marqueur', { ...FAILED, sessionFailure: undefined }],
    ['mode supervisé', { ...FAILED, mode: 'attended' }],
    ['PID de session publié (même périmé)', { ...FAILED, sessionPid: 4242 }],
    ['nouvelle session depuis', { ...FAILED, sessionStartedAt: '2026-10-27T11:00:00.000Z' }],
    [
      'des commits portés',
      { ...FAILED, sessionFailure: { ...FAILED.sessionFailure, hasCommits: true } },
    ],
    [
      'hasCommits illisible',
      { ...FAILED, sessionFailure: { ...FAILED.sessionFailure, hasCommits: undefined } },
    ],
    [
      'annulation demandée',
      { ...FAILED, sessionFailure: { ...FAILED.sessionFailure, status: 'CANCELLED' } },
    ],
    ['suppression en cours', { ...FAILED, removing: true }],
  ])('fail closed : %s', (_label, meta) => {
    expect(failedKeptSessionStatus(meta)).toBeNull();
  });

  it('classe les statuts : annulation et succès ne sont pas des échecs', () => {
    expect(isFailedSessionStatus('FAILED')).toBe(true);
    expect(isFailedSessionStatus('TIMEOUT')).toBe(true);
    expect(isFailedSessionStatus('COMPLETED')).toBe(false);
    expect(isFailedSessionStatus('CANCELLED')).toBe(false);
  });

  it('le marqueur retient le départ de la session constatée', () => {
    const m = sessionFailureMarker({ sessionStartedAt: 'x' }, 'FAILED', false, new Date(0));
    expect(m).toEqual({
      status: 'FAILED',
      at: '1970-01-01T00:00:00.000Z',
      hasCommits: false,
      sessionStartedAt: 'x',
    });
  });
});

describe('detectCollisionsDetailed — la sentinelle ignore seulement les clones échoués', () => {
  const failed = { name: 'a', predictedFiles: ['src/a.js'], sessionFailed: 'FAILED' };
  const live = { name: 'b', predictedFiles: ['src/b.js'], sessionFailed: null };

  it('tâche vague (**) : le clone échoué est relâché et nommé, le vivant bloque', () => {
    const r = detectCollisionsDetailed([WHOLE_REPO], [failed, live]);
    expect(r.collisions).toEqual([{ agent: 'b', files: [WHOLE_REPO] }]);
    expect(r.relaxed).toEqual([{ agent: 'a', reason: 'SESSION_FAILED', status: 'FAILED' }]);
  });

  it('clone échoué dont la prédiction est `**` : une tâche précise ne l’attend plus', () => {
    const vagueFailed = { name: 'v', predictedFiles: [WHOLE_REPO], sessionFailed: 'FAILED' };
    const r = detectCollisionsDetailed(['src/x.js'], [vagueFailed]);
    expect(r.collisions).toEqual([]);
    expect(r.relaxed).toHaveLength(1);
  });

  it('fichier PRÉCIS partagé : bloquant même contre un clone échoué', () => {
    const r = detectCollisionsDetailed(['src/a.js'], [failed]);
    expect(r.collisions).toEqual([{ agent: 'a', files: ['src/a.js'] }]);
    expect(r.relaxed).toEqual([]);
  });

  it('sans marqueur sessionFailed, comportement inchangé', () => {
    const plain = { name: 'a', predictedFiles: ['src/a.js'] };
    expect(detectCollisions([WHOLE_REPO], [plain])).toEqual([{ agent: 'a', files: [WHOLE_REPO] }]);
  });
});
