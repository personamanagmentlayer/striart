/**
 * Conversion des prompts de l'IDE (blocs de contenu ACP) en texte remis à
 * l'agent amont (lot I10). Fonctions PURES.
 *
 * Le texte reste de la DONNÉE : il devient un bloc `text` du protocole côté
 * amont (jamais un argv, jamais un shell). Les références de l'IDE à ses
 * fichiers (`resource_link`, `resource` embarqué) désignent le worktree
 * PRINCIPAL : elles sont réécrites en chemins relatifs au dépôt — l'agent les
 * lit dans SON clone, où les mêmes chemins existent — et le contenu embarqué
 * est cité comme contexte, jamais servi comme accès disque.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BUS_TEXT_CHARS } from '../acp/host-ipc.ts';

export { MAX_BUS_TEXT_CHARS };

/** Contrôles refusés par le bus de l'hôte (host-ipc.ts busTextProblem) — remplacés ici. */
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Chemin lisible d'une URI de l'IDE : relatif au dépôt si c'est un fichier du dépôt. */
export function describeUri(uri: string, root: string): string {
  if (!uri.startsWith('file:')) return uri;
  let absolute: string;
  try {
    absolute = fileURLToPath(uri);
  } catch {
    return uri;
  }
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return uri;
  return relative.split(path.sep).join('/');
}

export type PromptConversion =
  | { ok: true; text: string; replacedControls: number }
  | { ok: false; reason: 'EMPTY' | 'TOO_LONG' | 'UNSUPPORTED_CONTENT'; detail: string };

/**
 * Aplati les blocs d'un `session/prompt` en un texte. Blocs pris en charge :
 * `text`, `resource_link`, `resource` (texte embarqué ; un blob est signalé,
 * jamais transmis). `image`/`audio` ne sont pas annoncés à l'initialize : un
 * client qui en envoie quand même reçoit un refus explicite.
 */
export function promptToText(blocks: unknown, root: string): PromptConversion {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, reason: 'EMPTY', detail: 'the prompt has no content block' };
  }
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isPlainObject(block)) continue;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'resource_link': {
        const uri = typeof block.uri === 'string' ? block.uri : '';
        if (uri) parts.push(`[file: ${describeUri(uri, root)}]`);
        break;
      }
      case 'resource': {
        const resource = isPlainObject(block.resource) ? block.resource : {};
        const uri =
          typeof resource.uri === 'string' ? describeUri(resource.uri, root) : '(resource)';
        if (typeof resource.text === 'string') {
          parts.push(
            `\n--- ${uri} (context attached in the editor) ---\n${resource.text}\n--- end of ${uri} ---\n`,
          );
        } else {
          parts.push(`[binary resource not forwarded: ${uri}]`);
        }
        break;
      }
      default:
        return {
          ok: false,
          reason: 'UNSUPPORTED_CONTENT',
          detail: `content blocks of type "${String(block.type)}" are not supported by Striart`,
        };
    }
  }
  let replaced = 0;
  const text = parts.join('\n').replace(DISALLOWED_CONTROLS, () => {
    replaced += 1;
    return '�';
  });
  if (text.trim().length === 0)
    return { ok: false, reason: 'EMPTY', detail: 'the prompt is empty' };
  if (text.length > MAX_BUS_TEXT_CHARS) {
    return {
      ok: false,
      reason: 'TOO_LONG',
      detail: `the prompt is ${text.length} characters long (limit ${MAX_BUS_TEXT_CHARS}); mention files instead of embedding them`,
    };
  }
  return { ok: true, text, replacedControls: replaced };
}

/**
 * Commandes Striart tapées dans l'IDE, annoncées par `available_commands_update`.
 * Préfixées : elles ne masquent jamais une commande homonyme de l'agent amont
 * (`/status`, `/compact`…), relayée telle quelle.
 */
export const STRIART_COMMANDS = Object.freeze([
  { name: 'striart-finish', kind: 'finish' },
  { name: 'striart-status', kind: 'status' },
] as const);
export type SlashCommand = (typeof STRIART_COMMANDS)[number]['kind'];

export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  return STRIART_COMMANDS.find((c) => trimmed === `/${c.name}`)?.kind ?? null;
}
