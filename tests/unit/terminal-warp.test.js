import { describe, expect, it } from 'vitest';
import {
  buildWarpLaunch,
  resolveWarpChannel,
  tomlString,
  warpDirectories,
  warpTabConfigName,
} from '../../src/terminal/warp.ts';
import { DEFAULT_WARP_SETTINGS } from '../../src/terminal/config.ts';
import { StriartError } from '../../src/errors.ts';

/**
 * Lecteur TOML minimal des seules formes que Striart écrit (clé = "chaîne"
 * et clé = ["chaîne"]) : il prouve que l'échappement est réversible sans
 * dépendre d'un parseur TOML (aucune dépendance ajoutée pour un test).
 */
function readTomlString(raw) {
  expect(raw.startsWith('"') && raw.endsWith('"')).toBe(true);
  // Une chaîne basic TOML est un sur-ensemble strict d'une chaîne JSON pour
  // les échappements utilisés ici (\\ \" \t \uXXXX) : JSON.parse les relit.
  return JSON.parse(raw);
}

function field(content, key) {
  const line = content.split('\n').find((l) => l.startsWith(`${key} = `));
  expect(line, key).toBeDefined();
  return line.slice(key.length + 3);
}

const NODE = '/usr/bin/node';
const CLI = '/opt/striart/src/cli.js';

function plan(overrides = {}) {
  return buildWarpLaunch({
    platform: 'linux',
    env: {},
    home: '/home/u',
    root: '/srv/repo',
    agent: 'agent-a',
    cwd: '/srv/repo/.striart/agents/agent-a',
    title: 'STRIART: agent-a',
    argv: [NODE, CLI, 'attach', 'agent-a'],
    settings: DEFAULT_WARP_SETTINGS,
    ...overrides,
  });
}

