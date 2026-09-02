import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config.js';
import {
  PROMPT_PLACEHOLDER,
  buildAgentArgv,
  listProfiles,
  resolveAgentProfile,
  runAgentSession,
  sessionLogPath,
} from '../../src/session.js';

describe('session — résolution de profil', () => {
  it('résout un profil déclaré', () => {
    const profile = resolveAgentProfile(DEFAULT_CONFIG, 'claude');
    expect(profile.command).toBe('claude');
    expect(profile.args).toContain(PROMPT_PLACEHOLDER);
  });

  it('livre des profils par défaut pour plusieurs fournisseurs', () => {
    // Le mode autonome doit savoir piloter autre chose que Claude sur le
    // même projet — c'est la raison d'être de la table de profils.
    for (const key of ['claude', 'codex', 'aider', 'ollama']) {
      const profile = resolveAgentProfile(DEFAULT_CONFIG, key);
      expect(profile.args.some((a) => a.includes(PROMPT_PLACEHOLDER))).toBe(true);
    }
  });

  it('échoue explicitement sur un profil inconnu, en listant les profils connus', () => {
    expect(() => resolveAgentProfile(DEFAULT_CONFIG, 'kimi')).toThrowError(
      /Profil d'agent inconnu/,
    );
    try {
      resolveAgentProfile(DEFAULT_CONFIG, 'kimi');
    } catch (error) {
      expect(error.code).toBe('PROFILE_UNKNOWN');
      expect(error.details.known).toContain('claude');
    }
  });
});

describe('session — listProfiles (striart profiles)', () => {
  it('décrit chaque profil : invocation, clés env (JAMAIS les valeurs), timeout', () => {
    const rows = listProfiles({
      agentProfiles: {
        codex: {
          command: 'codex',
          args: ['exec', '{{prompt}}'],
          env: { OPENAI_API_KEY: 'secret-a-ne-pas-fuiter', MODEL: 'o4' },
          timeout: 600000,
        },
        claude: { command: 'claude', args: ['-p', '{{prompt}}'] },
      },
    });
    // Trié par nom.
    expect(rows.map((r) => r.name)).toEqual(['claude', 'codex']);
    const codex = rows.find((r) => r.name === 'codex');
    expect(codex.invocation).toBe('codex exec {{prompt}}');
    expect(codex.envKeys).toEqual(['OPENAI_API_KEY', 'MODEL']);
    expect(codex.timeout).toBe(600000);
    // La sortie ne doit JAMAIS contenir une valeur d'env (potentiellement un secret).
    expect(JSON.stringify(rows)).not.toContain('secret-a-ne-pas-fuiter');
    // Profil sans env/timeout : envKeys vide, timeout null.
    expect(rows.find((r) => r.name === 'claude')).toMatchObject({ envKeys: [], timeout: null });
  });

  it('signale le transport ACP des profils qui le déclarent', () => {
    const rows = listProfiles({
      agentProfiles: {
        classique: { command: 'claude', args: ['-p', '{{prompt}}'] },
        moderne: { command: 'agent-acp', args: [], acp: true },
      },
    });
    expect(rows.find((r) => r.name === 'moderne').acp).toBe(true);
    expect(rows.find((r) => r.name === 'classique').acp).toBe(false);
  });
});

