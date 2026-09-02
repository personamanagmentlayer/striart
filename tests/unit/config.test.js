import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, validateConfig } from '../../src/config.js';
import { StriartError } from '../../src/errors.js';

describe('validateConfig', () => {
  it('accepte une config vide', () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it('accepte des valeurs valides', () => {
    expect(() =>
      validateConfig({
        testCommand: 'pytest',
        autoPush: true,
        ollamaHost: 'http://127.0.0.1:11434',
      }),
    ).not.toThrow();
  });

  it('rejette un testCommand non-string', () => {
    expect(() => validateConfig({ testCommand: 42 })).toThrow(StriartError);
  });

  it('rejette un ollamaHost sans protocole http', () => {
    expect(() => validateConfig({ ollamaHost: 'localhost:11434' })).toThrow(StriartError);
  });

  it('rejette un autoPush non booléen', () => {
    expect(() => validateConfig({ autoPush: 'yes' })).toThrow(StriartError);
  });

  it('tolère les clés inconnues (réservées aux phases suivantes)', () => {
    expect(() => validateConfig({ futureOption: 123 })).not.toThrow();
  });

  it('accepte un objet llm et rejette un llm non-objet', () => {
    expect(() =>
      validateConfig({ llm: { provider: 'openai', model: 'gpt-4o-mini' } }),
    ).not.toThrow();
    expect(() => validateConfig({ llm: 'ollama' })).toThrow(StriartError);
    expect(() => validateConfig({ llm: ['ollama'] })).toThrow(StriartError);
  });

  it('accepte agentCommand string ou null, rejette le reste', () => {
    expect(() => validateConfig({ agentCommand: 'aider' })).not.toThrow();
    expect(() => validateConfig({ agentCommand: null })).not.toThrow();
    expect(() => validateConfig({ agentCommand: '' })).toThrow(StriartError);
  });

  it('notifiers : accepte url OU urlEnv, un type connu', () => {
    expect(() =>
      validateConfig({
        notifiers: [
          { type: 'slack', url: 'https://hooks.slack.com/x' },
          { type: 'discord', urlEnv: 'DISCORD_HOOK' },
          { type: 'generic', urlEnv: 'INTERNAL_HOOK' },
        ],
      }),
    ).not.toThrow();
  });

  it('notifiers : rejette type inconnu, url sans protocole, url ET urlEnv, ni l’un ni l’autre', () => {
    expect(() => validateConfig({ notifiers: [{ type: 'teams', url: 'https://x' }] })).toThrow(
      StriartError,
    );
    expect(() =>
      validateConfig({ notifiers: [{ type: 'slack', url: 'hooks.slack.com' }] }),
    ).toThrow(StriartError);
    // Les deux à la fois : ambiguïté refusée au chargement.
    expect(() =>
      validateConfig({ notifiers: [{ type: 'slack', url: 'https://x', urlEnv: 'Y' }] }),
    ).toThrow(StriartError);
    // Aucune des deux : entrée morte.
    expect(() => validateConfig({ notifiers: [{ type: 'slack' }] })).toThrow(StriartError);
    expect(() => validateConfig({ notifiers: 'https://x' })).toThrow(StriartError);
  });
});

describe('loadConfig', () => {
  it('retourne les valeurs par défaut sans fichier de config', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-config-'));
    const config = await loadConfig(dir);
    expect(config).toMatchObject(DEFAULT_CONFIG);
    expect(config.configPath).toBeNull();
  });

  it('fusionne le fichier utilisateur avec les défauts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-config-'));
    await writeFile(
      path.join(dir, '.striartrc.json'),
      JSON.stringify({ testCommand: 'make test' }),
    );
    const config = await loadConfig(dir);
    expect(config.testCommand).toBe('make test');
    expect(config.targetBranch).toBe(DEFAULT_CONFIG.targetBranch);
    expect(config.configPath).toContain('.striartrc.json');
  });

  it('rejette un fichier utilisateur invalide', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-config-'));
    await writeFile(path.join(dir, '.striartrc.json'), JSON.stringify({ autoPush: 'oui' }));
    await expect(loadConfig(dir)).rejects.toThrow(StriartError);
  });
});

