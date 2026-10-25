import { once } from 'node:events';
import path from 'node:path';
import { assertInitialized } from '../../clone.js';
import { StriartError } from '../../errors.js';
import { SCHEMA_VERSION } from '../../control/envelope.ts';
import {
  daemonStopSignal,
  releaseDaemonPidFile,
  startWatchDaemon,
  stopWatchDaemon,
  watchDaemonStatus,
} from '../../daemon.js';
import { configureLogger } from '../../logger.js';
import { striartDir } from '../../paths.js';
import { startWatchLoop } from '../../watch-loop.ts';
import type { WatchEvent } from '../../watch-loop.ts';
import type { CommandModule, Ctx } from '../context.ts';
import { Output } from '../output.ts';
import { renderMergeResult, renderSyncResult } from '../render/results.ts';
import { renderDaemonAction } from '../render/daemon.ts';
import type { DaemonActionData } from '../render/daemon.ts';

export interface WatchInput {
  merge: boolean;
  daemon: boolean;
  stop: boolean;
  status: boolean;
  ui: boolean;
}

export type WatchData = DaemonActionData | { action: 'watch' } | { action: 'ui' };

/** Une ligne humaine par événement de la boucle (stdout, ou l'onglet Terminal de l'UI). */
export function renderWatchEvent(out: Output, event: WatchEvent): void {
  const { m } = out;
  switch (event.type) {
    case 'started':
      out.line('info', m.watch.started(out.path(event.agentsDir)));
      out.detail(event.merge ? m.watch.autoMerge : m.watch.noMerge);
      return;
    case 'commit':
      out.line(
        'info',
        m.watch.commit(event.agent, out.untrusted(event.branch), out.sha(event.sha)),
      );
      return;
    case 'merge':
      renderMergeResult(out, event.result);
      return;
    case 'merge-skipped':
      out.line('skip', m.watch.mergeSkipped(event.agent));
      return;
    case 'merge-deferred':
      out.line('warn', m.watch.mergeDeferred(event.agent));
      out.hint(`striart merge ${event.agent}`);
      return;
    case 'merge-error':
      out.line('error', m.watch.mergeError(event.agent, out.untrusted(event.error.message)));
      return;
    case 'sync':
      renderSyncResult(out, event.result);
      return;
    case 'reconcile':
      for (const t of event.started) out.line('ok', m.queue.unblocked(t.taskId, t.agent));
      if (event.sessionPidsCleared.length > 0) {
        out.line('info', m.reconcile.cleared(event.sessionPidsCleared.join(', ')));
      }
      return;
    case 'reconcile-error':
      out.line('warn', m.watch.reconcileError(out.untrusted(event.error.message)));
      return;
    case 'behind':
      out.line(
        'info',
        event.behind > 0
          ? m.watch.behind(event.agent, event.behind, event.targetBranch)
          : m.watch.caughtUp(event.agent, event.targetBranch),
      );
      return;
    case 'fetch-error':
      out.line('warn', m.watch.fetchError(event.agent, out.untrusted(event.error.message)));
      return;
  }
}

/** Sortie qui capture chaque ligne (pour l'onglet Terminal de `--ui`). */
function lineCapture(ctx: Ctx, onLine: (line: string) => void): Output {
  let buffer = '';
  const sink = {
    write(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },
  };
  const output = new Output({
    caps: { ...ctx.caps, hyperlinks: false, columns: null, animate: false },
    messages: ctx.m,
    stdout: sink,
    stderr: sink,
    quiet: true,
    json: false,
  });
  output.root = ctx.out.root;
  return output;
}

