import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { runHook } from '../../src/hooks/run.ts';
import { installHooks, uninstallHooks } from '../../src/hooks/install.ts';
import { en } from '../../src/cli/i18n/en.ts';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const platform = process.platform;

let repo;
let root;
let clone;
let otherClone;

async function writeRegistry(extra = {}) {
  const registry = {
    'agent-a': {
      branch: 'striart/agent-a/task-1',
      taskId: '1',
      path: clone,
      baseCommit: 'x',
      prompt: null,
      predictedFiles: ['src/mine.ts'],
      command: null,
      createdAt: new Date().toISOString(),
      mode: 'attended',
    },
    'agent-b': {
      branch: 'striart/agent-b/task-2',
      taskId: '2',
      path: otherClone,
      baseCommit: 'x',
      prompt: null,
      predictedFiles: ['src/shared.ts', 'src/mine.ts'],
      command: null,
      createdAt: new Date().toISOString(),
      mode: 'attended',
    },
    ...extra,
  };
  await writeFile(path.join(root, '.striart', 'agents.json'), JSON.stringify(registry));
  await writeFile(
    path.join(root, '.striart', 'locks.json'),
    JSON.stringify({
      'src/mine.ts': 'agent-a',
      'src/shared.ts': 'agent-b',
      'src/locked.ts': 'agent-c',
    }),
  );
}

const input = (value) =>
  Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);
const messages = en.hook;

beforeEach(async () => {
  repo = await createTempRepo();
  root = repo.root;
  clone = path.join(root, '.striart', 'agents', 'agent-a');
  otherClone = path.join(root, '.striart', 'agents', 'agent-b');
  await mkdir(clone, { recursive: true });
  await mkdir(otherClone, { recursive: true });
  await writeRegistry();
});

afterEach(async () => {
  await repo.cleanup();
});

