import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_ACP_AGENT_SETTINGS,
  acpAgentRelaxedProtections,
  acpAgentSettingsProblem,
  resolveAcpAgentSettings,
} from '../../src/acp-agent/settings.ts';
import { describeUri, parseSlashCommand, promptToText } from '../../src/acp-agent/content.ts';
import { OUTGOING_REQUESTS, RpcPeer } from '../../src/acp-agent/rpc.ts';
import { acpProfileChoices, effectiveAcpOptions } from '../../src/acp-agent/session.ts';
import { toRpcError } from '../../src/acp-agent/server.ts';
import { StriartError } from '../../src/errors.ts';
import { validateConfig } from '../../src/config.ts';

/**
 * Proxy ACP `striart acp` (lot I10) : réglages, conversion des prompts,
 * frontière structurelle fs/terminal, options effectives, manifeste du
 * registre ACP. Fonctions pures, flux en mémoire : unitaire.
 */
const ROOT = path.resolve('/repo/main');

describe('acpAgent — réglages', () => {
  it('défauts sûrs : arbitrage humain, merge sous Test Gate, IDE déconnecté → clone conservé, collision → refus', () => {
    const s = resolveAcpAgentSettings(undefined);
    expect(s.permissions).toBe('ask');
    expect(s.permissionChoices).not.toContain('allow');
    expect(s.merge).toBe('auto');
    expect(s.onDisconnect).toBe('keep');
    expect(s.collisionPolicy).toBe('fail');
    expect(acpAgentRelaxedProtections(s)).toEqual([]);
    expect(acpAgentSettingsProblem(DEFAULT_ACP_AGENT_SETTINGS)).toBeNull();
  });

  it('objet partiel complété par les défauts', () => {
    const s = resolveAcpAgentSettings({ merge: 'manual' });
    expect(s.merge).toBe('manual');
    expect(s.permissions).toBe('ask');
  });

  it.each([
    [{ permissions: 'yolo' }, 'acpAgent.permissions'],
    [{ unknownKey: 1 }, 'acpAgent.unknownKey'],
    [{ reuse: true }, 'acpAgent.reuse'],
    [{ agentName: '../evil' }, 'acpAgent.agentName'],
    [{ permissions: 'allow' }, 'acpAgent.permissions'],
    [{ permissionChoices: [] }, 'acpAgent.permissionChoices'],
    [{ sessionTimeoutMs: 10 }, 'acpAgent.sessionTimeoutMs'],
    [{ profiles: ['ok', 'pas ok'] }, 'acpAgent.profiles'],
    ['oui', 'acpAgent'],
  ])('refus explicite du champ fautif (%j)', (value, field) => {
    expect(acpAgentSettingsProblem(value)).toBe(field);
  });

  it('config.js refuse au chargement une valeur invalide, en nommant le champ (jamais la valeur)', () => {
    expect(() => validateConfig({ acpAgent: { onDisconnect: 'merge-anyway' } })).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        details: { reason: 'INVALID_VALUE', key: 'acpAgent', field: 'acpAgent.onDisconnect' },
      }),
    );
  });

  it('relâchements nommés (journalisés au démarrage, pour doctor)', () => {
    const s = resolveAcpAgentSettings({
      permissions: 'allow',
      permissionChoices: ['allow', 'ask'],
      onDisconnect: 'finish',
    });
    expect(acpAgentRelaxedProtections(s)).toEqual([
      'acpAgent.permissions',
      'acpAgent.permissionChoices',
      'acpAgent.onDisconnect',
    ]);
  });
});