describe('Warp — Tab Config (contenu)', () => {
  it('volet unique : directory = clone, shell explicite, commands = argv cité pour le shell', () => {
    const { tabConfig } = plan();
    expect(readTomlString(field(tabConfig.content, 'directory'))).toBe(
      '/srv/repo/.striart/agents/agent-a',
    );
    expect(readTomlString(field(tabConfig.content, 'shell'))).toBe('bash');
    const commands = field(tabConfig.content, 'commands');
    expect(readTomlString(commands.slice(1, -1))).toBe(
      "'/usr/bin/node' '/opt/striart/src/cli.js' 'attach' 'agent-a'",
    );
    expect(tabConfig.content).toContain('type = "terminal"');
  });

  it('chemin avec espaces, apostrophe, guillemet, antislash et unicode : cité PUIS échappé, réversible', () => {
    const cwd = `/srv/ré po/o'brien "x" \\ 日本/.striart/agents/agent-a`;
    const cli = `/opt/my striart/l'outil "v2"/cli.js`;
    const { tabConfig } = plan({ cwd, argv: [NODE, cli, 'attach', 'agent-a'] });
    expect(readTomlString(field(tabConfig.content, 'directory'))).toBe(cwd);
    const command = readTomlString(field(tabConfig.content, 'commands').slice(1, -1));
    expect(command).toBe(
      `'/usr/bin/node' '/opt/my striart/l'\\''outil "v2"/cli.js' 'attach' 'agent-a'`,
    );
    // L'unicode reste tel quel (UTF-8), pas en \u.
    expect(tabConfig.content).toContain('日本');
  });

  it("Windows : volet pwsh, commande `& '…'` (apostrophes doublées)", () => {
    const { tabConfig, file, args, uri } = plan({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Ö B\\AppData\\Roaming' },
      home: 'C:\\Users\\Ö B',
      root: 'C:\\r',
      cwd: 'C:\\r\\.striart\\agents\\agent-a',
      argv: [
        'C:\\Program Files\\nodejs\\node.exe',
        "C:\\Users\\O'Brien\\cli.js",
        'attach',
        'agent-a',
      ],
    });
    expect(readTomlString(field(tabConfig.content, 'shell'))).toBe('pwsh');
    expect(readTomlString(field(tabConfig.content, 'commands').slice(1, -1))).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\O''Brien\\cli.js' 'attach' 'agent-a'",
    );
    expect(tabConfig.path).toBe(
      `C:\\Users\\Ö B\\AppData\\Roaming\\warp\\Warp\\data\\tab_configs\\${tabConfig.name}.toml`,
    );
    expect(file).toBe('powershell');
    expect(args.at(-1)).toBe(`Start-Process -FilePath '${uri}'`);
  });

  it('shell du volet réglable (fish, zsh) — citation POSIX', () => {
    const { tabConfig } = plan({ settings: { ...DEFAULT_WARP_SETTINGS, shell: 'fish' } });
    expect(readTomlString(field(tabConfig.content, 'shell'))).toBe('fish');
  });

  it.each([
    ['saut de ligne', '/srv/a\nb'],
    ['retour chariot', '/srv/a\rb'],
    ['nul', '/srv/a\0b'],
  ])('refus d’un chemin avec %s (TERMINAL_UNSAFE)', (_label, cwd) => {
    expect(() => plan({ cwd })).toThrow(StriartError);
    try {
      plan({ cwd });
    } catch (error) {
      expect(error.code).toBe('TERMINAL_UNSAFE');
    }
  });

  it('refus de « {{ » / « }} » (paramètres de Tab Config interprétés par Warp)', () => {
    expect(() => plan({ cwd: '/srv/{{x}}/.striart/agents/agent-a' })).toThrow(/\{\{/);
    expect(() => plan({ argv: [NODE, '/a}}b', 'attach', 'agent-a'] })).toThrow(StriartError);
  });

  it('Windows : un « " » dans l’argv d’un volet pwsh est refusé', () => {
    expect(() =>
      plan({ platform: 'win32', env: { APPDATA: 'C:\\A' }, argv: ['node', 'a"b'] }),
    ).toThrow(StriartError);
  });

  it('tomlString : contrôles en \\uXXXX, tabulation en \\t', () => {
    expect(tomlString('a\tb\u0001c\u007f')).toBe('"a\\tb\\u0001c\\u007f"');
    expect(tomlString('\\"')).toBe('"\\\\\\""');
  });
});

describe('Warp — nom, URI, dossiers', () => {
  it('nom dérivé du SEUL nom d’agent validé + empreinte (racine, agent)', () => {
    const a = warpTabConfigName('/srv/repo1', 'agent-a');
    const b = warpTabConfigName('/srv/repo2', 'agent-a');
    expect(a).toMatch(/^striart-agent-a-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    // Warp compare sans casse : l'empreinte distingue Agent-A d'agent-a.
    expect(warpTabConfigName('/r', 'Agent-A')).not.toBe(warpTabConfigName('/r', 'agent-a'));
    expect(() => warpTabConfigName('/r', '../evil')).toThrow(StriartError);
  });

  it('URI : warp://tab_config/<nom>, new_window réglable, canal preview', () => {
    expect(plan().uri).toMatch(/^warp:\/\/tab_config\/striart-agent-a-[0-9a-f]{8}$/);
    expect(plan({ settings: { ...DEFAULT_WARP_SETTINGS, newWindow: true } }).uri).toMatch(
      /\?new_window=true$/,
    );
    const preview = plan({ settings: { ...DEFAULT_WARP_SETTINGS, channel: 'preview' } });
    expect(preview.uri.startsWith('warppreview://tab_config/')).toBe(true);
    expect(preview.tabConfig.dir).toBe('/home/u/.local/share/warp-terminal-preview/tab_configs');
  });

  it('ouverture en argv : open (macOS), xdg-open (Linux)', () => {
    const mac = plan({ platform: 'darwin', home: '/Users/u' });
    expect(mac.file).toBe('open');
    expect(mac.args).toEqual([mac.uri]);
    expect(mac.tabConfig.dir).toBe('/Users/u/.warp/tab_configs');
    const linux = plan();
    expect(linux.file).toBe('xdg-open');
    expect(linux.args).toEqual([linux.uri]);
  });

  it('canal auto : preview si la session Warp courante est une Preview', () => {
    expect(resolveWarpChannel('auto', {})).toBe('stable');
    expect(
      resolveWarpChannel('auto', {
        TERM_PROGRAM: 'WarpTerminal',
        TERM_PROGRAM_VERSION: 'v0.2026.10.01.08.00.preview_01',
      }),
    ).toBe('preview');
    expect(
      resolveWarpChannel('stable', {
        TERM_PROGRAM: 'WarpTerminal',
        TERM_PROGRAM_VERSION: 'preview',
      }),
    ).toBe('stable');
  });

  it('dossiers documentés par OS (XDG relatif ignoré, %APPDATA% requis)', () => {
    const base = { home: '/home/u', channel: 'stable' };
    expect(
      warpDirectories({ ...base, platform: 'linux', env: { XDG_DATA_HOME: '/x/data' } })
        .tabConfigDir,
    ).toBe('/x/data/warp-terminal/tab_configs');
    expect(
      warpDirectories({ ...base, platform: 'linux', env: { XDG_DATA_HOME: 'rel' } }).tabConfigDir,
    ).toBe('/home/u/.local/share/warp-terminal/tab_configs');
    expect(() => warpDirectories({ ...base, platform: 'win32', env: {} })).toThrow(StriartError);
  });

  it('dossier tab_configs personnalisé (terminal.warp.tabConfigDir)', () => {
    const p = plan({
      settings: { ...DEFAULT_WARP_SETTINGS, tabConfigDir: '/opt/warp/tab_configs' },
    });
    expect(p.tabConfig.dir).toBe('/opt/warp/tab_configs');
    expect(p.tabConfig.appDir).toBe('/opt/warp');
  });
});
