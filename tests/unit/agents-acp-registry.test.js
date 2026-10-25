import { describe, expect, it, vi } from 'vitest';
import {
  acpAgentDir,
  importAcpAgent,
  isPinnedPackage,
  parseRegistry,
  profileFromRegistryAgent,
  registryPlatformKey,
} from '../../src/agents/acp-registry.ts';
import { isValidAcpRegistryConfig, isValidAgentProfile } from '../../src/agents/profile-schema.ts';

const REGISTRY = {
  version: '1.0.0',
  agents: [
    {
      id: 'codex-acp',
      name: 'Codex',
      version: '2.2.2',
      distribution: { npx: { package: '@agentclientprotocol/codex-acp@2.2.2' } },
    },
    {
      id: 'floating',
      name: 'Floating',
      version: '1.0.0',
      distribution: { npx: { package: 'floating-agent@latest' } },
    },
    {
      id: 'binary-agent',
      name: 'Bin',
      version: '3.1.0',
      distribution: {
        binary: {
          'linux-x86_64': {
            archive: 'https://example.invalid/bin-3.1.0-linux.tar.gz',
            cmd: './dist/bin-agent',
            args: ['acp'],
            sha256: 'a'.repeat(64),
          },
        },
      },
    },
    {
      id: 'no-hash',
      name: 'NoHash',
      version: '0.1.0',
      distribution: {
        binary: { 'linux-x86_64': { archive: 'https://example.invalid/x.tar.gz', cmd: './x' } },
      },
    },
    { id: 'broken', distribution: 'nope' },
  ],
};

const registryFetch = () =>
  vi.fn(async (url) => {
    if (String(url).endsWith('registry.json')) {
      return new Response(JSON.stringify(REGISTRY), { status: 200 });
    }
    throw new Error(`téléchargement inattendu : ${url}`);
  });

const settings = (allowBinaryDownload = false) => ({
  url: 'https://cdn.example.invalid/registry.json',
  allowBinaryDownload,
});

