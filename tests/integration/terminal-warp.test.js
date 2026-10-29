import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAgentTerminal, removeAgentTerminalArtifacts } from '../../src/terminal.ts';
import { warpDirectories, warpTabConfigName } from '../../src/terminal/warp.ts';

// En intégration : la Tab Config est réellement écrite sur disque (dossier
// de données de Warp simulé dans un HOME/APPDATA temporaire). L'ouverture
// (open / xdg-open / Start-Process) reste injectée : jamais de vrai Warp.

const platform = process.platform;
let home;
let env;
let root;
let cwd;

function fakeSpawn() {
  const calls = [];
  const spawnFn = vi.fn((file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  });
  return { spawnFn, calls };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'striart-warp-'));
  env = platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming') } : {};
  root = path.join(home, "mon dépôt o'brien");
  cwd = path.join(root, '.striart', 'agents', 'agent-a');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function installWarp(channel = 'stable') {
  const { appDir } = warpDirectories({ platform, env, home, channel });
  await mkdir(appDir, { recursive: true });
  return warpDirectories({ platform, env, home, channel });
}

const argv = () => [
  process.execPath,
  path.join(home, 'striart "x"', 'cli.js'),
  'attach',
  'agent-a',
];
const winArgv = () => [process.execPath, path.join(home, 'striart', 'cli.js'), 'attach', 'agent-a'];

describe('Warp : Tab Config écrite, ouverte par URI, nettoyée', () => {
  it('écrit striart-<agent>-<empreinte>.toml puis ouvre warp://tab_config/<nom> en argv', async () => {
    const { tabConfigDir } = await installWarp();
    const { spawnFn, calls } = fakeSpawn();
    const result = await openAgentTerminal({
      cwd,
      title: 'STRIART: agent-a',
      argv: platform === 'win32' ? winArgv() : argv(),
      terminal: { launcher: 'warp' },
      platform,
      env,
      home,
      spawnFn,
    });
    expect(result).toEqual({ launched: true });
    const name = warpTabConfigName(root, 'agent-a');
    const file = path.join(tabConfigDir, `${name}.toml`);
    const content = await readFile(file, 'utf8');
    expect(content).toContain('[[panes]]');
    expect(content).toContain(JSON.stringify(cwd).slice(1, -1));
    const uri = `warp://tab_config/${name}`;
    expect(calls).toHaveLength(1);
    if (platform === 'win32') expect(calls[0].args.at(-1)).toContain(`'${uri}'`);
    else expect(calls[0].args).toEqual([uri]);
    // Aucun temporaire laissé derrière.
    expect(await readdir(tabConfigDir)).toEqual([`${name}.toml`]);
  });

  it.runIf(platform !== 'win32')(
    'fichier en 0600, dossier tab_configs en 0700 si créé',
    async () => {
      const { tabConfigDir } = await installWarp();
      const { spawnFn } = fakeSpawn();
      await openAgentTerminal({
        cwd,
        title: 't',
        argv: argv(),
        terminal: { launcher: 'warp' },
        platform,
        env,
        home,
        spawnFn,
      });
      const file = path.join(tabConfigDir, `${warpTabConfigName(root, 'agent-a')}.toml`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(tabConfigDir)).mode & 0o777).toBe(0o700);
    },
  );

  it('Warp non installé (dossier de données absent) → repli, rien écrit, rien lancé', async () => {
    const { spawnFn } = fakeSpawn();
    const result = await openAgentTerminal({
      cwd,
      title: 't',
      argv: winArgv(),
      terminal: { launcher: 'warp' },
      platform,
      env,
      home,
      spawnFn,
    });
    expect(result.launched).toBe(false);
    expect(result.error).toMatch(/Warp/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('chemin avec saut de ligne → repli TERMINAL_UNSAFE, aucun fichier écrit', async () => {
    const { tabConfigDir } = await installWarp();
    const { spawnFn } = fakeSpawn();
    const result = await openAgentTerminal({
      cwd,
      title: 't',
      argv: [process.execPath, '/a\nb', 'attach', 'agent-a'],
      terminal: { launcher: 'warp' },
      platform,
      env,
      home,
      spawnFn,
    });
    expect(result.launched).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(await readdir(tabConfigDir).catch(() => [])).toEqual([]);
  });

  it.runIf(platform !== 'win32')(
    'cible déjà présente en lien symbolique → refus, la cible du lien est intacte',
    async () => {
      const { tabConfigDir } = await installWarp();
      await mkdir(tabConfigDir, { recursive: true });
      const victim = path.join(home, 'victim.txt');
      await writeFile(victim, 'intact');
      await symlink(victim, path.join(tabConfigDir, `${warpTabConfigName(root, 'agent-a')}.toml`));
      const { spawnFn } = fakeSpawn();
      const result = await openAgentTerminal({
        cwd,
        title: 't',
        argv: argv(),
        terminal: { launcher: 'warp' },
        platform,
        env,
        home,
        spawnFn,
      });
      expect(result.launched).toBe(false);
      expect(await readFile(victim, 'utf8')).toBe('intact');
    },
  );

  it('nettoyage : removeAgentTerminalArtifacts retire les Tab Configs de l’agent (deux canaux), idempotent', async () => {
    const stable = await installWarp('stable');
    const preview = await installWarp('preview');
    const { spawnFn } = fakeSpawn();
    for (const channel of ['stable', 'preview']) {
      await openAgentTerminal({
        cwd,
        title: 't',
        argv: winArgv(),
        terminal: { launcher: 'warp', warp: { channel } },
        platform,
        env,
        home,
        spawnFn,
      });
    }
    // Un autre dépôt avec le même nom d'agent : jamais touché.
    const otherRoot = path.join(home, 'autre');
    const otherCwd = path.join(otherRoot, '.striart', 'agents', 'agent-a');
    await mkdir(otherCwd, { recursive: true });
    await openAgentTerminal({
      cwd: otherCwd,
      title: 't',
      argv: winArgv(),
      terminal: { launcher: 'warp' },
      platform,
      env,
      home,
      spawnFn,
    });
    const removed = await removeAgentTerminalArtifacts({
      root,
      agent: 'agent-a',
      platform,
      env,
      home,
    });
    expect(removed).toHaveLength(2);
    expect(await readdir(preview.tabConfigDir)).toEqual([]);
    expect(await readdir(stable.tabConfigDir)).toEqual([
      `${warpTabConfigName(otherRoot, 'agent-a')}.toml`,
    ]);
    expect(
      await removeAgentTerminalArtifacts({ root, agent: 'agent-a', platform, env, home }),
    ).toEqual([]);
  });

  it('détection automatique : session Warp en « auto » → Tab Config ; detectWarp:false → lanceur historique', async () => {
    await installWarp();
    const warpEnv = { ...env, TERM_PROGRAM: 'WarpTerminal' };
    const auto = fakeSpawn();
    await openAgentTerminal({
      cwd,
      title: 't',
      argv: winArgv(),
      terminal: {},
      platform,
      env: warpEnv,
      home,
      spawnFn: auto.spawnFn,
    });
    expect(['open', 'xdg-open', 'powershell']).toContain(auto.calls[0].file);
    expect(auto.calls[0].args.join(' ')).toContain('tab_config/');
    const off = fakeSpawn();
    await openAgentTerminal({
      cwd,
      title: 't',
      argv: winArgv(),
      terminal: { detectWarp: false },
      platform,
      env: warpEnv,
      home,
      spawnFn: off.spawnFn,
    });
    expect(off.calls[0].args.join(' ')).not.toContain('tab_config/');
  });
});
