import { describe, expect, it, vi } from 'vitest';
import { isProcessAlive, killProcessTree, normalizeExitCode } from '../../src/process-tree.js';

describe('normalizeExitCode', () => {
  it('replie le wrap non signé de Windows en entier signé', () => {
    // Cas réel observé : ENOENT (-4058) rendu 4294963238 par Windows.
    expect(normalizeExitCode(4294963238)).toBe(-4058);
    // STATUS_CONTROL_C_EXIT (0xC000013A), le Ctrl+C de Windows.
    expect(normalizeExitCode(0xc000013a)).toBe(-1073741510);
  });

  it('laisse les codes ordinaires intacts — 0 reste 0', () => {
    expect(normalizeExitCode(0)).toBe(0);
    expect(normalizeExitCode(1)).toBe(1);
    expect(normalizeExitCode(255)).toBe(255);
    expect(normalizeExitCode(-4058)).toBe(-4058);
    // Borne : le plus grand int32 positif ne doit pas être replié.
    expect(normalizeExitCode(0x7fffffff)).toBe(0x7fffffff);
  });

  it('normalise l’absence de code (process tué par signal) en null', () => {
    expect(normalizeExitCode(null)).toBe(null);
    expect(normalizeExitCode(undefined)).toBe(null);
  });
});

describe('isProcessAlive', () => {
  it('vrai pour le process courant, faux pour un PID invalide', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(null)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  // EPERM = le process existe mais appartient à un autre utilisateur : il est
  // VIVANT. Le traiter comme mort désarmait sessionPid et la session
  // principale pour toute session lancée sous un autre compte (sudo, service).
  it('EPERM → vivant ; ESRCH → mort', () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });
      expect(isProcessAlive(4242)).toBe(true);
      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      expect(isProcessAlive(4242)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('killProcessTree (binaire natif injecté)', () => {
  it('délègue l’arbre au binaire natif, sans tuer le process de tête à part', async () => {
    const calls = [];
    const subprocess = { pid: 4242, kill: vi.fn() };
    await killProcessTree(subprocess, {
      treeKill: async (pid) => {
        calls.push(pid);
        return { root: pid, rootState: 'alive', killed: [], failed: [] };
      },
    });
    expect(calls).toEqual([4242]);
    expect(subprocess.kill).not.toHaveBeenCalled();
  });

  // Chemin de nettoyage appelé en `void` : une exception y serait un rejet
  // non géré. L'échec natif est journalisé (code NATIVE_*), puis le minimum
  // qui libère l'appelant est fait : tuer la tête.
  it('binaire indisponible : ne lève jamais, journalise, tue le process de tête', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
    });
    try {
      const subprocess = { pid: 4242, kill: vi.fn() };
      await expect(
        killProcessTree(subprocess, {
          treeKill: async () => {
            throw Object.assign(new Error('absent'), { code: 'NATIVE_UNAVAILABLE' });
          },
        }),
      ).resolves.toBeUndefined();
      expect(subprocess.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('process déjà sorti (pas de PID) : rien n’est appelé', async () => {
    const treeKill = vi.fn();
    await killProcessTree({ pid: undefined, kill: vi.fn() }, { treeKill });
    expect(treeKill).not.toHaveBeenCalled();
  });
});
