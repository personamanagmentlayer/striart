import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../../src/cli/caps.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { Output } from '../../src/cli/output.ts';
import { displayWidth, wrapWords } from '../../src/cli/text.ts';

describe('wrapWords', () => {
  it('coupe aux espaces, glouton, sans jamais dépasser quand c’est possible', () => {
    const lines = wrapWords('un deux trois quatre cinq six sept', 12);
    expect(lines).toEqual(['un deux', 'trois quatre', 'cinq six', 'sept']);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(12);
  });
  it('un mot plus long que la largeur n’est jamais coupé (un chemin reste entier)', () => {
    expect(wrapWords('voir /très/long/chemin/qui/ne/tient/pas ok', 10)).toEqual([
      'voir',
      '/très/long/chemin/qui/ne/tient/pas',
      'ok',
    ]);
  });
  it('largeur inconnue ou texte court : une seule ligne', () => {
    expect(wrapWords('a b c', 0)).toEqual(['a b c']);
    expect(wrapWords('a b c', 80)).toEqual(['a b c']);
  });
});

describe('Output.line : retour à la ligne propre dans un terminal', () => {
  const LONG =
    'aucun watcher actif : les commits des agents supervisés ne seront pas mergés automatiquement.';
  function make({ tty, columns, plain = false }) {
    const chunks = [];
    const sink = { write: (c) => chunks.push(c), isTTY: tty };
    const caps = detectCapabilities({
      env: { LANG: 'fr_FR.UTF-8', NO_COLOR: '1', COLUMNS: String(columns) },
      platform: 'linux',
      stdout: { isTTY: tty, columns },
      stderr: { isTTY: tty, columns },
      stdin: { isTTY: tty },
      plain,
      color: null,
    });
    const out = new Output({
      caps,
      messages: fr,
      stdout: sink,
      stderr: sink,
      quiet: false,
      json: false,
    });
    return { out, text: () => chunks.join('') };
  }

  it('terminal de 60 colonnes : aucune ligne ne dépasse, retrait sous le message', () => {
    const { out, text } = make({ tty: true, columns: 60 });
    out.line('info', LONG);
    const lines = text().trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(60);
    const indent = '· info : '.length;
    expect(lines[1].startsWith(' '.repeat(indent))).toBe(true);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('mergés automatiquement.');
  });

  it('hors terminal (redirection) : jamais coupé, une seule ligne', () => {
    const { out, text } = make({ tty: false, columns: 60 });
    out.line('info', LONG);
    expect(text().trimEnd().split('\n')).toHaveLength(1);
  });

  it('--plain : même retrait, crochets en toutes lettres', () => {
    const { out, text } = make({ tty: true, columns: 60, plain: true });
    out.line('warn', LONG);
    const lines = text().trimEnd().split('\n');
    expect(lines[0].startsWith('[attention] ')).toBe(true);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(60);
  });
});
