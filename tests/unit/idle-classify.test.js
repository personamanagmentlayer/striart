import { describe, expect, it } from 'vitest';
import { classifyAgent } from '../../src/idle/classify.ts';
import { resolveIdleSettings } from '../../src/idle/settings.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const known = (name, agoMs) => ({ name, status: 'known', at: NOW - agoMs });
const absent = (name) => ({ name, status: 'absent', at: null });

/** Entrée « session vivante, tous signaux vieux de `ago` ». */
function input(ago, overrides = {}) {
  return {
    name: 'agent-a',
    kind: 'live',
    host: 'process',
    signals: [
      known('sessionStart', ago + 5 * MIN),
      known('sessionOutput', ago),
      known('worktree', ago),
      known('refs', ago),
      absent('messages'),
    ],
    blockers: [],
    warnedAt: null,
    closeAuthorized: true,
    forceClose: false,
    ...overrides,
  };
}
const settings = (idle = {}) => resolveIdleSettings({ idle });
const classify = (inp, idle = {}, now = NOW) => classifyAgent(inp, settings(idle), now);

describe('classifyAgent : un agent n’est inactif que si TOUS les signaux dépassent le seuil', () => {
  it('actif tant que le signal le plus récent est sous warnAfterMs', () => {
    const v = classify(input(10 * MIN));
    expect(v.state).toBe('active');
    expect(v.idleMs).toBe(10 * MIN);
    expect(v.plan).toBe('none');
  });

  it('un seul signal frais suffit à garder l’agent actif, quel qu’il soit', () => {
    for (const fresh of ['sessionStart', 'sessionOutput', 'worktree', 'refs', 'messages']) {
      const base = input(3 * 3_600_000);
      base.signals = base.signals.map((s) =>
        s.name === fresh ? known(fresh, 2 * MIN) : s.name === 'messages' ? absent('messages') : s,
      );
      const v = classify(base);
      expect(v.state, fresh).toBe('active');
      expect(v.lastActivitySignal, fresh).toBe(fresh);
      expect(v.plan, fresh).toBe('none');
    }
  });

  it('inactif (idle) au seuil exact, avec la durée et le signal le plus récent', () => {
    const v = classify(input(30 * MIN));
    expect(v.state).toBe('idle');
    expect(v.idleMs).toBe(30 * MIN);
    expect(classify(input(30 * MIN - 1)).state).toBe('active');
  });

  it('seuils configurables', () => {
    expect(classify(input(10 * MIN), { warnAfterMs: 5 * MIN }).state).toBe('idle');
    expect(classify(input(10 * MIN), { warnAfterMs: 15 * MIN }).state).toBe('active');
  });
});

describe('classifyAgent : fail closed', () => {
  it('un signal illisible (unknown) rend l’agent ACTIF, nommé dans les raisons', () => {
    const base = input(5 * 3_600_000);
    base.signals[2] = { name: 'worktree', status: 'unknown', at: null };
    const v = classify(base, { action: 'close' });
    expect(v.state).toBe('active');
    expect(v.reasons).toContain('SIGNAL_UNKNOWN:worktree');
    expect(v.plan).toBe('none');
    expect(v.closable).toBe(false);
  });

  it('aucun signal connu : actif (rien ne prouve l’inactivité)', () => {
    const v = classify(input(0, { signals: [absent('refs'), absent('messages')] }));
    expect(v.state).toBe('active');
    expect(v.reasons).toContain('NO_SIGNAL');
  });

  it('horloge en retard sur un signal (dans le futur) : actif', () => {
    const base = input(5 * 3_600_000);
    base.signals[1] = { name: 'sessionOutput', status: 'known', at: NOW + 10 * MIN };
    const v = classify(base);
    expect(v.state).toBe('active');
    expect(v.reasons).toContain('CLOCK_SKEW');
  });

  it('horodatage non fini ou négatif : traité comme illisible', () => {
    for (const at of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const base = input(5 * 3_600_000);
      base.signals[2] = { name: 'worktree', status: 'known', at };
      expect(classify(base).state, String(at)).toBe('active');
    }
  });
});