describe('runHook — advisory : collision signalée, jamais bloquante', () => {
  it('Claude PreToolUse sur un fichier prédit par un autre agent → additionalContext', async () => {
    const result = await runHook({
      tool: 'claude',
      event: 'PreToolUse',
      stdin: input({
        hook_event_name: 'PreToolUse',
        cwd: clone,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(clone, 'src', 'shared.ts') },
      }),
      messages,
    });
    const out = JSON.parse(result.output);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('src/shared.ts');
    expect(out.hookSpecificOutput.additionalContext).toContain('agent-b');
    expect(JSON.stringify(out)).not.toMatch(/permissionDecision/);
  });

  it('verrou de locks.json tenu par un agent absent du registre → signalé aussi', async () => {
    const result = await runHook({
      tool: 'cline',
      event: 'PreToolUse',
      stdin: input({
        hookName: 'PreToolUse',
        workspaceRoots: [clone],
        preToolUse: { tool: 'write_to_file', parameters: { path: 'src/locked.ts' } },
      }),
      messages,
    });
    const out = JSON.parse(result.output);
    expect(out.cancel).toBe(false);
    expect(out.contextModification).toContain('agent-c');
  });

  it('fichier prédit par l’agent lui-même ET par un autre → l’autre est signalé, pas lui', async () => {
    const result = await runHook({
      tool: 'claude',
      event: 'PreToolUse',
      stdin: input({
        cwd: clone,
        tool_name: 'Write',
        tool_input: { file_path: path.join(clone, 'src/mine.ts') },
      }),
      messages,
    });
    const text = JSON.parse(result.output).systemMessage;
    expect(text).toContain('agent-b');
    expect(text).not.toMatch(/agent-a\b/);
  });

  it('aucune collision → sortie neutre', async () => {
    const result = await runHook({
      tool: 'claude',
      event: 'PreToolUse',
      stdin: input({
        cwd: clone,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(clone, 'free.ts') },
      }),
      messages,
    });
    expect(result.output).toBe('');
  });

  it.each([
    ['JSON invalide', '{nope'],
    ['tableau', '[]'],
  ])('%s → sortie neutre au format de l’outil', async (_l, raw) => {
    for (const [tool, event, neutral] of [
      ['claude', 'PreToolUse', ''],
      ['gemini', 'BeforeTool', '{}'],
      ['cline', 'PreToolUse', '{"cancel":false}'],
      ['copilot', 'postToolUse', ''],
    ]) {
      const result = await runHook({ tool, event, stdin: input(raw), messages });
      expect(result.output).toBe(neutral);
    }
  });

  it('événement trop long → sortie neutre (lecture bornée)', async () => {
    const huge = Readable.from(
      (function* () {
        for (let i = 0; i < 9; i += 1) yield Buffer.alloc(1024 * 1024, 0x20);
      })(),
    );
    const result = await runHook({ tool: 'gemini', event: 'BeforeTool', stdin: huge, messages });
    expect(result.output).toBe('{}');
    expect(result.warnings.join(' ')).toMatch(/too large|trop/i);
  });

  it('outil ou événement inconnu → sortie neutre, jamais d’exception', async () => {
    expect((await runHook({ tool: 'vim', event: 'x', stdin: input({}), messages })).output).toBe(
      '',
    );
    expect(
      (await runHook({ tool: 'claude', event: 'Nope', stdin: input({}), messages })).output,
    ).toBe('');
  });

  it('hors d’un clone Striart (projet quelconque, install utilisateur) → neutre', async () => {
    const result = await runHook({
      tool: 'claude',
      event: 'PreToolUse',
      stdin: input({
        cwd: os.tmpdir(),
        tool_name: 'Edit',
        tool_input: { file_path: path.join(os.tmpdir(), 'src/shared.ts') },
      }),
      messages,
    });
    expect(result.output).toBe('');
  });

  it('clone dont le chemin ne correspond pas au registre (registre forgé) → neutre', async () => {
    await writeRegistry({ 'agent-a': { path: path.join(root, 'ailleurs'), predictedFiles: [] } });
    const result = await runHook({
      tool: 'claude',
      event: 'PreToolUse',
      stdin: input({
        cwd: clone,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(clone, 'src/shared.ts') },
      }),
      messages,
    });
    expect(result.output).toBe('');
  });

  it('registre corrompu → neutre + avertissement', async () => {
    await writeFile(path.join(root, '.striart', 'agents.json'), '{corrupt');
    const result = await runHook({
      tool: 'claude',
      event: 'PreToolUse',
      stdin: input({
        cwd: clone,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(clone, 'src/shared.ts') },
      }),
      messages,
    });
    expect(result.output).toBe('');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('hooks.collisions: false (config données) → plus aucun signalement', async () => {
    await writeFile(
      path.join(root, '.striartrc.json'),
      JSON.stringify({ hooks: { collisions: false } }),
    );
    const result = await runHook({
      tool: 'claude',
      event: 'PreToolUse',
      stdin: input({
        cwd: clone,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(clone, 'src/shared.ts') },
      }),
      messages,
    });
    expect(result.output).toBe('');
  });
});

