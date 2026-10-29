import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlHub } from '../../src/control/hub.ts';

/** Collecte factice : compte les appels concurrents, résolue à la demande. */
function controlledCollect() {
  const pending = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const collect = () => {
    calls += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    return new Promise((resolve) => {
      pending.push(() => {
        concurrent -= 1;
        resolve({ generatedAt: new Date().toISOString(), agents: [], call: calls });
      });
    });
  };
  return {
    collect,
    release: () => pending.shift()?.(),
    get calls() {
      return calls;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
  };
}

function fakeTransport(policy, { buffered = 0 } = {}) {
  const frames = [];
  const drainCallbacks = [];
  return {
    frames,
    buffered,
    disconnected: null,
    policy,
    write(method, params) {
      frames.push({ method, params });
    },
    bufferedBytes() {
      return this.buffered;
    },
    disconnect(reason) {
      this.disconnected = reason;
    },
    onceDrained(callback) {
      drainCallbacks.push(callback);
    },
    drain() {
      this.buffered = 0;
      for (const callback of drainCallbacks.splice(0)) callback();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('hub du protocole de contrôle', () => {
  let hub;
  afterEach(async () => {
    vi.useRealTimers();
    await hub?.close();
    hub = null;
  });

  it('une seule collecte en vol ; un appel pendant la collecte attend la suivante (jamais un état périmé)', async () => {
    const c = controlledCollect();
    hub = new ControlHub({ root: '/repo', collect: c.collect, watchDisk: false });
    const first = hub.getState();
    const second = hub.getState();
    const third = hub.getState();
    expect(c.calls).toBe(1);
    c.release();
    const s1 = await first;
    await flush();
    // La deuxième collecte ne démarre qu'après la première, et sert les deux attentes.
    expect(c.calls).toBe(2);
    c.release();
    const [s2, s3] = await Promise.all([second, third]);
    expect(c.maxConcurrent).toBe(1);
    expect(s2).toBe(s3);
    expect(s2.revision).toBeGreaterThan(s1.revision);
    expect(s1.instanceId).toBe(hub.instanceId);
  });

  it('M2 : un appel fait dans le tick où la collecte courante se termine rejoint la suivante, jamais une collecte concurrente', async () => {
    const c = controlledCollect();
    hub = new ControlHub({ root: '/repo', collect: c.collect, watchDisk: false });
    const first = hub.getState();
    const queued = hub.getState();
    let late;
    void first.then(() => {
      late = hub.getState();
    });
    c.release();
    await first;
    await flush();
    expect(c.maxConcurrent).toBe(1);
    expect(c.calls).toBe(2);
    c.release();
    const [a, b] = await Promise.all([queued, late]);
    expect(a).toBe(b);
    expect(c.calls).toBe(2);
  });

  it('M14 : une notice émise avant l’activation d’un abonné est comptée dans droppedNotices, pas perdue en silence', async () => {
    hub = new ControlHub({
      root: '/r',
      collect: async () => ({ generatedAt: 'x', agents: [] }),
      watchDisk: false,
      debounceMs: 1,
    });
    const t = fakeTransport('coalesce');
    const { activate } = await hub.subscribe(t, { initial: 'return' });
    hub.notice('merge:done', 'mergé');
    activate();
    hub.changed();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const state = t.frames.find((f) => f.method === 'state.changed');
    expect(state.params.droppedNotices).toBe(1);
  });

  it('délai maximal : un flux continu de changements est poussé au plus tard après maxDelayMs', async () => {
    vi.useFakeTimers();
    const collect = vi.fn(async () => ({ generatedAt: 'x', agents: [] }));
    hub = new ControlHub({
      root: '/r',
      collect,
      watchDisk: false,
      debounceMs: 300,
      maxDelayMs: 2_000,
    });
    const t = fakeTransport('disconnect');
    await hub.subscribe(t, { initial: 'frame' });
    expect(t.frames).toHaveLength(1);
    // Un changement toutes les 200 ms : la fenêtre de 300 ms ne se fermerait jamais.
    for (let elapsed = 0; elapsed < 1_900; elapsed += 200) {
      hub.changed();
      await vi.advanceTimersByTimeAsync(200);
    }
    hub.changed();
    await vi.advanceTimersByTimeAsync(150);
    expect(t.frames.length).toBeGreaterThanOrEqual(2);
  });

  it('séquence contiguë par abonnement, révisions croissantes, notices numérotées', async () => {
    let n = 0;
    hub = new ControlHub({
      root: '/r',
      collect: async () => ({ generatedAt: String(++n), agents: [] }),
      watchDisk: false,
      debounceMs: 1,
    });
    const t = fakeTransport('disconnect');
    await hub.subscribe(t, { initial: 'frame' });
    hub.notice('merge:done', 'mergé');
    hub.changed();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.frames.map((f) => f.params.seq)).toEqual([1, 2, 3]);
    expect(t.frames.map((f) => f.method)).toEqual([
      'state.changed',
      'control.notice',
      'state.changed',
    ]);
    expect(t.frames[2].params.state.revision).toBeGreaterThan(t.frames[0].params.state.revision);
  });

  it('SSE (disconnect) : un abonné lent est déconnecté explicitement, les autres sont servis', async () => {
    hub = new ControlHub({
      root: '/r',
      collect: async () => ({ generatedAt: 'x', agents: [] }),
      watchDisk: false,
      debounceMs: 1,
      maxBufferedBytes: 1_000,
    });
    const fast = fakeTransport('disconnect');
    const slow = fakeTransport('disconnect');
    await hub.subscribe(fast, { initial: 'frame' });
    await hub.subscribe(slow, { initial: 'frame' });
    slow.buffered = 5_000;
    hub.changed();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slow.disconnected).toBe('slow');
    expect(fast.disconnected).toBeNull();
    expect(fast.frames).toHaveLength(2);
    expect(slow.frames).toHaveLength(1);
    expect(hub.stats()).toMatchObject({ subscribers: 1, slowDisconnects: 1 });
  });

  it('stdio (coalesce) : rien en file pendant la congestion, l’état le plus récent part au drain', async () => {
    let n = 0;
    hub = new ControlHub({
      root: '/r',
      collect: async () => ({ generatedAt: String(++n), agents: [] }),
      watchDisk: false,
      debounceMs: 1,
      maxBufferedBytes: 1_000,
    });
    const t = fakeTransport('coalesce');
    const sub = await hub.subscribe(t, { initial: 'return' });
    expect(sub.seq).toBe(1);
    // Rien n'est écrit avant la réponse de state.subscribe (activate).
    hub.changed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.frames).toHaveLength(0);
    sub.activate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.frames).toHaveLength(1);
    expect(t.frames[0].params.seq).toBe(2);

    t.buffered = 5_000;
    hub.changed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.changed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.notice('x', 'perdue pendant la congestion');
    expect(t.frames).toHaveLength(1);
    expect(t.disconnected).toBeNull();

    t.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.frames).toHaveLength(2);
    expect(t.frames[1].params).toMatchObject({
      seq: 3,
      droppedNotices: 1,
      subscriptionId: sub.subscriptionId,
    });
  });

  it('lock:contention (mesure du verrou, L8) ne déclenche ni recollecte ni notice', async () => {
    const { emitStriartEvent } = await import('../../src/events.ts');
    hub = new ControlHub({
      root: '/r',
      collect: async () => ({ generatedAt: 'x', agents: [] }),
      watchDisk: false,
      debounceMs: 1,
    });
    const t = fakeTransport('coalesce');
    const { activate } = await hub.subscribe(t, { initial: 'return' });
    activate();
    const before = hub.stats().collections;
    await emitStriartEvent(
      {},
      {
        type: 'lock:contention',
        operation: 'merge',
        waitedMs: 12,
        holder: { operation: 'resolve-apply', ageMs: 30 },
        queued: 2,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hub.stats().collections).toBe(before);
    expect(t.frames.filter((f) => f.method === 'control.notice')).toEqual([]);
    // Un événement ordinaire, lui, recollecte toujours.
    await emitStriartEvent({}, { type: 'merge:manual-mode', message: 'mode manuel' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hub.stats().collections).toBeGreaterThan(before);
  });

  it('close() déconnecte tous les abonnés et se désabonne du bus', async () => {
    hub = new ControlHub({ root: '/r', collect: async () => ({ agents: [] }), watchDisk: false });
    const t = fakeTransport('disconnect');
    await hub.subscribe(t, { initial: 'frame' });
    await hub.close();
    expect(t.disconnected).toBe('closing');
    expect(hub.stats().subscribers).toBe(0);
  });
});
