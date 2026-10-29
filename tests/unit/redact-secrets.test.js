import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSecretEnvName,
  redactSecrets,
  secretValuesFromEnv,
} from '../../src/redact-secrets.ts';

describe('redactSecrets — motifs de formats connus', () => {
  it.each([
    ['clé Anthropic', 'key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'sk-ant-api03'],
    ['clé OpenAI', 'using sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123 now', 'sk-proj-AbCd'],
    ['jeton GitHub', 'push with ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', 'ghp_0123456789'],
    ['jeton Slack', 'xoxb-faketoken-abcdefghijklmnop', 'xoxb-faketoken'],
    ['clé AWS', 'AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7'],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'eyJhbGciOiJIUzI1NiJ9',
    ],
    [
      'webhook Slack',
      'POST https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX',
      'T000/B000',
    ],
    [
      'webhook Discord',
      'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789',
      '123456789012345678',
    ],
    [
      'identifiants dans une URL',
      'git clone https://user:hunter2pass@example.com/r.git',
      'hunter2pass',
    ],
    ['en-tête Authorization', 'Authorization: Bearer abcdef0123456789abcdef', 'abcdef0123456789'],
    ['Bearer isolé', 'got Bearer abcdef0123456789abcdef0123', 'abcdef0123456789'],
    ['affectation de clé', 'OPENAI_API_KEY=hunter2-not-a-known-format', 'hunter2-not-a-known'],
    ['mot de passe', 'password: "correct horse battery"', 'correct horse'],
  ])('%s', (_name, input, leaked) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(leaked);
    expect(out).toContain(REDACTED.slice(0, 9));
  });

  it('retire un bloc de clé privée PEM, terminé ou tronqué', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(6);
    const full = `a\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nb`;
    expect(redactSecrets(full)).not.toContain('MIIEvQIBADANBg');
    const cut = `a\n-----BEGIN RSA PRIVATE KEY-----\n${body}`;
    expect(redactSecrets(cut)).not.toContain('MIIEvQIBADANBg');
    expect(redactSecrets(full)).toMatch(/^a\n/);
  });

  it('garde un JSON valide : les guillemets de la valeur restent', () => {
    const json = JSON.stringify({
      apiKey: 'abcdefgh12345678',
      model: 'x',
      nested: { token: 'zzzz1234zzzz' },
    });
    const out = redactSecrets(json);
    const parsed = JSON.parse(out);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.nested.token).toBe(REDACTED);
    expect(parsed.model).toBe('x');
  });

  it('ne défigure pas les valeurs numériques ou booléennes (max_tokens=100)', () => {
    expect(redactSecrets('max_tokens=100 tokens: 5 secret: true')).toBe(
      'max_tokens=100 tokens: 5 secret: true',
    );
  });

  it('laisse un texte ordinaire intact', () => {
    const text = 'Tests: 12 passed, 0 failed\nsrc/app.ts:10:3 error TS2322: Type string\n';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactSecrets — valeurs exactes connues', () => {
  it('retire une valeur sans aucun format, partout où elle apparaît', () => {
    const secret = 'plain-old-passphrase-no-format';
    const out = redactSecrets(`a ${secret} b ${secret}`, { values: [secret] });
    expect(out).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it('ignore une valeur trop courte (elle défigurerait le texte)', () => {
    expect(redactSecrets('fix the fix', { values: ['fix'] })).toBe('fix the fix');
  });

  it('prend les valeurs des variables à nom de secret de l’environnement', () => {
    const values = secretValuesFromEnv(
      {
        OPENAI_API_KEY: 'k-open-12345678',
        PATH: '/bin',
        MY_INTERNAL: 'zzzz-1234-zzzz',
        SLACK_WEBHOOK_URL: 'https://x/y',
      },
      ['MY_INTERNAL'],
    );
    expect(values.sort()).toEqual(['https://x/y', 'k-open-12345678', 'zzzz-1234-zzzz'].sort());
    expect(isSecretEnvName('GITHUB_TOKEN')).toBe(true);
    expect(isSecretEnvName('PATH')).toBe(false);
  });
});

describe('redactSecrets — coût borné', () => {
  it('traite plusieurs Mio sans explosion, y compris des entrées adversariales', () => {
    const nasty = [
      'a'.repeat(200_000),
      'api_key'.repeat(30_000),
      '-----BEGIN PRIVATE KEY-----'.repeat(2000),
      `${'x='.repeat(100_000)}`,
      `${'sk-'.repeat(100_000)}`,
    ].join('\n');
    const started = Date.now();
    const out = redactSecrets(nasty.repeat(3));
    expect(typeof out).toBe('string');
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('un journal de ~6 Mio avec un secret au milieu le retire', () => {
    const filler = 'ligne ordinaire de sortie de test\n'.repeat(180_000);
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const out = redactSecrets(`${filler}${key}\n${filler}`);
    expect(out).not.toContain('AbCdEfGhIjKl');
    expect(out.length).toBeGreaterThan(5_000_000);
  });

  it('ne lève jamais sur un non-texte', () => {
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(42)).toBe('42');
  });
});
