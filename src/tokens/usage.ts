/**
 * Normalisation des relevés d'usage des fournisseurs (lot T).
 *
 * Champs vérifiés en documentation officielle (2026) :
 *  - Anthropic Messages : `usage.input_tokens` (NON caché, après le dernier
 *    point de cache), `cache_read_input_tokens`, `cache_creation_input_tokens`
 *    (= somme de `cache_creation.ephemeral_5m/1h_input_tokens`),
 *    `output_tokens`. Total d'entrée = input + cache read + cache creation.
 *  - OpenAI-compatible / Azure : `usage.prompt_tokens` (INCLUT le cache),
 *    `prompt_tokens_details.cached_tokens`, `completion_tokens`,
 *    `completion_tokens_details.reasoning_tokens` (sous-ensemble de completion).
 *  - Ollama /api/generate : `prompt_eval_count`, `eval_count`, et — selon la
 *    version — `prompt_eval_cached_count` (jetons de prompt lus du cache).
 *
 * Toute fonction est PURE et tolérante : une valeur absente, négative ou non
 * numérique est ignorée (jamais une exception — le relevé ne doit pas casser
 * l'appel qu'il mesure) ; `null` quand le fournisseur n'a rien rapporté
 * d'exploitable (l'appelant bascule alors sur une estimation marquée telle).
 */
import type { TokenUsage } from '../types.js';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Entier >= 0, sinon `null`. */
export function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/** Jetons d'entrée totaux (cache compris). */
export function totalInput(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** Jetons totaux comptés par les budgets : entrée totale + sortie (le raisonnement est dans la sortie). */
export function totalTokens(u: TokenUsage): number {
  return totalInput(u) + u.output;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** Maximum champ par champ (cumuls rapportés plusieurs fois pour un même message). */
export function maxUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    reasoning: Math.max(a.reasoning, b.reasoning),
  };
}

/** Anthropic Messages (`usage` d'une réponse ou d'un message d'agent Claude Code). */
export function fromAnthropic(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  let cacheWrite = count(usage.cache_creation_input_tokens);
  if (cacheWrite === null && isObject(usage.cache_creation)) {
    const w5 = count(usage.cache_creation.ephemeral_5m_input_tokens) ?? 0;
    const w1 = count(usage.cache_creation.ephemeral_1h_input_tokens) ?? 0;
    cacheWrite = w5 + w1;
  }
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    reasoning: 0,
  };
}

/** Sémantique OpenAI : `prompt` INCLUT `cached` ; `completion` INCLUT `reasoning`. */
function fromOpenAiLike(
  prompt: number | null,
  completion: number | null,
  cached: number | null,
  reasoning: number | null,
): TokenUsage | null {
  if (prompt === null && completion === null) return null;
  const cachedTokens = Math.min(cached ?? 0, prompt ?? 0);
  return {
    input: Math.max(0, (prompt ?? 0) - cachedTokens),
    output: completion ?? 0,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    reasoning: Math.min(reasoning ?? 0, completion ?? 0),
  };
}

/** OpenAI / Azure / endpoints compatibles (`usage` de /chat/completions). */
export function fromOpenAi(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  const promptDetails = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isObject(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  return fromOpenAiLike(
    count(usage.prompt_tokens),
    count(usage.completion_tokens),
    count(promptDetails.cached_tokens),
    count(completionDetails.reasoning_tokens),
  );
}

/** Ollama /api/generate (réponse finale non streamée). */
export function fromOllama(data: unknown): TokenUsage | null {
  if (!isObject(data)) return null;
  const prompt = count(data.prompt_eval_count);
  const output = count(data.eval_count);
  if (prompt === null && output === null) return null;
  return {
    input: prompt ?? 0,
    output: output ?? 0,
    cacheRead: count(data.prompt_eval_cached_count) ?? 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

/** Codex `turn.completed` : `input_tokens` INCLUT `cached_input_tokens` (sémantique OpenAI). */
export function fromCodexTurn(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  return fromOpenAiLike(
    count(usage.input_tokens),
    count(usage.output_tokens),
    count(usage.cached_input_tokens),
    count(usage.reasoning_output_tokens),
  );
}

/** Gemini CLI `result.stats` : `input_tokens` INCLUT `cached`. */
export function fromGeminiStats(stats: unknown): TokenUsage | null {
  if (!isObject(stats)) return null;
  return fromOpenAiLike(
    count(stats.input_tokens),
    count(stats.output_tokens),
    count(stats.cached),
    null,
  );
}

/** ACP `Usage` (PromptResponse, brouillon du protocole) — champs camelCase, tolérant. */
export function fromAcpUsage(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (input === null && output === null) return null;
  const cacheRead = count(usage.cachedReadTokens) ?? 0;
  return {
    // Convention ACP : inputTokens est le total d'entrée (cache lu inclus).
    input: Math.max(0, (input ?? 0) - cacheRead),
    output: output ?? 0,
    cacheRead,
    cacheWrite: count(usage.cachedWriteTokens) ?? 0,
    reasoning: count(usage.thoughtTokens) ?? 0,
  };
}

/**
 * Événement d'usage extrait d'un flux structuré d'agent :
 *  - 'message' : usage d'UN message (Claude `assistant`), répété pour un même
 *    id quand le message est émis en plusieurs blocs → dédupliqué par id ;
 *  - 'turn'    : usage ADDITIF d'un tour (Codex `turn.completed`) ;
 *  - 'total'   : cumul AUTORITAIRE de la session (Claude `result`, Gemini
 *    `result`) — remplace tout cumul partiel, avec le coût si l'outil le donne.
 */
export type StreamUsageEvent =
  | { kind: 'message'; id: string; usage: TokenUsage; model: string | null }
  | { kind: 'turn'; usage: TokenUsage }
  | { kind: 'total'; usage: TokenUsage; costUsd: number | null };
