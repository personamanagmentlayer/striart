import { describe, expect, it } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { parsePlan, validatePlan } from '../../src/plan.ts';
import { validateConfig } from '../../src/config.ts';

/**
 * Le catalogue anglais remplace le message du domaine (français) par code.
 * Il ne doit jamais perdre l'information qui permet d'agir : la raison
 * d'un plan invalide, la clé de config fautive, la sortie de git, les
 * fichiers en cause. Avant : « invalid plan (see the detail above) » sans
 * aucun détail au-dessus, « the merge failed. », etc.
 */
const say = (code, details) => en.errors(code, details);

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('aucune erreur levée');
}

describe('catalogue anglais : le détail actionnable survit à la traduction', () => {
  it('PLAN_INVALID : chaque raison de validation est rendue, avec la tâche visée', () => {
    const cases = [
      [() => validatePlan('x'), /YAML object/],
      [() => validatePlan({ version: 3, tasks: [] }), /version 3/],
      [() => validatePlan({ version: 1, tasks: [] }), /"tasks"/],
      [() => validatePlan({ version: 1, tasks: ['x'] }), /task #1.*object/],
      [() => validatePlan({ version: 1, tasks: [{ id: 'db' }] }), /task #1 \(db\).*"prompt"/],
      [() => validatePlan({ version: 1, tasks: [{ prompt: 'p', agent: 3 }] }), /"agent"/],
      [
        () => validatePlan({ version: 1, tasks: [{ prompt: 'p', autonomous: 'y' }] }),
        /"autonomous"/,
      ],
      [() => validatePlan({ version: 1, tasks: [{ prompt: 'p', timeout: 5 }] }), /"timeout"/],
      [
        () =>
          validatePlan({
            version: 1,
            tasks: [
              { id: 'a', prompt: 'p' },
              { id: 'a', prompt: 'q' },
            ],
          }),
        /duplicate id "a"/,
      ],
      [
        () =>
          validatePlan({
            version: 1,
            tasks: [
              { id: 'a', prompt: 'p', after: 'b' },
              { id: 'b', prompt: 'q' },
            ],
          }),
        /"after: b".*later/,
      ],
      [() => parsePlan('tasks: [unclosed'), /not valid YAML/],
    ];
    for (const [fn, expected] of cases) {
      const error = thrown(fn);
      expect(error.code).toBe('PLAN_INVALID');
      expect(say(error.code, error.details)).toMatch(expected);
    }
  });

  it('CONFIG_INVALID : clé fautive, config illisible, promotion mal configurée', () => {
    const error = thrown(() => validateConfig({ testTimeoutMs: 'vite' }));
    expect(say(error.code, error.details)).toContain('"testTimeoutMs"');
    expect(say('CONFIG_INVALID', { reason: 'UNREADABLE', cause: 'Unexpected token' })).toContain(
      'Unexpected token',
    );
    expect(
      say('CONFIG_INVALID', { reason: 'SAME_BRANCH', mainBranch: 'main', targetBranch: 'main' }),
    ).toMatch(/mainBranch.*targetBranch/);
  });

  it('échecs git et LLM : la cause est conservée', () => {
    const cause = 'fatal: refusing to merge unrelated histories';
    expect(say('MERGE_FAILED', { agent: 'agent-a', cause })).toContain(cause);
    expect(say('UNTRACKED_COLLISION', { agent: 'agent-a', cause: 'a.js' })).toContain('a.js');
    expect(say('SECRETS_EXCLUSION_FAILED', { name: 'agent-a', cause: 'unknown option' })).toContain(
      'unknown option',
    );
    for (const code of ['LLM_FAILED', 'ROUTER_FAILED', 'MEMORY_FAILED', 'SEMANTIC_MERGE_FAILED']) {
      const text = say(code, { cause: 'ECONNREFUSED', provider: 'ollama', model: 'llama3.1:8b' });
      expect(text).toContain('ECONNREFUSED');
      expect(text).toContain('ollama:llama3.1:8b');
    }
    expect(say('PTY_ATTACH_LISTEN_FAILED', { agent: 'a', message: 'EADDRINUSE' })).toContain(
      'EADDRINUSE',
    );
    expect(
      say('REGISTRY_CORRUPT', { path: '/r/.striart/agents.json', cause: 'Unexpected end' }),
    ).toContain('Unexpected end');
  });

  it('LLM_CONFIG_INVALID : dit quoi renseigner', () => {
    expect(
      say('LLM_CONFIG_INVALID', {
        reason: 'UNKNOWN_PROVIDER',
        provider: 'x',
        supported: ['ollama'],
      }),
    ).toMatch(/"x".*ollama/);
    expect(say('LLM_CONFIG_INVALID', { reason: 'NO_MODEL', provider: 'openai' })).toContain(
      'llm.model',
    );
    expect(say('LLM_CONFIG_INVALID', { reason: 'NO_BASE_URL', provider: 'azure' })).toContain(
      'llm.baseUrl',
    );
    expect(
      say('LLM_CONFIG_INVALID', {
        reason: 'NO_API_KEY',
        provider: 'openai',
        apiKeyEnv: 'OPENAI_API_KEY',
      }),
    ).toContain('OPENAI_API_KEY');
  });

  it('PROFILE_INVALID : la règle enfreinte est nommée', () => {
    expect(say('PROFILE_INVALID', { field: 'command', reason: 'COMMAND_EMPTY' })).toContain(
      '"command"',
    );
    expect(say('PROFILE_INVALID', { field: 'args', reason: 'ARGS_NOT_STRINGS' })).toContain(
      '"args"',
    );
    expect(
      say('PROFILE_INVALID', {
        field: 'args',
        reason: 'PLACEHOLDER_MISSING',
        placeholder: '{{prompt}}',
      }),
    ).toContain('{{prompt}}');
    expect(say('PROFILE_INVALID', { field: 'args', reason: 'PLACEHOLDER_FORBIDDEN' })).toMatch(
      /ACP/,
    );
    expect(say('PROFILE_INVALID', { field: 'acp', reason: 'ACP_TRANSPORT' })).toMatch(/ACP/);
  });

  it('tickets, promotion, permissions : fichiers et valeurs en cause', () => {
    expect(say('RESOLUTION_INCOMPLETE', { ticketId: 't', missing: ['a.js', 'b.js'] })).toContain(
      'a.js, b.js',
    );
    expect(say('RESOLUTION_INCOMPLETE', { ticketId: 't', stillConflicted: ['c.js'] })).toContain(
      'c.js',
    );
    expect(say('STALE_TICKET', { ticketId: 't', sha: 'abcdef1234567890' })).toContain('abcdef12');
    expect(say('STALE_TICKET', { ticketId: 't', expected: ['a.js'], actual: ['b.js'] })).toMatch(
      /a\.js.*b\.js/,
    );
    expect(say('UNSUPPORTED_RESOLUTION_KIND', { ticketId: 't', unsupported: ['link'] })).toContain(
      'link',
    );
    expect(say('TICKET_NOT_APPLICABLE', { ticketId: 't', reason: 'TEST_GATE_FAILED' })).toContain(
      'TEST_GATE_FAILED',
    );
    expect(say('MAIN_DIVERGED', { mainBranch: 'main', behind: 2 })).toMatch(/main.*2/);
    expect(
      say('PERMISSION_OPTION_UNKNOWN', { id: 'p', optionId: 'x', known: ['allow'] }),
    ).toContain('allow');
    expect(say('MERGE_ABORT_FAILED', {})).toContain('git status');
  });
});

describe('catalogue anglais : ne perd ni la raison ni le champ fautif (C-I1)', () => {
  it('OPTION_CONFLICT : la raison propre à la commande n’est pas écrasée par le texte générique', () => {
    expect(say('OPTION_CONFLICT', { reason: 'NEEDS_UNATTENDED', options: ['--profile'] })).toBe(
      '--profile only makes sense with --autonomous or --on-main.',
    );
    expect(say('OPTION_CONFLICT', { reason: 'NEEDS_START', options: ['--pid'] })).toBe(
      '--pid only works with --start.',
    );
    expect(say('OPTION_CONFLICT', { options: ['<prompt>', '--prompt'] })).toBe(
      'incompatible options: <prompt>, --prompt.',
    );
  });

  it('INVALID_ARGUMENT : valeur, liste admise, outil, argument, méthode et paramètre', () => {
    expect(
      say('INVALID_ARGUMENT', { option: 'role', value: 'bad', allowed: ['merger', 'router'] }),
    ).toBe('invalid value for role: bad (expected one of: merger, router).');
    expect(say('INVALID_ARGUMENT', { option: 'port', value: 70000 })).toBe(
      'invalid value for port: 70000.',
    );
    expect(say('INVALID_ARGUMENT', { option: 'port', port: 70000 })).toBe(
      'invalid value for port: 70000.',
    );
    expect(say('INVALID_ARGUMENT', { option: 'taskId' })).toBe('invalid value for taskId.');
    expect(say('INVALID_ARGUMENT', { argument: 'agent' })).toBe(
      'invalid or missing argument "agent".',
    );
    expect(
      say('INVALID_ARGUMENT', { method: 'agent.start', param: '/agent', keyword: 'pattern' }),
    ).toBe('invalid parameter "/agent" for "agent.start" (pattern).');
    expect(say('INVALID_ARGUMENT', { method: 'agent.start', param: 'params' })).toBe(
      'invalid parameter "params" for "agent.start".',
    );
    for (const details of [
      { option: 'role', value: 'x' },
      { option: 'taskId' },
      { argument: 'agent' },
      { method: 'm', param: 'p' },
    ]) {
      expect(say('INVALID_ARGUMENT', details)).not.toContain('?');
    }
  });

  it('INVALID_ARGUMENT sans champ exploitable : null, le message du domaine (détaillé) est conservé', () => {
    expect(say('INVALID_ARGUMENT', { tool: 'striart_merge' })).toBeNull();
    expect(say('INVALID_ARGUMENT', {})).toBeNull();
    expect(say('INVALID_ARGUMENT', { maxLineBytes: '0' })).toBeNull();
  });

  it('CONFIG_INVALID INVALID_VALUE : le champ fautif remonte, profil ACP compris', () => {
    expect(
      say('CONFIG_INVALID', {
        reason: 'INVALID_VALUE',
        key: 'agentProfiles',
        profile: 'claude-acp',
        field: 'acp.askTimeoutMs',
      }),
    ).toBe('invalid value for "agentProfiles.claude-acp.acp.askTimeoutMs" in the Striart config.');
    expect(
      say('CONFIG_INVALID', {
        reason: 'INVALID_VALUE',
        key: 'acpAgent',
        field: 'acpAgent.permissions',
      }),
    ).toBe('invalid value for "acpAgent.permissions" in the Striart config.');
    // Cas historique inchangé.
    expect(say('CONFIG_INVALID', { key: 'testTimeoutMs' })).toContain('"testTimeoutMs"');
  });

  it('CONTROL_INSTANCE_NOT_FOUND : sans port, null (le message localisé de la commande est gardé)', () => {
    expect(say('CONTROL_INSTANCE_NOT_FOUND', {})).toBeNull();
    expect(say('CONTROL_INSTANCE_NOT_FOUND', { port: 3456 })).toContain('3456');
  });

  it('hôte de pty : la raison, le code natif et le journal sont rendus', () => {
    expect(
      say('PTY_HOST_SPAWN_FAILED', { agent: 'a', reason: 'TIMEOUT', logFile: '/l/a.log' }),
    ).toBe('the terminal host of "a" did not become ready in time (log: /l/a.log).');
    expect(
      say('PTY_HOST_SPAWN_FAILED', {
        agent: 'a',
        reason: 'EXITED',
        exitCode: 3,
        signal: null,
        nativeCode: 'NATIVE_UNAVAILABLE',
        logFile: null,
      }),
    ).toBe('the terminal host of "a" exited before being ready (NATIVE_UNAVAILABLE, exit code 3).');
    expect(
      say('PTY_HOST_SPAWN_FAILED', { agent: 'a', reason: 'EXITED', signal: 'SIGKILL' }),
    ).toContain('SIGKILL');
    expect(say('PTY_HOST_ALREADY_RUNNING', { agent: 'a' })).toBe(
      'a terminal host already runs for agent "a": attach to it instead of starting another.',
    );
  });

  it('REVIEW_VERDICT_INVALID : identifiant ou commentaire manquant', () => {
    expect(say('REVIEW_VERDICT_INVALID', { reason: 'ID_REQUIRED' })).toBe(
      'a verdict needs the id of a review request.',
    );
    expect(say('REVIEW_VERDICT_INVALID', { reason: 'COMMENT_REQUIRED' })).toBe(
      '--request-changes needs --comment: the author must know what to fix.',
    );
    expect(say('REVIEW_VERDICT_INVALID', { reason: 'TOO_LONG' })).toContain('TOO_LONG');
  });
});

describe('catalogue français : les erreurs de domaine rédigées en anglais sont traduites (C-M2)', () => {
  const sayFr = (code, details) => fr.errors(code, details);

  it('hôte de pty, vérdicts de relecture, instructions de profil', () => {
    expect(sayFr('PTY_HOST_ALREADY_RUNNING', { agent: 'a' })).toMatch(/hôte.*déjà.*"a"/);
    expect(
      sayFr('PTY_HOST_SPAWN_FAILED', { agent: 'a', reason: 'TIMEOUT', logFile: '/l.log' }),
    ).toMatch(/hôte.*"a".*à temps.*\/l\.log/);
    expect(
      sayFr('PTY_HOST_SPAWN_FAILED', {
        agent: 'a',
        reason: 'EXITED',
        exitCode: 3,
        nativeCode: 'X',
      }),
    ).toMatch(/avant d'être prêt.*X.*3/);
    expect(sayFr('REVIEW_VERDICT_INVALID', { reason: 'ID_REQUIRED' })).toMatch(/identifiant/);
    expect(sayFr('REVIEW_VERDICT_INVALID', { reason: 'COMMENT_REQUIRED' })).toMatch(/--comment/);
    expect(sayFr('PROFILE_INVALID', { reason: 'INSTRUCTIONS_CHANNEL_TRANSPORT' })).toMatch(
      /acp-prompt/,
    );
    expect(sayFr('PROFILE_INVALID', { reason: 'INSTRUCTIONS_FLAG_MISSING' })).toMatch(
      /system-prompt-file/,
    );
  });

  it('les autres codes gardent le message du domaine (null)', () => {
    expect(sayFr('MAIN_DIRTY', {})).toBeNull();
    expect(sayFr('PROFILE_INVALID', { reason: 'COMMAND_EMPTY' })).toBeNull();
    expect(sayFr('INVALID_ARGUMENT', { option: 'role', value: 'x' })).toBeNull();
  });
});
