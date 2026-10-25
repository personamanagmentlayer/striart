import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertInitialized } from '../../clone.js';
import { loadConfig } from '../../config.js';
import {
  dashboardDaemonStatus,
  publishDaemonInfo,
  daemonStopSignal,
  releaseDaemonPidFile,
  startDashboardDaemon,
  stopDashboardDaemon,
} from '../../daemon.js';
import { StriartError } from '../../errors.js';
import { SCHEMA_VERSION } from '../../control/envelope.ts';
import { assertHumanPlane } from '../../control/guard.ts';
import { issueSignInLink, portOfUrl } from '../../control/link.ts';
import type { CommandModule, CommandWarning, Ctx } from '../context.ts';
import { renderDaemonAction } from '../render/daemon.ts';
import type { DaemonActionData } from '../render/daemon.ts';

export interface DashboardInput {
  port: number | null;
  daemon: boolean;
  stop: boolean;
  status: boolean;
  link: boolean;
}

interface SignIn {
  signInUrl?: string | null;
  expiresAt?: string | null;
}

export type DashboardData =
  | (DaemonActionData & { url?: string | null } & SignIn)
  | ({ action: 'serve'; url: string } & SignIn)
  | { action: 'link'; url: string; signInUrl: string; expiresAt: string };

/** Délai d'attente de l'adresse publiée par un daemon qui démarre. */
const DAEMON_URL_WAIT_MS = 15_000;

async function waitForDaemonUrl(root: string): Promise<string | null> {
  const deadline = Date.now() + DAEMON_URL_WAIT_MS;
  for (;;) {
    const status = await dashboardDaemonStatus({ root });
    if (status.url) return status.url;
    if (!status.running || Date.now() > deadline) return null;
    await sleep(200);
  }
}

function renderSignIn(
  ctx: Ctx,
  signInUrl: string | null | undefined,
  expiresAt: string | null | undefined,
) {
  if (!signInUrl || !expiresAt) return;
  ctx.out.line('info', ctx.m.dashboard.signIn(signInUrl));
  ctx.out.detail(ctx.m.dashboard.signInDetail(ctx.out.date(expiresAt)));
}

export const dashboard: CommandModule<DashboardInput, DashboardData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    await assertInitialized(root);

    if (input.stop)
      return { data: { action: 'stop', ...(await stopDashboardDaemon({ root })) }, outcome: 'ok' };
    if (input.status) {
      return {
        data: { action: 'status', ...(await dashboardDaemonStatus({ root })) },
        outcome: 'ok',
      };
    }
    if (input.link) {
      // Plan humain : jamais de lien émis pour une session d'agent.
      assertHumanPlane(process.env, 'striart dashboard --link');
      const port = input.port ?? portOfUrl((await dashboardDaemonStatus({ root })).url);
      if (port === null) {
        throw new StriartError(ctx.m.dashboard.noInstance, {
          code: 'CONTROL_INSTANCE_NOT_FOUND',
          details: {},
          hint: 'striart dashboard --daemon',
        });
      }
      const config = await loadConfig(root);
      const link = await issueSignInLink(root, port, config.dashboardLinkTtlMs);
      return {
        data: {
          action: 'link',
          url: link.url,
          signInUrl: link.signInUrl,
          expiresAt: link.expiresAt,
        },
        outcome: 'ok',
      };
    }
    if (input.daemon) {
      assertHumanPlane(process.env, 'striart dashboard');
      const started = await startDashboardDaemon({ root, port: input.port });
      // Le lien est émis ICI (process de l'utilisateur), jamais par le daemon :
      // sa sortie va dans .striart/logs/, et un jeton ne se journalise pas.
      const url = await waitForDaemonUrl(root);
      const warnings: CommandWarning[] = [];
      let signIn: SignIn = { signInUrl: null, expiresAt: null };
      const port = portOfUrl(url);
      if (port !== null) {
        const config = await loadConfig(root);
        const link = await issueSignInLink(root, port, config.dashboardLinkTtlMs);
        signIn = { signInUrl: link.signInUrl, expiresAt: link.expiresAt };
      } else {
        warnings.push({ code: 'CONTROL_LINK_PENDING', message: ctx.m.dashboard.linkPending });
      }
      return { data: { action: 'daemon', ...started, url, ...signIn }, outcome: 'ok', warnings };
    }

    const { startDashboard } = await import('../../dashboard.js');
    const server = await startDashboard({ root, port: input.port });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : input.port;
    // Adresse EXACTE du serveur : en `dashboardHostname: 'instance'` le nom
    // d'hôte est propre à l'instance et `localhost` renvoie 403 (Host check).
    const url = server.striart.baseUrl;
    const isDaemon = process.env.STRIART_DAEMON === '1';
    if (isDaemon) await publishDaemonInfo({ root, name: 'dashboard', patch: { url } });
    // Un daemon n'affiche jamais de lien : sa sortie est un journal sur disque.
    const signIn = isDaemon ? null : server.striart.signInUrl();

    if (ctx.json) {
      ctx.out.event({
        schemaVersion: SCHEMA_VERSION,
        command: ctx.command,
        type: 'listening',
        at: new Date().toISOString(),
        data: {
          url,
          port,
          ...(signIn ? { signInUrl: signIn.url, expiresAt: signIn.expiresAt } : {}),
        },
      });
    } else {
      ctx.out.line('ok', ctx.m.dashboard.listening(url));
      if (signIn) renderSignIn(ctx, signIn.url, signIn.expiresAt);
      ctx.out.detail(ctx.m.dashboard.quit);
    }
    try {
      // Daemon : la demande d'arrêt de stopDaemon vaut SIGTERM (seul arrêt
      // propre possible sous Windows, où un signal est un TerminateProcess).
      const stop = daemonStopSignal({ root, name: 'dashboard', signal: ctx.signal });
      try {
        if (!stop.signal.aborted) await once(stop.signal, 'abort');
      } finally {
        stop.dispose();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      if (isDaemon) await releaseDaemonPidFile({ root, name: 'dashboard' });
    }
    return { data: { action: 'serve', url }, outcome: 'ok', streamed: true };
  },

  render(ctx, { data }) {
    if (data.action === 'serve') return;
    if (data.action === 'link') {
      renderSignIn(ctx, data.signInUrl, data.expiresAt);
      return;
    }
    renderDaemonAction(ctx, 'dashboard', data);
    if (data.action === 'status' && data.running && data.url)
      ctx.out.detail(ctx.m.dashboard.url(data.url));
    if (data.action === 'daemon') {
      if (data.url) ctx.out.detail(ctx.m.dashboard.url(data.url));
      renderSignIn(ctx, data.signInUrl, data.expiresAt);
    }
  },
};
