import { fromAnthropic, fromCodexTurn, fromGeminiStats } from '../tokens/usage.ts';
import type { StreamUsageEvent } from '../tokens/usage.ts';
import type { StructuredOutputFormat } from '../types.js';

/**
 * Transcription lisible de la sortie STRUCTURÉE d'une session argv
 * (`--output-format stream-json`, `codex exec --json`…) pour le log de
 * session. Même gain d'observabilité que le transport ACP (`formatSessionUpdate`
 * dans acp.ts) : le log raconte le déroulé — messages, appels d'outils,
 * commandes, fichiers modifiés, issue — au lieu d'un mur de JSON.
 *
 * Contrat de fidélité : rien n'est perdu. Une ligne qui n'est pas du JSON
 * (stderr entrelacé, bannière, trace d'erreur) est recopiée telle quelle ;
 * un objet JSON d'un type inconnu est rendu en JSON compact ; seules les
 * sorties d'outils volumineuses sont tronquées (le flux brut complet est
 * conservé à part par session.js). Fonction pure, sans E/S.
 */

/** Longueur max d'une sortie d'outil citée dans la transcription. */
export const TOOL_OUTPUT_MAX_CHARS = 2000;

export const STRUCTURED_OUTPUT_FORMATS: readonly StructuredOutputFormat[] = [
  'none',
  'claude-stream-json',
  'codex-jsonl',
  'gemini-stream-json',
  'ndjson',
];

type Json = Record<string, unknown>;

