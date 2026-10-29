// Test Gate dans un conteneur de process natif (src/gate.js) : codes de sortie,
// orphelins (D2 : GATE_ORPHAN_PROCESS), plafond de journal, indisponibilité du
// binaire (fail closed). Vrais process, binaire construit par le globalSetup —
// d'où l'intégration (ces tests vivaient en unitaire tant que le gate lançait
// un simple execa).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runTestGate } from '../../src/gate.ts';
import { resetNativeBinaryCache } from '../../src/native.ts';
import { requireNativeBuild } from '../helpers/native-build.js';
import { REPO_ROOT } from '../helpers/native.js';

// Échec explicite (sortie cargo) si le binaire natif ne compile pas.
beforeAll(() => requireNativeBuild(REPO_ROOT));
afterEach(() => {
  delete process.env.STRIART_NATIVE_BIN;
  resetNativeBinaryCache();
});

const NODE = JSON.stringify(process.execPath);
/** Commande de test lancée par le shell : `node -e "<script>"`. */
const node = (script) => `${NODE} -e ${JSON.stringify(script)}`;

/** Le process existe-t-il encore ? (EPERM = vivant) */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
async function waitDead(pid, ms = 8000) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

describe('runTestGate — conteneur natif', () => {
  it('retourne success=true quand la commande passe', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: node("console.log('ok')"),
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain('ok');
    expect(result.code).toBeUndefined();
    expect(result.orphanPids).toBeUndefined();
  });

  it('retourne success=false et le log quand la commande échoue', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: node("console.error('boom'); process.exit(3)"),
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.log).toContain('boom');
    expect(result.code).toBeUndefined();
  });

  it('retourne success=false pour une commande introuvable', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: 'commande-inexistante-striart',
    });
    expect(result.success).toBe(false);
  });

  it('stdout et stderr sont entrelacés dans le journal, dans l’ordre', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: node(
        "process.stdout.write('A1 '); setTimeout(() => { process.stderr.write('B2 '); }, 80); setTimeout(() => { process.stdout.write('C3'); }, 160)",
      ),
    });
    expect(result.success).toBe(true);
    expect(result.log.replace(/\s+/g, ' ')).toContain('A1 B2 C3');
  });

  it('D2 — code 0 mais un descendant tient encore la sortie après le délai de grâce : ROUGE GATE_ORPHAN_PROCESS, orphelin tué', async () => {
    const started = Date.now();
    // Le parent lance un petit-fils qui hérite de la sortie, puis sort 0.
    // (Windows : `detached` — libuv enferme sinon chaque enfant dans un Job
    // Object « tué à la mort du parent », et l'orphelin mourrait avec lui.)
    const spawnOrphan = node(
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: process.platform === 'win32' }); c.unref(); console.log('ORPHAN:' + c.pid);",
    );
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: spawnOrphan,
      orphanGraceMs: 400,
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(false); // fail closed malgré le 0
    expect(result.code).toBe('GATE_ORPHAN_PROCESS');
    expect(result.orphanPids?.length).toBeGreaterThanOrEqual(1);
    expect(result.log).toContain('GATE_ORPHAN_PROCESS');
    const orphan = Number(/ORPHAN:(\d+)/.exec(result.log)?.[1]);
    expect(orphan).toBeGreaterThan(0);
    expect(await waitDead(orphan), 'l’orphelin doit être tué').toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000); // jamais resté bloqué sur son tube
  });

  it('D2 — un descendant qui finit DANS le délai de grâce n’est pas un orphelin', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: node(
        "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => console.log(\"late-child-done\"), 250)'], { stdio: 'inherit', detached: process.platform === 'win32' }).unref();",
      ),
      orphanGraceMs: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.code).toBeUndefined();
    expect(result.log).toContain('late-child-done');
  });

  it('un test qui bloque au-delà du délai est tué (arbre compris) → rouge timedOut', async () => {
    const start = Date.now();
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: node('setTimeout(() => {}, 30000)'),
      timeoutMs: 1500,
    });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.log).toContain('délai de 1500ms dépassé');
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  it('plafond de journal : seule la FIN de la sortie est gardée, mémoire bornée, gate vert si 0', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: node(
        "const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 6000; i++) process.stdout.write(line); process.stdout.write('FIN-DU-JOURNAL\\n');",
      ),
      maxOutputBytes: 100 * 1024,
    });
    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.log).toContain('FIN-DU-JOURNAL');
    expect(result.log).toContain('Sortie tronquée');
    expect(Buffer.byteLength(result.log)).toBeLessThan(100 * 1024 + 1024);
  });

  it('binaire natif indisponible : rouge GATE_NATIVE_UNAVAILABLE explicite, jamais un vert sans conteneur', async () => {
    process.env.STRIART_NATIVE_BIN = require_absolute_missing();
    resetNativeBinaryCache();
    const result = await runTestGate({ cwd: process.cwd(), testCommand: node('process.exit(0)') });
    expect(result.success).toBe(false);
    expect(result.code).toBe('GATE_NATIVE_UNAVAILABLE');
    expect(result.log).toContain('gateContainer');
  });
});

function require_absolute_missing() {
  return process.platform === 'win32'
    ? 'C:\\striart-inexistant\\striart-native.exe'
    : '/striart-inexistant/striart-native';
}

describe("runTestGate — relâchement explicite container: 'process'", () => {
  it('exécute sans conteneur natif (aucune détection d’orphelins), journal plafonné aussi', async () => {
    process.env.STRIART_NATIVE_BIN = require_absolute_missing();
    resetNativeBinaryCache();
    const ok = await runTestGate({
      cwd: process.cwd(),
      testCommand: node("console.log('plain-ok')"),
      container: 'process',
    });
    expect(ok.success).toBe(true);
    expect(ok.log).toContain('plain-ok');
    const capped = await runTestGate({
      cwd: process.cwd(),
      testCommand: node(
        "for (let i = 0; i < 3000; i++) process.stdout.write('y'.repeat(1023) + '\\n'); process.stdout.write('BOUT\\n');",
      ),
      container: 'process',
      maxOutputBytes: 50 * 1024,
    });
    expect(capped.success).toBe(true);
    expect(capped.truncated).toBe(true);
    expect(capped.log).toContain('BOUT');
  });
});

describe('startNativeJob — rapport absent sans attendre `report` (M15)', () => {
  it('aucun unhandledRejection quand seul `subprocess` est attendu', async () => {
    const { startNativeJob } = await import('../../src/native.ts');
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      // Programme introuvable : `job run` sort en erreur SANS écrire de rapport,
      // donc `report` rejette (NO_REPORT).
      const job = await startNativeJob({
        argv: ['striart-programme-inexistant-xyz'],
        cwd: process.cwd(),
        graceMs: 0,
      });
      await job.subprocess;
      await new Promise((r) => setTimeout(r, 300));
      expect(rejections).toEqual([]);
      // Le rejet reste observable par qui attend `report`.
      await expect(job.report).rejects.toMatchObject({ code: 'NATIVE_COMMAND_FAILED' });
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
