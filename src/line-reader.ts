import { StriartError } from './errors.ts';

/**
 * Découpeur de lignes BORNÉ pour les flux d'octets non fiables (stdin du
 * serveur MCP, stdout d'un agent ACP, flux pty…).
 *
 * Pourquoi pas `readline` : readline accumule la ligne ENTIÈRE avant de la
 * livrer. Une borne appliquée après coup (`line.length > N`) est illusoire —
 * un flux inondé sans « \n » a déjà fait gonfler le tampon jusqu'à l'OOM.
 * Ici, dès que la ligne courante dépasse `maxLineBytes`, ses octets sont
 * JETÉS au fil de l'eau (rien n'est conservé) jusqu'au prochain « \n » ;
 * `onOverflow` reçoit alors le nombre d'octets écartés, et la ligne n'est
 * jamais émise.
 *
 * Sûreté UTF-8 : le découpage se fait sur l'octet 0x0A, qui n'apparaît
 * JAMAIS à l'intérieur d'une séquence multi-octets UTF-8 (les octets de
 * continuation valent 0x80–0xBF). Chaque ligne est décodée en une fois, sur
 * ses octets complets : un caractère coupé entre deux chunks est recollé
 * avant décodage. Le « \r » final d'un « \r\n » est retiré.
 *
 * Contre-pression : l'itération asynchrone sur le flux ne lit le chunk
 * suivant que lorsque le consommateur redemande une ligne — un consommateur
 * lent ralentit la lecture au lieu de remplir la mémoire.
 */

/** Encodages orientés octet, où 0x0A est toujours un saut de ligne. */
const BYTE_ORIENTED_ENCODINGS: ReadonlySet<string> = new Set([
  'utf8',
  'utf-8',
  'latin1',
  'binary',
  'ascii',
]);

const LF = 0x0a;
const CR = 0x0d;

export interface BoundedLinesOptions {
  /** Taille maximale d'une ligne, en octets, saut de ligne exclu. */
  maxLineBytes: number;
  /** Appelé pour chaque ligne écartée, avec le nombre d'octets jetés. */
  onOverflow?: (droppedBytes: number) => void;
  /** Décodage des lignes émises (défaut utf8 ; encodages orientés octet seulement). */
  encoding?: BufferEncoding;
}

function toBuffer(chunk: unknown, encoding: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
  throw new StriartError('boundedLines received a non-byte chunk from the stream.', {
    code: 'INVALID_ARGUMENT',
    hint: 'Pass a byte or string stream (not an object-mode stream).',
  });
}

/**
 * Itère les lignes d'un flux, en écartant sans les retenir celles qui
 * dépassent `maxLineBytes`. La dernière ligne sans « \n » final est émise
 * à la fin du flux (si elle respecte la borne).
 */
export function boundedLines(
  stream: NodeJS.ReadableStream,
  options: BoundedLinesOptions,
): AsyncIterable<string> {
  const { maxLineBytes, onOverflow, encoding = 'utf8' } = options;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new StriartError('boundedLines needs a positive integer maxLineBytes.', {
      code: 'INVALID_ARGUMENT',
      details: { maxLineBytes: String(maxLineBytes) },
    });
  }
  if (!BYTE_ORIENTED_ENCODINGS.has(encoding)) {
    throw new StriartError(`boundedLines cannot split lines in encoding "${encoding}".`, {
      code: 'INVALID_ARGUMENT',
      hint: 'Use utf8 (default), latin1 or ascii.',
    });
  }

  return {
    async *[Symbol.asyncIterator]() {
      /** Morceaux de la ligne courante (bornée à maxLineBytes + 1 octet de « \r » éventuel). */
      let pieces: Buffer[] = [];
      let pendingBytes = 0;
      /** Vrai tant que la ligne courante a débordé : ses octets sont jetés. */
      let dropping = false;
      let droppedBytes = 0;

      const finishLine = (): string | null => {
        if (dropping) {
          dropping = false;
          const dropped = droppedBytes;
          droppedBytes = 0;
          onOverflow?.(dropped);
          return null;
        }
        let line = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, pendingBytes);
        pieces = [];
        pendingBytes = 0;
        if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, -1);
        // Le « \r » retiré, la borne s'applique au contenu réel.
        if (line.length > maxLineBytes) {
          onOverflow?.(line.length);
          return null;
        }
        return line.toString(encoding);
      };

      const append = (segment: Buffer) => {
        if (segment.length === 0) return;
        if (dropping) {
          droppedBytes += segment.length;
          return;
        }
        // +1 : tolère le « \r » d'un « \r\n » qui serait coupé juste avant le « \n ».
        if (pendingBytes + segment.length > maxLineBytes + 1) {
          dropping = true;
          droppedBytes = pendingBytes + segment.length;
          pieces = [];
          pendingBytes = 0;
          return;
        }
        // Copie : le tampon du chunk peut être recyclé par le flux.
        pieces.push(Buffer.from(segment));
        pendingBytes += segment.length;
      };

      for await (const chunk of stream) {
        const buf = toBuffer(chunk, encoding);
        let start = 0;
        for (;;) {
          const nl = buf.indexOf(LF, start);
          if (nl === -1) {
            append(buf.subarray(start));
            break;
          }
          append(buf.subarray(start, nl));
          const line = finishLine();
          if (line !== null) yield line;
          start = nl + 1;
        }
      }
      if (dropping || pendingBytes > 0) {
        const line = finishLine();
        if (line !== null) yield line;
      }
    },
  };
}
