import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildTerminalCommand, openAgentTerminal, quoteForShell } from '../../src/terminal.ts';
import { StriartError } from '../../src/errors.ts';

const ARGV = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\striart\\src\\cli.js',
  'attach',
  'agent-a',
];
const BASE = {
  cwd: 'C:\\repo\\.striart\\agents\\agent-a',
  title: 'STRIART: agent-a',
  argv: ARGV,
};

describe('quoteForShell — lignes « à copier » affichées à l’humain', () => {
  const hostile = 'a $(touch x) `id` "q" \'s\' %PATH% $env:HOME';

  it('PowerShell : guillemets simples, apostrophes doublées — aucune expansion', () => {
    expect(quoteForShell("l'éd $x", { shell: 'pwsh', platform: 'win32' })).toBe("'l''éd $x'");
    expect(quoteForShell('x', { shell: null, platform: 'win32' })).toBe("'x'");
  });

  it('POSIX (bash, zsh, Git Bash) : guillemets simples (fish a sa propre grammaire : terminal-fish.test.js)', () => {
    expect(quoteForShell("l'éd $x", { shell: 'bash', platform: 'linux' })).toBe("'l'\\''éd $x'");
    expect(quoteForShell('x', { shell: 'bash', platform: 'win32' })).toBe("'x'");
    expect(quoteForShell('x', { shell: null, platform: 'darwin' })).toBe("'x'");
  });

  // cmd n'a aucune citation sans expansion de %VAR% ; entre guillemets
  // doubles, rien ne s'exécute (& | < > ^ littéraux) — reste une expansion de
  // variable, jamais une commande.
  it('cmd : guillemets doubles, " doublé', () => {
    expect(quoteForShell('a "b" & del x', { shell: 'cmd', platform: 'win32' })).toBe(
      '"a ""b"" & del x"',
    );
  });

  it('jamais de guillemets doubles hors cmd (expansion de $ et backticks)', () => {
    for (const [shell, platform] of [
      ['pwsh', 'win32'],
      ['bash', 'linux'],
      ['zsh', 'darwin'],
      ['fish', 'linux'],
    ]) {
      expect(quoteForShell(hostile, { shell, platform }).startsWith("'")).toBe(true);
    }
  });
});

