import { describe, expect, it } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';

/**
 * Parité structurelle fr ↔ en. `tsc` impose déjà que `en` satisfasse
 * `Messages`, mais seulement sur le TYPE des feuilles : ce test compare les
 * clés réellement présentes à l'exécution (objets imbriqués, tableaux) — une
 * clé ajoutée d'un seul côté, ou un tableau de longueur différente, échoue.
 */
function shape(node, prefix = '', out = []) {
  if (Array.isArray(node)) {
    out.push(`${prefix}[${node.length}]`);
    return out;
  }
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node).sort()) shape(node[key], `${prefix}.${key}`, out);
    return out;
  }
  out.push(`${prefix}:${typeof node}`);
  return out;
}

describe('catalogues fr / en : parité structurelle', () => {
  it('mêmes clés, mêmes natures (chaîne / fonction / tableau) partout', () => {
    const a = new Set(shape(fr));
    const b = new Set(shape(en));
    const onlyFr = [...a].filter((k) => !b.has(k));
    const onlyEn = [...b].filter((k) => !a.has(k));
    expect({ onlyFr, onlyEn }).toEqual({ onlyFr: [], onlyEn: [] });
  });
});

describe('fr.errors : les erreurs de verrou d’état sont traduites avec leurs détails', () => {
  it('STATE_LOCK_TIMEOUT : une phrase par cause, avec le verrou et le porteur', () => {
    const held = fr.errors('STATE_LOCK_TIMEOUT', {
      lockFile: '.striart/state.lock',
      pid: 4242,
      heldForMs: 12_000,
    });
    expect(held).toContain('.striart/state.lock');
    expect(held).toContain('4242');
    const breakFailed = fr.errors('STATE_LOCK_TIMEOUT', {
      lockFile: 'l',
      reason: 'BREAK_FAILED',
      cause: 'EPERM',
    });
    expect(breakFailed).toContain('EPERM');
    const unreadable = fr.errors('STATE_LOCK_TIMEOUT', {
      lockFile: 'l',
      reason: 'LOCK_UNREADABLE',
      cause: 'EACCES',
    });
    expect(unreadable).toContain('EACCES');
    expect(new Set([held, breakFailed, unreadable]).size).toBe(3);
  });

  it('STATE_LOCK_LOST et STATE_LOCK_FAILED', () => {
    expect(fr.errors('STATE_LOCK_LOST', { lockFile: 'l' })).toContain('l');
    const created = fr.errors('STATE_LOCK_FAILED', { lockFile: 'l', cause: 'EACCES' });
    expect(created).toContain('EACCES');
    const handled = fr.errors('STATE_LOCK_FAILED', {
      lockFile: 'l',
      operation: 'lecture',
      cause: 'EIO',
    });
    expect(handled).toContain('lecture');
    expect(handled).not.toBe(created);
  });
});
