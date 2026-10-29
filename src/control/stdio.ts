/**
 * Transport stdio du Striart Control Protocol (`striart api --stdio`) — pour
 * les extensions IDE (VS Code, JetBrains) : zéro surface réseau, fonctionne
 * tel quel en Remote SSH, devcontainer et Codespaces (l'extension tourne là
 * où tourne le dépôt et lance la CLI comme sous-process).
 *
 * stdout est le canal du protocole et RIEN d'autre (les journaux vont sur
 * stderr, logger.js) ; stdin porte les requêtes. Pas de jeton : le pair est
 * le process parent, du même utilisateur, qui a lancé la commande.
 *
 * Concurrence : les requêtes d'une connexion sont traitées en parallèle
 * (un `agent.merge` long ne bloque pas un `state.get`), bornées à
 * MAX_IN_FLIGHT — au-delà, la lecture de stdin s'arrête jusqu'à ce qu'une
 * réponse parte (contre-pression vers le client, jamais de file sans fin).
 * Les réponses portent l'`id` de leur requête et peuvent arriver dans le
 * désordre (JSON-RPC 2.0). Les éléments d'un LOT, eux, s'exécutent dans
 * l'ordre.
 *
 * Notifications : coalescence au `drain` quand le client lit trop lentement
 * (voir hub.ts) — jamais de file d'états périmés en mémoire.
 */
import type { Locale, Messages } from '../cli/i18n/index.ts';
import { encodeFrame, readFrames } from './framing.ts';
import type { Framing } from './framing.ts';
import { DEFAULT_MAX_BUFFERED_BYTES, ControlHub } from './hub.ts';
import { logger } from '../logger.ts';
import type { MethodContext } from './methods.ts';
import { afterWrite, handleMessage, parseError, parseErrorResponse } from './rpc.ts';

export const MAX_IN_FLIGHT = 16;

export interface StdioOptions {
  root: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream & { writableLength: number };
  framing: Framing;
  m: Messages;
  locale: Locale;
  version: string;
  maxBufferedBytes?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

export async function serveStdio(options: StdioOptions): Promise<{ requests: number }> {
  const { root, input, output, framing, m, locale, version, signal } = options;
  const hub = new ControlHub({
    root,
    maxBufferedBytes: options.maxBufferedBytes,
    maxDelayMs: options.maxDelayMs,
  });
  const subscriptions = new Set<string>();
  let closed = false;

  let outputGone = false;
  output.once('close', () => {
    outputGone = true;
  });
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const write = (message: unknown) => {
    if (closed) return;
    try {
      output.write(encodeFrame(framing, message));
    } catch (error) {
      // Écriture impossible (pipe fermé, message non sérialisable) : journalisé
      // sur stderr, jamais une rejection non gérée qui tuerait le process.
      logger.error({ err: (error as Error).message }, 'Control stdio write failed');
    }
  };

  /**
   * Contre-pression : tant que le client n'a pas lu ses réponses (tampon de
   * sortie au-delà du plafond), on ne lit plus stdin. Libéré par le drain, la
   * fermeture de la sortie ou l'arrêt demandé — jamais bloqué pour toujours.
   */
  const waitForOutputRoom = async () => {
    while (!closed && !outputGone && !signal?.aborted && output.writableLength > maxBuffered) {
      await new Promise<void>((resolve) => {
        const done = () => {
          output.removeListener('drain', done);
          output.removeListener('close', done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        output.once('drain', done);
        output.once('close', done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  };

  const ctx: MethodContext = {
    root,
    hub,
    m,
    locale,
    version,
    transport: 'stdio',
    connection: {
      async subscribe() {
        const result = await hub.subscribe(
          {
            policy: 'coalesce',
            write: (method, params) => write({ jsonrpc: '2.0', method, params }),
            bufferedBytes: () => output.writableLength,
            disconnect: () => {
              // Fermeture du hub : la connexion stdio elle-même se termine avec stdin.
            },
            onceDrained: (callback) => output.once('drain', callback),
          },
          { initial: 'return' },
        );
        subscriptions.add(result.subscriptionId);
        return result;
      },
      unsubscribe(id) {
        if (!subscriptions.delete(id)) return false;
        return hub.unsubscribe(id);
      },
    },
  };

  const inFlight = new Set<Promise<void>>();
  let requests = 0;
  let wake: (() => void) | null = null;

  const handleText = async (text: string) => {
    try {
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        write(parseErrorResponse(parseError(), ctx));
        return;
      }
      const response = await handleMessage(message, ctx);
      if (response !== null) {
        write(response);
        afterWrite(response);
      }
    } catch (error) {
      logger.error({ err: (error as Error).message }, 'Control stdio request failed');
    }
  };

  const onAbort = () => {
    // Arrêt demandé (Ctrl+C, SIGTERM) : plus aucune lecture ; les requêtes
    // en vol finissent (une action mutante n'est jamais coupée en deux).
    input.unpipe?.();
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for await (const frame of readFrames(input, framing, undefined, (error) =>
      write(parseErrorResponse(error, ctx)),
    )) {
      if ('error' in frame) {
        write(parseErrorResponse(frame.error, ctx));
        if (frame.fatal) break;
        continue;
      }
      await waitForOutputRoom();
      requests += 1;
      const task = handleText(frame.text).finally(() => {
        inFlight.delete(task);
        wake?.();
      });
      inFlight.add(task);
      while (inFlight.size >= MAX_IN_FLIGHT) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
  } catch (error) {
    // stdin détruit par l'arrêt demandé : fin normale de la connexion.
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await Promise.allSettled([...inFlight]);
    closed = true;
    await hub.close();
  }
  return { requests };
}
