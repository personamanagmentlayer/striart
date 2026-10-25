import { describe, expect, it } from 'vitest';
import {
  acpOptionsProblem,
  acpRelaxedProtections,
  buildAuthRequiredMessage,
  resolveAcpOptions,
} from '../../src/acp/protocol.ts';
import {
  elicitationSchemaProblem,
  validateElicitationContent,
} from '../../src/acp/elicitation-schema.ts';

describe('acp — options de profil étendues (client v1 complet)', () => {
  it('défauts sûrs : hôte persistant, bus accepté, terminal borné, MCP Striart, pas d’auth auto', () => {
    const options = resolveAcpOptions({ command: 'x', args: [], acp: true });
    expect(options).toMatchObject({
      permissions: 'allow',
      askTimeoutMs: 120_000,
      authMethodId: null,
      persistentHost: true,
      bus: true,
      mcp: 'striart',
      terminal: { enabled: true, timeoutMs: 600_000, outputByteLimit: 1_000_000, maxTerminals: 8 },
    });
    // Elicitation : jamais annoncée sans humain pour répondre (politique ≠ ask).
    expect(options.elicitation).toEqual({ form: false, url: false });
  });

  it("politique ask : l'elicitation form est annoncée par défaut, url seulement sur opt-in", () => {
    expect(
      resolveAcpOptions({ command: 'x', args: [], acp: { permissions: 'ask' } }).elicitation,
    ).toEqual({ form: true, url: false });
    expect(
      resolveAcpOptions({
        command: 'x',
        args: [],
        acp: { permissions: 'ask', elicitation: { url: true } },
      }).elicitation,
    ).toEqual({ form: true, url: true });
  });

  it('terminal: false désactive la capacité ; un objet surcharge les bornes', () => {
    expect(
      resolveAcpOptions({ command: 'x', args: [], acp: { terminal: false } }).terminal.enabled,
    ).toBe(false);
    expect(
      resolveAcpOptions({
        command: 'x',
        args: [],
        acp: { terminal: { timeoutMs: 5_000, maxTerminals: 2 } },
      }).terminal,
    ).toEqual({ enabled: true, timeoutMs: 5_000, outputByteLimit: 1_000_000, maxTerminals: 2 });
  });

  it('auth.methodId explicite = seule voie vers authenticate', () => {
    expect(
      resolveAcpOptions({ command: 'x', args: [], acp: { auth: { methodId: 'agent-login' } } })
        .authMethodId,
    ).toBe('agent-login');
  });

  it('acpOptionsProblem : valide chaque clé, nomme la cause et le champ (jamais la valeur)', () => {
    expect(acpOptionsProblem(true)).toBeNull();
    expect(acpOptionsProblem(undefined)).toBeNull();
    expect(acpOptionsProblem({ permissions: 'ask', bus: false, mcp: 'none' })).toBeNull();
    expect(acpOptionsProblem({ permissions: 'maybe' })).toEqual({
      reason: 'ACP_OPTION_INVALID',
      field: 'acp.permissions',
    });
    expect(acpOptionsProblem({ auth: { methodId: '' } })).toMatchObject({ field: 'acp.auth' });
    expect(acpOptionsProblem({ terminal: { timeoutMs: 10 } })).toMatchObject({
      field: 'acp.terminal.timeoutMs',
    });
    expect(acpOptionsProblem({ mcp: 'everything' })).toMatchObject({ field: 'acp.mcp' });
    expect(acpOptionsProblem({ inconnu: 1 })).toMatchObject({ field: 'acp.inconnu' });
    // Elicitation explicitement demandée sans humain pour arbitrer : refus.
    expect(acpOptionsProblem({ elicitation: { form: true } })).toEqual({
      reason: 'ACP_ELICITATION_NEEDS_ASK',
      field: 'acp.elicitation',
    });
  });

  it('fsReadMaxBytes : défaut 4 Mio, borné, relâché → affiché', () => {
    const base = { command: 'x', args: [] };
    expect(resolveAcpOptions({ ...base, acp: true }).fsReadMaxBytes).toBe(4 * 1024 * 1024);
    expect(resolveAcpOptions({ ...base, acp: { fsReadMaxBytes: 2_048 } }).fsReadMaxBytes).toBe(
      2_048,
    );
    for (const bad of [0, 1_023, 1.5, '4096', 268_435_457]) {
      expect(() => resolveAcpOptions({ ...base, acp: { fsReadMaxBytes: bad } })).toThrowError(
        expect.objectContaining({ code: 'PROFILE_INVALID' }),
      );
    }
    expect(acpRelaxedProtections(resolveAcpOptions({ ...base, acp: true }))).not.toContain(
      'acp.fsReadMaxBytes',
    );
    expect(
      acpRelaxedProtections(resolveAcpOptions({ ...base, acp: { fsReadMaxBytes: 16_777_216 } })),
    ).toContain('acp.fsReadMaxBytes');
  });

  it('resolveAcpOptions refuse une option invalide (PROFILE_INVALID, fail closed)', () => {
    expect(() =>
      resolveAcpOptions({ command: 'x', args: [], acp: { permissions: 'maybe' } }),
    ).toThrowError(expect.objectContaining({ code: 'PROFILE_INVALID' }));
  });

  it('message auth_required : anglais, actionnable, cite chaque méthode proposée', () => {
    const message = buildAuthRequiredMessage({
      profileKey: 'gemini-acp',
      command: 'gemini',
      args: ['--experimental-acp'],
      methods: [
        { id: 'agent-login', name: 'Agent login' },
        { id: 'terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] },
      ],
    });
    expect(message).toMatch(/requires authentication/);
    expect(message).toContain('agent-login');
    expect(message).toContain('agentProfiles.gemini-acp.acp.auth.methodId');
    // Méthode terminal : jamais passée à authenticate — la commande à lancer est donnée.
    expect(message).toContain('gemini --experimental-acp --login');
  });
});

describe('acp — schéma d’elicitation (formulaire plat)', () => {
  const schema = {
    type: 'object',
    properties: {
      strategy: { type: 'string', enum: ['rebase', 'merge'] },
      reason: { type: 'string', minLength: 3, maxLength: 20 },
      retries: { type: 'integer', minimum: 0, maximum: 5 },
      ratio: { type: 'number', minimum: 0, maximum: 1 },
      squash: { type: 'boolean' },
      labels: { type: 'array', items: { enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 },
      email: { type: 'string', format: 'email' },
      titled: { type: 'string', oneOf: [{ const: 'x', title: 'X' }, { const: 'y' }] },
    },
    required: ['strategy'],
  };

  it('accepte un schéma plat bien formé, refuse les formes non supportées', () => {
    expect(elicitationSchemaProblem(schema)).toBeNull();
    expect(elicitationSchemaProblem({ type: 'array' })).not.toBeNull();
    expect(
      elicitationSchemaProblem({ type: 'object', properties: { n: { type: 'object' } } }),
    ).not.toBeNull();
    expect(
      elicitationSchemaProblem({ type: 'object', properties: {}, required: ['absent'] }),
    ).not.toBeNull();
    expect(
      elicitationSchemaProblem({
        type: 'object',
        properties: { p: { type: 'string', pattern: '(' } },
      }),
    ).not.toBeNull();
  });

  it('valide une réponse conforme', () => {
    expect(
      validateElicitationContent(schema, {
        strategy: 'merge',
        reason: 'parce que',
        retries: 2,
        ratio: 0.5,
        squash: true,
        labels: ['a', 'c'],
        email: 'dev@example.org',
        titled: 'y',
      }),
    ).toEqual({ ok: true });
  });

  it('refuse : requis manquant, enum hors liste, bornes, type, champ inconnu', () => {
    expect(validateElicitationContent(schema, {})).toMatchObject({
      ok: false,
      field: 'strategy',
      reason: 'REQUIRED',
    });
    expect(validateElicitationContent(schema, { strategy: 'squash' })).toMatchObject({
      field: 'strategy',
      reason: 'ENUM',
    });
    expect(validateElicitationContent(schema, { strategy: 'merge', reason: 'no' })).toMatchObject({
      field: 'reason',
      reason: 'MIN_LENGTH',
    });
    expect(validateElicitationContent(schema, { strategy: 'merge', retries: 1.5 })).toMatchObject({
      field: 'retries',
      reason: 'TYPE',
    });
    expect(validateElicitationContent(schema, { strategy: 'merge', ratio: 2 })).toMatchObject({
      field: 'ratio',
      reason: 'MAXIMUM',
    });
    expect(
      validateElicitationContent(schema, { strategy: 'merge', labels: ['a', 'b', 'c'] }),
    ).toMatchObject({ field: 'labels', reason: 'MAX_ITEMS' });
    expect(
      validateElicitationContent(schema, { strategy: 'merge', email: 'pas-un-mail' }),
    ).toMatchObject({ field: 'email', reason: 'FORMAT' });
    expect(validateElicitationContent(schema, { strategy: 'merge', titled: 'z' })).toMatchObject({
      field: 'titled',
      reason: 'ENUM',
    });
    expect(validateElicitationContent(schema, { strategy: 'merge', extra: 1 })).toMatchObject({
      field: 'extra',
      reason: 'UNKNOWN_FIELD',
    });
    expect(validateElicitationContent(schema, 'texte')).toMatchObject({ reason: 'TYPE' });
  });
});

describe('elicitation — motifs fournis par l’agent (S-M3, ReDoS)', () => {
  const withPattern = (pattern) => ({
    type: 'object',
    properties: { p: { type: 'string', pattern } },
  });

  it.each([
    String.raw`^(\w+\s?)*$`,
    '^(a+)+$',
    '^(a|a)*$',
    '^((a+))*$',
    '^(.*)*x$',
    String.raw`^(a)\1$`,
    '^(?=a)a$',
  ])('refuse le motif à retour arrière dangereux %s', (pattern) => {
    expect(elicitationSchemaProblem(withPattern(pattern))).toMatch(/unsafe/);
  });

  it.each([
    '^[a-z0-9-]+$',
    String.raw`^v\d+\.\d+$`,
    '^(feat|fix)$',
    '^(abc)?d$',
    '^[a-z]+(-[a-z]+)?$',
  ])('accepte le motif usuel %s', (pattern) => {
    expect(elicitationSchemaProblem(withPattern(pattern))).toBeNull();
  });

  it('une saisie géante n’est jamais évaluée contre un motif', () => {
    const started = Date.now();
    const result = validateElicitationContent(withPattern('^[a-z]+$'), { p: 'a'.repeat(10_000) });
    expect(result).toMatchObject({ ok: false, reason: 'PATTERN' });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
