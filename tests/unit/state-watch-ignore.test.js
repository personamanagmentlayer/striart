import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { isIgnoredStatePath } from '../../src/state-watch-ignore.ts';

const p = (...parts) => parts.join(path.sep);

describe('isIgnoredStatePath — chemins de .striart/ qui ne sont jamais un changement d’état', () => {
  it.each([
    'main.lock',
    'state.lock',
    'state.lock.break',
    'agents.json.123.abcdef012345.tmp',
    p('lock-queue', '0001.json'),
    p('removing', 'agent-a.json'),
    p('agents', 'agent-a', 'x'),
  ])('ignore %s', (rel) => {
    expect(isIgnoredStatePath(rel)).toBe(true);
  });

  it.each([
    'agents.json',
    'queue.json',
    'state.json',
    'locks.json',
    p('conflicts', 't1', 'ticket.json'),
  ])('ne masque pas %s', (rel) => {
    expect(isIgnoredStatePath(rel)).toBe(false);
  });

  it('têtes supplémentaires propres à un consommateur', () => {
    expect(isIgnoredStatePath(p('logs', 'watch.log'), ['logs'])).toBe(true);
    expect(isIgnoredStatePath(p('logs', 'watch.log'))).toBe(false);
  });

  it('la racine et les chemins hors du dossier ne sont pas ignorés (le filtre ne décide pas pour eux)', () => {
    expect(isIgnoredStatePath('')).toBe(false);
    expect(isIgnoredStatePath(p('..', 'x'))).toBe(false);
  });
});