describe('agentProfiles (mode autonome)', () => {
  it('rejette un profil dont aucun argument ne porte {{prompt}}', () => {
    // Sans marqueur, l'agent démarrerait sans tâche et sortirait en 0 :
    // un faux succès. Le refus doit tomber au chargement de la config.
    expect(() =>
      validateConfig({ agentProfiles: { kimi: { command: 'kimi', args: ['--headless'] } } }),
    ).toThrow(StriartError);
  });

  it('rejette une commande vide ou des args non textuels', () => {
    expect(() =>
      validateConfig({ agentProfiles: { x: { command: '', args: ['{{prompt}}'] } } }),
    ).toThrow(StriartError);
    expect(() => validateConfig({ agentProfiles: { x: { command: 'x', args: [42] } } })).toThrow(
      StriartError,
    );
  });

  it('accepte un profil bien formé', () => {
    expect(() =>
      validateConfig({ agentProfiles: { kimi: { command: 'kimi', args: ['-p', '{{prompt}}'] } } }),
    ).not.toThrow();
  });

  it('accepte les champs enrichis env (chaînes) et timeout (ms ≥ 1000)', () => {
    expect(() =>
      validateConfig({
        agentProfiles: {
          codex: {
            command: 'codex',
            args: ['exec', '{{prompt}}'],
            env: { OPENAI_API_KEY: 'x', MODEL: 'o4' },
            timeout: 1_800_000,
          },
        },
      }),
    ).not.toThrow();
  });

  it('ACP : le marqueur {{prompt}} suit le transport — interdit avec, obligatoire sans', () => {
    // Profil ACP valide : pas de placeholder, le prompt passe par le protocole.
    expect(() =>
      validateConfig({ agentProfiles: { a: { command: 'agent-acp', args: [], acp: true } } }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        agentProfiles: {
          a: { command: 'agent-acp', args: ['--acp'], acp: { permissions: 'reject' } },
        },
      }),
    ).not.toThrow();
    // Placeholder DANS un profil ACP : config recopiée d'un profil argv — refus.
    expect(() =>
      validateConfig({
        agentProfiles: { a: { command: 'agent-acp', args: ['{{prompt}}'], acp: true } },
      }),
    ).toThrow(StriartError);
    // acp mal formé : ni booléen ni { permissions: allow|reject|ask }.
    expect(() =>
      validateConfig({ agentProfiles: { a: { command: 'x', args: [], acp: 'oui' } } }),
    ).toThrow(StriartError);
    expect(() =>
      validateConfig({
        agentProfiles: { a: { command: 'x', args: [], acp: { permissions: 'jamais' } } },
      }),
    ).toThrow(StriartError);
    // 'ask' (semi-autonome, Phase F) est une politique valide, avec ou sans
    // son délai d'arbitrage — qui doit être un entier ≥ 1000 quand il est là.
    expect(() =>
      validateConfig({
        agentProfiles: { a: { command: 'x', args: [], acp: { permissions: 'ask' } } },
      }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        agentProfiles: {
          a: { command: 'x', args: [], acp: { permissions: 'ask', askTimeoutMs: 60_000 } },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        agentProfiles: {
          a: { command: 'x', args: [], acp: { permissions: 'ask', askTimeoutMs: 5 } },
        },
      }),
    ).toThrow(StriartError);
    // acp: false ≡ absent : le placeholder redevient obligatoire.
    expect(() =>
      validateConfig({ agentProfiles: { a: { command: 'x', args: [], acp: false } } }),
    ).toThrow(StriartError);
  });

  it('rejette un env non-chaîne et un timeout invalide', () => {
    const p = (extra) => ({
      agentProfiles: { x: { command: 'x', args: ['{{prompt}}'], ...extra } },
    });
    expect(() => validateConfig(p({ env: { KEY: 42 } }))).toThrow(StriartError);
    expect(() => validateConfig(p({ env: ['KEY=v'] }))).toThrow(StriartError);
    expect(() => validateConfig(p({ timeout: 500 }))).toThrow(StriartError);
    expect(() => validateConfig(p({ timeout: 1.5 }))).toThrow(StriartError);
  });

  it('AJOUTE un profil utilisateur sans effacer les profils par défaut', async () => {
    // La fusion de config est shallow ailleurs : sans traitement dédié,
    // déclarer "kimi" ferait disparaître claude/codex/aider/ollama.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-config-'));
    await writeFile(
      path.join(dir, '.striartrc.json'),
      JSON.stringify({ agentProfiles: { kimi: { command: 'kimi', args: ['-p', '{{prompt}}'] } } }),
    );
    const config = await loadConfig(dir);
    expect(Object.keys(config.agentProfiles).sort()).toEqual([
      'aider',
      'claude',
      'codex',
      'kimi',
      'ollama',
    ]);
    expect(config.agentProfiles.claude).toEqual(DEFAULT_CONFIG.agentProfiles.claude);
  });

  it('permet de redéfinir un profil par défaut', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-config-'));
    await writeFile(
      path.join(dir, '.striartrc.json'),
      JSON.stringify({
        agentProfiles: { claude: { command: 'claude', args: ['--print', '{{prompt}}'] } },
      }),
    );
    const config = await loadConfig(dir);
    expect(config.agentProfiles.claude.args).toEqual(['--print', '{{prompt}}']);
  });
});

describe('prompts surchargeables (Router/Merger)', () => {
  it('accepte null et un template complet', () => {
    expect(() => validateConfig({ prompts: { router: null, merger: null } })).not.toThrow();
    expect(() =>
      validateConfig({
        prompts: {
          router: 'Task {{task}} on {{files}}',
          merger: '{{file}} {{base}} {{ours}} {{theirs}} {{feedback}}',
        },
      }),
    ).not.toThrow();
  });

  it('rejette un template auquel il manque un placeholder', () => {
    // Router sans {{files}} : le LLM ne verrait jamais la liste des fichiers.
    expect(() => validateConfig({ prompts: { router: 'Task {{task}}' } })).toThrow(StriartError);
    // Merger sans {{feedback}} : le retry post-gate referait la même fusion rejetée.
    expect(() =>
      validateConfig({ prompts: { merger: '{{file}} {{base}} {{ours}} {{theirs}}' } }),
    ).toThrow(StriartError);
  });

  it('rejette une clé de prompt inconnue et un template non-string', () => {
    expect(() => validateConfig({ prompts: { image: 'x' } })).toThrow(StriartError);
    expect(() => validateConfig({ prompts: { router: 42 } })).toThrow(StriartError);
    expect(() => validateConfig({ prompts: [] })).toThrow(StriartError);
  });

  it('surcharger un prompt ne fait pas disparaître l’autre (fusion par clé)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-config-'));
    await writeFile(
      path.join(dir, '.striartrc.json'),
      JSON.stringify({ prompts: { router: 'T {{task}} F {{files}}' } }),
    );
    const config = await loadConfig(dir);
    expect(config.prompts.router).toBe('T {{task}} F {{files}}');
    expect(config.prompts.merger).toBeNull();
  });
});
