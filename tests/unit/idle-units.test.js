import { beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { outputBeatPath, closeRequestPath } from '../../src/idle/paths.ts';
import { judgeOrphanAgent } from '../../src/idle/close.ts';
import { isIgnoredStatePath } from '../../src/state-watch-ignore.ts';
import { COMMANDS, commandSpec } from '../../src/cli/registry.ts';
import { METHOD_SPECS, methodSpec } from '../../src/control/schema.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { en } from '../../src/cli/i18n/en.ts';

// Chemins calculés seulement : le dossier n'est jamais créé.
let root;
beforeEach(() => {
  root = path.join(os.tmpdir(), 'striart-idle-paths');
});

describe('judgeOrphanAgent : identité d’un agent orphelin par son heure de création', () => {
  const published = Date.UTC(2026, 9, 27, 12, 0, 0);
  it('créé juste avant sa publication : vérifié', () => {
    expect(judgeOrphanAgent({ startTimeMs: published - 500 }, published)).toBe('alive');
    expect(judgeOrphanAgent({ startTimeMs: published + 1_000 }, published)).toBe('alive');
  });
  it('créé APRÈS la publication (PID recyclé) ou longtemps avant (autre process) : étranger', () => {
    expect(judgeOrphanAgent({ startTimeMs: published + 6_000 }, published)).toBe('foreign');
    expect(judgeOrphanAgent({ startTimeMs: published - 121_000 }, published)).toBe('foreign');
  });
  it('heure de création, process ou publication illisibles : non vérifiable (jamais tué)', () => {
    expect(judgeOrphanAgent({ startTimeMs: null }, published)).toBe('unverified');
    expect(judgeOrphanAgent(undefined, published)).toBe('unverified');
    expect(judgeOrphanAgent({ startTimeMs: published }, null)).toBe('unverified');
  });
});

describe('surfaces', () => {
  it('battements et demandes de fermeture n’excitent pas les watchers d’état ; state.json oui', () => {
    const sep = path.sep;
    expect(isIgnoredStatePath(['idle', 'beats', 'agent-a.beat'].join(sep))).toBe(true);
    expect(isIgnoredStatePath(['idle', 'close', 'agent-a.json'].join(sep))).toBe(true);
    expect(isIgnoredStatePath(['idle', 'state.lock'].join(sep))).toBe(true);
    expect(isIgnoredStatePath(['idle', 'state.json'].join(sep))).toBe(false);
    expect(path.relative(path.join(root, '.striart'), outputBeatPath(root, 'a'))).toBe(
      ['idle', 'beats', 'a.beat'].join(sep),
    );
    expect(path.relative(path.join(root, '.striart'), closeRequestPath(root, 'a'))).toBe(
      ['idle', 'close', 'a.json'].join(sep),
    );
  });

  it('commande gc : registre unique, textes fr/en, document --json', () => {
    expect(commandSpec('gc')).toMatchObject({ group: 'repair', json: 'document' });
    expect(COMMANDS.filter((c) => c.name === 'gc')).toHaveLength(1);
    for (const catalogue of [fr, en]) {
      expect(catalogue.commands.gc.examples.length).toBeGreaterThan(0);
      expect(catalogue.gc.summary(1, 1, 1, false)).toBeTruthy();
    }
  });

  it('plan humain : workspace.gc est une méthode mutante du Control Protocol', () => {
    expect(methodSpec('workspace.gc')).toMatchObject({ mutating: true, data: 'IdleSweepReport' });
    expect(METHOD_SPECS.filter((m) => m.name === 'workspace.gc')).toHaveLength(1);
  });
});
