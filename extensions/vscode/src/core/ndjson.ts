/**
 * Découpage NDJSON borné en mémoire : un message par ligne, jamais plus de
 * `maxBytes` octets en tampon. Un message trop gros est écarté au fil de
 * l'eau (jamais bufferisé) et signalé ; le flux continue au message suivant.
 * Même borne que le serveur (1 Mio).
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface NdjsonHandlers {
  onLine(line: string): void;
  /** Un message a dépassé la borne ; `bytes` = taille totale constatée. */
  onOverflow(bytes: number): void;
}

export class NdjsonDecoder {
  private chunks: Buffer[] = [];
  private pending = 0;
  private discarding = false;
  private discarded = 0;

  private readonly handlers: NdjsonHandlers;
  private readonly maxBytes: number;

  constructor(handlers: NdjsonHandlers, maxBytes: number = MAX_MESSAGE_BYTES) {
    this.handlers = handlers;
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        this.append(chunk.subarray(start));
        return;
      }
      this.append(chunk.subarray(start, newline));
      this.endLine();
      start = newline + 1;
    }
  }

  /** Octets en tampon (pour les tests de bornage). */
  get bufferedBytes(): number {
    return this.pending;
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.discarding) {
      this.discarded += part.length;
      return;
    }
    if (this.pending + part.length > this.maxBytes) {
      this.discarding = true;
      this.discarded = this.pending + part.length;
      this.chunks = [];
      this.pending = 0;
      return;
    }
    this.chunks.push(part);
    this.pending += part.length;
  }

  private endLine(): void {
    if (this.discarding) {
      const bytes = this.discarded;
      this.discarding = false;
      this.discarded = 0;
      this.handlers.onOverflow(bytes);
      return;
    }
    const text = Buffer.concat(this.chunks, this.pending).toString('utf8');
    this.chunks = [];
    this.pending = 0;
    // Tolère le CRLF ; ignore les lignes vides.
    const line = text.endsWith('\r') ? text.slice(0, -1) : text;
    if (line.trim().length > 0) this.handlers.onLine(line);
  }
}

/** Encode un message : une ligne JSON terminée par LF (JSON.stringify n'émet jamais de LF brut). */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