function truncate(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} caractères tronqués]`;
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    // Valeur non sérialisable (cycle) : sa forme textuelle suffit au log.
    return String(value);
  }
}

/** Texte d'un bloc de contenu (chaîne, {text}, ou tableau de blocs). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n');
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Claude Code `--output-format stream-json` (exige `--verbose` en mode -p). */
function formatClaude(event: Json): string | null | undefined {
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        const model = typeof event.model === 'string' ? ` — modèle ${event.model}` : '';
        return `[session] démarrée${model}`;
      }
      return null;
    case 'assistant':
    case 'user': {
      const message = isObject(event.message) ? event.message : {};
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      const lines: string[] = [];
      for (const block of blocks) {
        if (typeof block === 'string') {
          if (event.type === 'assistant') lines.push(block);
          continue;
        }
        if (!isObject(block)) continue;
        if (block.type === 'text' && event.type === 'assistant') lines.push(str(block.text));
        else if (block.type === 'tool_use') {
          lines.push(`[outil] ${str(block.name)} ${truncate(str(block.input), 500)}`);
        } else if (block.type === 'tool_result') {
          const status = block.is_error === true ? 'erreur' : 'ok';
          const output = truncate(contentText(block.content));
          lines.push(`[outil] → ${status}${output ? `\n${output}` : ''}`);
        }
        // thinking / redacted_thinking : raisonnement interne, bruit au log.
      }
      return lines.length > 0 ? lines.join('\n') : null;
    }
    case 'result': {
      const outcome = event.is_error === true ? 'échec' : str(event.subtype) || 'terminé';
      const parts = [`[résultat] ${outcome}`];
      if (typeof event.num_turns === 'number') parts.push(`${event.num_turns} tours`);
      if (typeof event.duration_ms === 'number') parts.push(`${event.duration_ms} ms`);
      if (typeof event.total_cost_usd === 'number') parts.push(`$${event.total_cost_usd}`);
      const summary = parts.join(' — ');
      const text = typeof event.result === 'string' ? `\n${event.result}` : '';
      return `${summary}${text}`;
    }
    default:
      return undefined;
  }
}

/** Codex `codex exec --json` (JSONL : thread/turn/item). */
function formatCodex(event: Json): string | null | undefined {
  const item = isObject(event.item) ? event.item : null;
  switch (event.type) {
    case 'thread.started':
      return `[session] démarrée${event.thread_id ? ` (${str(event.thread_id)})` : ''}`;
    case 'turn.started':
      return null;
    case 'turn.completed': {
      const usage = isObject(event.usage) ? event.usage : null;
      const tokens =
        usage && typeof usage.output_tokens === 'number'
          ? ` — ${str(usage.input_tokens)} in / ${usage.output_tokens} out`
          : '';
      return `[tour] terminé${tokens}`;
    }
    case 'turn.failed':
      return `[tour] échec : ${str(isObject(event.error) ? event.error.message : event.error)}`;
    case 'error':
      return `[erreur] ${str(event.message)}`;
    case 'item.started':
    case 'item.updated':
      // Seule la complétion d'un item porte son résultat ; le démarrage
      // d'une commande est utile pour suivre une session bloquée.
      if (event.type === 'item.started' && item?.type === 'command_execution') {
        return `[commande] ${str(item.command)}`;
      }
      return null;
    case 'item.completed': {
      if (!item) return null;
      switch (item.type) {
        case 'agent_message':
          return str(item.text);
        case 'reasoning':
          return null;
        case 'command_execution': {
          const code = item.exit_code === undefined ? '' : ` (code ${str(item.exit_code)})`;
          const output = truncate(str(item.aggregated_output));
          return `[commande] ${str(item.command)} → ${str(item.status)}${code}${output ? `\n${output}` : ''}`;
        }
        case 'file_change': {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          const files = changes
            .map((c) => (isObject(c) ? `${str(c.kind)} ${str(c.path)}` : str(c)))
            .join(', ');
          return `[fichiers] ${files || '(aucun détail)'} — ${str(item.status)}`;
        }
        case 'mcp_tool_call':
          return `[outil MCP] ${str(item.server)}/${str(item.tool)} → ${str(item.status)}`;
        case 'error':
          return `[erreur] ${str(item.message)}`;
        default:
          return `[${str(item.type)}] ${truncate(str(item), 500)}`;
      }
    }
    default:
      return undefined;
  }
}

/** Gemini CLI `--output-format stream-json`. */
function formatGemini(event: Json): string | null | undefined {
  switch (event.type) {
    case 'init':
      return `[session] démarrée${event.model ? ` — modèle ${str(event.model)}` : ''}`;
    case 'message':
      // Le message utilisateur est l'écho du prompt : déjà connu.
      return event.role === 'assistant' ? contentText(event.content) || null : null;
    case 'tool_use':
      return `[outil] ${str(event.tool_name)} ${truncate(str(event.parameters), 500)}`;
    case 'tool_result': {
      const output = truncate(
        str(event.output ?? (isObject(event.error) ? event.error.message : '')),
      );
      return `[outil] → ${str(event.status)}${output ? `\n${output}` : ''}`;
    }
    case 'error':
      return `[erreur] ${str(event.message)}`;
    case 'result':
      return `[résultat] ${str(event.status)}${event.stats ? ` — ${truncate(str(event.stats), 300)}` : ''}`;
    default:
      return undefined;
  }
}

/** NDJSON générique : un objet par ligne, rendu par son `type` quand il en a un. */
function formatGeneric(event: Json): string {
  const type = typeof event.type === 'string' ? event.type : 'événement';
  return `[${type}] ${truncate(str(event), 500)}`;
}

const FORMATTERS: Record<
  Exclude<StructuredOutputFormat, 'none' | 'ndjson'>,
  (event: Json) => string | null | undefined
> = {
  'claude-stream-json': formatClaude,
  'codex-jsonl': formatCodex,
  'gemini-stream-json': formatGemini,
};

/**
 * Rend une ligne d'événement. `undefined` d'un formateur spécialisé = type
 * inconnu de lui → rendu générique (jamais d'événement perdu) ; `null` =
 * événement connu et volontairement muet (écho, raisonnement interne).
 */
function formatEvent(format: StructuredOutputFormat, event: Json): string | null {
  if (format === 'ndjson' || format === 'none') return formatGeneric(event);
  const rendered = FORMATTERS[format](event);
  if (rendered === undefined) return formatGeneric(event);
  return rendered;
}

/**
 * Transcrit une sortie brute (stdout+stderr entrelacés) selon le format
 * structuré déclaré par le profil. `'none'` rend la sortie inchangée.
 */
export function transcribeStructuredOutput(format: StructuredOutputFormat, raw: string): string {
  if (format === 'none') return raw;
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith('{')) {
      out.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Ligne qui ressemble à du JSON sans en être (trace, JSON tronqué par
      // un kill) : recopiée telle quelle, c'est souvent la plus utile.
      out.push(line);
      continue;
    }
    if (!isObject(parsed)) {
      out.push(line);
      continue;
    }
    const rendered = formatEvent(format, parsed);
    if (rendered) out.push(rendered);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Relevé d'usage du flux structuré (lot T)
// ---------------------------------------------------------------------------

/**
 * Événement d'usage porté par UNE ligne d'un flux structuré, ou `null`.
 * Champs vérifiés dans les documentations officielles des outils :
 *  - Claude Code `stream-json` : `assistant` → `message.id` + `message.usage`
 *    (répété quand un message est émis en plusieurs blocs → dédupliqué par id),
 *    `result` → `usage` cumulé + `total_cost_usd` (coût que l'outil rapporte) ;
 *  - Codex `exec --json` : `turn.completed` → `usage` (`input_tokens` inclut
 *    `cached_input_tokens`) ;
 *  - Gemini CLI `stream-json` : `result` → `stats` (`input_tokens`,
 *    `output_tokens`, `cached`).
 * Tolérant : un champ absent ou mal typé donne `null`, jamais une exception.
 */
export function extractStreamUsage(
  format: StructuredOutputFormat,
  event: Record<string, unknown>,
): StreamUsageEvent | null {
  switch (format) {
    case 'claude-stream-json': {
      if (event.type === 'assistant' && isObject(event.message)) {
        const usage = fromAnthropic(event.message.usage);
        const id = typeof event.message.id === 'string' ? event.message.id : null;
        if (!usage || !id) return null;
        const model = typeof event.message.model === 'string' ? event.message.model : null;
        return { kind: 'message', id, usage, model };
      }
      if (event.type === 'result') {
        const usage = fromAnthropic(event.usage);
        if (!usage) return null;
        const cost = event.total_cost_usd;
        return {
          kind: 'total',
          usage,
          costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
        };
      }
      return null;
    }
    case 'codex-jsonl': {
      if (event.type !== 'turn.completed') return null;
      const usage = fromCodexTurn(event.usage);
      return usage ? { kind: 'turn', usage } : null;
    }
    case 'gemini-stream-json': {
      if (event.type !== 'result') return null;
      const usage = fromGeminiStats(event.stats);
      return usage ? { kind: 'total', usage, costUsd: null } : null;
    }
    default:
      return null;
  }
}
