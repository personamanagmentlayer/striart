// Test Gate bloqué au-delà de son délai : l'arbre de process est tué par le
// binaire natif (killProcessTree → striart-native proc tree-kill), d'où sa
// place en intégration (vrais process, binaire construit par le globalSetup).
import { beforeAll, describe, expect, it } from 'vitest';
import { runTestGate } from '../../src/gate.js';
import { requireNativeBuild } from '../helpers/native-build.js';
import { REPO_ROOT } from '../helpers/native.js';

// Échec explicite (sortie cargo) si le binaire natif ne compile pas.
beforeAll(() => requireNativeBuild(REPO_ROOT));

describe('runTestGate — délai dépassé', () => {
  it('tue un test qui bloque au-delà du timeout → gate rouge', async () => {
    const start = Date.now();
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: 'node -e "setTimeout(() => {}, 30000)"',
      timeoutMs: 1500,
    });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.log).toContain('délai de 1500ms dépassé');
    expect(Date.now() - start).toBeLessThan(10000); // pas resté bloqué 30s
  });
});
