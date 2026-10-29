import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent, readRegistry } from '../../src/clone.ts';
import { syncAgentWithMain } from '../../src/sync.ts';
import { getPreset, materializePreset } from '../../src/agents/catalog.ts';
import { runAgentSession, sessionRawLogPath } from '../../src/session.ts';
import { loadConfig } from '../../src/config.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('../helpers/fake-claude.cjs', import.meta.url));
const exists = async (p) => Boolean(await stat(p).catch(() => null));
const porcelain = async (dir) =>
  (await simpleGit(dir).raw(['status', '--porcelain', '-uall'])).trim();

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

describe('consignes Striart — mode supervisé (fichier non suivi dans le clone)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('Claude : .claude/rules/striart.md + exclusion des CLAUDE.md du principal, statut git propre', async () => {
    await setConfig(repo.root, { testCommand: 'npm run check', agentCommand: 'claude' });
    const info = await createAgent({ root: repo.root, name: 'agent-a', command: null });

    const rules = await readFile(path.join(info.path, '.claude', 'rules', 'striart.md'), 'utf8');
    expect(rules).toContain('Striart session rules');
    expect(rules).toContain('agent-a');
    expect(rules).toContain('`npm run check`'); // commande du Test Gate
    expect(rules).toContain(info.branch);
    expect(rules).toMatch(/Never push/);
    expect(rules).toMatch(/AGENTS\.md/); // chemins protégés cités

    // Claude concatène les CLAUDE.md des PARENTS : ceux du worktree principal
    // (<repo>/CLAUDE.md…) sont exclus par une ignore locale au clone.
    const local = JSON.parse(
      await readFile(path.join(info.path, '.claude', 'settings.local.json'), 'utf8'),
    );
    const rootPosix = repo.root.split(path.sep).join('/');
    expect(local.claudeMdExcludes).toContain(`${rootPosix}/CLAUDE.md`);
    expect(local.claudeMdExcludes).toContain(`${rootPosix}/.claude/rules/**`);

    // Fichiers injectés : NON suivis et ignorés localement → statut propre.
    expect(await porcelain(info.path)).toBe('');
    const exclude = await readFile(path.join(info.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.claude/rules/striart.md');
    expect(exclude).toContain('/.claude/settings.local.json');
  });

  it('D11 : AGENTS.md racine suivi → AGENTS.override.md composite (Codex), régénéré au rebase', async () => {
    await writeFile(path.join(repo.root, 'AGENTS.md'), '# Conventions du dépôt\nv1\n');
    await repo.git.add(['AGENTS.md']);
    await repo.git.commit('docs: agents');
    await setConfig(repo.root, { agentCommand: 'codex' });

    const info = await createAgent({ root: repo.root, name: 'agent-b' });
    // L'AGENTS.md suivi n'est jamais touché.
    // (core.autocrlf peut convertir les fins de ligne au checkout Windows.)
    const tracked = await readFile(path.join(info.path, 'AGENTS.md'), 'utf8');
    expect(tracked.replaceAll('\r\n', '\n')).toBe('# Conventions du dépôt\nv1\n');
    const composite = await readFile(path.join(info.path, 'AGENTS.override.md'), 'utf8');
    expect(composite).toContain('# Conventions du dépôt\nv1');
    expect(composite).toContain('Striart session rules');
    expect(await porcelain(info.path)).toBe('');

    // Le principal fait évoluer AGENTS.md : le rebase régénère le composite.
    await writeFile(path.join(repo.root, 'AGENTS.md'), '# Conventions du dépôt\nv2\n');
    await repo.git.add(['AGENTS.md']);
    await repo.git.commit('docs: agents v2');
    const sync = await syncAgentWithMain({ root: repo.root, agent: 'agent-b' });
    expect(sync.status).toBe('REBASED');
    const regenerated = await readFile(path.join(info.path, 'AGENTS.override.md'), 'utf8');
    expect(regenerated).toContain('v2');
    expect(regenerated).not.toContain('v1');
    expect(await porcelain(info.path)).toBe('');
  });

  it("D11 paramétrable : agentsMd 'non-file' → rien à côté d'AGENTS.md", async () => {
    await writeFile(path.join(repo.root, 'AGENTS.md'), '# repo\n');
    await repo.git.add(['AGENTS.md']);
    await repo.git.commit('docs: agents');
    await setConfig(repo.root, {
      agentCommand: 'codex',
      agentInstructions: { agentsMd: 'non-file' },
    });
    const info = await createAgent({ root: repo.root, name: 'agent-c' });
    expect(await exists(path.join(info.path, 'AGENTS.override.md'))).toBe(false);
    expect(await porcelain(info.path)).toBe('');
  });

  it('outil absent du catalogue : canal générique (AGENTS.md) ; désactivation : aucun fichier', async () => {
    await setConfig(repo.root, { agentCommand: 'mon-outil-maison' });
    const a = await createAgent({ root: repo.root, name: 'agent-d' });
    expect(await readFile(path.join(a.path, 'AGENTS.md'), 'utf8')).toContain(
      'Striart session rules',
    );
    expect(await porcelain(a.path)).toBe('');

    await setConfig(repo.root, { agentCommand: 'claude', agentInstructions: { enabled: false } });
    const b = await createAgent({ root: repo.root, name: 'agent-e' });
    expect(await exists(path.join(b.path, '.claude', 'rules', 'striart.md'))).toBe(false);
  });

  it("n'écrase jamais un fichier existant qui n'est pas à Striart", async () => {
    await setConfig(repo.root, { agentCommand: 'claude' });
    const info = await createAgent({ root: repo.root, name: 'agent-f' });
    const target = path.join(info.path, '.claude', 'rules', 'striart.md');
    await writeFile(target, 'contenu humain\n');
    // Régénération (comme après un rebase) : le fichier modifié n'est plus le nôtre.
    const { syncAgentInstructionsToClone } = await import('../../src/agents/instructions.ts');
    const result = await syncAgentInstructionsToClone({
      root: repo.root,
      agent: 'agent-f',
      clonePath: info.path,
    });
    expect(await readFile(target, 'utf8')).toBe('contenu humain\n');
    expect(result.warnings.join('\n')).toMatch(/not Striart's/);
  });

  it('mode autonome : aucun fichier de consignes dans le clone (canal du profil)', async () => {
    await setConfig(repo.root, {});
    const info = await createAgent({
      root: repo.root,
      name: 'agent-g',
      mode: 'autonomous',
      command: 'claude',
    });
    expect(await exists(path.join(info.path, '.claude'))).toBe(false);
    expect((await readRegistry(repo.root))['agent-g'].mode).toBe('autonomous');
  });
});