describe('buildTerminalCommand', () => {
  it('Windows Terminal : onglet titré, répertoire par -d, argv cité pour PowerShell', () => {
    const { file, args, spawnCwd } = buildTerminalCommand({
      ...BASE,
      platform: 'win32',
      env: { WT_SESSION: 'x' },
    });
    expect(file).toBe('wt');
    expect(args).toEqual(expect.arrayContaining(['new-tab', '-d', BASE.cwd, '--title']));
    expect(args.at(-1)).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\striart\\src\\cli.js' 'attach' 'agent-a'",
    );
    expect(spawnCwd).toBeNull();
  });

  it('Windows Terminal : « ; » échappé (séparateur de sous-commandes wt)', () => {
    const { args } = buildTerminalCommand({
      ...BASE,
      cwd: 'C:\\a;b',
      platform: 'win32',
      env: { WT_SESSION: 'x' },
    });
    expect(args).toContain('C:\\a\\;b');
  });

  it('console Windows : PowerShell détaché, répertoire par spawn (aucune interpolation, plus de cmd /c start)', () => {
    const { file, args, spawnCwd } = buildTerminalCommand({ ...BASE, platform: 'win32', env: {} });
    expect(file).toBe('powershell');
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    expect(spawnCwd).toBe(BASE.cwd);
    expect(args.join(' ')).not.toContain(BASE.cwd);
  });

  it('macOS : Terminal.app, citation shell puis chaîne AppleScript', () => {
    const { file, args } = buildTerminalCommand({
      ...BASE,
      platform: 'darwin',
      env: {},
      cwd: '/Users/o"brien/repo',
      argv: ['/usr/local/bin/node', '/opt/striart/src/cli.js', 'attach', 'a'],
    });
    expect(file).toBe('osascript');
    expect(args.at(-1)).toBe(
      `tell application "Terminal" to do script "cd '/Users/o\\"brien/repo' && '/usr/local/bin/node' '/opt/striart/src/cli.js' 'attach' 'a'"`,
    );
  });

  it('Linux : argv en paramètres positionnels de bash -c "$@" (rien n’est réinterprété)', () => {
    const { file, args } = buildTerminalCommand({
      ...BASE,
      platform: 'linux',
      env: {},
      cwd: '/repo/a',
      argv: ['/usr/bin/node', "/home/o'brien/cli.js", 'attach', 'a'],
    });
    expect(file).toBe('gnome-terminal');
    expect(args.slice(0, 6)).toEqual([
      '--working-directory=/repo/a',
      '--',
      'bash',
      '-c',
      '"$@"; exec bash',
      'striart',
    ]);
    expect(args.slice(6)).toEqual(['/usr/bin/node', "/home/o'brien/cli.js", 'attach', 'a']);
  });

  it.each([
    ['/repo/a\ninjection', 'saut de ligne'],
    ['/repo/a\rb', 'retour chariot'],
    ['/repo/a\0b', 'caractère nul'],
  ])('refuse ce qu’aucun lanceur ne sait transmettre (%s : %s)', (cwd) => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(() => buildTerminalCommand({ ...BASE, platform, env: {}, cwd })).toThrow(StriartError);
    }
  });

  it('un chemin avec apostrophe n’est plus refusé : il est cité', () => {
    const { args } = buildTerminalCommand({
      ...BASE,
      platform: 'win32',
      env: {},
      argv: ["C:\\Users\\O'Brien\\node.exe", 'attach', 'a'],
    });
    expect(args.at(-1)).toBe("& 'C:\\Users\\O''Brien\\node.exe' 'attach' 'a'");
  });

  // Windows PowerShell 5.1 retire les « " » internes des arguments natifs
  // (vérifié par exécution réelle) : refus explicite plutôt que déformation.
  it('Windows : un « " » dans l’argv est refusé', () => {
    for (const env of [{}, { WT_SESSION: 'x' }]) {
      expect(() =>
        buildTerminalCommand({ ...BASE, platform: 'win32', env, argv: ['node', 'a"b'] }),
      ).toThrow(StriartError);
    }
  });

  it('argv vide → refus', () => {
    expect(() => buildTerminalCommand({ ...BASE, argv: [] })).toThrow(StriartError);
  });
});

