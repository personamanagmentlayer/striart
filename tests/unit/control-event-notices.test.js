import { afterEach, describe, expect, it } from 'vitest';
import { ControlHub } from '../../src/control/hub.ts';
import { describeOrchestrationEvent } from '../../src/control/event-notices.ts';
import { emitStriartEvent } from '../../src/events.ts';

const EVENTS = [
  {
    type: 'orchestration:node',
    runId: 'run-1',
    nodeId: 'n1',
    kind: 'review',
    phase: 'started',
    status: null,
    agent: 'agent-a',
  },
  {
    type: 'orchestration:node',
    runId: 'run-1',
    nodeId: 'n1',
    kind: 'review',
    phase: 'finished',
    status: 'MERGED',
    agent: 'agent-a',
  },
  {
    type: 'collab:turn',
    group: 'review-0123456789ab',
    agent: 'agent-a',
    role: 'author',
    round: 1,
    phase: 'started',
    status: null,
  },
  {
    type: 'collab:message',
    group: 'review-0123456789ab',
    from: 'author',
    to: 'reviewer',
    kind: 'question',
    seq: 3,
  },
  {
    type: 'review:verdict',
    group: 'review-0123456789ab',
    agent: 'agent-a',
    reviewer: 'r1',
    round: 1,
    verdict: 'approve',
  },
  {
    type: 'review:verdict',
    group: 'review-0123456789ab',
    agent: 'agent-a',
    reviewer: 'r1',
    round: 1,
    verdict: 'invalid',
  },
  {
    type: 'review:human-pending',
    group: 'review-0123456789ab',
    agent: 'agent-a',
    reviewId: 'rev-0123456789ab',
  },
  {
    type: 'race:winner',
    group: 'race-0123456789ab',
    agent: 'agent-b',
    candidates: ['agent-a', 'agent-b'],
  },
  { type: 'race:winner', group: 'race-0123456789ab', agent: null, candidates: ['agent-a'] },
];

describe('describeOrchestrationEvent — texte des notices, identifiants seulement', () => {
  it.each(EVENTS)('décrit %j', (event) => {
    const text = describeOrchestrationEvent(event);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(300);
  });

  it('ne dépend d’aucun champ de contenu : un corps injecté n’apparaît jamais', () => {
    const text = describeOrchestrationEvent({
      type: 'collab:message',
      group: 'g',
      from: 'a',
      to: 'b',
      kind: 'note',
      seq: 1,
      body: 'SECRET BODY',
    });
    expect(text).not.toContain('SECRET BODY');
  });

  it('rend null pour un type étranger (le hub n’invente rien)', () => {
    expect(describeOrchestrationEvent({ type: 'merge:done', agent: 'a' })).toBeNull();
  });
});

describe('ControlHub — notices des événements d’orchestration', () => {
  let hub;
  afterEach(async () => {
    await hub?.close();
  });

  it.each(EVENTS)('un événement %j produit une control.notice de même type', async (event) => {
    hub = new ControlHub({
      root: process.cwd(),
      watchDisk: false,
      collect: async () => ({ generatedAt: new Date().toISOString() }),
    });
    const frames = [];
    await hub.subscribe(
      {
        policy: 'drop',
        write: (method, params) => frames.push({ method, params }),
        bufferedBytes: () => 0,
        disconnect() {},
        onceDrained() {},
      },
      { initial: 'frame' },
    );
    frames.length = 0;
    await emitStriartEvent({}, event);
    const notice = frames.find((f) => f.method === 'control.notice');
    expect(notice?.params).toMatchObject({ type: event.type });
    expect(typeof notice.params.message).toBe('string');
  });
});
