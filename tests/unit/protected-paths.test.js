import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTECTED_AGENT_PATHS,
  canonicalProtectedPath,
  compileProtectedGlob,
  matchProtectedPath,
  protectedPatternProblem,
  resolveProtectedPathsPolicy,
} from '../../src/protected-paths.ts';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.js';

const policy = (protectedAgentPaths = DEFAULT_CONFIG.protectedAgentPaths, platform = 'linux') =>
  resolveProtectedPathsPolicy({ protectedAgentPaths }, platform);
const isProtected = (p, file) => matchProtectedPath(p, file).protected;

describe('protected-paths — globs ancrés', () => {
  it('`*` ne traverse pas `/`, `**` couvre zéro ou plusieurs segments', () => {
    const re = compileProtectedGlob('**/AGENTS.md', false);
    expect(re.test('AGENTS.md')).toBe(true);
    expect(re.test('pkg/a/AGENTS.md')).toBe(true);
    expect(re.test('pkg/NOTAGENTS.md')).toBe(false);
    expect(compileProtectedGlob('.striartrc.*', false).test('.striartrc.json')).toBe(true);
    expect(compileProtectedGlob('.striartrc.*', false).test('x/.striartrc.json')).toBe(false);
    expect(compileProtectedGlob('a/*.md', false).test('a/b/c.md')).toBe(false);
  });

  it('`x/**` couvre `x` lui-même (fichier, lien, submodule qui remplacerait le dossier)', () => {
    const re = compileProtectedGlob('**/.claude/**', false);
    expect(re.test('.claude')).toBe(true);
    expect(re.test('.claude/settings.json')).toBe(true);
    expect(re.test('apps/web/.claude/hooks/pre.sh')).toBe(true);
    expect(re.test('.claudette/x')).toBe(false);
  });

  it('refuse une syntaxe ambiguë (négation, classes, absolu, `..`, `**` collé)', () => {
    for (const bad of ['', ' a', '!a', '/a', 'a/../b', 'a//b', 'a**', '[ab]', '{a,b}', 'a\\b']) {
      expect(protectedPatternProblem(bad), bad).not.toBeNull();
    }
    expect(protectedPatternProblem('**/x.md')).toBeNull();
  });
});

describe('protected-paths — politique par défaut', () => {
  const p = policy();

  it.each([
    'AGENTS.md',
    'pkg/AGENTS.override.md',
    'CLAUDE.md',
    'docs/CLAUDE.local.md',
    'GEMINI.md',
    'WARP.md',
    '.cursorrules',
    '.clinerules',
    '.clinerules/style.md',
    '.windsurfrules',
    '.github/copilot-instructions.md',
    '.github/instructions/ts.instructions.md',
    '.github/hooks/policy.json',
    '.claude/settings.json',
    '.gemini/settings.json',
    '.codex/config.toml',
    '.cursor/mcp.json',
    '.warp/x',
    '.agents/skills/a/SKILL.md',
    '.mcp.json',
    'apps/web/.mcp.json',
    '.vscode/mcp.json',
    '.vscode/settings.json',
    '.aider.conf.yml',
    '.kilocode/rules/a.md',
    '.junie/guidelines.md',
    '.continue/config.yaml',
    'opencode.json',
    '.striart/conflicts/x/app.js.resolved',
    '.striart-inbox.md',
    'sub/.striart-outbox.json',
    '.striartrc.json',
    'striart.config.mjs',
    '.config/striartrc.yaml',
    '.config/config.json',
  ])('%s est protégé', (file) => {
    expect(isProtected(p, file)).toBe(true);
  });

  it.each([
    'README.md',
    'src/agents.ts',
    'docs/claude-notes.md',
    'package.json',
    '.github/workflows/ci.yml',
  ])('%s ne l’est pas', (file) => {
    expect(isProtected(p, file)).toBe(false);
  });

  it('insensible à la casse par défaut, sur toutes les plateformes', () => {
    expect(isProtected(p, '.Claude/Settings.json')).toBe(true);
    expect(isProtected(p, 'agents.md')).toBe(true);
  });

  it("matchCase 'platform' : sensible sous Linux, insensible sous Windows/macOS — et signalé comme relâchement", () => {
    const linux = policy({ matchCase: 'platform' }, 'linux');
    expect(isProtected(linux, '.Claude/settings.json')).toBe(false);
    expect(linux.relaxed.caseSensitive).toBe(true);
    for (const os of ['win32', 'darwin']) {
      const other = policy({ matchCase: 'platform' }, os);
      expect(isProtected(other, '.Claude/settings.json')).toBe(true);
      expect(other.relaxed.caseSensitive).toBe(false);
    }
  });

  it('neutralise les points/espaces finaux et les flux NTFS (Windows lit CLAUDE.md.)', () => {
    expect(canonicalProtectedPath('CLAUDE.md. ')).toBe('CLAUDE.md');
    expect(canonicalProtectedPath('.claude./settings.json::$DATA')).toBe('.claude/settings.json');
    expect(isProtected(p, 'CLAUDE.md.')).toBe(true);
    expect(isProtected(p, 'AGENTS.md::$DATA')).toBe(true);
  });

  it('chaque motif par défaut est valide et classé', () => {
    for (const rule of DEFAULT_PROTECTED_AGENT_PATHS) {
      expect(protectedPatternProblem(rule.pattern), rule.pattern).toBeNull();
      expect(['instructions', 'agent-config', 'striart-config']).toContain(rule.kind);
    }
  });
});