describe('runHook — fin de session supervisée notifiée', () => {
  let server;
  let received;
  let url;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end('ok');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/hook`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('SessionEnd Claude → webhook « session ended » (config données)', async () => {
    await writeFile(
      path.join(root, '.striartrc.json'),
      JSON.stringify({ notifiers: [{ type: 'generic', url }] }),
    );
    const result = await runHook({
      tool: 'claude',
      event: 'SessionEnd',
      stdin: input({ hook_event_name: 'SessionEnd', cwd: clone, reason: 'prompt_input_exit' }),
      messages,
    });
    expect(result.output).toBe('');
    expect(received).toHaveLength(1);
    expect(received[0].message).toContain('agent-a');
  });

  it('agent autonome → aucune notification (sa fin de cycle appartient à l’orchestrateur)', async () => {
    await writeFile(
      path.join(root, '.striartrc.json'),
      JSON.stringify({ notifiers: [{ type: 'generic', url }] }),
    );
    const registry = JSON.parse(await readFile(path.join(root, '.striart', 'agents.json'), 'utf8'));
    registry['agent-a'].mode = 'autonomous';
    await writeFile(path.join(root, '.striart', 'agents.json'), JSON.stringify(registry));
    await runHook({
      tool: 'cline',
      event: 'TaskComplete',
      stdin: input({ workspaceRoots: [clone], taskComplete: {} }),
      messages,
    });
    expect(received).toHaveLength(0);
  });

  it('config exécutable sans --root de confiance → JAMAIS exécutée (notification sautée, avertie)', async () => {
    const marker = path.join(root, 'executed.txt');
    await writeFile(
      path.join(root, 'striart.config.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); export default { notifiers: [{ type: 'generic', url: ${JSON.stringify(url)} }] };`,
    );
    const result = await runHook({
      tool: 'claude',
      event: 'SessionEnd',
      stdin: input({ cwd: clone, reason: 'other' }),
      messages,
    });
    await expect(stat(marker)).rejects.toThrow();
    expect(received).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/executable|exécutable/i);
  });

  it('config exécutable AVEC --root de confiance (install dans le clone) → chargée', async () => {
    await writeFile(
      path.join(root, 'striart.config.mjs'),
      `export default { notifiers: [{ type: 'generic', url: ${JSON.stringify(url)} }] };`,
    );
    await runHook({
      tool: 'claude',
      event: 'SessionEnd',
      stdin: input({ cwd: clone, reason: 'other' }),
      trustedRoot: root,
      messages,
    });
    expect(received).toHaveLength(1);
  });

  it('hooks.notifySessionEnd: false → silence', async () => {
    await writeFile(
      path.join(root, '.striartrc.json'),
      JSON.stringify({ notifiers: [{ type: 'generic', url }], hooks: { notifySessionEnd: false } }),
    );
    await runHook({ tool: 'claude', event: 'SessionEnd', stdin: input({ cwd: clone }), messages });
    expect(received).toHaveLength(0);
  });

  describe('racines de confiance (hooks.trustedRoots de la config UTILISATEUR)', () => {
    let configHome;
    const env = () => ({ STRIART_CONFIG_HOME: configHome });
    const codeConfig = () =>
      writeFile(
        path.join(root, 'striart.config.mjs'),
        `export default { notifiers: [{ type: 'generic', url: ${JSON.stringify(url)} }] };`,
      );
    const userConfig = (value) =>
      writeFile(
        path.join(configHome, 'config.json'),
        typeof value === 'string' ? value : JSON.stringify(value),
        { mode: 0o600 },
      );
    const sessionEnd = () =>
      runHook({
        tool: 'claude',
        event: 'SessionEnd',
        stdin: input({ cwd: clone, reason: 'other' }),
        messages,
        env: env(),
      });

    beforeEach(async () => {
      configHome = path.join(root, '..', `${path.basename(root)}-cfg`);
      await mkdir(configHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(configHome, { recursive: true, force: true });
    });

    it('racine listée (casse et séparateur final différents sous Windows/macOS) → config code chargée', async () => {
      await codeConfig();
      const listed =
        platform === 'win32' || platform === 'darwin' ? `${root.toUpperCase()}${path.sep}` : root;
      await userConfig({ hooks: { trustedRoots: [listed] } });
      const result = await sessionEnd();
      expect(received).toHaveLength(1);
      expect(result.trustedBy).toBe('user-config');
    });

    it('racine non listée → config code jamais exécutée', async () => {
      await codeConfig();
      await userConfig({ hooks: { trustedRoots: [path.join(root, 'autre')] } });
      const result = await sessionEnd();
      expect(received).toHaveLength(0);
      expect(result.warnings.join(' ')).toMatch(/executable|exécutable/i);
    });

    it('config utilisateur invalide → aucune confiance (fail closed), avertie', async () => {
      await codeConfig();
      await userConfig('{ "hooks": { "trustedRoots": "' + root.replace(/\\/g, '\\\\') + '" } }');
      const result = await sessionEnd();
      expect(received).toHaveLength(0);
      expect(result.warnings.join(' ')).toMatch(/config/i);
    });

    it.runIf(platform !== 'win32')(
      'config utilisateur modifiable par le groupe ou les autres → refusée (fail closed)',
      async () => {
        await codeConfig();
        await userConfig({ hooks: { trustedRoots: [root] } });
        const { chmod } = await import('node:fs/promises');
        await chmod(path.join(configHome, 'config.json'), 0o666);
        const result = await sessionEnd();
        expect(received).toHaveLength(0);
        expect(result.warnings.join(' ')).toMatch(/writable|modifiable/i);
      },
    );
  });
});