describe("session — construction de l'argv", () => {
  it('substitue le marqueur par le prompt', () => {
    const argv = buildAgentArgv(
      { command: 'claude', args: ['-p', PROMPT_PLACEHOLDER] },
      'ajoute un test',
    );
    expect(argv).toEqual({ command: 'claude', args: ['-p', 'ajoute un test'] });
  });

  it('substitue aussi le marqueur enchâssé dans un argument', () => {
    const argv = buildAgentArgv(
      { command: 'aider', args: [`--message=${PROMPT_PLACEHOLDER}`] },
      'refactor',
    );
    expect(argv.args).toEqual(['--message=refactor']);
  });

  it("garde le prompt dans UN SEUL élément d'argv, quels que soient ses métacaractères", () => {
    // Le prompt est de la donnée : il peut venir d'une issue ou d'un fichier.
    // S'il était concaténé dans une ligne de shell, ceci serait une injection
    // de commande. Ici il doit rester un argument opaque, non découpé.
    const hostile = 'corrige le bug"; rm -rf / #';
    const argv = buildAgentArgv({ command: 'claude', args: ['-p', PROMPT_PLACEHOLDER] }, hostile);
    expect(argv.args).toHaveLength(2);
    expect(argv.args[1]).toBe(hostile);
  });

  it('refuse un profil sans marqueur — le prompt ne serait jamais transmis', () => {
    // Sans ce garde-fou, l'agent démarrerait sans tâche et sortirait en 0 :
    // un succès vide, le pire des résultats en mode autonome.
    expect(() => buildAgentArgv({ command: 'claude', args: ['-p'] }, 'tâche')).toThrowError(
      /aucun argument ne contient/,
    );
  });

  it('refuse une commande vide ou des args non textuels', () => {
    expect(() => buildAgentArgv({ command: '  ', args: [PROMPT_PLACEHOLDER] }, 't')).toThrowError(
      /command/,
    );
    expect(() => buildAgentArgv({ command: 'x', args: [42] }, 't')).toThrowError(
      /tableau de chaînes/,
    );
  });

  it("refuse un profil ACP : le prompt passe par le protocole, pas par l'argv", () => {
    expect(() => buildAgentArgv({ command: 'agent-acp', args: [], acp: true }, 't')).toThrowError(
      /protocole/,
    );
  });
});

describe('session — exécution supervisée', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-session-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const run = (profile, extra = {}) =>
    runAgentSession({
      root,
      agent: 'agent-a',
      taskId: 'task-1',
      cwd: root,
      profile,
      prompt: 'bonjour',
      timeoutMs: 15_000,
      ...extra,
    });

  it('rapporte COMPLETED et écrit un log hors du clone', async () => {
    const result = await run({
      command: process.execPath,
      args: ['-e', `console.log(process.argv[1])`, PROMPT_PLACEHOLDER],
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);

    // Le log vit sous .striart/logs/ : il doit survivre à la suppression du
    // clone en fin de cycle réussi, sinon la session ne laisse aucune trace.
    expect(result.logPath).toBe(sessionLogPath(root, 'agent-a', 'task-1'));
    expect(result.logPath).toContain(path.join('.striart', 'logs'));
    await expect(readFile(result.logPath, 'utf8')).resolves.toContain('bonjour');
  });

  it('rapporte FAILED sur sortie non nulle, sans throw', async () => {
    const result = await run({
      command: process.execPath,
      args: ['-e', 'process.exit(3)', PROMPT_PLACEHOLDER],
    });
    expect(result.status).toBe('FAILED');
    expect(result.exitCode).toBe(3);
  });

  it('rapporte FAILED sans throw quand le binaire n’existe pas, en citant la commande', async () => {
    // Volontairement pas de statut dédié : execa normalise le ENOENT de
    // Windows en exitCode 1, un SPAWN_FAILED serait faux sur un des trois OS
    // de la matrice CI. Le diagnostic passe par `error`, qui est portable.
    const result = await run({
      command: 'striart-binaire-absent-xyz',
      args: [PROMPT_PLACEHOLDER],
    });
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('striart-binaire-absent-xyz');
  });

  it('tue la session au-delà du délai et rapporte TIMEOUT', async () => {
    const result = await run(
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)', PROMPT_PLACEHOLDER],
      },
      { timeoutMs: 1500 },
    );
    expect(result.status).toBe('TIMEOUT');
    expect(result.timedOut).toBe(true);
    await expect(readFile(result.logPath, 'utf8')).resolves.toContain('délai');
  });
});