describe('registre ACP — import (D8)', () => {
  it('parseRegistry ignore les entrées mal formées sans invalider le reste', () => {
    expect(parseRegistry(REGISTRY).map((a) => a.id)).toEqual([
      'codex-acp',
      'floating',
      'binary-agent',
      'no-hash',
    ]);
  });

  it('isPinnedPackage : version exacte seulement', () => {
    expect(isPinnedPackage('@scope/pkg@1.2.3')).toBe(true);
    expect(isPinnedPackage('pkg==0.26.0')).toBe(true);
    expect(isPinnedPackage('pkg@latest')).toBe(false);
    expect(isPinnedPackage('pkg@^1.2.0')).toBe(false);
    expect(isPinnedPackage('@scope/pkg')).toBe(false);
  });

  it('npx épinglé : profil ACP valide, version dans l’argv, AUCUN téléchargement', async () => {
    const fetchImpl = registryFetch();
    const result = await importAcpAgent({
      root: '/nonexistent',
      id: 'codex-acp',
      settings: settings(),
      fetchImpl,
      platform: 'linux-x86_64',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // le registre, rien d'autre
    expect(result.profile).toMatchObject({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp@2.2.2'],
      acp: true,
    });
    expect(isValidAgentProfile(result.profile)).toBe(true);
    expect(result.installation).toMatchObject({ downloaded: false, resolvedAtLaunchBy: 'npx' });
  });

  it('version non épinglée : refus', async () => {
    await expect(
      importAcpAgent({
        root: '/x',
        id: 'floating',
        settings: settings(),
        fetchImpl: registryFetch(),
      }),
    ).rejects.toMatchObject({ code: 'ACP_IMPORT_UNPINNED' });
  });

  it('binaire, métadonnées seules par défaut : nom du binaire + archive à installer', async () => {
    const fetchImpl = registryFetch();
    const result = await importAcpAgent({
      root: '/x',
      id: 'binary-agent',
      settings: settings(false),
      fetchImpl,
      platform: 'linux-x86_64',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.profile.command).toBe('bin-agent'); // jamais le chemin du registre
    expect(result.installation).toMatchObject({
      downloaded: false,
      archive: 'https://example.invalid/bin-3.1.0-linux.tar.gz',
      sha256: 'a'.repeat(64),
    });
  });

  it('téléchargement autorisé : empreinte publiée obligatoire, empreinte fausse rejetée', async () => {
    await expect(
      importAcpAgent({
        root: '/x',
        id: 'no-hash',
        settings: settings(true),
        fetchImpl: registryFetch(),
        platform: 'linux-x86_64',
      }),
    ).rejects.toMatchObject({ code: 'ACP_IMPORT_NO_INTEGRITY' });

    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith('registry.json')
        ? new Response(JSON.stringify(REGISTRY), { status: 200 })
        : new Response('contenu altéré', { status: 200 }),
    );
    await expect(
      importAcpAgent({
        root: '/x',
        id: 'binary-agent',
        settings: settings(true),
        fetchImpl,
        platform: 'linux-x86_64',
      }),
    ).rejects.toMatchObject({ code: 'ACP_DOWNLOAD_INTEGRITY_MISMATCH' });
  });

  it('plateforme non publiée, id inconnu, URL non https', async () => {
    await expect(
      importAcpAgent({
        root: '/x',
        id: 'binary-agent',
        settings: settings(),
        fetchImpl: registryFetch(),
        platform: 'darwin-aarch64',
      }),
    ).rejects.toMatchObject({ code: 'ACP_IMPORT_PLATFORM_UNSUPPORTED' });
    await expect(
      importAcpAgent({
        root: '/x',
        id: 'absent',
        settings: settings(),
        fetchImpl: registryFetch(),
      }),
    ).rejects.toMatchObject({ code: 'ACP_AGENT_UNKNOWN' });
    await expect(
      importAcpAgent({
        root: '/x',
        id: 'codex-acp',
        settings: { url: 'http://x/registry.json', allowBinaryDownload: false },
        fetchImpl: registryFetch(),
      }),
    ).rejects.toMatchObject({ code: 'ACP_REGISTRY_INVALID' });
  });

  it('profileFromRegistryAgent refuse un id qui ne serait pas un nom sûr', () => {
    expect(() =>
      profileFromRegistryAgent({
        id: '../evil',
        name: 'x',
        version: '1.0.0',
        distribution: { npx: { package: 'x@1.0.0' } },
      }),
    ).toThrow();
  });

  it('parseRegistry ignore une version qui serait un segment de chemin dangereux', () => {
    const entry = (version) => ({
      id: 'v',
      name: 'V',
      version,
      distribution: { npx: { package: 'x@1.0.0' } },
    });
    for (const bad of ['../../..', '..', '1.0/../..', 'a\\b', '/abs', '', '-rf', 'x'.repeat(65)]) {
      expect(parseRegistry({ agents: [entry(bad)] }), JSON.stringify(bad)).toEqual([]);
    }
    expect(parseRegistry({ agents: [entry('1.2.3-rc.1+build5')] })).toHaveLength(1);
  });

  it('acpAgentDir refuse de sortir de .striart/acp-agents', () => {
    expect(acpAgentDir('/r', 'a', '1.0.0').replaceAll('\\', '/')).toMatch(
      /\.striart\/acp-agents\/a\/1\.0\.0$/,
    );
    expect(() => acpAgentDir('/r', 'a', '../../..')).toThrow(/ACP|invalide/i);
    expect(() => acpAgentDir('/r', '..', '1.0.0')).toThrow();
  });

  it('isPinnedPackage : refuse les options injectées dans l’argv de npx/uvx', () => {
    expect(isPinnedPackage('--registry=http://x@1.2.3')).toBe(false);
    expect(isPinnedPackage('-y@1.2.3')).toBe(false);
    expect(isPinnedPackage('--package=evil@1.2.3')).toBe(false);
    expect(isPinnedPackage('pkg@1.2.3 --flag')).toBe(false);
    expect(isPinnedPackage('http://x/y@1.2.3')).toBe(false);
    expect(isPinnedPackage('../local@1.2.3')).toBe(false);
    expect(isPinnedPackage('pkg@1.2.3')).toBe(true);
    expect(isPinnedPackage('@scope/pkg@1.2.3-rc.1')).toBe(true);
    expect(isPinnedPackage('some_tool==1.2.3')).toBe(true);
    expect(isPinnedPackage('--index-url=x==1.2.3')).toBe(false);
  });

  it('env du registre : refusé par défaut, jamais NODE_OPTIONS/PATH même listé', () => {
    const agent = (env) => ({
      id: 'e',
      name: 'E',
      version: '1.0.0',
      distribution: { npx: { package: 'x@1.0.0', env } },
    });
    for (const name of ['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'path', 'npm_config_registry']) {
      expect(() => profileFromRegistryAgent(agent({ [name]: 'x' }))).toThrow(
        expect.objectContaining({ code: 'ACP_IMPORT_ENV_FORBIDDEN' }),
      );
      expect(() => profileFromRegistryAgent(agent({ [name]: 'x' }), { allowEnv: [name] })).toThrow(
        expect.objectContaining({ code: 'ACP_IMPORT_ENV_FORBIDDEN' }),
      );
    }
    expect(() => profileFromRegistryAgent(agent({ MY_AGENT_MODE: 'x' }))).toThrow(
      expect.objectContaining({ code: 'ACP_IMPORT_ENV_FORBIDDEN' }),
    );
    const ok = profileFromRegistryAgent(agent({ MY_AGENT_MODE: 'x' }), {
      allowEnv: ['MY_AGENT_MODE'],
    });
    expect(ok.profile.env).toEqual({ MY_AGENT_MODE: 'x' });
    expect(isValidAcpRegistryConfig({ allowEnv: ['NODE_OPTIONS'] })).toBe(false);
    expect(isValidAcpRegistryConfig({ allowEnv: ['MY_AGENT_MODE'] })).toBe(true);
  });

  it('registryPlatformKey', () => {
    expect(registryPlatformKey('win32', 'x64')).toBe('windows-x86_64');
    expect(registryPlatformKey('darwin', 'arm64')).toBe('darwin-aarch64');
    expect(registryPlatformKey('linux', 'ia32')).toBeNull();
  });
});