describe('classifyAgent : garde-fous (jamais fermés, jamais avertis)', () => {
  it.each([
    'HUMAN_REQUEST',
    'OPEN_TICKET',
    'ORCHESTRATED',
    'MERGE_IN_PROGRESS',
    'MAIN_SESSION',
    'REMOVING',
    'EXCLUDED',
  ])('blocage %s : protégé, aucun plan, non fermable, même si tout est vieux', (blocker) => {
    const v = classify(input(10 * 3_600_000, { blockers: [blocker], warnedAt: NOW - 3_600_000 }), {
      action: 'close',
    });
    expect(v.state).toBe('protected');
    expect(v.blockers).toEqual([blocker]);
    expect(v.plan).toBe('none');
    expect(v.closable).toBe(false);
  });
});

describe('classifyAgent : états de session', () => {
  it('session morte (clone conservé) ou jamais lancée : idle rapporté, rien à fermer', () => {
    for (const kind of ['ended', 'none']) {
      const v = classify(input(5 * 3_600_000, { kind, host: 'none' }), { action: 'close' });
      expect(v.state, kind).toBe('idle');
      expect(v.kind).toBe(kind);
      expect(v.plan).toBe('none');
      expect(v.closable).toBe(false);
      expect(v.closeBlockedBy).toContain('NO_LIVE_SESSION');
    }
  });
});

