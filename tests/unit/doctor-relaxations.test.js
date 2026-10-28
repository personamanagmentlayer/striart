import { describe, expect, it } from 'vitest';
import { collectRelaxations } from '../../src/doctor-relaxations.ts';

const names = (input) => collectRelaxations(input).names;

describe('collectRelaxations — synthèse des protections relâchées (doctor)', () => {
  it('config par défaut : aucune relaxation', () => {
    expect(
      collectRelaxations({
        config: {},
        protectedRelaxed: { allow: [], caseSensitive: false },
        userTrustedRoots: [],
      }),
    ).toEqual({
      names: [],
      policies: [],
      unreadable: [],
    });
  });

  it('config absente : rien à synthétiser', () => {
    expect(collectRelaxations({ config: null })).toEqual({
      names: [],
      policies: [],
      unreadable: [],
    });
  });

  it('mcp.scope orchestrator', () => {
    expect(names({ config: { mcp: { scope: 'orchestrator' } } })).toContain('mcp.scope');
  });

  it('orchestration.race.losers clean et reviewerWrites discard', () => {
    const n = names({
      config: {
        orchestration: { race: { losers: 'clean' }, review: { reviewerWrites: 'discard' } },
      },
    });
    expect(n).toEqual(
      expect.arrayContaining(['orchestration.race.losers', 'orchestration.review.reviewerWrites']),
    );
  });

  it('acpRegistry.allowBinaryDownload', () => {
    expect(names({ config: { acpRegistry: { allowBinaryDownload: true } } })).toContain(
      'acpRegistry.allowBinaryDownload',
    );
    expect(names({ config: { acpRegistry: { allowBinaryDownload: false } } })).toEqual([]);
  });

  it('acpRegistry.allowEnv non vide : variables du registre acceptées', () => {
    expect(names({ config: { acpRegistry: { allowEnv: ['MY_AGENT_MODE'] } } })).toContain(
      'acpRegistry.allowEnv',
    );
    expect(names({ config: { acpRegistry: { allowEnv: [] } } })).toEqual([]);
  });

  it('agentInstructions.enabled=false', () => {
    expect(names({ config: { agentInstructions: { enabled: false } } })).toContain(
      'agentInstructions.enabled',
    );
    expect(names({ config: { agentInstructions: { enabled: true } } })).toEqual([]);
  });

  it('gateContainer process : le Test Gate sans conteneur natif relâche une protection', () => {
    expect(names({ config: { gateContainer: 'process' } })).toContain('gateContainer');
    expect(names({ config: { gateContainer: 'native' } })).toEqual([]);
    expect(names({ config: {} })).toEqual([]);
  });

  it('lock.breakFrozenHolderAfterMs non nul', () => {
    expect(names({ config: { lock: { breakFrozenHolderAfterMs: 60000 } } })).toContain(
      'lock.breakFrozenHolderAfterMs',
    );
    expect(names({ config: { lock: { breakFrozenHolderAfterMs: null } } })).toEqual([]);
  });

  it('dashboardAllowedHosts non vide', () => {
    expect(names({ config: { dashboardAllowedHosts: ['*.app.github.dev'] } })).toContain(
      'dashboardAllowedHosts',
    );
    expect(names({ config: { dashboardAllowedHosts: [] } })).toEqual([]);
  });

  it('protectedAgentPaths.allow et matchCase platform (sources déjà résolues par doctor)', () => {
    expect(
      names({ config: {}, protectedRelaxed: { allow: ['a/**'], caseSensitive: false } }),
    ).toEqual(['protectedAgentPaths.allow']);
    expect(names({ config: {}, protectedRelaxed: { allow: [], caseSensitive: true } })).toEqual([
      'protectedAgentPaths.matchCase',
    ]);
  });

  it('hooks.trustedRoots de la config UTILISATEUR', () => {
    expect(names({ config: {}, userTrustedRoots: ['/repo'] })).toEqual(['hooks.trustedRoots']);
  });

  it('secretPatterns: [] (exclusion des secrets et scan historique désactivés)', () => {
    expect(names({ config: { secretPatterns: [] } })).toEqual(['secretPatterns']);
    // Défaut de la config chargée, ou liste personnalisée non vide : pas un relâchement.
    expect(names({ config: { secretPatterns: ['.env', '*.pem'] } })).toEqual([]);
    expect(names({ config: {} })).toEqual([]);
  });

  it('pty.shell fixé par la config (exécutable choisi par le dépôt)', () => {
    expect(names({ config: { pty: { shell: 'pwsh' } } })).toEqual(['pty.shell']);
    expect(names({ config: { pty: { shell: '/usr/bin/zsh' } } })).toEqual(['pty.shell']);
    expect(names({ config: { pty: { shell: 'auto' } } })).toEqual([]);
    expect(names({ config: { pty: { shellArgs: ['-NoProfile'] } } })).toEqual([]);
  });

  it("terminal.launcher: 'custom' (argv choisi par le dépôt)", () => {
    expect(names({ config: { terminal: { launcher: 'custom' } } })).toEqual(['terminal.launcher']);
    expect(names({ config: { terminal: { launcher: 'auto' } } })).toEqual([]);
    expect(names({ config: { terminal: { launcher: 'warp' } } })).toEqual([]);
  });

  it('presets expérimentaux déclarés', () => {
    expect(
      names({
        config: { agentProfiles: { z: { experimental: true }, a: { experimental: true }, ok: {} } },
      }),
    ).toEqual(['agentProfiles.a.experimental', 'agentProfiles.z.experimental']);
  });

  it('relaxations ACP d’un profil (identifiants stables, rattachés au profil)', () => {
    const n = names({
      config: {
        agentProfiles: {
          p1: {
            command: 'x',
            args: [],
            acp: { permissions: 'ask', elicitation: { url: true } },
          },
        },
      },
    });
    expect(n).toContain('acp.elicitation.url@p1');
  });

  it('un profil ACP illisible est signalé, jamais passé sous silence', () => {
    const r = collectRelaxations({
      config: { agentProfiles: { bad: { command: 'x', args: [], acp: { permissions: 'nope' } } } },
    });
    expect(r.unreadable).toEqual(['agentProfiles.bad.acp']);
  });

  it('noms sans doublon, triés, ordre déterministe', () => {
    const r = names({
      config: {
        mcp: { scope: 'orchestrator' },
        dashboardAllowedHosts: ['x.example.com'],
        lock: { breakFrozenHolderAfterMs: 1000 },
      },
      userTrustedRoots: ['/r'],
      protectedRelaxed: { allow: ['a'], caseSensitive: true },
    });
    expect(r).toEqual([...new Set(r)].sort());
    expect(r.length).toBe(6);
    // Les trois relâchements de config-as-code s'ajoutent sans doublon.
    expect(
      names({
        config: { secretPatterns: [], pty: { shell: 'pwsh' }, terminal: { launcher: 'custom' } },
      }),
    ).toEqual(['pty.shell', 'secretPatterns', 'terminal.launcher']);
  });
});

describe('collectRelaxations — réseau (config UTILISATEUR / environnement)', () => {
  it('network.allowInsecureHosts non vide : HTTP en clair autorisé vers ces hôtes', () => {
    expect(
      collectRelaxations({
        config: null,
        userNetwork: { allowInsecureHosts: ['gpu.corp.example'] },
      }).names,
    ).toContain('network.allowInsecureHosts');
    expect(
      collectRelaxations({ config: null, userNetwork: { allowInsecureHosts: [] } }).names,
    ).toEqual([]);
  });

  it('vérification TLS coupée (NODE_TLS_REJECT_UNAUTHORIZED=0) : relâchement nommé', () => {
    expect(collectRelaxations({ config: null, tlsVerificationDisabled: true }).names).toContain(
      'env.NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });

  it('config utilisateur illisible : bloc réseau non évaluable, jamais compté sûr', () => {
    expect(collectRelaxations({ config: null, userNetworkUnreadable: true }).unreadable).toContain(
      'network',
    );
  });
});
