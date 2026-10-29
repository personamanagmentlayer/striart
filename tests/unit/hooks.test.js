import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  HOOK_TOOLS,
  canonicalEvent,
  extractPatchFiles,
  getAdapter,
} from '../../src/hooks/adapters.ts';
import { MAX_EVENT_BYTES, parseHookPayload, readBoundedInput } from '../../src/hooks/stdin.ts';
import { toCloneRelative } from '../../src/hooks/advisory.ts';
import { DEFAULT_HOOK_SETTINGS, isValidHookSettings } from '../../src/hooks/config.ts';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.ts';

const streamOf = (chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));

describe('lecture bornée de l’événement (stdin)', () => {
  it('lit un JSON complet', async () => {
    const result = await readBoundedInput(streamOf(['{"a":', '1}']), {
      maxBytes: 100,
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: true, text: '{"a":1}' });
  });

  it('au-delà de la borne → TOO_LARGE (lecture interrompue, aucune accumulation)', async () => {
    const big = 'x'.repeat(64);
    const result = await readBoundedInput(streamOf([big, big, big]), {
      maxBytes: 100,
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('flux qui ne se termine jamais → TIMEOUT', async () => {
    const never = new Readable({ read() {} });
    const result = await readBoundedInput(never, { maxBytes: 100, timeoutMs: 50 });
    expect(result).toEqual({ ok: false, reason: 'TIMEOUT' });
  });

  it('terminal interactif (aucun événement) → TTY sans attendre', async () => {
    const tty = new Readable({ read() {} });
    tty.isTTY = true;
    expect(await readBoundedInput(tty, { maxBytes: 100, timeoutMs: 5000 })).toEqual({
      ok: false,
      reason: 'TTY',
    });
  });

  it('borne par défaut : quelques Mio (un Write de gros fichier reste lisible)', () => {
    expect(MAX_EVENT_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it.each([
    ['vide', ''],
    ['non JSON', 'nope'],
    ['tableau', '[1,2]'],
    ['nombre', '42'],
    ['null', 'null'],
  ])('charge utile %s → null (sortie neutre)', (_l, text) => {
    expect(parseHookPayload(text)).toBeNull();
  });

  it('BOM UTF-8 toléré', () => {
    expect(parseHookPayload('\uFEFF{"x":1}')).toEqual({ x: 1 });
  });
});

describe('adaptateurs : événements reconnus par outil', () => {
  it('cinq outils', () => {
    expect([...HOOK_TOOLS].sort()).toEqual(['claude', 'cline', 'codex', 'copilot', 'gemini']);
    expect(getAdapter('vim')).toBeNull();
  });

  it.each([
    ['claude', 'PreToolUse', 'pre-tool'],
    ['claude', 'PostToolUse', 'post-tool'],
    ['claude', 'SessionEnd', 'session-end'],
    ['codex', 'PreToolUse', 'pre-tool'],
    ['codex', 'SessionEnd', 'session-end'],
    ['copilot', 'postToolUse', 'post-tool'],
    ['copilot', 'sessionEnd', 'session-end'],
    ['gemini', 'BeforeTool', 'pre-tool'],
    ['gemini', 'AfterTool', 'post-tool'],
    ['gemini', 'SessionEnd', 'session-end'],
    ['cline', 'PreToolUse', 'pre-tool'],
    ['cline', 'TaskComplete', 'session-end'],
    ['cline', 'TaskCancel', 'session-end'],
  ])('%s %s → %s', (tool, event, kind) => {
    const adapter = getAdapter(tool);
    const canonical = canonicalEvent(adapter, event);
    expect(adapter.events[canonical]).toBe(kind);
  });

  it('casse tolérée, événement inconnu → null', () => {
    expect(canonicalEvent(getAdapter('claude'), 'pretooluse')).toBe('PreToolUse');
    expect(canonicalEvent(getAdapter('claude'), 'Nope')).toBeNull();
  });
});

describe('adaptateurs : extraction des fichiers écrits', () => {
  it('Claude Code : Edit/Write/MultiEdit (file_path), NotebookEdit (notebook_path) ; Read ignoré', () => {
    const a = getAdapter('claude');
    expect(
      a.parse({ cwd: '/c', tool_name: 'Edit', tool_input: { file_path: '/c/a.ts' } }).files,
    ).toEqual(['/c/a.ts']);
    expect(
      a.parse({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/c/n.ipynb' } }).files,
    ).toEqual(['/c/n.ipynb']);
    expect(a.parse({ tool_name: 'Read', tool_input: { file_path: '/c/a.ts' } }).files).toEqual([]);
  });

  it('Codex : apply_patch → chemins du patch (ajout, mise à jour, suppression, renommage)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-x',
      '+y',
      '*** Add File: src/new file.ts',
      '+z',
      '*** Delete File: old.ts',
      '*** Update File: src/b.ts',
      '*** Move to: src/c.ts',
      '*** End Patch',
    ].join('\n');
    expect(extractPatchFiles(patch)).toEqual([
      'src/a.ts',
      'src/new file.ts',
      'old.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    const parsed = getAdapter('codex').parse({
      cwd: '/c',
      tool_name: 'apply_patch',
      tool_input: { command: patch },
    });
    expect(parsed.files).toContain('src/c.ts');
    expect(parsed.cwd).toBe('/c');
  });

  it('Copilot CLI : toolArgs en chaîne JSON ou objet, outils edit/create', () => {
    const a = getAdapter('copilot');
    expect(a.parse({ cwd: '/c', toolName: 'edit', toolArgs: '{"path":"/c/x.js"}' }).files).toEqual([
      '/c/x.js',
    ]);
    expect(a.parse({ toolName: 'create', toolArgs: { path: 'y.js' } }).files).toEqual(['y.js']);
    expect(a.parse({ toolName: 'view', toolArgs: { path: 'y.js' } }).files).toEqual([]);
    expect(a.parse({ toolName: 'edit', toolArgs: '{not json' }).files).toEqual([]);
    expect(a.parse({ reason: 'complete' }).reason).toBe('complete');
  });

  it('Gemini CLI : write_file / replace (file_path)', () => {
    const a = getAdapter('gemini');
    expect(
      a.parse({ tool_name: 'write_file', tool_input: { file_path: '/g/a.py' } }).files,
    ).toEqual(['/g/a.py']);
    expect(a.parse({ tool_name: 'read_file', tool_input: { file_path: '/g/a.py' } }).files).toEqual(
      [],
    );
  });

  it('Cline : preToolUse.tool + parameters.path, cwd = workspaceRoots[0]', () => {
    const parsed = getAdapter('cline').parse({
      hookName: 'PreToolUse',
      workspaceRoots: ['/w'],
      preToolUse: { tool: 'write_to_file', parameters: { path: 'src/config.ts' } },
    });
    expect(parsed).toMatchObject({
      cwd: '/w',
      files: ['src/config.ts'],
      toolName: 'write_to_file',
    });
  });

  it('champs hostiles (types inattendus, chemins énormes) → ignorés sans erreur', () => {
    const a = getAdapter('claude');
    expect(a.parse({ tool_name: 'Edit', tool_input: { file_path: 42 } }).files).toEqual([]);
    expect(
      a.parse({ tool_name: 'Edit', tool_input: { file_path: 'x'.repeat(10_000) } }).files,
    ).toEqual([]);
    expect(a.parse({ tool_name: ['Edit'], tool_input: 'x', cwd: 3 })).toMatchObject({
      files: [],
      cwd: null,
    });
  });
});

describe('adaptateurs : sortie au format de chaque outil — advisory, jamais bloquante', () => {
  const M = 'Striart: collision';

  it('Claude Code / Codex : additionalContext + systemMessage, aucune décision de permission', () => {
    for (const tool of ['claude', 'codex']) {
      const out = JSON.parse(getAdapter(tool).render('PreToolUse', 'pre-tool', M));
      expect(out).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: M },
        systemMessage: M,
      });
      expect(JSON.stringify(out)).not.toMatch(/permissionDecision|decision|continue/);
      expect(getAdapter(tool).render('PreToolUse', 'pre-tool', null)).toBe('');
      expect(getAdapter(tool).render('SessionEnd', 'session-end', M)).toBe('');
    }
  });

  it('Gemini CLI : JSON toujours présent ({} neutre), systemMessage sans decision', () => {
    const a = getAdapter('gemini');
    expect(a.render('BeforeTool', 'pre-tool', null)).toBe('{}');
    expect(JSON.parse(a.render('BeforeTool', 'pre-tool', M))).toEqual({ systemMessage: M });
    expect(JSON.parse(a.render('AfterTool', 'post-tool', M))).toEqual({
      systemMessage: M,
      hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: M },
    });
  });

  it('Copilot CLI : preToolUse muet (seule sortie possible = une décision), postToolUse additionalContext', () => {
    const a = getAdapter('copilot');
    expect(a.render('preToolUse', 'pre-tool', M)).toBe('');
    expect(JSON.parse(a.render('postToolUse', 'post-tool', M))).toEqual({ additionalContext: M });
  });

  it('Cline : cancel toujours false', () => {
    const a = getAdapter('cline');
    expect(JSON.parse(a.render('PreToolUse', 'pre-tool', null))).toEqual({ cancel: false });
    expect(JSON.parse(a.render('PreToolUse', 'pre-tool', M))).toEqual({
      cancel: false,
      contextModification: M,
    });
    expect(JSON.parse(a.render('TaskComplete', 'session-end', null))).toEqual({ cancel: false });
  });
});

describe('chemins : relatifs au clone, jamais hors du clone', () => {
  it.each([
    ['/r/.striart/agents/a/src/x.ts', '/r/.striart/agents/a', '/r/.striart/agents/a', 'src/x.ts'],
    ['src/x.ts', '/r/.striart/agents/a', '/r/.striart/agents/a', 'src/x.ts'],
    ['x.ts', '/r/.striart/agents/a/src', '/r/.striart/agents/a', 'src/x.ts'],
    ['../../../etc/passwd', '/r/.striart/agents/a', '/r/.striart/agents/a', null],
    ['/elsewhere/x', '/r/.striart/agents/a', '/r/.striart/agents/a', null],
    ['/r/.striart/agents/a', '/r/.striart/agents/a', '/r/.striart/agents/a', null],
  ])('%s (base %s) → %s', (file, base, clone, expected) => {
    expect(toCloneRelative(file, base, clone, 'linux')).toBe(expected);
  });

  it('Windows : antislashs, casse du lecteur', () => {
    expect(
      toCloneRelative(
        'c:\\R\\.striart\\agents\\a\\Src\\X.ts',
        'C:\\R\\.striart\\agents\\a',
        'C:\\R\\.striart\\agents\\a',
        'win32',
      ),
    ).toBe('Src/X.ts');
  });
});

describe('config hooks', () => {
  it('défaut présent et valide ; clés inconnues / types faux refusés', () => {
    expect(DEFAULT_CONFIG.hooks).toEqual(DEFAULT_HOOK_SETTINGS);
    expect(() => validateConfig({ hooks: { collisions: false } })).not.toThrow();
    expect(isValidHookSettings({ block: true })).toBe(false);
    expect(isValidHookSettings({ collisions: 'yes' })).toBe(false);
    expect(() => validateConfig({ hooks: { notify: true } })).toThrow(/hooks/);
  });
});