describe('protected-paths — extend / allow (D12)', () => {
  it('extend ajoute librement, sans relâcher', () => {
    const p = policy({ extend: ['config/agent.yml'] });
    expect(isProtected(p, 'config/agent.yml')).toBe(true);
    expect(p.relaxed.allow).toEqual([]);
    expect(p.counts.extend).toBe(1);
  });

  it('allow est le seul moyen de retirer un défaut, et il est remonté comme relâchement', () => {
    const p = policy({ allow: ['**/AGENTS.md'] });
    const verdict = matchProtectedPath(p, 'pkg/AGENTS.md');
    expect(verdict.protected).toBe(false);
    expect(verdict).toMatchObject({ exemptedBy: '**/AGENTS.md', pattern: '**/AGENTS.md' });
    expect(isProtected(p, 'CLAUDE.md')).toBe(true);
    expect(p.relaxed.allow).toEqual(['**/AGENTS.md']);
  });

  it('une config partielle garde les autres défauts (fusion superficielle de loadConfig)', () => {
    const p = policy({ allow: [] });
    expect(p.matchCase).toBe('insensitive');
    expect(isProtected(p, 'CLAUDE.md')).toBe(true);
  });
});

describe('config — validation de protectedAgentPaths / commitPolicy / commitMessage', () => {
  it('accepte les formes valides', () => {
    expect(() =>
      validateConfig({
        protectedAgentPaths: { extend: ['a/**'], allow: ['**/AGENTS.md'], matchCase: 'platform' },
        commitPolicy: 'agent-then-striart',
        commitMessage: 'chore({{agent}}): {{task}}\n\nTâche {{taskId}} sur {{branch}}',
      }),
    ).not.toThrow();
  });

  it.each([
    [{ protectedAgentPaths: { alow: [] } }, 'protectedAgentPaths'],
    [{ protectedAgentPaths: { extend: ['/abs'] } }, 'protectedAgentPaths'],
    [{ protectedAgentPaths: { allow: ['!x'] } }, 'protectedAgentPaths'],
    [{ protectedAgentPaths: { matchCase: 'never' } }, 'protectedAgentPaths'],
    [{ protectedAgentPaths: ['x'] }, 'protectedAgentPaths'],
    [{ commitPolicy: 'always' }, 'commitPolicy'],
    [{ commitMessage: '{{agnet}} oups' }, 'commitMessage'],
    [{ commitMessage: '   ' }, 'commitMessage'],
  ])('refuse %j (CONFIG_INVALID, clé seule)', (config, key) => {
    let error;
    try {
      validateConfig(config);
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('CONFIG_INVALID');
    expect(error.details).toEqual({ reason: 'INVALID_VALUE', key });
  });

  it('défauts sûrs : commitPolicy agent, aucune exemption', () => {
    expect(DEFAULT_CONFIG.commitPolicy).toBe('agent');
    expect(DEFAULT_CONFIG.protectedAgentPaths).toEqual({
      extend: [],
      allow: [],
      matchCase: 'insensitive',
    });
  });
});

describe('protected-paths — repli Unicode, alias 8.3, nouveaux défauts (S-M7)', () => {
  const win = () => policy(DEFAULT_CONFIG.protectedAgentPaths, 'win32');

  it('le repli Unicode du système de fichiers est reconnu (ſ → s, signe Kelvin → k)', () => {
    const p = win();
    expect(isProtected(p, 'AGENT\u017f.md')).toBe(true); // AGENTſ.md
    expect(isProtected(p, 'pkg/AGENT\u017f.md')).toBe(true);
    expect(isProtected(p, 'aider.\u212a')).toBe(false); // un faux ami n'est pas protégé à tort
    expect(isProtected(p, '.mcp.json'.replace('m', 'M'))).toBe(true);
  });

  it('un nom réellement distinct sous une politique sensible à la casse n est pas replié', () => {
    const p = policy({ matchCase: 'platform' }, 'linux');
    expect(isProtected(p, 'AGENT\u017f.md')).toBe(false);
  });

  it('un alias 8.3 (CLAUDE~1.MD) est traité comme protégé, allow le débloque', () => {
    const p = policy();
    expect(isProtected(p, 'CLAUDE~1.MD')).toBe(true);
    expect(isProtected(p, 'dir/PROGRA~2/x.txt')).toBe(true);
    expect(isProtected(p, 'src/notes~final.txt')).toBe(false);
    const allowed = policy({ allow: ['CLAUDE~1.MD'] });
    expect(isProtected(allowed, 'CLAUDE~1.MD')).toBe(false);
  });

  it.each([
    '.vscode/tasks.json',
    '.devcontainer/devcontainer.json',
    'pkg/.devcontainer/Dockerfile',
    '.husky/pre-commit',
    '.githooks/pre-push',
    '.envrc',
    '.pre-commit-config.yaml',
    'lefthook.yml',
    '.lefthook.yml',
  ])('%s est protégé par défaut', (file) => {
    expect(isProtected(policy(), file)).toBe(true);
  });
});
