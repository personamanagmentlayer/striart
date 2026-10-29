import { describe, expect, it, vi } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';

// Le rendu ne dépend ni de git ni du domaine : on isole le module de la commande.
vi.mock('../../src/watch-loop.ts', () => ({ startWatchLoop: async () => ({}) }));

const { renderWatchEvent } = await import('../../src/cli/commands/watch.ts');

function capture(m) {
  const lines = [];
  const out = {
    m,
    line: (level, text) => lines.push({ level, text }),
    hint: () => {},
    detail: () => {},
    untrusted: (t) => String(t ?? ''),
    duration: (ms) => `${Math.round(ms / 60_000)}min`,
  };
  return { out, lines };
}

describe('watch : événements du GC d’inactivité', () => {
  it.each([
    ['en', en, /idle for 45min.*closed after the grace period/],
    ['fr', fr, /inactif depuis 45min.*fermée après le délai de grâce/],
  ])('idle-warned (%s) : annonce la fermeture quand elle est activée', (_l, catalogue, re) => {
    const { out, lines } = capture(catalogue);
    renderWatchEvent(out, {
      type: 'idle-warned',
      agent: 'agent-a',
      idleMs: 45 * 60_000,
      willClose: true,
    });
    expect(lines[0].level).toBe('warn');
    expect(lines[0].text).toMatch(re);
  });

  it('idle-warned sans fermeture activée : ne promet pas une fermeture', () => {
    const { out, lines } = capture(en);
    renderWatchEvent(out, {
      type: 'idle-warned',
      agent: 'agent-a',
      idleMs: 45 * 60_000,
      willClose: false,
    });
    expect(lines[0].text).toContain('not enabled');
  });

  it('idle-closed : succès ; idle-refused : erreur avec code et motif ; idle-error : avertissement', () => {
    const { out, lines } = capture(en);
    renderWatchEvent(out, { type: 'idle-closed', agent: 'agent-a', host: 'acp', code: 'CLOSED' });
    renderWatchEvent(out, {
      type: 'idle-refused',
      agent: 'agent-b',
      host: 'process',
      code: 'IDLE_CLOSE_UNVERIFIED',
      detail: 'IDENTITY',
    });
    renderWatchEvent(out, { type: 'idle-error', error: { code: null, message: 'boom' } });
    expect(lines.map((l) => l.level)).toEqual(['ok', 'error', 'warn']);
    expect(lines[1].text).toContain('IDLE_CLOSE_UNVERIFIED');
    expect(lines[2].text).toContain('boom');
  });
});
