// Environnement du Test Gate : les tests (écrits par l'agent) ne voient PAS les clés
// d'API ni les webhooks de l'orchestrateur, mais tournent avec ce qu'il leur faut
// (PATH, node, git). Vrais process, conteneur natif ET process simple.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runTestGate } from '../../src/gate.ts';
import { resetNativeBinaryCache } from '../../src/native.ts';
import { requireNativeBuild } from '../helpers/native-build.js';
import { REPO_ROOT } from '../helpers/native.js';

beforeAll(() => requireNativeBuild(REPO_ROOT));
afterEach(() => {
  delete process.env.STRIART_NATIVE_BIN;
  resetNativeBinaryCache();
});

const NODE = JSON.stringify(process.execPath);
const node = (script) => `${NODE} -e ${JSON.stringify(script)}`;

const SECRET_API_KEY = 'sk-test-ORCH-API-KEY-0123456789abcdef';
const SECRET_HOOK = 'https://hooks.slack.com/services/T000/B000/WEBHOOKSECRET0123456789';
const SECRET_INTERNAL = 'internal-token-value-0123456789';

/** Environnement d'orchestrateur simulé : le vrai, plus des secrets. */
const orchestratorEnv = () => ({
  ...process.env,
  OPENAI_API_KEY: SECRET_API_KEY,
  MY_COMPANY_LLM_KEY: SECRET_INTERNAL,
  SLACK_WEBHOOK_URL: SECRET_HOOK,
  GITHUB_TOKEN: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
  MYAPP_REGION: 'eu-west',
});

/** Script de test : écrit sur la sortie l'état de quelques variables. */
const PROBE =
  "const names = ['OPENAI_API_KEY','MY_COMPANY_LLM_KEY','SLACK_WEBHOOK_URL','GITHUB_TOKEN','MYAPP_REGION','PATH_PRESENT']; " +
  "console.log(names.map((n) => n + '=' + (n === 'PATH_PRESENT' ? String(Boolean(process.env.PATH || process.env.Path)) : (process.env[n] === undefined ? 'absent' : 'present'))).join(';'))";

describe.each(['native', 'process'])(
  'Test Gate — environnement filtré (conteneur %s)',
  (container) => {
    it('une clé d’API posée dans l’environnement de l’orchestrateur n’est PAS visible du testCommand', async () => {
      const result = await runTestGate({
        cwd: process.cwd(),
        testCommand: node(PROBE),
        container,
        baseEnv: orchestratorEnv(),
        secretEnvNames: ['MY_COMPANY_LLM_KEY'],
      });
      expect(result.success).toBe(true);
      expect(result.log).toContain('OPENAI_API_KEY=absent');
      expect(result.log).toContain('MY_COMPANY_LLM_KEY=absent');
      expect(result.log).toContain('SLACK_WEBHOOK_URL=absent');
      expect(result.log).toContain('GITHUB_TOKEN=absent');
      // Et tout de même ce qu'il faut pour tourner.
      expect(result.log).toContain('PATH_PRESENT=true');
      // Variable ordinaire non demandée : absente aussi (liste blanche, pas liste noire).
      expect(result.log).toContain('MYAPP_REGION=absent');
    });

    it('npm et git se résolvent avec l’environnement filtré', async () => {
      const result = await runTestGate({
        cwd: process.cwd(),
        testCommand: 'npm --version && git --version',
        container,
        baseEnv: orchestratorEnv(),
      });
      expect(result.success, result.log).toBe(true);
      expect(result.log).toMatch(/git version/);
    });

    it('une demande du dépôt sans autorisation utilisateur est écartée ET annoncée dans le journal', async () => {
      const result = await runTestGate({
        cwd: process.cwd(),
        testCommand: node(PROBE),
        container,
        baseEnv: orchestratorEnv(),
        gateEnv: ['MYAPP_REGION'],
      });
      expect(result.log).toContain('MYAPP_REGION=absent');
      expect(result.log).toContain('gateEnv');
      expect(result.log).toContain('non transmises : MYAPP_REGION');
    });

    it('gateEnv: "inherit" rend tout (relâchement explicite) — mais le journal reste caviardé', async () => {
      const result = await runTestGate({
        cwd: process.cwd(),
        testCommand: node(
          "console.log('OPENAI=' + process.env.OPENAI_API_KEY); console.log('HOOK=' + process.env.SLACK_WEBHOOK_URL)",
        ),
        container,
        baseEnv: orchestratorEnv(),
        gateEnv: 'inherit',
      });
      expect(result.success).toBe(true);
      // La variable ÉTAIT visible du test (sinon le journal ne contiendrait pas « OPENAI= »+marqueur)…
      expect(result.log).toMatch(/OPENAI=\[redacted\]/);
      // …mais la valeur n'est jamais écrite dans le journal rendu.
      expect(result.log).not.toContain(SECRET_API_KEY);
      expect(result.log).not.toContain('WEBHOOKSECRET');
    });
  },
);

describe('Test Gate — journal caviardé', () => {
  it('un test qui affiche un secret connu ou au format reconnaissable ne le laisse pas dans le journal', async () => {
    const result = await runTestGate({
      cwd: process.cwd(),
      testCommand: node(
        "console.log('token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'); console.log('Authorization: Bearer abcdef0123456789abcdef0123'); process.exit(1)",
      ),
      container: 'process',
      baseEnv: orchestratorEnv(),
    });
    expect(result.success).toBe(false);
    expect(result.log).not.toContain('ghp_0123456789');
    expect(result.log).not.toContain('abcdef0123456789');
  });
});
