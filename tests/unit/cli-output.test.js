import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { detectCapabilities } from '../../src/cli/caps.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { en } from '../../src/cli/i18n/en.ts';
import { Output } from '../../src/cli/output.ts';
import { displayWidth, sanitize, truncate } from '../../src/cli/text.ts';

function sink() {
  const chunks = [];
  return { write: (c) => chunks.push(c), text: () => chunks.join(''), isTTY: false };
}

function output({
  json = false,
  quiet = false,
  plain = false,
  columns = null,
  messages = fr,
  env = {},
} = {}) {
  const stdout = sink();
  const stderr = sink();
  const caps = detectCapabilities({
    env: { LANG: 'fr_FR.UTF-8', ...env, ...(columns ? { COLUMNS: String(columns) } : {}) },
    platform: 'linux',
    stdout: { isTTY: false },
    stderr: { isTTY: false },
    stdin: { isTTY: false },
    plain,
    color: null,
  });
  return { out: new Output({ caps, messages, stdout, stderr, quiet, json }), stdout, stderr };
}

describe('text', () => {
  it('sanitize neutralise les séquences de contrôle d’un texte non fiable', () => {
    const hostile = 'feat: ok\u001B]0;pwned\u0007\u001B[2J\u009B31m';
    const safe = sanitize(hostile);
    // eslint-disable-next-line no-control-regex -- vérifie précisément l'absence de contrôles
    expect(safe).not.toMatch(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/);
    expect(safe).toContain('\\x1b');
    expect(sanitize('a\tb')).toBe('a\tb');
    expect(sanitize('ligne 1\nligne 2')).toBe('ligne 1↵ligne 2');
  });

  it('sanitize neutralise les contrôles bidirectionnels (usurpation d’affichage d’un nom de fichier)', () => {
    // Trojan Source : un override U+202E avant « txt.exe » affiche « exe.txt ».
    expect(sanitize('evil‮txt.exe')).toBe('evil\\u202etxt.exe');
    for (const cp of [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f,
      0x061c,
    ]) {
      expect(sanitize(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(
        `a\\u${cp.toString(16).padStart(4, '0')}b`,
      );
    }
    // Les jointures d'émojis et le texte arabe/hébreu ordinaire restent intacts.
    expect(sanitize('👨‍👩 שלום مرحبا')).toBe('👨‍👩 שלום مرحبا');
  });

  it('displayWidth compte les caractères larges et ignore les séquences de style', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth('\u001B[1mgras\u001B[22m')).toBe(4);
    expect(displayWidth('é')).toBe(1);
  });

  it('truncate coupe à la largeur avec une ellipse', () => {
    expect(truncate('abcdefgh', 5, '…')).toBe('abcd…');
    expect(truncate('abc', 5, '…')).toBe('abc');
    expect(truncate('abcdefgh', 6, '...')).toBe('abc...');
  });
});

describe('Output — lignes de statut', () => {
  it('le niveau est toujours porté par un MOT (lecteurs d’écran, daltonisme, logs)', () => {
    const { out, stdout } = output();
    out.line('ok', 'merge fait');
    out.line('error', 'gate rouge', 'striart resolve');
    expect(stdout.text()).toBe('✓ ok : merge fait\n✗ erreur : gate rouge\n  → striart resolve\n');
  });

  it('--plain : préfixe entre crochets, ni glyphe ni couleur', () => {
    const { out, stdout } = output({ plain: true });
    out.line('warn', 'mode manuel');
    expect(stdout.text()).toBe('[attention] mode manuel\n');
  });

  it('anglais : séparateur et mots de niveau localisés', () => {
    const { out, stdout } = output({ messages: en });
    out.line('warn', 'manual mode');
    expect(stdout.text()).toBe('! warning: manual mode\n');
  });

  it('les pistes sont neutralisées (valeurs venues du registre ou de la config)', () => {
    const { out, stdout } = output();
    out.hint('claude\u001B]8;;http://evil\u0007');
    expect(stdout.text()).not.toContain('\u001B');
  });

  it('--json : aucune sortie humaine sur stdout, progression muette', () => {
    const { out, stdout, stderr } = output({ json: true });
    out.line('ok', 'x');
    out.step('travail');
    out.document({ ok: true });
    expect(stdout.text()).toBe('{"ok":true}\n');
    expect(stderr.text()).toBe('');
  });

  it('la progression va sur stderr, jamais sur stdout ; --quiet la coupe', () => {
    const a = output();
    a.out.step('Merge');
    expect(a.stdout.text()).toBe('');
    expect(a.stderr.text()).toBe('… Merge\n');
    const b = output({ quiet: true });
    b.out.step('Merge');
    expect(b.stderr.text()).toBe('');
  });

  it('un message d’erreur ou d’avertissement intégrant une valeur externe est neutralisé', () => {
    const { out, stderr } = output();
    out.error("fatal: couldn't find ref \u001B]0;pwned\u0007", null, 'X');
    out.warn('push échoué : \u001B[2J');
    expect(stderr.text()).not.toContain('\u001B');
  });

  it('erreurs et avertissements sur stderr, avec le code entre parenthèses', () => {
    const { out, stdout, stderr } = output();
    out.error('agent inconnu', 'striart status', 'AGENT_UNKNOWN');
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('✗ erreur : agent inconnu (AGENT_UNKNOWN)\n  → striart status\n');
  });
});

describe('Output — tableaux', () => {
  const columns = [
    { key: 'a', header: 'AGENT', value: (r) => r.a, priority: 9 },
    { key: 'm', header: 'MESSAGE', value: (r) => r.m, priority: 5, shrink: { min: 6 } },
    { key: 'x', header: 'EXTRA', value: (r) => r.x, priority: 1 },
  ];
  const rows = [{ a: 'agent-a', m: 'un message de commit assez long', x: 'zzz' }];

  it('hors terminal : jamais tronqué, aucun espace en fin de ligne', () => {
    const { out, stdout } = output();
    out.table(columns, rows);
    const lines = stdout.text().split('\n').filter(Boolean);
    expect(lines[1]).toBe('agent-a  un message de commit assez long  zzz');
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });

  it('terminal étroit : compresse puis retire les colonnes de plus basse priorité', () => {
    const { out, stdout } = output({ columns: 30 });
    out.table(columns, rows);
    const lines = stdout.text().split('\n').filter(Boolean);
    expect(lines[0]).not.toContain('EXTRA');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
    expect(lines[1]).toContain('…');
  });

  it('une cellule non fiable est neutralisée', () => {
    const { out, stdout } = output();
    out.table(columns, [{ a: 'a', m: 'x\u001B[2Jy', x: '' }]);
    expect(stdout.text()).not.toContain('\u001B');
  });
});

describe('Output — chemins', () => {
  it('relatifs à la racine du dépôt quand ils y sont, absolus sinon', () => {
    const { out } = output();
    const root = path.resolve('/tmp/repo');
    out.root = root;
    expect(out.path(path.join(root, '.striart', 'conflicts', 't1'))).toBe(
      path.join('.striart', 'conflicts', 't1'),
    );
    expect(out.path(path.resolve('/ailleurs/x'))).toBe(path.resolve('/ailleurs/x'));
  });
});
