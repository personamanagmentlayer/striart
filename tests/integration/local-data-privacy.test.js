// Données locales écrites par Striart (journaux de session, tickets, journaux ACP,
// `striart init`) : réservées à l'utilisateur ET caviardées des secrets. Modes POSIX
// réels / ACL Windows réelles (icacls, SDDL).
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLog } from '../../src/acp/session-log.ts';
import { createConflictTicket } from '../../src/conflicts.js';
import { initStriart } from '../../src/init.js';
import { isPrivate, resetHardenMemo } from '../../src/private-fs.ts';
import { ensureStateProtection, resetStateProtectionMemo } from '../../src/state-protection.ts';
import { runAgentSession } from '../../src/session.js';
import { createTempRepo } from '../helpers/temp-repo.js';

const WIN = process.platform === 'win32';

/**
 * Tous les fichiers et dossiers sous `dir`, récursivement — hors arbres de travail
 * (`agents/`, `removing/`) : des copies du dépôt, jamais resserrées (voir private-fs.ts).
 */
async function walk(dir, top = true) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (top && ['agents', 'removing'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) out.push(...(await walk(full, false)));
  }
  return out;
}

async function expectAllPrivate(dir) {
  const targets = [dir, ...(await walk(dir))];
  for (const target of targets) expect(await isPrivate(target), target).toBe(true);
  if (!WIN) {
    for (const target of targets) {
      const mode = (await stat(target)).mode & 0o777;
      expect(mode & 0o077, `${target} ${mode.toString(8)}`).toBe(0);
    }
  }
}

beforeEach(() => {
  resetHardenMemo();
  resetStateProtectionMemo();
});

describe('journal de session autonome', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'striart-priv-sess-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('le journal est privé ET caviardé (clé connue de l’env, motif reconnu)', async () => {
    const known = 'plain-passphrase-without-any-format';
    const result = await runAgentSession({
      root,
      agent: 'agent-a',
      taskId: 'task-1',
      cwd: root,
      profile: {
        command: process.execPath,
        args: [
          '-e',
          `console.log('db=' + process.env.APP_DB_SECRET); console.log('key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'); console.log('ok')`,
          '{{prompt}}',
        ],
        env: { APP_DB_SECRET: known },
      },
      prompt: 'tâche',
      timeoutMs: 20_000,
    });
    expect(result.status).toBe('COMPLETED');
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('ok');
    expect(log).not.toContain(known);
    expect(log).not.toContain('AbCdEfGhIjKl');
    expect(result.command).not.toContain(known);
    await expectAllPrivate(path.join(root, '.striart'));
  });
});

describe('privateStateDir: false — relâchement explicite', () => {
  it('ensureStateProtection ne touche à rien et le dit', async () => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'striart-priv-off-'));
    try {
      const base = path.join(root, '.striart');
      await mkdir(path.join(base, 'logs'), { recursive: true });
      if (!WIN) await chmod(path.join(base, 'logs'), 0o755);
      const before = await isPrivate(path.join(base, 'logs'));
      const report = await ensureStateProtection(root, { privateStateDir: false });
      expect(report).toBeNull();
      expect(await isPrivate(path.join(base, 'logs'))).toBe(before);
      expect(before).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('tickets de conflit', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('dossier et fichiers du ticket (base/ours/theirs, log) sont privés ; le log est caviardé', async () => {
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task-1',
      sha: 'a'.repeat(40),
      reason: 'GATE_FAILED',
      conflictedFiles: ['src/app.js'],
      log: 'FAIL\nAuthorization: Bearer abcdef0123456789abcdef0123\nOPENAI_API_KEY=hunter2-unrecognised\n',
      resolutions: [
        {
          path: 'src/app.js',
          base: 'base code',
          ours: 'ours code',
          theirs: 'theirs code',
          llmAttempt: 'attempt',
        },
      ],
    });
    const files = await readdir(ticket.dir);
    expect(files).toEqual(
      expect.arrayContaining([
        'ticket.json',
        'test-output.log',
        'src%2Fapp.js.base',
        'src%2Fapp.js.ours',
        'src%2Fapp.js.theirs',
        'src%2Fapp.js.llm-attempt',
      ]),
    );
    await expectAllPrivate(path.join(repo.root, '.striart'));
    const log = await readFile(path.join(ticket.dir, 'test-output.log'), 'utf8');
    expect(log).toContain('FAIL');
    expect(log).not.toContain('abcdef0123456789');
    expect(log).not.toContain('hunter2-unrecognised');
  });

  it('le code des versions du ticket n’est PAS altéré par le caviardage', async () => {
    const ours = "const token = 'a-literal-in-the-source';\nexport const apiKey = process.env.X;\n";
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-b',
      branch: 'b',
      sha: 'b'.repeat(40),
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['x.js'],
      resolutions: [{ path: 'x.js', base: '', ours, theirs: '' }],
    });
    expect(await readFile(path.join(ticket.dir, 'x.js.ours'), 'utf8')).toBe(ours);
  });
});

describe('journal ACP (SessionLog)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'striart-priv-acp-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('privé et caviardé, au fil de l’eau', async () => {
    const logPath = path.join(root, '.striart', 'logs', 'session-agent-a-t1.log');
    const log = new SessionLog(logPath);
    await log.open('# session\n');
    log.append('agent dit: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n');
    log.append('voici le résultat\n');
    await log.flush();
    const text = await readFile(logPath, 'utf8');
    expect(text).toContain('voici le résultat');
    expect(text).not.toContain('ghp_0123456789');
    await expectAllPrivate(path.join(root, '.striart'));
  });

  it('un chemin hors .striart/ n’est pas durci (tests, usages isolés) mais reste écrit', async () => {
    const dir = path.join(root, 'plain');
    await mkdir(dir, { recursive: true });
    const log = new SessionLog(path.join(dir, 'x.log'));
    await log.open('hdr\n');
    log.append('texte\n');
    await log.flush();
    expect(await readFile(path.join(dir, 'x.log'), 'utf8')).toContain('texte');
  });
});

describe('striart init', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('crée .striart/ privé, et resserre un .striart/ existant ouvert (idempotent)', async () => {
    await initStriart(repo.root);
    await expectAllPrivate(path.join(repo.root, '.striart'));
    // Second passage : rien ne change, rien ne casse.
    resetStateProtectionMemo();
    resetHardenMemo();
    const second = await initStriart(repo.root);
    expect(second.alreadyInitialized).toBe(true);
    await expectAllPrivate(path.join(repo.root, '.striart'));
  });
});
