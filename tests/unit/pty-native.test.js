import { describe, expect, it } from 'vitest';
import { nativePtyHostArgs, PTY_HOST_LIMITS } from '../../src/native.ts';
import { lastNativeErrorCode } from '../../src/pty-attach.ts';
import { expectedPtyHostIdentity } from '../../src/pty-host-state.ts';
import { checkProcessInstance } from '../../src/process-info.ts';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.ts';

// Lot R2 : hôte de pty natif. Logique pure (argv, identité, journal,
// config) — les vrais process sont couverts par
// tests/integration/pty-native.test.js et native/striart-native/tests/pty_host.rs.

const ROOT = process.platform === 'win32' ? 'C:\\r' : '/r';
const base = {
  agent: 'agent-a',
  stateDir: `${ROOT}${process.platform === 'win32' ? '\\' : '/'}.striart/pty/agent-a`,
  endpoint: 'ep',
  cwd: ROOT,
  program: 'powershell.exe',
};

describe('nativePtyHostArgs', () => {
  it('construit un argv sans shell : options, puis -- et le programme tel quel', () => {
    const args = nativePtyHostArgs({
      ...base,
      args: ['-NoLogo', 'a b; rm -rf /'],
      cols: 120,
      rows: 40,
      initial: 'claude --model "x"',
      term: 'xterm-256color',
      replayBytes: 65_536,
      clientQueueBytes: 4_194_304,
      killGraceMs: 1_000,
      parentPid: 4242,
    });
    expect(args.slice(0, 9)).toEqual([
      'pty-host',
      '--agent',
      'agent-a',
      '--state-dir',
      base.stateDir,
      '--endpoint',
      'ep',
      '--cwd',
      ROOT,
    ]);
    expect(args).toContain('--parent-pid');
    expect(args[args.indexOf('--initial') + 1]).toBe('claude --model "x"');
    const sep = args.indexOf('--');
    expect(args.slice(sep)).toEqual(['--', 'powershell.exe', '-NoLogo', 'a b; rm -rf /']);
  });

  it('omet les options non fournies (défauts du binaire)', () => {
    const args = nativePtyHostArgs(base);
    for (const flag of ['--cols', '--initial', '--term', '--parent-pid', '--replay-bytes']) {
      expect(args).not.toContain(flag);
    }
  });

  it('refuse les valeurs hors bornes AVANT tout lancement (INVALID_ARGUMENT)', () => {
    const bad = [
      { cols: 0 },
      { rows: PTY_HOST_LIMITS.maxDimension + 1 },
      { cols: 1.5 },
      { replayBytes: 10 },
      { clientQueueBytes: 1 },
      { killGraceMs: -1 },
      { parentPid: 0 },
      { term: 'x;rm' },
      { initial: 'x'.repeat(PTY_HOST_LIMITS.maxInitialBytes + 1) },
      { cwd: 'relative' },
      { stateDir: 'relative' },
      { program: '' },
    ];
    for (const extra of bad) {
      expect(() => nativePtyHostArgs({ ...base, ...extra }), JSON.stringify(extra)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    }
  });
});

describe('lastNativeErrorCode (journal de l’hôte)', () => {
  it('rend le code de la dernière ligne d’erreur JSON, en ignorant le reste', () => {
    const log = [
      '{"event":"listening","agent":"a"}',
      'texte libre d’un outil',
      '{"error":{"code":"PTY_PROGRAM_NOT_FOUND","message":"x"}}',
      '',
    ].join('\n');
    expect(lastNativeErrorCode(log)).toBe('PTY_PROGRAM_NOT_FOUND');
    expect(lastNativeErrorCode('{"event":"stopped"}')).toBeNull();
    expect(lastNativeErrorCode('{"error":{"code":"bad code; rm"}}')).toBeNull();
    expect(lastNativeErrorCode('')).toBeNull();
  });
});

describe('expectedPtyHostIdentity', () => {
  it('hôte natif : nom du binaire publié + `pty-host --agent <agent>`', () => {
    const { implementation, expected } = expectedPtyHostIdentity('agent-a', {
      pid: 1,
      startedAt: 't',
      implementation: 'native',
      program: 'striart-native.exe',
    });
    expect(implementation).toBe('native');
    expect(expected).toEqual({
      scriptName: 'striart-native.exe',
      imageName: 'striart-native.exe',
      args: ['pty-host', '--agent', 'agent-a'],
      startedAt: 't',
    });
  });

  it('PID file d’une version antérieure (hôte Node) : identité `cli.js pty-host-run`', () => {
    const { implementation, expected } = expectedPtyHostIdentity('agent-a', {
      pid: 1,
      startedAt: 't',
    });
    expect(implementation).toBe('node');
    expect(expected.args).toEqual(['pty-host-run', 'agent-a']);
  });

  it('nom de binaire non sûr (séparateur) : jamais pris pour l’identité native', () => {
    const { implementation } = expectedPtyHostIdentity('agent-a', {
      pid: 1,
      startedAt: 't',
      implementation: 'native',
      program: '..\\evil.exe',
    });
    expect(implementation).toBe('node');
  });
});

describe('checkProcessInstance — hôte natif', () => {
  const proc = (name, commandLine) => ({
    pid: 4242,
    ppid: 1,
    name,
    commandLine,
    startTimeMs: null,
  });
  const expected = {
    scriptName: 'striart-native.exe',
    imageName: 'striart-native.exe',
    args: ['pty-host', '--agent', 'agent-a'],
  };
  const check = (info) =>
    checkProcessInstance(4242, expected, {
      isAlive: () => true,
      readChain: async () => [info],
      cache: false,
    });

  it('ligne de commande du binaire natif reconnue', async () => {
    const line = String.raw`"C:\Program Files\x\striart-native.exe" pty-host --agent agent-a --state-dir C:\r`;
    expect(await check(proc('striart-native.exe', line))).toBe('alive');
    expect(await check(proc('striart-native.exe', line.replace('agent-a', 'agent-b')))).toBe(
      'foreign',
    );
  });

  it('ligne de commande illisible : image native → unverified, node → foreign', async () => {
    expect(await check(proc('striart-native.exe', null))).toBe('unverified');
    expect(await check(proc('node.exe', null))).toBe('foreign');
  });
});

describe('config `pty`', () => {
  it('défauts sûrs', () => {
    expect(DEFAULT_CONFIG.pty).toEqual({
      replayBytes: 65_536,
      clientQueueBytes: 4_194_304,
      killGraceMs: 1_000,
      shell: 'auto',
      shellArgs: [],
    });
  });

  it('validation positive : clés connues, bornes, file ≥ rejeu', () => {
    expect(() => validateConfig({ pty: { replayBytes: 8_192 } })).not.toThrow();
    for (const bad of [
      { replayBytes: 100 },
      { clientQueueBytes: 1 },
      { killGraceMs: 60_001 },
      { unknown: 1 },
      { replayBytes: 1_048_576, clientQueueBytes: 65_536 },
      [],
      null,
    ]) {
      expect(() => validateConfig({ pty: bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