describe('classifyAgent : cycle avertissement → grâce → fermeture', () => {
  const idle3h = 3 * 3_600_000;

  it("action 'report' : jamais d'avertissement ni de fermeture", () => {
    const v = classify(input(idle3h), { action: 'report' });
    expect(v.state).toBe('idle');
    expect(v.plan).toBe('none');
    expect(v.closable).toBe(false);
  });

  it("action 'warn' : avertit une fois par période d'inactivité, ne ferme jamais", () => {
    expect(classify(input(idle3h), { action: 'warn' }).plan).toBe('warn');
    const warned = classify(input(idle3h, { warnedAt: NOW - 10 * MIN }), { action: 'warn' });
    expect(warned.plan).toBe('none');
    expect(warned.stage).toBe('warned');
    expect(warned.closable).toBe(false);
  });

  it('jamais de fermeture sans avertissement préalable, même au-delà de closeAfterMs', () => {
    const v = classify(input(idle3h), { action: 'close' });
    expect(v.plan).toBe('warn');
    expect(v.closable).toBe(false);
  });

  it('pendant la grâce : ni fermeture ni nouvel avertissement', () => {
    const v = classify(input(idle3h, { warnedAt: NOW - 2 * MIN }), { action: 'close' });
    expect(v.plan).toBe('none');
    expect(v.stage).toBe('warned');
    expect(v.closeNotBefore).toBe(NOW - 2 * MIN + 5 * MIN);
  });

  it('grâce écoulée ET closeAfterMs atteint ET autorisé : fermeture', () => {
    const v = classify(input(idle3h, { warnedAt: NOW - 6 * MIN }), { action: 'close' });
    expect(v.plan).toBe('close');
    expect(v.closable).toBe(true);
    expect(v.stage).toBe('closable');
  });

  it('closeAfterMs pas atteint : averti mais pas fermable', () => {
    const v = classify(input(45 * MIN, { warnedAt: NOW - 20 * MIN }), { action: 'close' });
    expect(v.state).toBe('idle');
    expect(v.plan).toBe('none');
    expect(v.closable).toBe(false);
  });

  it("un avertissement ANTÉRIEUR à la dernière activité n'est plus valable (nouvelle période)", () => {
    // Activité il y a 40 min ; averti il y a 3 h (période précédente) : il faut ré-avertir.
    const v = classify(input(40 * MIN, { warnedAt: NOW - idle3h }), {
      action: 'close',
      closeAfterMs: 30 * MIN,
    });
    expect(v.plan).toBe('warn');
    expect(v.closable).toBe(false);
  });

  it('non autorisé par la config utilisateur : jamais fermable, motif nommé', () => {
    const v = classify(input(idle3h, { warnedAt: NOW - 6 * MIN, closeAuthorized: false }), {
      action: 'close',
    });
    expect(v.plan).toBe('none');
    expect(v.closable).toBe(false);
    expect(v.closeBlockedBy).toContain('NOT_AUTHORIZED');
  });

  it('demande humaine explicite (forceClose) : remplace l’autorisation et l’action, pas la grâce ni les seuils', () => {
    const early = classify(input(idle3h, { forceClose: true, closeAuthorized: false }), {
      action: 'report',
    });
    expect(early.plan).toBe('warn');
    const ready = classify(
      input(idle3h, { forceClose: true, closeAuthorized: false, warnedAt: NOW - 6 * MIN }),
      { action: 'report' },
    );
    expect(ready.plan).toBe('close');
    const notIdle = classify(input(5 * MIN, { forceClose: true }), { action: 'report' });
    expect(notIdle.plan).toBe('none');
  });

  describe('terminal (pty) dont la dernière sortie est PUBLIÉE par l’hôte (ptyOutputObserved)', () => {
    const observed = (ago, over = {}) =>
      input(ago, { host: 'pty', ptyOutputObserved: true, warnedAt: NOW - 6 * MIN, ...over });

    it('fermable SANS closePty quand la sortie est observée et tout est écoulé', () => {
      const v = classify(observed(idle3h), { action: 'close' });
      expect(v.closable).toBe(true);
      expect(v.plan).toBe('close');
      expect(v.closeBlockedBy).not.toContain('PTY_OUTPUT_UNOBSERVABLE');
    });

    it('une sortie récente garde l’agent actif : la sortie observée compte comme un signal', () => {
      const base = observed(idle3h);
      base.signals = base.signals.map((s) =>
        s.name === 'sessionOutput' ? known('sessionOutput', 2 * MIN) : s,
      );
      const v = classify(base, { action: 'close' });
      expect(v.state).toBe('active');
      expect(v.plan).toBe('none');
    });

    it('les AUTRES garde-fous restent entiers (autorisation, grâce, seuil de fermeture, garde)', () => {
      expect(
        classify(observed(idle3h, { closeAuthorized: false }), { action: 'close' }).closeBlockedBy,
      ).toContain('NOT_AUTHORIZED');
      expect(
        classify(observed(idle3h, { warnedAt: NOW - MIN }), { action: 'close' }).closeBlockedBy,
      ).toContain('GRACE_RUNNING');
      expect(
        classify(observed(45 * MIN, { warnedAt: NOW - 6 * MIN }), { action: 'close' })
          .closeBlockedBy,
      ).toContain('BELOW_CLOSE_THRESHOLD');
      const guarded = classify(observed(idle3h, { blockers: ['OPEN_TICKET'] }), {
        action: 'close',
      });
      expect(guarded.closable).toBe(false);
      expect(guarded.stage).toBe('protected');
    });

    it('sortie NON observée (absent ou faux) : le blocage historique demeure', () => {
      for (const flag of [undefined, false]) {
        const base = observed(idle3h, { ptyOutputObserved: flag });
        const v = classify(base, { action: 'close' });
        expect(v.closable).toBe(false);
        expect(v.closeBlockedBy).toContain('PTY_OUTPUT_UNOBSERVABLE');
      }
    });
  });

  it('terminal (pty) : sortie inobservable, fermeture refusée sauf closePty', () => {
    const base = input(idle3h, { host: 'pty', warnedAt: NOW - 6 * MIN });
    base.signals[1] = { name: 'sessionOutput', status: 'unobservable', at: null };
    const blocked = classify(base, { action: 'close' });
    expect(blocked.state).toBe('idle');
    expect(blocked.closable).toBe(false);
    expect(blocked.closeBlockedBy).toContain('PTY_OUTPUT_UNOBSERVABLE');
    const allowed = classify(base, { action: 'close', closePty: true });
    expect(allowed.closable).toBe(true);
    expect(allowed.plan).toBe('close');
  });
});
