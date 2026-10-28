import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS, logRedactionOptions, scrubForLog } from '../../src/logger.js';

const require = createRequire(import.meta.url);
const pino = require('pino');

/** Un logger pino réel, mêmes options de caviardage que le logger de Striart, flux en mémoire. */
function capture() {
  const lines = [];
  const logger = pino(
    { level: 'trace', base: undefined, ...logRedactionOptions(pino) },
    {
      write: (chunk) => lines.push(JSON.parse(chunk)),
    },
  );
  return { logger, lines };
}

describe('logger — caviardage pino', () => {
  it('remplace les champs dont le NOM dit qu’ils portent un secret, à la racine et imbriqués', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        apiKey: 'sk-live-1',
        token: 't0k',
        password: 'pw',
        env: { OPENAI_API_KEY: 'x' },
        headers: { authorization: 'Bearer abc', 'content-type': 'json' },
        req: { headers: { authorization: 'Bearer def', cookie: 'sid=1' } },
        profile: { env: { KEY: 'v' }, command: 'claude' },
        agent: 'agent-a',
      },
      'appel',
    );
    const line = lines[0];
    expect(line.apiKey).toBe('[redacted]');
    expect(line.token).toBe('[redacted]');
    expect(line.password).toBe('[redacted]');
    expect(line.env).toBe('[redacted]');
    expect(line.headers.authorization).toBe('[redacted]');
    expect(line.headers['content-type']).toBe('json');
    expect(line.req.headers.authorization).toBe('[redacted]');
    expect(line.req.headers.cookie).toBe('[redacted]');
    expect(line.profile.env).toBe('[redacted]');
    expect(line.profile.command).toBe('claude');
    expect(line.agent).toBe('agent-a');
  });

  it('caviarde par motif le message et les chaînes de l’objet', () => {
    const { logger, lines } = capture();
    logger.warn(
      { command: 'tool --api-key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', n: 3 },
      'échec avec Bearer abcdef0123456789abcdef0123',
    );
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('AbCdEfGhIjKl');
    expect(serialized).not.toContain('abcdef0123456789');
    expect(lines[0].n).toBe(3);
  });

  it('caviarde le message et la pile d’une erreur sérialisée, cause comprise', () => {
    const { logger, lines } = capture();
    const cause = new Error('HTTP 401 Authorization: Bearer abcdef0123456789abcdef0123');
    const error = new Error('requête https://user:hunter2pass@api.example.com/x échouée', {
      cause,
    });
    logger.error({ err: error }, 'LLM en échec');
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('hunter2pass');
    expect(serialized).not.toContain('abcdef0123456789');
    expect(lines[0].err.type).toBe('Error');
  });

  it('ne modifie jamais l’objet de l’appelant', () => {
    const original = { note: 'key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', list: ['x'] };
    const copy = structuredClone(original);
    const scrubbed = scrubForLog(original);
    expect(original).toEqual(copy);
    expect(scrubbed.note).not.toContain('AbCdEfGhIjKl');
  });

  it('liste des chemins connus, sans doublon', () => {
    expect(new Set(LOG_REDACT_PATHS).size).toBe(LOG_REDACT_PATHS.length);
    expect(LOG_REDACT_PATHS).toContain('apiKey');
    expect(LOG_REDACT_PATHS).toContain('*.authorization');
  });
});