describe('striart hook (CLI) — code de sortie toujours 0', () => {
  const run = (args, stdinText) =>
    execa(process.execPath, [CLI, 'hook', ...args], {
      cwd: clone,
      input: stdinText,
      reject: false,
      env: { STRIART_LANG: 'en' },
    });

  it('collision → JSON Claude sur stdout, sortie 0', async () => {
    const r = await run(
      ['claude', 'PreToolUse'],
      JSON.stringify({
        cwd: clone,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(clone, 'src/shared.ts') },
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('agent-b');
  });

  it('JSON invalide, outil inconnu, option inconnue, argument manquant → sortie 0 (jamais un blocage)', async () => {
    for (const args of [
      ['claude', 'PreToolUse'],
      ['vim', 'x'],
      ['claude', 'PreToolUse', '--future-flag'],
      ['claude'],
    ]) {
      const r = await run(args, '{nope');
      expect(r.exitCode, args.join(' ')).toBe(0);
    }
    const g = await run(['gemini', 'BeforeTool'], '{nope');
    expect(g.stdout).toBe('{}');
  });
});

describe('striart hook install / uninstall', () => {
  let home;
  const env = () => ({
    ...(platform === 'win32' ? { LOCALAPPDATA: path.join(home, 'Local') } : {}),
  });
  const base = () => ({
    home,
    env: env(),
    platform,
    nodePath: process.execPath,
    cliPath: CLI,
  });

  beforeEach(async () => {
    home = path.join(root, '..', `${path.basename(root)}-home`);
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('Claude, utilisateur : réglages existants préservés, idempotent, désinstallation ciblée', async () => {
    const file = path.join(home, '.claude', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    const mine = { type: 'command', command: 'echo', args: ['mine'] };
    await writeFile(
      file,
      JSON.stringify({
        theme: 'dark',
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] },
      }),
    );
    await installHooks({ ...base(), tool: 'claude', scope: 'user' });
    await installHooks({ ...base(), tool: 'claude', scope: 'user' });
    const after = JSON.parse(await readFile(file, 'utf8'));
    expect(after.theme).toBe('dark');
    const pre = after.hooks.PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0].hooks[0]).toEqual(mine);
    const ours = pre[1].hooks[0];
    // Forme exec (args) : aucun shell entre Claude Code et Striart.
    expect(ours.command).toBe(process.execPath);
    expect(ours.args.slice(1)).toEqual(['hook', 'claude', 'PreToolUse']);
    expect(after.hooks.SessionEnd).toHaveLength(1);
    await uninstallHooks({ ...base(), tool: 'claude', scope: 'user' });
    const removed = JSON.parse(await readFile(file, 'utf8'));
    expect(removed).toEqual({
      theme: 'dark',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] },
    });
  });

  it('réglages utilisateur illisibles → refus, fichier intact (jamais écrasé)', async () => {
    const file = path.join(home, '.claude', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ invalid json');
    await expect(installHooks({ ...base(), tool: 'claude', scope: 'user' })).rejects.toMatchObject({
      code: 'HOOK_CONFIG_UNREADABLE',
    });
    expect(await readFile(file, 'utf8')).toBe('{ invalid json');
  });

  it('--dry-run : rien n’est écrit', async () => {
    const changes = await installHooks({ ...base(), tool: 'gemini', scope: 'user', dryRun: true });
    expect(changes.length).toBeGreaterThan(0);
    await expect(stat(path.join(home, '.gemini', 'settings.json'))).rejects.toThrow();
  });

  it('dans le clone : fichier non suivi, exclu localement (git status propre), --root de confiance', async () => {
    await rm(clone, { recursive: true, force: true });
    await simpleGit(root).clone(root, clone);
    const changes = await installHooks({
      ...base(),
      tool: 'claude',
      scope: 'clone',
      root,
      agent: 'agent-a',
      clonePath: clone,
    });
    const file = path.join(clone, '.claude', 'settings.local.json');
    expect(changes.map((c) => c.path)).toContain(file);
    const settings = JSON.parse(await readFile(file, 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].args).toEqual([
      CLI,
      'hook',
      'claude',
      'PreToolUse',
      '--root',
      root,
    ]);
    const status = await simpleGit(clone).status();
    expect(status.isClean()).toBe(true);
    await uninstallHooks({
      ...base(),
      tool: 'claude',
      scope: 'clone',
      root,
      agent: 'agent-a',
      clonePath: clone,
    });
    await expect(stat(file)).rejects.toThrow();
    expect(await readFile(path.join(clone, '.git', 'info', 'exclude'), 'utf8')).not.toContain(
      'settings.local.json',
    );
  });

  it('dans le clone : cible VERSIONNÉE par le dépôt → refus (la garde des chemins protégés refuserait le merge)', async () => {
    await mkdir(path.join(root, '.github', 'hooks'), { recursive: true });
    await writeFile(path.join(root, '.github', 'hooks', 'striart.json'), '{}');
    await repo.git.add('.');
    await repo.git.commit('hooks versionnés');
    await rm(clone, { recursive: true, force: true });
    await simpleGit(root).clone(root, clone);
    await expect(
      installHooks({
        ...base(),
        tool: 'copilot',
        scope: 'clone',
        root,
        agent: 'agent-a',
        clonePath: clone,
      }),
    ).rejects.toMatchObject({ code: 'HOOK_TARGET_TRACKED' });
  });

  it('Copilot : fichier dédié en forme exec (pas de shell), pas de preToolUse (sa seule sortie serait une décision)', async () => {
    await installHooks({ ...base(), tool: 'copilot', scope: 'user' });
    const file = path.join(home, '.copilot', 'hooks', 'striart.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    expect(config.version).toBe(1);
    expect(config.hooks.preToolUse).toBeUndefined();
    expect(config.hooks.postToolUse[0]).toMatchObject({ type: 'command', exec: process.execPath });
    expect(config.hooks.postToolUse[0].args.slice(1)).toEqual(['hook', 'copilot', 'postToolUse']);
    await uninstallHooks({ ...base(), tool: 'copilot', scope: 'user' });
    await expect(stat(file)).rejects.toThrow();
  });

  it('Copilot : striart.json étranger → refus', async () => {
    const file = path.join(home, '.copilot', 'hooks', 'striart.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, hooks: { sessionEnd: [{ type: 'command', bash: 'echo hi' }] } }),
    );
    await expect(installHooks({ ...base(), tool: 'copilot', scope: 'user' })).rejects.toMatchObject(
      {
        code: 'HOOK_TARGET_FOREIGN',
      },
    );
  });

  it('Cline : scripts nommés d’après l’événement ; script étranger → refus', async () => {
    const dir = path.join(home, 'Documents', 'Cline', 'Hooks');
    await installHooks({ ...base(), tool: 'cline', scope: 'user' });
    const name = platform === 'win32' ? 'PreToolUse.ps1' : 'PreToolUse';
    const script = await readFile(path.join(dir, name), 'utf8');
    expect(script).toContain('striart-hook');
    if (platform !== 'win32') expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o700);
    await writeFile(
      path.join(dir, platform === 'win32' ? 'TaskCancel.ps1' : 'TaskCancel'),
      'echo mine',
    );
    await expect(installHooks({ ...base(), tool: 'cline', scope: 'user' })).rejects.toMatchObject({
      code: 'HOOK_TARGET_FOREIGN',
    });
  });

  it('Codex / Gemini (chaîne de commande) : la commande générée s’exécute réellement et rend la collision', async () => {
    for (const tool of ['codex', 'gemini']) {
      await installHooks({ ...base(), tool, scope: 'user' });
      const file =
        tool === 'codex'
          ? path.join(home, '.codex', 'hooks.json')
          : path.join(home, '.gemini', 'settings.json');
      const config = JSON.parse(await readFile(file, 'utf8'));
      const event = tool === 'codex' ? 'PreToolUse' : 'BeforeTool';
      const handler = config.hooks[event][0].hooks[0];
      const command =
        platform === 'win32' && tool === 'codex' ? handler.commandWindows : handler.command;
      const payload = JSON.stringify({
        cwd: clone,
        tool_name: tool === 'codex' ? 'Write' : 'write_file',
        tool_input: { file_path: path.join(clone, 'src', 'shared.ts') },
      });
      const shells =
        platform === 'win32'
          ? [
              ['cmd.exe', ['/d', '/s', '/c', command]],
              ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]],
            ]
          : [['sh', ['-c', command]]];
      for (const [shell, args] of shells) {
        const r = await execa(shell, args, {
          cwd: clone,
          input: payload,
          reject: false,
          env: { STRIART_LANG: 'en' },
          windowsVerbatimArguments: shell === 'cmd.exe',
        });
        expect(r.exitCode, `${tool} via ${shell}: ${r.stderr}`).toBe(0);
        expect(r.stdout, `${tool} via ${shell}`).toContain('agent-b');
      }
    }
  }, 60_000);
});
