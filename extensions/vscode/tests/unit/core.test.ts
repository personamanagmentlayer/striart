import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backoffDelayMs } from '../../src/core/backoff.ts';
import { NdjsonDecoder, encodeMessage } from '../../src/core/ndjson.ts';
import { RequestTracker, classifyAgent, summarize } from '../../src/core/model.ts';
import { hasUnsafeChars, sanitizeBlock, sanitizeLine } from '../../src/core/sanitize.ts';
import { safeDashboardUrl } from '../../src/core/url.ts';
import { parseMessage, toRpcError, validateState } from '../../src/core/validate.ts';
import type { AgentInfo } from '../../src/core/types.ts';
import { makeState } from './fake-server.ts';

describe('backoff', () => {
  it('double, plafonne, gigue entre la moitié et le plein délai', () => {
    const o = { initialMs: 1000, maxMs: 8000 };
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, o, () => 1 - Number.EPSILON)),
      [1000, 2000, 4000, 8000, 8000, 8000],
    );
    assert.deepEqual(
      [1, 2, 3].map((n) => backoffDelayMs(n, o, () => 0)),
      [500, 1000, 2000],
    );
    assert.equal(
      backoffDelayMs(1000, o, () => 0),
      4000,
    );
  });
});

describe('NdjsonDecoder', () => {
  function collect(max?: number) {
    const lines: string[] = [];
    const overflow: number[] = [];
    const decoder = new NdjsonDecoder({ onLine: (l) => lines.push(l), onOverflow: (b) => overflow.push(b) }, max);
    return { decoder, lines, overflow };
  }

  it('découpe sur LF, tolère CRLF et lignes vides', () => {
    const { decoder, lines } = collect();
    decoder.push(Buffer.from('{"a":1}\r\n\n{"b":2}\n'));
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  it('recompose un caractère UTF-8 multi-octets coupé entre deux morceaux', () => {
    const { decoder, lines } = collect();
    const bytes = Buffer.from('{"t":"é€😀"}\n');
    for (const b of bytes) decoder.push(Buffer.from([b]));
    assert.deepEqual(lines, ['{"t":"é€😀"}']);
  });

  it('écarte un message trop gros sans le bufferiser, puis reprend', () => {
    const { decoder, lines, overflow } = collect(100);
    decoder.push(Buffer.alloc(80, 0x61));
    decoder.push(Buffer.alloc(80, 0x61));
    assert.equal(decoder.bufferedBytes, 0);
    decoder.push(Buffer.from('\nok\n'));
    assert.deepEqual(overflow, [160]);
    assert.deepEqual(lines, ['ok']);
  });

  it('encodeMessage : une ligne, jamais de LF brut dans le JSON', () => {
    const text = encodeMessage({ a: 'x\ny' });
    assert.equal(text.indexOf('\n'), text.length - 1);
  });
});

describe('parseMessage', () => {
  it('distingue réponse, erreur et notification', () => {
    assert.equal(parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}').kind, 'response');
    assert.equal(parseMessage('{"jsonrpc":"2.0","method":"state.changed","params":{}}').kind, 'notification');
    const e = parseMessage('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"x"}}');
    assert.equal(e.kind === 'response' && e.error?.code, -32000);
  });

  it('refuse les formes invalides', () => {
    for (const bad of [
      '[]',
      '{"jsonrpc":"1.0","id":1,"result":1}',
      '{"jsonrpc":"2.0","id":1}',
      '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"x"}}',
      '{"jsonrpc":"2.0","id":1.5,"result":1}',
      '{"jsonrpc":"2.0","id":{},"result":1}',
      '{"jsonrpc":"2.0","method":5}',
      '{"jsonrpc":"2.0","id":1,"error":{"code":"x","message":"y"}}',
      'pas du json',
    ]) {
      assert.throws(() => parseMessage(bad), Error, bad);
    }
  });

  it('toRpcError : document valide ou repli explicite', () => {
    const ok = toRpcError('agent.stop', {
      code: -32001,
      message: 'refus',
      data: { error: { code: 'AGENT_HAS_PENDING', kind: 'refusal', message: 'm', hint: 'h', details: { agent: 'a' } } },
    });
    assert.equal(ok.code, 'AGENT_HAS_PENDING');
    assert.equal(ok.kind, 'refusal');
    const fallback = toRpcError('x', { code: -32700, message: 'parse', data: null });
    assert.equal(fallback.code, 'CONTROL_ERROR');
  });
});

describe('validateState', () => {
  const agent = {
    name: 'a1',
    status: 'ACTIVE',
    pendingCommits: 2,
    mode: 'attended',
    session: { state: 'idle', via: null, pid: null },
  };

  it('accepte un état valide et tolère les champs inconnus', () => {
    const s = validateState(makeState(3, { agents: [{ ...agent, futur: true }], futur: 1 }));
    assert.equal(s.agents[0]!.name, 'a1');
    assert.equal(s.revision, 3);
  });

  it('rejette types, énumérations, noms et bornes invalides', () => {
    const bads: Array<Record<string, unknown>> = [
      { agents: 'x' },
      { agents: [{ ...agent, name: '../etc' }] },
      { agents: [{ ...agent, status: 'WEIRD' }] },
      { agents: [{ ...agent, pendingCommits: -1 }] },
      { agents: Array.from({ length: 2001 }, (_, i) => ({ ...agent, name: `a${i}` })) },
      { revision: 0 },
      { permissions: [{ id: 'perm-zz', agent: 'a', title: 't', options: [], status: 'PENDING', expiresAt: 'x' }] },
      {
        tickets: [
          { id: 'ok', agent: null, reason: null, resolved: 'non', dir: '/x', conflictedFiles: [], createdAt: 'x' },
        ],
      },
    ];
    for (const bad of bads)
      assert.throws(
        () => validateState(makeState(1, bad)),
        /Unexpected message shape/,
        JSON.stringify(bad).slice(0, 80),
      );
  });
});

describe('sanitize', () => {
  it('retire contrôles, bidi et caractères de largeur nulle, borne la taille', () => {
    assert.equal(sanitizeLine('a‮b\u0000c\nd​e'), 'a b c d e');
    assert.equal(sanitizeLine('x'.repeat(300), 10), `${'x'.repeat(9)}…`);
    assert.equal(sanitizeBlock('l1\r\nl2\u0007'), 'l1\nl2');
    assert.equal(sanitizeLine(42 as unknown), '');
  });

  it('hasUnsafeChars', () => {
    assert.equal(hasUnsafeChars('claude --flag'), false);
    assert.equal(hasUnsafeChars('a\nb'), true);
    assert.equal(hasUnsafeChars('a‮b'), true);
  });
});

describe('safeDashboardUrl', () => {
  it('n’accepte que la boucle locale en http sur /auth', () => {
    assert.ok(safeDashboardUrl('http://abc123.localhost:3456/auth?code=xyz'));
    assert.ok(safeDashboardUrl('http://127.0.0.1:3456/auth?code=1'));
    for (const bad of [
      'https://abc.localhost/auth',
      'http://evil.example.com/auth?code=1',
      'http://localhost.evil.com/auth',
      'http://user:pw@localhost/auth',
      'http://localhost/other',
      'file:///etc/passwd',
      'javascript:alert(1)',
      42,
      `http://localhost/auth?${'a'.repeat(3000)}`,
    ]) {
      assert.equal(safeDashboardUrl(bad), null, String(bad).slice(0, 60));
    }
  });
});

describe('model', () => {
  const base: AgentInfo = {
    name: 'a',
    status: 'ACTIVE',
    pendingCommits: 0,
    mode: 'attended',
    profile: null,
    branch: null,
    command: null,
    lastMessage: null,
    session: null,
  };

  it('classe les agents par groupe sémantique', () => {
    assert.deepEqual(
      [
        classifyAgent(base),
        classifyAgent({ ...base, pendingCommits: 2 }),
        classifyAgent({ ...base, session: { state: 'running', via: 'pty', pid: 1 } }),
        classifyAgent({ ...base, status: 'BROKEN' }),
        classifyAgent({ ...base, status: 'MISSING' }),
      ].map((c) => `${c.group}/${c.key}/${c.mergeable}`),
      [
        'idle/idle/false',
        'attention/to-merge/true',
        'running/running/false',
        'attention/broken/false',
        'attention/missing/false',
      ],
    );
  });

  it('synthèse : watcher arrêté avec commits en attente', () => {
    const state = validateState(makeState(1, { agents: [{ ...base, pendingCommits: 1, name: 'x' }] }));
    const s = summarize(state);
    assert.equal(s.unwatchedPending, true);
    assert.equal(s.toMerge, 1);
    assert.equal(s.watcher, 'stopped');
  });

  it('RequestTracker : notifie une seule fois, oublie les demandes disparues', () => {
    const req = {
      id: 'perm-12345678',
      agent: 'a',
      title: 't',
      options: [{ optionId: 'o' }],
      status: 'PENDING',
      expiresAt: 'x',
    };
    const withReq = validateState(makeState(1, { permissions: [req] }));
    const empty = validateState(makeState(2));
    const tracker = new RequestTracker();
    assert.equal(tracker.fresh(withReq).length, 1);
    assert.equal(tracker.fresh(withReq).length, 0);
    assert.equal(tracker.fresh(empty).length, 0);
    assert.equal(tracker.fresh(withReq).length, 1);
  });
});
