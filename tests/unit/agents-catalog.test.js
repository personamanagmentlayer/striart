import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  attendedCommandOf,
  commandBaseName,
  defaultAgentProfiles,
  expandAgentProfiles,
  findPresetForCommand,
  getPreset,
  materializePreset,
} from '../../src/agents/catalog.ts';
import {
  COMMIT_POLICIES,
  PROMPT_PLACEHOLDER,
  isValidAgentProfile,
  isValidCommitAuthor,
  isValidCommitMessageTemplate,
} from '../../src/agents/profile-schema.ts';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.js';
import { StriartError } from '../../src/errors.js';

const argOf = (profile, flag) => profile.args[profile.args.indexOf(flag) + 1];

describe('catalogue — chaque preset matérialise un profil valide', () => {
  it('ids uniques, clés de profil uniques parmi les presets prêts', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = PRESETS.filter((p) => p.status === 'ready').map((p) => p.profileKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(PRESETS.map((p) => [p.id, p]))('%s : profil valide pour chaque contrat', (_id, p) => {
    expect(p.docs.length).toBeGreaterThan(0);
    for (const commitPolicy of COMMIT_POLICIES) {
      const profile = materializePreset(p, { commitPolicy });
      expect(isValidAgentProfile(profile)).toBe(true);
      const hasPrompt = profile.args.some((a) => a.includes(PROMPT_PLACEHOLDER));
      expect(hasPrompt).toBe(p.transport === 'argv');
    }
  });

  it('les profils par défaut ne contiennent QUE des presets prêts', () => {
    const defaults = defaultAgentProfiles();
    for (const profile of Object.values(defaults)) {
      expect(getPreset(profile.preset).status).toBe('ready');
      expect(profile.experimental).toBeUndefined();
    }
    // Les expérimentaux restent dans le catalogue, hors défauts.
    const experimental = PRESETS.filter((p) => p.status === 'experimental');
    expect(experimental.length).toBeGreaterThan(0);
    for (const p of experimental) expect(materializePreset(p).experimental).toBe(true);
  });

  it('les clés historiques survivent : claude, codex, aider, ollama', () => {
    for (const key of ['claude', 'codex', 'aider', 'ollama']) {
      expect(DEFAULT_CONFIG.agentProfiles[key]).toBeDefined();
    }
  });
});

describe('correctifs des presets (constats vérifiés en doc officielle)', () => {
  it('claude : --bare, acceptEdits, commit autorisé selon le contrat, push refusé', () => {
    const claude = DEFAULT_CONFIG.agentProfiles.claude;
    // `-p` seul démarre en mode Manual (≥ 2.1.302) : éditions et commit refusés.
    expect(claude.args).toContain('--bare');
    expect(argOf(claude, '--permission-mode')).toBe('acceptEdits');
    expect(argOf(claude, '--setting-sources')).toBe('user');
    expect(claude.args).toContain('--strict-mcp-config');
    expect(argOf(claude, '--allowedTools')).toContain('Bash(git commit *)');
    expect(argOf(claude, '--disallowedTools')).toBe('Bash(git push *)');
    expect(claude.instructions).toMatchObject({
      channel: 'system-prompt-file',
      flag: '--append-system-prompt-file',
    });
    expect(claude.structuredOutput).toBe('claude-stream-json');
    // Contrat 'human' : plus aucune règle qui autorise git commit.
    const human = materializePreset(getPreset('claude-code'), { commitPolicy: 'human' });
    expect(argOf(human, '--allowedTools')).not.toContain('git commit');
  });

  it('codex : sandbox workspace-write (exec seul est en lecture seule), Striart committe', () => {
    const codex = DEFAULT_CONFIG.agentProfiles.codex;
    expect(codex.args.slice(0, 3)).toEqual(['exec', '--sandbox', 'workspace-write']);
    expect(codex.args).not.toContain('--full-auto'); // retiré de Codex
    // workspace-write rend .git lecture seule : l'agent ne PEUT pas commiter.
    expect(codex.commitPolicy).toBe('striart');
    expect(codex.structuredOutput).toBe('codex-jsonl');
  });

  it('ollama : requalifié — Aider pilote le modèle local (`ollama run` n’édite rien)', () => {
    const ollama = DEFAULT_CONFIG.agentProfiles.ollama;
    expect(ollama.command).toBe('aider');
    expect(argOf(ollama, '--model')).toMatch(/^ollama_chat\//);
    expect(ollama.args).not.toContain('run');
  });

  it('neutralisation de la config du dépôt quand l’outil le permet', () => {
    expect(DEFAULT_CONFIG.agentProfiles.opencode.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(DEFAULT_CONFIG.agentProfiles.amp.env.AMP_IGNORE_GUIDANCE_FILES).toBe('*');
    expect(DEFAULT_CONFIG.agentProfiles.aider.settingsFile).toEqual({ flag: '--config', json: {} });
    expect(DEFAULT_CONFIG.agentProfiles['claude-subscription'].settingsFile).toMatchObject({
      flag: '--settings',
      json: { disableAllHooks: true },
      claudeMdExcludes: true,
    });
    // Copilot : JAMAIS COPILOT_ALLOW_ALL (approuverait le dossier du dépôt).
    expect(DEFAULT_CONFIG.agentProfiles.copilot.env?.COPILOT_ALLOW_ALL).toBeUndefined();
  });
});

describe('références de preset dans la config', () => {
  it('{ preset } est matérialisé ; les champs donnés l’emportent, env fusionne', () => {
    const out = expandAgentProfiles({
      mine: { preset: 'opencode', env: { OPENAI_API_KEY: 'k' }, timeout: 5000 },
    });
    expect(out.mine.command).toBe('opencode');
    expect(out.mine.timeout).toBe(5000);
    expect(out.mine.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENAI_API_KEY: 'k',
    });
  });

  it('contrat de commit : entrée > global déclaré > défaut du preset', () => {
    const refs = {
      a: { preset: 'claude-code' },
      b: { preset: 'claude-code', commitPolicy: 'agent' },
    };
    expect(expandAgentProfiles(refs).a.commitPolicy).toBe('agent');
    const withGlobal = expandAgentProfiles(refs, { commitPolicy: 'human' });
    expect(withGlobal.a.commitPolicy).toBe('human');
    expect(withGlobal.b.commitPolicy).toBe('agent');
  });

  it('validateConfig : preset inconnu refusé, preset expérimental accepté sur déclaration', () => {
    expect(() => validateConfig({ agentProfiles: { x: { preset: 'nope' } } })).toThrow(
      StriartError,
    );
    expect(() => validateConfig({ agentProfiles: { j: { preset: 'junie' } } })).not.toThrow();
    // Une surcharge qui casse le profil matérialisé est refusée.
    expect(() =>
      validateConfig({ agentProfiles: { c: { preset: 'claude-code', args: ['-p'] } } }),
    ).toThrow(StriartError);
  });

  it('valide les nouveaux champs : canal, drapeau, sortie, réglages, auteur', () => {
    const base = { command: 'x', args: ['{{prompt}}'] };
    const ok = (extra) => isValidAgentProfile({ ...base, ...extra });
    expect(ok({ structuredOutput: 'codex-jsonl' })).toBe(true);
    expect(ok({ structuredOutput: 'xml' })).toBe(false);
    expect(ok({ instructions: { channel: 'acp-prompt' } })).toBe(false); // argv
    expect(ok({ instructions: { channel: 'system-prompt-file' } })).toBe(false); // ni flag ni slot
    expect(ok({ instructions: { channel: 'system-prompt-file', flag: '--rules' } })).toBe(true);
    expect(ok({ instructions: { flag: 'pas un drapeau' } })).toBe(false);
    expect(ok({ instructions: { template: 'Hi {{agent}} {{oops}}' } })).toBe(false);
    expect(ok({ settingsFile: { flag: '--settings', json: {} } })).toBe(true);
    expect(ok({ settingsFile: { flag: '--settings', json: [] } })).toBe(false);
    expect(ok({ commitPolicy: 'agent-then-striart' })).toBe(true);
    expect(ok({ commitPolicy: 'sometimes' })).toBe(false);
    expect(isValidCommitAuthor({ name: 'Bot', email: 'bot@x.invalid' })).toBe(true);
    expect(isValidCommitAuthor({ name: 'Evil <a@b>' })).toBe(false);
    expect(isValidCommitAuthor({ name: 'line\nbreak' })).toBe(false);
    expect(isValidCommitAuthor({ email: 'not-an-email' })).toBe(false);
    expect(isValidCommitMessageTemplate('striart({{agent}}): {{task}}')).toBe(true);
    expect(isValidCommitMessageTemplate('x {{secret}}')).toBe(false);
    // ACP : ni sortie structurée, ni emplacements argv de consignes.
    const acp = { command: 'a', args: [], acp: true };
    expect(isValidAgentProfile({ ...acp, structuredOutput: 'ndjson' })).toBe(false);
    expect(isValidAgentProfile({ ...acp, args: ['{{striartInstructions}}'] })).toBe(false);
  });

  it('validateConfig : agentInstructions et acpRegistry stricts', () => {
    expect(() => validateConfig({ agentInstructions: { enabled: false } })).not.toThrow();
    expect(() => validateConfig({ agentInstructions: { enable: false } })).toThrow(StriartError);
    expect(() => validateConfig({ agentInstructions: { agentsMd: 'skip' } })).toThrow(StriartError);
    expect(() =>
      validateConfig({ agentInstructions: { attendedFiles: { claude: ['../escape.md'] } } }),
    ).toThrow(StriartError);
    expect(() => validateConfig({ agentInstructions: { genericFiles: ['.git/info/x'] } })).toThrow(
      StriartError,
    );
    expect(() => validateConfig({ acpRegistry: { url: 'http://insecure/r.json' } })).toThrow(
      StriartError,
    );
    expect(() => validateConfig({ acpRegistry: { allowBinaryDownload: true } })).not.toThrow();
  });
});

describe('outil d’un agent supervisé', () => {
  it('reconnaît la commande quel que soit son chemin ou son extension', () => {
    expect(commandBaseName('C:\\tools\\claude.exe --model x')).toBe('claude');
    expect(findPresetForCommand('/usr/local/bin/codex').id).toBe('codex');
    // Un binaire porté par plusieurs presets : le preset argv prêt d'abord.
    expect(findPresetForCommand('goose').id).toBe('goose');
    expect(findPresetForCommand('inconnu')).toBeNull();
  });

  it('attendedCommandOf : agent > config > claude', () => {
    expect(attendedCommandOf('aider', 'codex')).toBe('aider');
    expect(attendedCommandOf(null, 'codex')).toBe('codex');
    expect(attendedCommandOf(null, null)).toBe('claude');
  });
});

describe('options ACP validées au chargement (règle unique de src/acp/protocol.ts)', () => {
  it('clé ACP inconnue ou mal typée : CONFIG_INVALID avec profil et champ, jamais la valeur', () => {
    let caught;
    try {
      validateConfig({
        agentProfiles: { a: { command: 'agent-acp', args: [], acp: { persistentHost: 'oui' } } },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StriartError);
    expect(caught.details).toEqual({
      reason: 'INVALID_VALUE',
      key: 'agentProfiles',
      profile: 'a',
      field: 'acp.persistentHost',
    });
    expect(() =>
      validateConfig({ agentProfiles: { a: { command: 'x', args: [], acp: { typo: true } } } }),
    ).toThrow(StriartError);
    expect(() =>
      validateConfig({ agentProfiles: { g: { preset: 'gemini-acp', acp: { bus: true } } } }),
    ).not.toThrow();
  });
});