describe('openAgentTerminal (spawner injecté — jamais de vrai terminal en test)', () => {
  // Config du dépôt propriétaire du clone : injectée (aucune lecture disque en unitaire).
  const noConfig = async () => ({});
  const fakeChild = () => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    return child;
  };

  it('spawn réussi → launched:true, process détaché et unref', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    const result = await openAgentTerminal({ ...BASE, spawnFn, loadConfigFn: noConfig });
    expect(result).toEqual({ launched: true });
    expect(child.unref).toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('binaire introuvable → launched:false avec le motif (repli « lance à la main »)', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => {
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    });
    const result = await openAgentTerminal({ ...BASE, spawnFn, loadConfigFn: noConfig });
    expect(result.launched).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('argument non transmissible → launched:false SANS spawn (TERMINAL_UNSAFE absorbé en repli)', async () => {
    const spawnFn = vi.fn();
    const result = await openAgentTerminal({
      ...BASE,
      cwd: 'C:/repo\nx',
      spawnFn,
      loadConfigFn: noConfig,
    });
    expect(result.launched).toBe(false);
    expect(result.error).toMatch(/refusée/i);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('réglages lus dans la config du dépôt PROPRIÉTAIRE du clone (racine déduite du chemin)', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    const loadConfigFn = vi.fn(async () => ({ terminal: { launcher: 'alacritty' } }));
    const result = await openAgentTerminal({
      cwd: '/srv/repo/.striart/agents/agent-a',
      title: 'STRIART: agent-a',
      argv: ['/usr/bin/node', '/opt/striart/src/cli.js', 'attach', 'agent-a'],
      platform: 'linux',
      env: {},
      spawnFn,
      loadConfigFn,
    });
    expect(result).toEqual({ launched: true });
    expect(loadConfigFn).toHaveBeenCalledWith(expect.stringMatching(/repo$/));
    expect(spawnFn.mock.calls[0][0]).toBe('alacritty');
  });

  it('config illisible → repli « lance à la main », JAMAIS le lanceur par défaut à la place', async () => {
    const spawnFn = vi.fn();
    const loadConfigFn = vi.fn(async () => {
      throw new StriartError('config cassée', { code: 'CONFIG_INVALID' });
    });
    const result = await openAgentTerminal({
      cwd: '/srv/repo/.striart/agents/agent-a',
      title: 't',
      argv: ['node'],
      platform: 'linux',
      env: {},
      spawnFn,
      loadConfigFn,
    });
    expect(result).toEqual({ launched: false, error: 'config cassée' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('lanceur indisponible sur la plateforme → repli, sans spawn', async () => {
    const spawnFn = vi.fn();
    const result = await openAgentTerminal({
      ...BASE,
      terminal: { launcher: 'iterm' },
      platform: 'win32',
      env: {},
      spawnFn,
    });
    expect(result.launched).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('lanceur configurable (terminal.launcher)', () => {
  const LINUX = {
    platform: 'linux',
    env: {},
    cwd: '/repo/.striart/agents/agent-a',
    title: 'STRIART: agent-a',
    argv: ['/usr/bin/node', "/home/o'brien/cli.js", 'attach', 'agent-a'],
  };
  const held = ['bash', '-c', '"$@"; exec bash', 'striart', ...LINUX.argv];

  it("'auto' sans Warp : comportement historique inchangé sur les trois OS", () => {
    expect(buildTerminalCommand({ ...BASE, platform: 'win32', env: {} }).file).toBe('powershell');
    expect(
      buildTerminalCommand({ ...BASE, platform: 'win32', env: { WT_SESSION: '1' } }).file,
    ).toBe('wt');
    expect(buildTerminalCommand({ ...LINUX, platform: 'darwin' }).file).toBe('osascript');
    expect(buildTerminalCommand(LINUX).file).toBe('gnome-terminal');
  });

  it("'auto' + session Warp → Warp ; detectWarp:false → comportement historique", () => {
    const env = { TERM_PROGRAM: 'WarpTerminal' };
    const home = '/home/u';
    const warp = buildTerminalCommand({ ...LINUX, env, home });
    expect(warp.launcher).toBe('warp');
    expect(warp.tabConfig).toBeDefined();
    const off = buildTerminalCommand({ ...LINUX, env, home, terminal: { detectWarp: false } });
    expect(off.launcher).toBe('gnome-terminal');
    expect(off.tabConfig).toBeUndefined();
  });

  it('Warp en opt-in explicite, hors session Warp', () => {
    const plan = buildTerminalCommand({
      ...LINUX,
      home: '/home/u',
      terminal: { launcher: 'warp' },
    });
    expect(plan.launcher).toBe('warp');
    expect(plan.file).toBe('xdg-open');
  });

  it('konsole / kitty / wezterm / alacritty : argv en paramètres positionnels du shell de maintien', () => {
    expect(buildTerminalCommand({ ...LINUX, terminal: { launcher: 'konsole' } }).args).toEqual([
      '--new-tab',
      '--workdir',
      LINUX.cwd,
      '-e',
      ...held,
    ]);
    expect(buildTerminalCommand({ ...LINUX, terminal: { launcher: 'kitty' } }).args).toEqual([
      '--directory',
      LINUX.cwd,
      '--title',
      LINUX.title,
      ...held,
    ]);
    expect(buildTerminalCommand({ ...LINUX, terminal: { launcher: 'wezterm' } }).args).toEqual([
      'start',
      '--cwd',
      LINUX.cwd,
      '--',
      ...held,
    ]);
    expect(
      buildTerminalCommand({ ...LINUX, terminal: { launcher: 'alacritty', holdShell: 'zsh' } })
        .args,
    ).toEqual([
      '--working-directory',
      LINUX.cwd,
      '--title',
      LINUX.title,
      '-e',
      'zsh',
      '-c',
      '"$@"; exec zsh',
      'striart',
      ...LINUX.argv,
    ]);
  });

  it('wezterm sous Windows : PowerShell, argv cité', () => {
    const { args } = buildTerminalCommand({
      ...BASE,
      platform: 'win32',
      env: {},
      terminal: { launcher: 'wezterm' },
    });
    expect(args.slice(0, 4)).toEqual(['start', '--cwd', BASE.cwd, '--']);
    expect(args.at(-1)).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\striart\\src\\cli.js' 'attach' 'agent-a'",
    );
  });

  it('iTerm2 : ligne POSIX citée puis chaîne AppleScript', () => {
    const { file, args } = buildTerminalCommand({
      ...LINUX,
      platform: 'darwin',
      cwd: '/Users/o"brien/r',
      terminal: { launcher: 'iterm' },
    });
    expect(file).toBe('osascript');
    expect(args).toContain(
      `tell current session of striartWindow to write text "cd '/Users/o\\"brien/r' && '/usr/bin/node' '/home/o'\\\\''brien/cli.js' 'attach' 'agent-a'"`,
    );
  });

  it("'wt' explicite, même hors Windows Terminal", () => {
    expect(
      buildTerminalCommand({ ...BASE, platform: 'win32', env: {}, terminal: { launcher: 'wt' } })
        .file,
    ).toBe('wt');
  });

  it.each([
    ['wt', 'linux'],
    ['terminal-app', 'win32'],
    ['iterm', 'linux'],
    ['gnome-terminal', 'darwin'],
    ['konsole', 'win32'],
    ['kitty', 'win32'],
  ])('%s refusé sur %s (TERMINAL_LAUNCHER_UNSUPPORTED)', (launcher, platform) => {
    try {
      buildTerminalCommand({ ...LINUX, platform, terminal: { launcher } });
      throw new Error('aucune erreur');
    } catch (error) {
      expect(error.code).toBe('TERMINAL_LAUNCHER_UNSUPPORTED');
    }
  });

  it('custom : argv, placeholders substitués en un passage, {{argv}} développé', () => {
    const plan = buildTerminalCommand({
      ...LINUX,
      cwd: '/r/.striart/agents/agent-a',
      terminal: {
        launcher: 'custom',
        custom: {
          command: 'foot',
          args: ['--working-directory={{cwd}}', '--title', '{{title}} ({{agent}})', '{{argv}}'],
        },
      },
    });
    expect(plan.file).toBe('foot');
    expect(plan.args).toEqual([
      '--working-directory=/r/.striart/agents/agent-a',
      '--title',
      'STRIART: agent-a (agent-a)',
      ...LINUX.argv,
    ]);
  });

  it('custom : une valeur substituée n’est jamais relue comme placeholder', () => {
    const plan = buildTerminalCommand({
      ...LINUX,
      title: '{{cwd}}',
      terminal: { launcher: 'custom', custom: { command: 'x', args: ['{{title}}', '{{argv}}'] } },
    });
    expect(plan.args[0]).toBe('{{cwd}}');
  });

  it('custom : {{posixCommand}} / {{powershellCommand}} portent la commande citée', () => {
    const plan = buildTerminalCommand({
      ...LINUX,
      terminal: {
        launcher: 'custom',
        custom: { command: 'tmux', args: ['new-window', '{{posixCommand}}'] },
      },
    });
    expect(plan.args[1]).toBe("'/usr/bin/node' '/home/o'\\''brien/cli.js' 'attach' 'agent-a'");
    const ps = buildTerminalCommand({
      ...BASE,
      platform: 'win32',
      env: {},
      terminal: {
        launcher: 'custom',
        custom: {
          command: 'conemu64',
          args: ['-run', 'powershell', '-Command', '{{powershellCommand}}'],
        },
      },
    });
    expect(ps.args.at(-1)).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\striart\\src\\cli.js' 'attach' 'agent-a'",
    );
  });
});
