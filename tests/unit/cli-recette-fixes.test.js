import { describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../src/logger.ts';
import { logMcpScope } from '../../src/mcp/scope.ts';
import { detectCapabilities } from '../../src/cli/caps.ts';
import { Output } from '../../src/cli/output.ts';
import { asciiGlyphs } from '../../src/cli/text.ts';
import { isVersionRequest } from '../../src/cli/main.ts';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { validatePlan } from '../../src/plan.ts';
import { errorKindOf } from '../../src/errors.ts';

/**
 * Anomalies de la campagne de recette (CLI). Ces tests ont été écrits AVANT les correctifs
 * et vérifiés rouges sans eux.
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

describe('A4 — clés réservées de pino dans les champs de log', () => {
  it('logMcpScope n’émet aucun champ `level` (le niveau pino serait écrasé)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      logMcpScope(
        '/repo',
        { agent: null, boundBy: null, readOnly: false, collab: false, scope: 'orchestrator' },
        {},
      );
      const [fields] = warn.mock.calls[0];
      expect(Object.keys(fields)).not.toContain('level');
      expect(fields.scope).toBe('orchestrator');
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('aucun appel logger.* de src/ ne passe un champ littéral `level`, `time` ou `msg`', async () => {
    const offenders = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          const text = await readFile(full, 'utf8');
          const calls = text.matchAll(
            /\blogger\.(?:trace|debug|info|warn|error|fatal)\(\s*\{([^}]*)\}/gs,
          );
          for (const call of calls) {
            if (/(?:^|[,{\s])(level|time|msg)\s*(?::|,|$)/.test(call[1].trim() + '\n')) {
              offenders.push(`${path.relative(SRC, full)}: ${call[1].trim().slice(0, 60)}`);
            }
          }
        }
      }
    };
    await walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe('A9 — outil de hook inconnu', () => {
  it('HOOK_TOOL_UNKNOWN est une erreur d’usage (sortie 2), comme les autres valeurs invalides', () => {
    expect(errorKindOf('HOOK_TOOL_UNKNOWN')).toBe('usage');
  });
});

describe('A7 — langue du catalogue anglais', () => {
  it('LLM_FAILED : la cause française de la couche LLM est rendue en anglais', () => {
    const say = (cause) => en.errors('LLM_FAILED', { provider: 'ollama', model: 'm', cause }) ?? '';
    expect(say('panne de transport (ECONNREFUSED)')).toContain('transport failure (ECONNREFUSED)');
    expect(say('panne de transport (ECONNREFUSED)')).not.toMatch(/panne/);
    expect(say('délai dépassé')).toContain('timed out');
    expect(say('Ollama a répondu HTTP 503')).toContain('Ollama answered HTTP 503');
    // Une cause inconnue reste affichée telle quelle (aucune information perdue).
    expect(say('quelque chose')).toContain('quelque chose');
  });

  it('l’en-tête du script de complétion existe dans les deux langues', () => {
    expect(fr.completion.header('bash', 'x')).toContain('complétion bash');
    expect(en.completion.header('bash', 'x')).toBe('# striart — bash completion. Install: x');
  });
});

describe('plan sans version', () => {
  it('message dédié (et non « version undefined »)', () => {
    let error;
    try {
      validatePlan({ tasks: [{ prompt: 'p' }] });
    } catch (e) {
      error = e;
    }
    expect(error.details.reason).toBe('VERSION_MISSING');
    expect(en.errors('PLAN_INVALID', error.details)).toMatch(/"version" is missing/);
    expect(en.errors('PLAN_INVALID', error.details)).not.toMatch(/undefined/);
  });
});

describe('couleur — règle unique NO_COLOR > FORCE_COLOR > TERM=dumb > isTTY', () => {
  const caps = (env, tty = true) =>
    detectCapabilities({
      env,
      platform: 'linux',
      stdout: { isTTY: tty },
      stderr: { isTTY: tty },
      stdin: { isTTY: tty },
      plain: false,
      color: null,
    });

  it('la précédence est celle documentée', () => {
    expect(caps({ NO_COLOR: '1', FORCE_COLOR: '1', TERM: 'dumb' }).colorStdout).toBe(false);
    expect(caps({ FORCE_COLOR: '1', TERM: 'dumb' }).colorStdout).toBe(true);
    expect(caps({ TERM: 'dumb' }).colorStdout).toBe(false);
    expect(caps({ FORCE_COLOR: '1' }, false).colorStdout).toBe(true);
    expect(caps({}, false).colorStdout).toBe(false);
  });

  it('FORCE_COLOR=1 TERM=dumb : le libellé de niveau ET la piste sont colorés de la même façon', () => {
    const chunks = [];
    const sink = { write: (c) => chunks.push(c) };
    const out = new Output({
      caps: caps({ FORCE_COLOR: '1', TERM: 'dumb' }),
      messages: en,
      stdout: sink,
      stderr: sink,
      quiet: false,
      json: false,
    });
    out.line('ok', 'main repository free', 'striart status');
    const [label, hint] = chunks.join('').split('\n');
    // eslint-disable-next-line no-control-regex -- vérifie la présence de séquences ANSI
    expect(label).toMatch(/\u001B\[/);
    // eslint-disable-next-line no-control-regex
    expect(hint).toMatch(/\u001B\[/);
    expect(label).toContain('[ok]');
  });
});

describe('STRIART_ASCII — glyphes de l’aide', () => {
  it('asciiGlyphs remplace flèches, points de suspension, tirets et guillemets typographiques', () => {
    expect(asciiGlyphs('a → b … c — d ’e’ « f »')).toBe('a -> b ... c - d \'e\' " f "');
    expect(asciiGlyphs('élève')).toBe('élève');
  });
});

describe('--version --json', () => {
  it('reconnaît --version/-v parmi les seules options de tête', () => {
    expect(isVersionRequest(['--json', '--version'])).toBe(true);
    expect(isVersionRequest(['--version', '--json'])).toBe(true);
    expect(isVersionRequest(['-v'])).toBe(true);
    expect(isVersionRequest(['run', '--version'])).toBe(false);
    expect(isVersionRequest(['--', '--version'])).toBe(false);
    expect(isVersionRequest([])).toBe(false);
  });
});
