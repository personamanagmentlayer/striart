/**
 * Lecture BORNÉE de l'événement JSON qu'un outil de coding passe à son hook
 * sur stdin. Un hook tourne sur le chemin de chaque action de l'outil : il
 * ne doit ni accumuler une entrée sans limite, ni attendre indéfiniment un
 * flux qui ne se ferme pas. Tout écart rend un motif — l'appelant répond
 * alors la sortie neutre de l'outil (advisory : on n'informe pas, on ne
 * bloque jamais).
 */

/**
 * 8 Mio : un `Write` de Claude Code transporte le contenu entier du fichier
 * écrit ; une borne trop basse ferait taire le hook sur les gros fichiers.
 */
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/** Délai de lecture : au-delà, l'outil n'enverra plus rien d'utile. */
export const EVENT_TIMEOUT_MS = 5000;

export type InputFailure = 'TTY' | 'TOO_LARGE' | 'TIMEOUT' | 'ERROR';

export type InputResult = { ok: true; text: string } | { ok: false; reason: InputFailure };

type ReadableLike = NodeJS.ReadableStream & { isTTY?: boolean; destroy?: (error?: Error) => void };

export function readBoundedInput(
  stream: ReadableLike,
  {
    maxBytes = MAX_EVENT_BYTES,
    timeoutMs = EVENT_TIMEOUT_MS,
  }: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<InputResult> {
  // Lancé à la main dans un terminal : aucun événement ne viendra.
  if (stream.isTTY) return Promise.resolve({ ok: false, reason: 'TTY' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: InputResult, release: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      // Lecture abandonnée : libérer le flux (sinon le process attendrait sa fin).
      if (release) stream.destroy?.();
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBytes) {
        finish({ ok: false, reason: 'TOO_LARGE' }, true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }, false);
    const onError = () => finish({ ok: false, reason: 'ERROR' }, true);
    const timer = setTimeout(() => finish({ ok: false, reason: 'TIMEOUT' }, true), timeoutMs);
    timer.unref?.();
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/** Objet JSON de l'événement, ou null (vide, invalide, ou pas un objet). */
export function parseHookPayload(text: string): Record<string, unknown> | null {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed === '') return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    // JSON invalide : l'appelant répond la sortie neutre et l'avertit sur stderr.
    return null;
  }
}
