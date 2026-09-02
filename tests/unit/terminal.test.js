import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildTerminalCommand, openAgentTerminal } from '../../src/terminal.js';
import { StriartError } from '../../src/errors.js';

const BASE = {
  cwd: 'C:\\repo\\.striart\\agents\\agent-a',
  title: 'STRIART: agent-a',
  command: 'claude',
};

describe('buildTerminalCommand', () => {
  it('Windows Terminal : nouvel onglet avec titre et répertoire', () => {
    const { file, args } = buildTerminalCommand({
      ...BASE,
      platform: 'win32',
      env: { WT_SESSION: 'x' },
    });
    expect(file).toBe('wt');
    expect(args).toContain('new-tab');
    expect(args).toContain(BASE.cwd);
    expect(args).toContain('STRIART: agent-a');
    expect(args).toContain('claude');
  });

  it('Windows sans WT : fenêtre PowerShell via start', () => {
    const { file, args } = buildTerminalCommand({ ...BASE, platform: 'win32', env: {} });
    expect(file).toBe('cmd');
    expect(args).toContain('start');
    expect(args.at(-1)).toContain('claude');
    expect(args.at(-1)).toContain(BASE.cwd);
  });

  it('macOS : osascript Terminal.app', () => {
    const { file, args } = buildTerminalCommand({
      ...BASE,
      platform: 'darwin',
      env: {},
      cwd: '/repo/.striart/agents/agent-a',
    });
    expect(file).toBe('osascript');
    expect(args.join(' ')).toContain('do script');
    expect(args.join(' ')).toContain('/repo/.striart/agents/agent-a');
  });

  it('Linux : gnome-terminal', () => {
    const { file, args } = buildTerminalCommand({
      ...BASE,
      platform: 'linux',
      env: {},
      cwd: '/repo/a',
    });
    expect(file).toBe('gnome-terminal');
    expect(args.at(-1)).toContain("cd '/repo/a' && claude");
  });

  it('la commande custom de l’agent est propagée', () => {
    const { args } = buildTerminalCommand({
      ...BASE,
      platform: 'win32',
      env: { WT_SESSION: 'x' },
      command: 'aider --model gpt-4o',
    });
    expect(args).toContain('aider --model gpt-4o');
  });

  it.each([
    ["C:\\Users\\O'Brien\\repo", 'apostrophe dans le chemin'],
    ['/repo/a\ninjection', 'saut de ligne'],
    ['/repo/`whoami`', 'backtick'],
    ['/repo/$USER', 'expansion shell'],
  ])('refuse un cwd qui casserait le quoting shell (%s : %s)', (cwd) => {
    // Sécurité : une ligne de shell malformée vaut mieux refusée qu'émise.
    // Testé sur chaque plateforme qui interpole cwd dans une chaîne shell.
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(() => buildTerminalCommand({ ...BASE, platform, env: {}, cwd })).toThrow(StriartError);
    }
  });

  it('refuse une commande custom contenant une apostrophe', () => {
    expect(() =>
      buildTerminalCommand({ ...BASE, platform: 'linux', env: {}, command: "sh -c 'evil'" }),
    ).toThrow(StriartError);
  });
});

describe('openAgentTerminal (spawner injecté — jamais de vrai terminal en test)', () => {
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
    const result = await openAgentTerminal({
      cwd: 'C:/repo/clone',
      title: 'STRIART: a',
      command: 'claude',
      spawnFn,
    });
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
    const result = await openAgentTerminal({ cwd: '/repo', title: 't', command: 'x', spawnFn });
    expect(result.launched).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('chemin non sûr → launched:false SANS spawn (TERMINAL_UNSAFE absorbé en repli)', async () => {
    const spawnFn = vi.fn();
    const result = await openAgentTerminal({
      cwd: "C:/Users/O'Brien/repo",
      title: 't',
      command: 'claude',
      spawnFn,
    });
    expect(result.launched).toBe(false);
    expect(result.error).toMatch(/refusée/i);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