export const watch: CommandModule<WatchInput, WatchData> = {
  async execute(ctx, input) {
    if (input.ui) {
      // Refusé AVANT tout démarrage : sans terminal interactif, Ink plantait
      // (mode raw impossible) en laissant le watcher tourner sans fin.
      if (ctx.json) {
        throw new StriartError(ctx.m.main.jsonUnsupported('watch --ui'), {
          code: 'UNSUPPORTED_OUTPUT_FORMAT',
          details: { command: 'watch --ui' },
          hint: 'striart watch --json',
        });
      }
      if (!ctx.caps.stdinIsTTY || !ctx.caps.stdoutIsTTY) {
        throw new StriartError(ctx.m.main.uiNeedsTty, {
          code: 'UI_REQUIRES_TTY',
          hint: ctx.m.main.uiNeedsTtyHint,
        });
      }
    }
    const root = await ctx.repoRoot();
    await assertInitialized(root);

    if (input.stop)
      return { data: { action: 'stop', ...(await stopWatchDaemon({ root })) }, outcome: 'ok' };
    if (input.status)
      return { data: { action: 'status', ...(await watchDaemonStatus({ root })) }, outcome: 'ok' };
    if (input.daemon) {
      return {
        data: { action: 'daemon', ...(await startWatchDaemon({ root, noMerge: !input.merge })) },
        outcome: 'ok',
      };
    }

    if (input.ui) {
      // L'écran appartient à l'UI : les journaux vont dans un fichier, les
      // événements de la boucle dans l'onglet Terminal.
      configureLogger({ file: path.join(striartDir(root), 'logs', 'watch-ui.log'), pretty: false });
      const listeners = new Set<(line: string) => void>();
      const capture = lineCapture(ctx, (line) => {
        for (const listener of listeners) listener(line);
      });
      const loop = await startWatchLoop({
        root,
        merge: input.merge,
        onEvent: (event) => renderWatchEvent(capture, event),
      });
      const { runWatchUi } = await import('../../watch-ui.ts');
      try {
        await runWatchUi(root, {
          messages: ctx.m,
          // main.ts classe `watch` parmi les commandes à arrêt propre : le
          // premier signal n'interrompt rien de lui-même, c'est à l'UI de se
          // démonter (sinon un seul SIGTERM était ignoré).
          signal: ctx.signal,
          subscribeLoop: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        });
      } finally {
        // Quitter l'UI ne fait pas attendre un merge en cours sur un écran
        // déjà rendu : la récupération après coupure le reprend.
        await loop.stop({ drain: false });
      }
      // Des connexions d'attache (pty) peuvent survivre au démontage : la
      // sortie est garantie sans couper ce qui reste à écrire.
      setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref();
      return { data: { action: 'ui' }, outcome: 'ok' };
    }

    const loop = await startWatchLoop({
      root,
      merge: input.merge,
      onEvent: (event) => {
        if (ctx.json) ctx.out.event(streamEvent(ctx, event));
        else renderWatchEvent(ctx.out, event);
      },
    });
    try {
      // Daemon : la demande d'arrêt de stopDaemon vaut SIGTERM (seul arrêt
      // propre possible sous Windows, où un signal est un TerminateProcess).
      const stop = daemonStopSignal({ root, name: 'watch', signal: ctx.signal });
      try {
        if (!stop.signal.aborted) await once(stop.signal, 'abort');
      } finally {
        stop.dispose();
      }
      if (loop.isBusy() && !ctx.json) ctx.out.step(ctx.m.watch.draining);
      await loop.stop();
    } finally {
      // Daemon : son PID file ne disparaît qu'à sa sortie effective (voir
      // stopDaemon) — c'est lui qui le retire, après la vidange.
      if (process.env.STRIART_DAEMON === '1') await releaseDaemonPidFile({ root, name: 'watch' });
    }
    return { data: { action: 'watch' }, outcome: 'ok', streamed: true };
  },

  render(ctx, { data }) {
    if (data.action === 'watch' || data.action === 'ui') return;
    renderDaemonAction(ctx, 'watch', data);
  },
};

/** Événement du flux ndjson : enveloppe stable, `data` = l'événement sans son type. */
function streamEvent(ctx: Ctx, event: WatchEvent) {
  const { type, ...data } = event;
  return {
    schemaVersion: SCHEMA_VERSION,
    command: ctx.command,
    type,
    at: new Date().toISOString(),
    data,
  };
}