describe('prompts de l’IDE → texte de l’agent amont', () => {
  it('texte, lien et ressource embarquée ; chemins du principal réécrits en chemins du dépôt', () => {
    const file = pathToFileURL(path.join(ROOT, 'src', 'a.js')).href;
    const r = promptToText(
      [
        { type: 'text', text: 'corrige' },
        { type: 'resource_link', uri: file, name: 'a.js' },
        { type: 'resource', resource: { uri: file, text: 'export const a = 1;' } },
      ],
      ROOT,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain('[file: src/a.js]');
    expect(r.text).toContain('--- src/a.js (context attached in the editor) ---');
    expect(r.text).not.toContain(ROOT);
  });

  it('URI hors du dépôt ou non-fichier : laissée telle quelle', () => {
    expect(describeUri('https://example.com/x', ROOT)).toBe('https://example.com/x');
    const outside = pathToFileURL(path.resolve('/elsewhere/x.js')).href;
    expect(describeUri(outside, ROOT)).toBe(outside);
  });

  it('caractères de contrôle remplacés (comptés), jamais transmis', () => {
    const r = promptToText([{ type: 'text', text: 'a\u0000b\u001bc\td' }], ROOT);
    expect(r).toMatchObject({ ok: true, replacedControls: 2 });
    expect(r.text).toBe('a�b�c\td');
  });

  it('refus explicites : vide, trop long, contenu non annoncé (image)', () => {
    expect(promptToText([], ROOT)).toMatchObject({ ok: false, reason: 'EMPTY' });
    expect(promptToText([{ type: 'text', text: '   ' }], ROOT)).toMatchObject({
      ok: false,
      reason: 'EMPTY',
    });
    expect(promptToText([{ type: 'text', text: 'x'.repeat(70_000) }], ROOT)).toMatchObject({
      ok: false,
      reason: 'TOO_LONG',
    });
    expect(
      promptToText([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], ROOT),
    ).toMatchObject({
      ok: false,
      reason: 'UNSUPPORTED_CONTENT',
    });
  });

  it('commandes Striart préfixées : jamais une commande homonyme de l’amont', () => {
    expect(parseSlashCommand(' /striart-finish ')).toBe('finish');
    expect(parseSlashCommand('/striart-status')).toBe('status');
    expect(parseSlashCommand('/status')).toBeNull();
    expect(parseSlashCommand('/finish')).toBeNull();
  });
});

describe('frontière structurelle : aucune capacité fs/terminal de l’IDE', () => {
  const peer = () => {
    const output = new PassThrough();
    const written = [];
    output.on('data', (c) => written.push(String(c)));
    return {
      written,
      peer: new RpcPeer({
        input: new PassThrough(),
        output,
        onRequest: async () => null,
        onNotification: () => {},
        mapError: toRpcError,
      }),
    };
  };

  it.each(['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output'])(
    'une requête %s vers l’IDE est refusée avant tout octet écrit',
    async (method) => {
      const { peer: p, written } = peer();
      await expect(p.request(method, {})).rejects.toThrow(/only human arbitration/);
      expect(written).toEqual([]);
    },
  );

  it('seules les demandes d’arbitrage humain sont autorisées', () => {
    expect([...OUTGOING_REQUESTS].sort()).toEqual([
      'elicitation/create',
      'session/request_permission',
    ]);
  });

  it('une notification autre que session/update est refusée', () => {
    const { peer: p } = peer();
    expect(() => p.notify('terminal/output', {})).toThrow();
  });

  it('erreurs : code Striart stable dans data, aucun détail sensible ; erreur inattendue générique', () => {
    const rpc = toRpcError(
      new StriartError('x', {
        code: 'ACP_PROXY_COLLISION',
        details: { agents: ['a'], env: { KEY: 's3cret' } },
      }),
    );
    expect(rpc.data.code).toBe('ACP_PROXY_COLLISION');
    expect(JSON.stringify(rpc.data)).not.toContain('s3cret');
    const unexpected = toRpcError(new Error('chemin /secret/interne'));
    expect(unexpected.message).not.toContain('/secret');
    expect(unexpected.data.code).toBe('UNEXPECTED');
  });
});

describe('options effectives d’une session IDE', () => {
  const profile = (acp = true) => ({ command: 'agent', args: ['--acp'], acp });
  const settings = resolveAcpAgentSettings({});

  it('politique choisie, hôte persistant et bus imposés, elicitation seulement avec un humain', () => {
    const ask = effectiveAcpOptions(
      profile({ permissions: 'allow', bus: false, persistentHost: false }),
      'ask',
      settings,
    );
    expect(ask).toMatchObject({ permissions: 'ask', persistentHost: true, bus: true });
    expect(ask.elicitation.form).toBe(true);
    const reject = effectiveAcpOptions(profile(), 'reject', settings);
    expect(reject.permissions).toBe('reject');
    expect(reject.elicitation).toEqual({ form: false, url: false });
  });

  it("'profile' reprend la politique du profil ; askTimeoutMs de acpAgent prioritaire", () => {
    const o = effectiveAcpOptions(
      profile({ permissions: 'reject' }),
      'profile',
      resolveAcpAgentSettings({
        askTimeoutMs: 5_000,
        permissions: 'profile',
        permissionChoices: ['profile'],
      }),
    );
    expect(o.permissions).toBe('reject');
    expect(o.askTimeoutMs).toBe(5_000);
  });

  it('profil ACP invalide : refus (fail closed), jamais ignoré', () => {
    expect(() =>
      effectiveAcpOptions(profile({ permissions: 'peut-être' }), 'ask', settings),
    ).toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }));
  });

  it('profils proposés : ACP seulement ; une liste blanche qui nomme un profil non ACP est refusée', () => {
    const config = {
      agentProfiles: { b: profile(), a: profile(), argv: { command: 'x', args: ['{{prompt}}'] } },
    };
    expect(acpProfileChoices(config, settings)).toEqual(['a', 'b']);
    expect(() =>
      acpProfileChoices(config, resolveAcpAgentSettings({ profiles: ['argv'] })),
    ).toThrow(expect.objectContaining({ code: 'ACP_PROXY_PROFILE_UNAVAILABLE' }));
  });
});

describe('manifeste du registre ACP (registry/acp/striart)', () => {
  const dir = fileURLToPath(new URL('../../registry/acp/striart/', import.meta.url));

  it('conforme au format du registre (agent.schema.json, 2026-10-24) et synchronisé avec package.json', async () => {
    const manifest = JSON.parse(await readFile(path.join(dir, 'agent.json'), 'utf8'));
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    );
    expect(manifest.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(path.basename(dir)).toBe(manifest.id);
    for (const field of ['id', 'name', 'version', 'description', 'distribution', 'license_url'])
      expect(manifest[field], field).toBeTruthy();
    expect(manifest.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(manifest.version).toBe(pkg.version);
    // Version épinglée, la même que le manifeste : jamais un « latest » flottant.
    expect(manifest.distribution.npx.package).toBe(`${pkg.name}@${pkg.version}`);
    expect(manifest.distribution.npx.args).toEqual(['acp']);
    expect(Object.keys(manifest.distribution)).toEqual(['npx']);
    expect(manifest.license).toBe(pkg.license);
  });

  it('icône 16x16 monochrome (currentColor, aucune couleur codée en dur)', async () => {
    const svg = await readFile(path.join(dir, 'icon.svg'), 'utf8');
    expect(svg).toContain('width="16"');
    expect(svg).toContain('height="16"');
    expect(svg).toContain('currentColor');
    expect(svg).not.toMatch(/fill="(?!currentColor|none)[^"]*"/);
    expect(svg).not.toMatch(/stroke="(?!currentColor|none)[^"]*"/);
  });
});
