import { afterEach, describe, expect, it, vi } from 'vitest';
import { notify, resolveNotifiers } from '../../src/notify.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notify', () => {
  it('ne fait rien sans webhookUrl', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await notify({ webhookUrl: null }, 'msg')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envoie { text } pour Slack', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const sent = await notify(
      { webhookUrl: 'https://hooks.slack.com/services/xxx' },
      'tâche bloquée',
    );
    expect(sent).toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ text: 'tâche bloquée' });
  });

  it('envoie { content } pour Discord', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const sent = await notify(
      { webhookUrl: 'https://discord.com/api/webhooks/xxx' },
      'merge échoué',
    );
    expect(sent).toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ content: 'merge échoué' });
  });

  it('un webhook en panne ne throw jamais', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await notify({ webhookUrl: 'https://hooks.slack.com/x' }, 'msg')).toBe(false);
  });

  it('une réponse HTTP non-ok retourne false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await notify({ webhookUrl: 'https://hooks.slack.com/x' }, 'msg')).toBe(false);
  });
});

describe('notify — table notifiers', () => {
  it('envoie à tous les canaux, chacun avec le payload de son type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const sent = await notify(
      {
        webhookUrl: null,
        notifiers: [
          { type: 'slack', url: 'https://hooks.slack.com/a' },
          { type: 'discord', url: 'https://discord.com/api/webhooks/b' },
          { type: 'generic', url: 'https://interne.example/hook' },
        ],
      },
      'gate rouge',
    );

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies).toContainEqual({ text: 'gate rouge' });
    expect(bodies).toContainEqual({ content: 'gate rouge' });
    expect(bodies).toContainEqual({ message: 'gate rouge' });
  });

  it('webhookUrl (canal historique) et notifiers cumulent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await notify(
      {
        webhookUrl: 'https://hooks.slack.com/legacy',
        notifiers: [{ type: 'discord', url: 'https://discord.com/api/webhooks/x' }],
      },
      'msg',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain('https://hooks.slack.com/legacy');
    expect(urls).toContain('https://discord.com/api/webhooks/x');
  });

  it("urlEnv résout l'URL depuis l'environnement", () => {
    const targets = resolveNotifiers(
      { webhookUrl: null, notifiers: [{ type: 'slack', urlEnv: 'MY_HOOK' }] },
      { MY_HOOK: 'https://hooks.slack.com/from-env' },
    );
    expect(targets).toEqual([{ type: 'slack', url: 'https://hooks.slack.com/from-env' }]);
  });

  it('urlEnv absent → canal écarté, les autres passent quand même', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    // resolveNotifiers lit process.env : la variable ABSENT_XYZ n'existe pas.
    const sent = await notify(
      {
        webhookUrl: null,
        notifiers: [
          { type: 'slack', urlEnv: 'STRIART_TEST_ABSENT_XYZ' },
          { type: 'discord', url: 'https://discord.com/api/webhooks/ok' },
        ],
      },
      'msg',
    );

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://discord.com/api/webhooks/ok');
  });

  it('un canal en panne ne bloque pas les autres — true si au moins un passe', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const sent = await notify(
      {
        webhookUrl: null,
        notifiers: [
          { type: 'slack', url: 'https://hooks.slack.com/panne' },
          { type: 'generic', url: 'https://interne.example/ok' },
        ],
      },
      'msg',
    );

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tous en échec → false, jamais de throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const sent = await notify(
      {
        webhookUrl: null,
        notifiers: [
          { type: 'slack', url: 'https://a.example' },
          { type: 'discord', url: 'https://b.example' },
        ],
      },
      'msg',
    );
    expect(sent).toBe(false);
  });
});
