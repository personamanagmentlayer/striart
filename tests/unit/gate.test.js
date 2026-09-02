import { describe, expect, it } from 'vitest';
import { runTestGate } from '../../src/gate.js';

describe('runTestGate', () => {
  it('retourne success=true quand la commande passe', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: 'node -e "console.log(\'ok\')"',
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain('ok');
  });

  it('retourne success=false et le log quand la commande échoue', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: 'node -e "console.error(\'boom\'); process.exit(3)"',
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.log).toContain('boom');
  });

  it('retourne success=false pour une commande introuvable', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: 'commande-inexistante-striart',
    });
    expect(result.success).toBe(false);
  });

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
