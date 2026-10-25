import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { checkProcessInstance, readProcessInfos } from '../../src/process-info.ts';

// Lit l'OS réel (PowerShell sous Windows, ps ou /proc ailleurs) : intégration.
describe('readProcessInfos (lecture groupée, OS réel)', () => {
  it('lit plusieurs PID en une passe ; ignore un PID invalide ou mort', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const table = await readProcessInfos([process.pid, child.pid, 0, -3, 999_999_999]);
      expect(table.get(process.pid)?.name.startsWith('node')).toBe(true);
      expect(table.get(child.pid)?.commandLine).toContain('setInterval');
      expect(table.has(999_999_999)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it('checkProcessInstance par défaut (lot) reconnaît un process étranger', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      stdio: 'ignore',
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const expected = { scriptName: 'cli.js', args: ['watch'] };
      const [a, b] = await Promise.all([
        checkProcessInstance(child.pid, expected, { cache: false }),
        checkProcessInstance(process.pid, expected, { cache: false }),
      ]);
      expect(a).toBe('foreign');
      expect(b).toBe('foreign');
    } finally {
      child.kill();
    }
  });
});