describe('preset Claude Code corrigé — faux agent qui exige les drapeaux', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const session = async (profile) => {
    const info = await createAgent({ root: repo.root, name: 'agent-a', mode: 'autonomous' });
    const config = await loadConfig(repo.root);
    const result = await runAgentSession({
      root: repo.root,
      agent: 'agent-a',
      taskId: info.taskId,
      cwd: info.path,
      profile,
      prompt: 'ajoute une feature',
      config,
      profileKey: 'claude',
    });
    return { info, result };
  };

  it('témoin : l’ancien profil `-p {{prompt}}` échoue (mode Manual)', async () => {
    const { result } = await session({
      command: process.execPath,
      args: [FAKE_CLAUDE, '-p', '{{prompt}}'],
    });
    expect(result.status).toBe('FAILED');
    expect(await readFile(result.logPath, 'utf8')).toMatch(/permission denied/);
  });

  it('preset : édite, commite, reçoit les consignes HORS du clone, log transcrit', async () => {
    const preset = materializePreset(getPreset('claude-code'));
    const { info, result } = await session({
      ...preset,
      command: process.execPath,
      args: [FAKE_CLAUDE, ...preset.args],
    });
    expect(result.status).toBe('COMPLETED');
    expect(await simpleGit(info.path).raw(['log', '-1', '--format=%s'])).toMatch(/feat: fake/);

    // Log lisible (stream-json transcrit) + flux brut conservé à part.
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('[session] démarrée — modèle fake-claude');
    expect(log).toContain('[résultat] success');
    const raw = await readFile(sessionRawLogPath(repo.root, 'agent-a', info.taskId), 'utf8');
    expect(raw).toContain('"type":"result"');
  });
});
