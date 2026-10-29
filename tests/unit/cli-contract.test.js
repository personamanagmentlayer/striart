import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_KINDS } from '../../src/errors.ts';
import { detectLocale } from '../../src/cli/i18n/index.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { en } from '../../src/cli/i18n/en.ts';
import { COMMANDS, publicCommands } from '../../src/cli/registry.ts';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Tous les codes d'erreur levés dans src/ (littéraux `code: 'X'` et `errorCode: 'X'`). */
async function thrownCodes() {
  const codes = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        const text = await readFile(full, 'utf8');
        for (const match of text.matchAll(/\b(?:code|errorCode)(?::| \?\?=) '([A-Z][A-Z_]+)'/g))
          codes.add(match[1]);
      }
    }
  };
  await walk(SRC);
  return codes;
}

/**
 * Codes qui apparaissent comme `code: '…'` dans src/ sans être des erreurs du
 * domaine : avertissements de la CLI (jamais levés), erreur inattendue, et
 * codes système (EEXIST… : `Object.assign(new Error(), {code: 'EEXIST'})`).
 */
const NOT_DOMAIN_ERRORS = new Set([
  'ACP_BINARY_DOWNLOADED',
  'CONTROL_LINK_PENDING',
  'DEPRECATED_OPTION',
  // Avertissement de `stop`/`clean` (artefacts périphériques non nettoyés), jamais levé.
  'AGENT_ARTIFACT_FAILED',
  'HOOK_ADVISORY_SKIPPED',
  'PTY_HOST_STOPPING',
  'PTY_HOST_UNTOUCHED',
  'TERMINAL_OPEN_FAILED',
  'UNEXPECTED',
]);
/**
 * Codes dont l'entrée du catalogue anglais rend `null` quand les détails ne
 * permettent pas de formuler mieux que le message du domaine (qui reste alors
 * affiché, plus détaillé) : on vérifie qu'ils ONT une entrée en leur donnant
 * des détails exploitables.
 */
const RENDERABLE_DETAILS = {
  INVALID_ARGUMENT: { option: 'x' },
  CONTROL_INSTANCE_NOT_FOUND: { port: 3456 },
};
const isSystemErrno = (code) => Object.hasOwn(osConstants.errno, code);

/** Clés de premier et second niveau d'un catalogue (structure, pas valeurs). */
function shape(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.keys(value)
    .sort()
    .flatMap((key) => shape(value[key], prefix ? `${prefix}.${key}` : key));
}

describe('contrat des erreurs', () => {
  it('chaque code classé dans ERROR_KINDS est réellement levé quelque part (pas d’entrée morte)', async () => {
    const codes = await thrownCodes();
    // Codes produits par la CLI à partir des erreurs de commander (main.ts).
    for (const code of [
      'UNKNOWN_OPTION',
      'UNKNOWN_COMMAND',
      'MISSING_ARGUMENT',
      'MISSING_OPTION_VALUE',
      'MISSING_OPTION',
      'EXCESS_ARGUMENTS',
      'MISSING_COMMAND',
    ]) {
      codes.add(code);
    }
    const dead = Object.keys(ERROR_KINDS).filter((code) => !codes.has(code));
    expect(dead).toEqual([]);
  });

  it('le catalogue anglais traduit chaque code levé par le domaine', async () => {
    const missing = [...(await thrownCodes())]
      .filter((code) => !code.startsWith('PACK_'))
      // Avertissements de la CLI (jamais levés comme erreurs), erreur
      // inattendue (message déjà composé avec le texte d'origine) et codes
      // système (errno : ce ne sont pas des codes Striart).
      .filter((code) => !NOT_DOMAIN_ERRORS.has(code) && !isSystemErrno(code))
      .filter((code) => en.errors(code, RENDERABLE_DETAILS[code] ?? {}) === null);
    expect(missing).toEqual([]);
  });

  it('chaque code levé par le domaine est CLASSÉ explicitement dans ERROR_KINDS (un oubli ne passe plus en silence)', async () => {
    const unclassified = [...(await thrownCodes())]
      .filter((code) => !code.startsWith('PACK_'))
      .filter((code) => !NOT_DOMAIN_ERRORS.has(code) && !isSystemErrno(code))
      .filter((code) => !Object.hasOwn(ERROR_KINDS, code))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it('ERROR_KINDS ne classe aucun code système ni avertissement', () => {
    const wrong = Object.keys(ERROR_KINDS).filter(
      (code) => NOT_DOMAIN_ERRORS.has(code) || isSystemErrno(code),
    );
    expect(wrong).toEqual([]);
  });
});

describe('catalogues i18n', () => {
  it('l’épilogue d’aide documente chaque code de sortie du barème, 143 compris', () => {
    for (const catalogue of [fr, en]) {
      const epilog = catalogue.help.rootEpilog;
      for (const code of [0, 1, 2, 3, 130, 143]) {
        expect(epilog, `code ${code}`).toMatch(new RegExp(`^ {2}${code} {2,}`, 'm'));
      }
    }
  });

  it('fr et en ont exactement la même structure', () => {
    expect(shape(en)).toEqual(shape(fr));
  });

  it('chaque commande du registre a ses textes dans les deux langues', () => {
    for (const spec of COMMANDS) {
      for (const catalogue of [fr, en]) {
        const entry = catalogue.commands[spec.name];
        expect(entry, spec.name).toBeDefined();
        expect(entry.summary.length).toBeGreaterThan(0);
        if (!spec.hidden) expect(entry.examples.length, spec.name).toBeGreaterThan(0);
      }
    }
  });

  it('detectLocale : STRIART_LANG, puis la locale POSIX ; le français seulement s’il est demandé', () => {
    expect(detectLocale({ STRIART_LANG: 'en', LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(detectLocale({ STRIART_LANG: 'fr' })).toBe('fr');
    expect(detectLocale({ LANG: 'fr_CA.UTF-8' })).toBe('fr');
    expect(detectLocale({ LC_ALL: 'de_DE.UTF-8', LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(detectLocale({ LANG: 'en_US.UTF-8' })).toBe('en');
  });
});

describe('conventions de la couche CLI', () => {
  it('aucun `schemaVersion: <littéral>` : la version du document est SCHEMA_VERSION (source unique)', async () => {
    const offenders = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(js|ts)$/.test(entry.name)) {
          const text = await readFile(full, 'utf8');
          if (/schemaVersion:\s*\d/.test(text)) offenders.push(path.relative(SRC, full));
        }
      }
    };
    await walk(path.join(SRC, 'cli'));
    expect(offenders).toEqual([]);
  });
});

describe('registre des commandes', () => {
  it('chaque commande publique est documentée dans docs/fr et docs/en', async () => {
    const docs = {
      fr: await readFile(
        fileURLToPath(new URL('../../docs/fr/commandes.md', import.meta.url)),
        'utf8',
      ),
      en: await readFile(
        fileURLToPath(new URL('../../docs/en/commands.md', import.meta.url)),
        'utf8',
      ),
    };
    for (const spec of publicCommands()) {
      for (const [lang, text] of Object.entries(docs)) {
        expect(text.includes(`striart ${spec.name}`), `${spec.name} absent de docs/${lang}`).toBe(
          true,
        );
      }
    }
  });

  it('les commandes de premier plan déclarent leur raison', () => {
    for (const name of ['watch', 'mcp', 'attach', 'dashboard']) {
      expect(COMMANDS.find((c) => c.name === name)?.foreground).toBeDefined();
    }
  });
});
