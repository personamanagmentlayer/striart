/**
 * Découpage des messages du transport stdio, borné en mémoire.
 *
 * Deux cadrages, au choix du client :
 *  - `ndjson` (défaut) : un message JSON par ligne — trivial à parler depuis
 *    n'importe quel langage, comme le serveur MCP ;
 *  - `content-length` : en-têtes « Content-Length: N\r\n\r\n » puis N octets,
 *    le cadrage de LSP — celui que parlent nativement `vscode-jsonrpc`
 *    (extension VS Code) et `lsp4j` (plugin JetBrains).
 *
 * Aucun des deux ne bufferise un message au-delà de `maxMessageBytes` : un
 * flux hostile ou défaillant ne fait jamais gonfler la mémoire (le message
 * trop gros est écarté au fil de l'eau et signalé, le flux continue). Une
 * désynchronisation irréparable du cadrage Content-Length (en-têtes
 * illisibles) est FATALE : on ne devine pas où recommence le message suivant.
 */
import { StriartError } from '../errors.ts';
import { boundedLines } from '../line-reader.ts';

export type Framing = 'ndjson' | 'content-length';
export const FRAMINGS: readonly Framing[] = ['ndjson', 'content-length'];

/** Taille maximale d'un message (même borne que le serveur MCP). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;

export type Frame = { text: string } | { error: StriartError; fatal: boolean };

function tooLarge(bytes: number, max: number): StriartError {
  return new StriartError(`Message of ${bytes} bytes exceeds the ${max}-byte limit: dropped.`, {
    code: 'CONTROL_MESSAGE_TOO_LARGE',
    details: { bytes, limit: max },
    hint: 'Split the request, or send large content by path instead of inline.',
  });
}

function badHeaders(reason: string): StriartError {
  return new StriartError(`Unreadable Content-Length framing (${reason}): connection closed.`, {
    code: 'CONTROL_INVALID_REQUEST',
    details: { reason },
    hint: 'Send "Content-Length: <bytes>\\r\\n\\r\\n<json>" frames, or use --framing ndjson.',
  });
}

async function* ndjsonFrames(
  stream: NodeJS.ReadableStream,
  max: number,
  onDropped?: (error: StriartError) => void,
): AsyncGenerator<Frame> {
  const overflows: number[] = [];
  for await (const line of boundedLines(stream, {
    maxLineBytes: max,
    // Le découpeur ne rend la main qu'à la ligne suivante : sans rappel
    // immédiat, le client n'apprendrait le rejet qu'au message d'après.
    onOverflow: (bytes) => (onDropped ? onDropped(tooLarge(bytes, max)) : overflows.push(bytes)),
  })) {
    while (overflows.length > 0) yield { error: tooLarge(overflows.shift()!, max), fatal: false };
    if (line.trim().length === 0) continue;
    yield { text: line };
  }
  while (overflows.length > 0) yield { error: tooLarge(overflows.shift()!, max), fatal: false };
}

async function* contentLengthFrames(
  stream: NodeJS.ReadableStream,
  max: number,
): AsyncGenerator<Frame> {
  let buffer = Buffer.alloc(0);
  /** Octets du corps courant restant à JETER (message trop gros). */
  let skipping = 0;
  let skippedTotal = 0;
  /** Longueur du corps attendu, null tant que les en-têtes ne sont pas lus. */
  let expected: number | null = null;

  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    buffer = buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([buffer, bytes]);
    for (;;) {
      if (skipping > 0) {
        const n = Math.min(skipping, buffer.length);
        skipping -= n;
        buffer = buffer.subarray(n);
        if (skipping > 0) break;
        yield { error: tooLarge(skippedTotal, max), fatal: false };
        continue;
      }
      if (expected === null) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (buffer.length > MAX_HEADER_BYTES) {
            yield { error: badHeaders('header block too large'), fatal: true };
            return;
          }
          break;
        }
        const headers = buffer.subarray(0, end).toString('ascii').split('\r\n');
        buffer = buffer.subarray(end + 4);
        let length: number | null = null;
        for (const header of headers) {
          const match = /^([A-Za-z-]+):\s*(.*)$/.exec(header);
          if (!match) {
            yield { error: badHeaders('malformed header line'), fatal: true };
            return;
          }
          if (match[1].toLowerCase() === 'content-length') {
            if (!/^\d{1,10}$/.test(match[2].trim())) {
              yield { error: badHeaders('invalid Content-Length'), fatal: true };
              return;
            }
            length = Number(match[2].trim());
          }
        }
        if (length === null) {
          yield { error: badHeaders('missing Content-Length'), fatal: true };
          return;
        }
        if (length > max) {
          skipping = length;
          skippedTotal = length;
          continue;
        }
        expected = length;
      }
      if (buffer.length < expected) break;
      const body = buffer.subarray(0, expected).toString('utf8');
      buffer = buffer.subarray(expected);
      expected = null;
      yield { text: body };
    }
  }
}

/** Itère les messages d'un flux selon le cadrage choisi. */
export function readFrames(
  stream: NodeJS.ReadableStream,
  framing: Framing,
  max: number = MAX_MESSAGE_BYTES,
  onDropped?: (error: StriartError) => void,
): AsyncGenerator<Frame> {
  return framing === 'ndjson'
    ? ndjsonFrames(stream, max, onDropped)
    : contentLengthFrames(stream, max);
}

/** Encode un message pour le cadrage choisi. */
export function encodeFrame(framing: Framing, message: unknown): string {
  // JSON.stringify n'émet jamais de saut de ligne brut : une ligne = un message.
  const json = JSON.stringify(message);
  if (framing === 'ndjson') return `${json}\n`;
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}
