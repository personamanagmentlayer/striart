import { describe, expect, it } from 'vitest';
import { validateConfig, DEFAULT_CONFIG } from '../../src/config.js';
import {
  DEFAULT_TERMINAL_SETTINGS,
  isValidTerminalSettings,
  resolveTerminalSettings,
} from '../../src/terminal/config.ts';
import { inferCloneContext } from '../../src/terminal/clone-context.ts';

describe('terminal — validation de la config', () => {
  it('défaut présent dans DEFAULT_CONFIG et valide', () => {
    expect(DEFAULT_CONFIG.terminal).toEqual(DEFAULT_TERMINAL_SETTINGS);
    expect(() => validateConfig({ terminal: DEFAULT_CONFIG.terminal })).not.toThrow();
  });

  it.each([
    [{ launcher: 'warp' }],
    [{ launcher: 'auto', detectWarp: false }],
    [{ warp: { channel: 'preview', shell: 'fish', newWindow: true } }],
    [{ warp: { tabConfigDir: 'C:\\Users\\u\\warp\\tab_configs' } }],
    [{ holdShell: '/usr/bin/zsh' }],
    [{ launcher: 'custom', custom: { command: 'foot', args: ['-D', '{{cwd}}', '{{argv}}'] } }],
    [{ custom: { command: 'tmux', args: ['new-window', '{{posixCommand}}'] } }],
  ])('accepté : %j', (terminal) => {
    expect(isValidTerminalSettings(terminal)).toBe(true);
    expect(() => validateConfig({ terminal })).not.toThrow();
  });

  it.each([
    ['lanceur inconnu', { launcher: 'xterm' }],
    ['clé inconnue (faute de frappe)', { lancher: 'warp' }],
    ['detectWarp non booléen', { detectWarp: 'yes' }],
    ['holdShell avec espace', { holdShell: 'bash -x' }],
    ['holdShell avec ;', { holdShell: 'bash;rm' }],
    ['shell Warp inconnu', { warp: { shell: 'cmd' } }],
    ['canal Warp inconnu', { warp: { channel: 'beta' } }],
    ['tabConfigDir relatif', { warp: { tabConfigDir: 'tab_configs' } }],
    ['custom sans commande', { launcher: 'custom' }],
    ['custom sans placeholder de commande', { custom: { command: 'x', args: ['{{cwd}}'] } }],
    ['custom : placeholder inconnu', { custom: { command: 'x', args: ['{{argv}}', '{{env}}'] } }],
    ['custom : {{argv}} pas seul', { custom: { command: 'x', args: ['--run={{argv}}'] } }],
    ['custom : saut de ligne', { custom: { command: 'x', args: ['{{argv}}', 'a\nb'] } }],
    ['custom : placeholder dans command', { custom: { command: '{{cwd}}/x', args: ['{{argv}}'] } }],
  ])('refusé : %s', (_label, terminal) => {
    expect(isValidTerminalSettings(terminal)).toBe(false);
    expect(() => validateConfig({ terminal })).toThrow(/terminal/);
  });

  it('résolution : une valeur partielle est complétée par les défauts', () => {
    expect(resolveTerminalSettings({ warp: { shell: 'zsh' } })).toEqual({
      ...DEFAULT_TERMINAL_SETTINGS,
      warp: { ...DEFAULT_TERMINAL_SETTINGS.warp, shell: 'zsh' },
    });
    expect(resolveTerminalSettings(undefined)).toEqual(DEFAULT_TERMINAL_SETTINGS);
  });
});

describe('inferCloneContext — racine et agent déduits du chemin du clone', () => {
  it('POSIX : <root>/.striart/agents/<agent>[/sous-dossier]', () => {
    expect(inferCloneContext('/srv/repo/.striart/agents/agent-a', { platform: 'linux' })).toEqual({
      root: '/srv/repo',
      agent: 'agent-a',
      clonePath: '/srv/repo/.striart/agents/agent-a',
    });
    expect(
      inferCloneContext('/srv/repo/.striart/agents/agent-a/src/x', { platform: 'linux' })?.agent,
    ).toBe('agent-a');
  });

  it('Windows : insensible à la casse des segments .striart/agents', () => {
    expect(inferCloneContext('C:\\R\\.Striart\\Agents\\agent-b', { platform: 'win32' })).toEqual({
      root: 'C:\\R',
      agent: 'agent-b',
      clonePath: 'C:\\R\\.Striart\\Agents\\agent-b',
    });
  });

  it('hors clone, ou nom d’agent invalide → null', () => {
    expect(inferCloneContext('/srv/repo/src', { platform: 'linux' })).toBeNull();
    expect(inferCloneContext('/srv/repo/.striart/agents/-bad', { platform: 'linux' })).toBeNull();
    expect(inferCloneContext('/srv/a\nb', { platform: 'linux' })).toBeNull();
  });
});
