import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_INSTRUCTIONS_TEMPLATE,
  buildAgentInstructions,
  instructionFileBody,
  parentInstructionExcludes,
  planArgvInstructions,
  renderInstructions,
  resolveInstructionsChannel,
  wrapPrompt,
} from '../../src/agents/instructions.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';

// Racine inexistante : le registre est absent (branche générique), rien n'est écrit.
const ROOT = path.join(path.parse(process.cwd()).root, 'striart-nonexistent-root');
const build = (profile, extra = {}, mode = 'autonomous') =>
  buildAgentInstructions({
    root: ROOT,
    agent: 'agent-a',
    profileKey: 'claude',
    profile,
    config: { ...DEFAULT_CONFIG, ...extra },
    mode,
  });

describe('consignes — texte (gabarit complet D15)', () => {
  it('cite le clone, le contrat de commit, push interdit, Test Gate, chemins protégés, MCP', async () => {
    const text = await build(DEFAULT_CONFIG.agentProfiles.claude, { testCommand: 'pnpm test' });
    expect(text).toContain('Striart session rules');
    expect(text).toContain('"agent-a"');
    expect(text).toContain('Stay inside this clone');
    expect(text).toContain('Never push');
    expect(text).toContain('`pnpm test`');
    expect(text).toMatch(/Commit message convention: Conventional Commits/);
    expect(text).toContain('`.claude/`'); // liste effective de la garde I2
    expect(text).toContain('striart_run'); // bornes des outils MCP
    expect(text).toContain('refused by design'); // autonome : outils mutants refusés
  });

  it('règle de commit propre à chaque contrat ; supervisé = toujours « agent »', async () => {
    const p = (commitPolicy) => ({ command: 'x', args: ['{{prompt}}'], commitPolicy });
    expect(await build(p('human'))).toContain('Do NOT commit');
    expect(await build(p('striart'))).toContain('Striart commits the working tree');
    expect(await build(p('agent-then-striart'))).toMatch(/If you do not commit, Striart commits/);
    expect(await build(p('human'), {}, 'attended')).toContain('Commit your work yourself');
  });

  it('null quand désactivé (global ou par profil) ; gabarit et ajouts surchargeables', async () => {
    const p = { command: 'x', args: ['{{prompt}}'] };
    expect(await build(p, { agentInstructions: { enabled: false } })).toBeNull();
    expect(await build({ ...p, instructions: { channel: 'none' } })).toBeNull();
    const custom = await build(
      { ...p, instructions: { append: 'Profil : utilise pnpm.' } },
      {
        agentInstructions: {
          template: 'Agent {{agent}} → {{testCommand}}{{extra}}',
          append: 'Global.',
        },
      },
    );
    expect(custom).toBe('Agent agent-a → npm test\nGlobal.\n\nProfil : utilise pnpm.\n');
  });

  it('renderInstructions : substitution littérale, aucun placeholder résiduel', () => {
    const text = renderInstructions(DEFAULT_INSTRUCTIONS_TEMPLATE, {});
    expect(text).not.toMatch(/\{\{[^}]+\}\}/);
  });
});

describe('consignes — canaux', () => {
  it('canal effectif : auto → ACP / fichier système / prompt ; explicite prioritaire', () => {
    expect(resolveInstructionsChannel({ command: 'x', args: [], acp: true })).toBe('acp-prompt');
    expect(
      resolveInstructionsChannel({ command: 'x', args: [], instructions: { flag: '--rules' } }),
    ).toBe('system-prompt-file');
    expect(resolveInstructionsChannel({ command: 'x', args: [] })).toBe('prompt');
    expect(
      resolveInstructionsChannel({ command: 'x', args: [], instructions: { channel: 'none' } }),
    ).toBe('none');
  });

  it("canal 'prompt' : emplacement d'argv s'il existe, sinon enveloppe du prompt", async () => {
    const slot = await planArgvInstructions({
      root: ROOT,
      agent: 'a',
      taskId: 't',
      instructions: 'RÈGLES',
      profile: {
        command: 'goose',
        args: ['--system', '{{striartInstructions}}', '-t', '{{prompt}}'],
      },
      prompt: 'tâche',
    });
    expect(slot).toMatchObject({
      channel: 'prompt',
      prompt: 'tâche',
      slots: { instructions: 'RÈGLES' },
    });
    const wrapped = await planArgvInstructions({
      root: ROOT,
      agent: 'a',
      taskId: 't',
      instructions: 'RÈGLES',
      profile: { command: 'amp', args: ['-x', '{{prompt}}'] },
      prompt: 'tâche',
    });
    expect(wrapped.prompt).toBe(wrapPrompt('RÈGLES', 'tâche'));
    expect(wrapped.prompt.indexOf('RÈGLES')).toBeLessThan(wrapped.prompt.indexOf('tâche'));
  });

  it("encodage 'toml-string' (Codex -c developer_instructions=…) : chaîne TOML entre guillemets", async () => {
    const plan = await planArgvInstructions({
      root: ROOT,
      agent: 'a',
      taskId: 't',
      instructions: 'ligne "1"\nligne 2',
      profile: DEFAULT_CONFIG.agentProfiles.codex,
      prompt: 'p',
    });
    expect(plan.slots.instructions).toBe('"ligne \\"1\\"\\nligne 2"');
  });

  it('acp-prompt sur un profil argv : erreur explicite', async () => {
    await expect(
      planArgvInstructions({
        root: ROOT,
        agent: 'a',
        taskId: 't',
        instructions: 'x',
        profile: { command: 'x', args: ['{{prompt}}'], instructions: { channel: 'acp-prompt' } },
        prompt: 'p',
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
  });
});

describe('consignes — fichiers du mode supervisé', () => {
  it('format par outil : en-tête YAML en tête pour Cursor (.mdc) et Copilot (.instructions.md)', () => {
    expect(instructionFileBody('.cursor/rules/striart.mdc', 'T').startsWith('---\n')).toBe(true);
    expect(instructionFileBody('.cursor/rules/striart.mdc', 'T')).toContain('alwaysApply: true');
    expect(instructionFileBody('.github/instructions/striart.instructions.md', 'T')).toMatch(
      /^---\napplyTo: "\*\*"\n---/,
    );
    expect(instructionFileBody('AGENTS.md', 'T')).toMatch(/^<!-- Generated by Striart/);
  });

  it('claudeMdExcludes : du parent du clone jusqu’à la racine du dépôt, pas au-delà', () => {
    const root = path.resolve('/work/repo');
    const clone = path.join(root, '.striart', 'agents', 'agent-a');
    const excludes = parentInstructionExcludes(root, clone);
    const posix = (p) => p.split(path.sep).join('/');
    expect(excludes).toContain(`${posix(root)}/CLAUDE.md`);
    expect(excludes).toContain(`${posix(path.join(root, '.striart', 'agents'))}/CLAUDE.md`);
    expect(excludes.some((e) => e.startsWith(`${posix(path.resolve('/work'))}/CLAUDE`))).toBe(
      false,
    );
    // Le clone lui-même garde son CLAUDE.md.
    expect(excludes).not.toContain(`${posix(clone)}/CLAUDE.md`);
  });
});
