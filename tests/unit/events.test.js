import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitStriartEvent, onStriartEvent } from '../../src/events.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CONFIG_SANS_WEBHOOK = { webhookUrl: null, notifiers: [] };

describe('bus d’observabilité', () => {
  it('délivre l’événement aux abonnés, avec la config', async () => {
    const seen = [];
    const off = onStriartEvent((config, event) => {
      seen.push({ config, event });
    });

    const event = { type: 'merge:manual-mode', message: 'mode manuel' };
    await emitStriartEvent(CONFIG_SANS_WEBHOOK, event);

    off();
    expect(seen).toHaveLength(1);
    expect(seen[0].event).toBe(event);
    expect(seen[0].config).toBe(CONFIG_SANS_WEBHOOK);
  });

  it('un abonné qui throw ne casse ni l’émission ni les autres abonnés', async () => {
    const seen = [];
    const offBroken = onStriartEvent(() => {
      throw new Error('abonné cassé');
    });
    const offOk = onStriartEvent((_config, event) => {
      seen.push(event.type);
    });

    // L'invariant n°1 du bus : ceci ne doit JAMAIS rejeter.
    await expect(
      emitStriartEvent(CONFIG_SANS_WEBHOOK, { type: 'merge:manual-mode' }),
    ).resolves.toBeUndefined();

    offBroken();
    offOk();
    expect(seen).toEqual(['merge:manual-mode']);
  });

  it('un abonné async en rejet est isolé de la même façon', async () => {
    const off = onStriartEvent(async () => {
      throw new Error('rejet async');
    });
    await expect(
      emitStriartEvent(CONFIG_SANS_WEBHOOK, { type: 'merge:manual-mode' }),
    ).resolves.toBeUndefined();
    off();
  });

  it('le désabonnement est effectif', async () => {
    const seen = [];
    const off = onStriartEvent((_config, event) => seen.push(event.type));
    off();
    await emitStriartEvent(CONFIG_SANS_WEBHOOK, { type: 'merge:manual-mode' });
    expect(seen).toEqual([]);
  });

  it('pont notify : un événement porteur de message part vers le webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await emitStriartEvent(
      { webhookUrl: 'https://hooks.slack.com/x', notifiers: [] },
      { type: 'merge:gate-red', agent: 'a', ticketId: 't1', exitCode: 1, message: 'gate rouge' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'gate rouge' });
  });

  it('pont notify : un événement SANS message ne notifie pas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await emitStriartEvent(
      { webhookUrl: 'https://hooks.slack.com/x', notifiers: [] },
      { type: 'merge:manual-mode' },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
