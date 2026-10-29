import { setTimeout as sleep } from 'node:timers/promises';
import { StriartError } from './errors.ts';
import { logger } from './logger.ts';
import { isLoopbackHost, netFetch } from './net.ts';
import { llmConfigForRole } from './orchestration/llm-roles.ts';
import { LLM_ROLE_NAMES } from './orchestration/settings.ts';
import {
  LlmCallError,
  backoffDelay,
  breakerAdmit,
  breakerFailure,
  breakerKey,
  breakerRelease,
  breakerSuccess,
  circuitOpenError,
  isRetryableStatus,
  parseRetryAfter,
  resolveLlmResilience,
} from './llm-resilience.ts';
import { cacheDelete, cacheGet, cacheKey, cachePut } from './tokens/cache.ts';
import {
  openCallScope,
  preflight,
  recordCacheHit,
  recordCall,
  recordRefusal,
} from './tokens/call.ts';
import { ACCOUNTING_FAILED_CODE, logAccountingFailure } from './tokens/accounting-error.ts';
import { resolveTokensSettings } from './tokens/settings.ts';
import { fromAnthropic, fromOllama, fromOpenAi } from './tokens/usage.ts';

/**
 * Couche provider LLM : le Router et le Merger ne connaissent que
 * llmGenerate(). Le provider concret (Ollama local, endpoint
 * OpenAI-compatible, Anthropic) est choisi via striart.config :
 *
 *   llm: {
 *     provider: 'ollama' | 'openai' | 'anthropic',
 *     model: 'llama3.1:8b',
 *     baseUrl: 'http://localhost:11434',   // optionnel, défaut par provider
 *     apiKeyEnv: 'OPENAI_API_KEY',         // nom de variable d'env, JAMAIS la clé elle-même
 *   }
 *
 * 'openai' couvre tout endpoint compatible /chat/completions : OpenAI,
 * Mistral, Groq, DeepSeek, Together, Fireworks, OpenRouter, xAI, Perplexity,
 * Gemini et Cohere (via leurs endpoints compatibles), LM Studio, vLLM,
 * llama.cpp, TGI, LiteLLM (proxy vers Bedrock/Vertex)... — voir .env.example.
 * 'azure' gère l'auth api-key + URLs par deployment d'Azure OpenAI.
 *
 * Lot T : chaque appel est COMPTÉ (usage réel du fournisseur → registre
 * `.striart/usage/`), plafonné par les budgets `tokens.budgets` AVANT envoi,
 * et résilient (erreurs classées, backoff à gigue complète, Retry-After,
 * disjoncteur par fournisseur — voir llm-resilience.ts).
 */
export const LLM_PROVIDERS = ['ollama', 'openai', 'anthropic', 'azure'];

const AZURE_DEFAULT_API_VERSION = '2024-10-21';

const PROVIDER_DEFAULTS = {
  ollama: { baseUrl: 'http://localhost:11434', apiKeyEnv: null },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  // Azure : pas de baseUrl par défaut — l'endpoint de la ressource est requis
  // (https://<ressource>.openai.azure.com) et model = nom du deployment.
  azure: { baseUrl: null, apiKeyEnv: 'AZURE_OPENAI_API_KEY' },
};

/** max_tokens par défaut d'Anthropic (champ obligatoire de l'API). */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Garde de l'exfiltration de secrets (S-M5). `llm.baseUrl` et `llm.apiKeyEnv`
// viennent de la config du dépôt, donc potentiellement d'un dépôt hostile : sans
// garde, `apiKeyEnv: 'GITHUB_TOKEN'` + `baseUrl: 'https://evil.example'` enverrait
// n'importe quelle variable d'environnement en `Authorization: Bearer`.
// ---------------------------------------------------------------------------

/** Forme d'un nom de variable de clé d'API : *_API_KEY, *_KEY ou *_TOKEN. */
const API_KEY_ENV_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_(API_KEY|KEY|TOKEN)$/;
/** Variables d'environnement qui ne sont JAMAIS une clé de LLM (identifiants d'infrastructure). */
const API_KEY_ENV_DENY =
  /^(GITHUB|GH|GITLAB|NPM|AWS|SSH|GCP|GOOGLE_APPLICATION|KUBE|DOCKER|CI|STRIART|PYPI|TWINE|CARGO|HEROKU|VERCEL|NETLIFY|CLOUDFLARE|STRIPE|SLACK|DISCORD)(_|$)|^AZURE_(?!OPENAI_)|^(HOME|PATH)$/;

/**
 * Le nom doit avoir la forme d'une clé d'API ET ne pas désigner un secret
 * d'infrastructure. `allowAny` (option `llm.allowAnyApiKeyEnv`) lève la
 * restriction — décision explicite de l'utilisateur, affichée par doctor.
 */
function assertSafeApiKeyEnv(name, allowAny) {
  if (allowAny) return;
  const problem =
    typeof name !== 'string' || !API_KEY_ENV_RE.test(name)
      ? 'FORM'
      : API_KEY_ENV_DENY.test(name)
        ? 'DENYLISTED'
        : null;
  if (!problem) return;
  throw new StriartError(
    `llm.apiKeyEnv : "${String(name).slice(0, 64)}" n'est pas accepté (${problem === 'FORM' ? 'attendu : un nom en MAJUSCULES terminé par _API_KEY, _KEY ou _TOKEN' : 'secret d’infrastructure, jamais une clé de LLM'}). Une config de dépôt pourrait sinon exfiltrer n'importe quelle variable d'environnement.`,
    {
      code: 'LLM_CONFIG_INVALID',
      hint: 'striart doctor',
      details: { reason: problem === 'FORM' ? 'API_KEY_ENV_FORM' : 'API_KEY_ENV_DENYLISTED' },
    },
  );
}

const warnedHosts = new Set();

/**
 * Une clé n'est envoyée qu'en HTTPS (ou vers la boucle locale) ; un hôte qui
 * n'est pas celui du fournisseur est journalisé une fois (proxy légitime ou
 * détournement : l'utilisateur le voit).
 */
function assertKeySafeBaseUrl(provider, baseUrl, allowInsecure) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new StriartError('llm.baseUrl n’est pas une URL valide.', {
      code: 'LLM_CONFIG_INVALID',
      hint: 'striart doctor',
      details: { reason: 'BASE_URL_INVALID', provider },
    });
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !loopback && !allowInsecure) {
    throw new StriartError(
      `llm.baseUrl : la clé d'API ne part pas en clair vers ${url.hostname} (HTTPS requis hors boucle locale).`,
      {
        code: 'LLM_CONFIG_INVALID',
        hint: 'Utilise https:// ; pour un hôte interne en clair : llm.allowInsecureTransport: true ET l’hôte dans network.allowInsecureHosts (config utilisateur), en connaissance de cause.',
        details: { reason: 'INSECURE_BASE_URL', provider, host: url.hostname },
      },
    );
  }
  const defaultHost = PROVIDER_DEFAULTS[provider]?.baseUrl
    ? new URL(PROVIDER_DEFAULTS[provider].baseUrl).hostname
    : null;
  const key = `${provider}@${url.hostname}`;
  if (defaultHost !== url.hostname && !loopback && !warnedHosts.has(key)) {
    warnedHosts.add(key);
    logger.warn(
      { provider, host: url.hostname },
      'LLM: the API key is sent to a host that is not the provider’s own (proxy or gateway?). Check llm.baseUrl.',
    );
  }
}

export function resolveLlmConfig(config) {
  const llm = config.llm ?? {};
  const provider = llm.provider ?? 'ollama';
  if (!LLM_PROVIDERS.includes(provider)) {
    throw new StriartError(
      `Provider LLM inconnu : "${provider}". Providers supportés : ${LLM_PROVIDERS.join(', ')}.`,
      {
        code: 'LLM_CONFIG_INVALID',
        hint: 'striart doctor',
        details: { reason: 'UNKNOWN_PROVIDER', provider, supported: LLM_PROVIDERS },
      },
    );
  }
  const defaults = PROVIDER_DEFAULTS[provider];

  // Rétro-compatibilité : ollamaModel / ollamaHost restent la façon simple
  // de configurer le provider par défaut.
  const model = llm.model ?? (provider === 'ollama' ? config.ollamaModel : null);
  if (!model) {
    throw new StriartError(
      `Aucun modèle configuré pour le provider "${provider}". Renseigne llm.model dans striart.config.`,
      {
        code: 'LLM_CONFIG_INVALID',
        hint: 'striart doctor',
        details: { reason: 'NO_MODEL', provider },
      },
    );
  }

  const rawBaseUrl = llm.baseUrl ?? (provider === 'ollama' ? config.ollamaHost : defaults.baseUrl);
  if (!rawBaseUrl) {
    throw new StriartError(
      `Le provider "${provider}" exige llm.baseUrl (ex: https://ma-ressource.openai.azure.com).`,
      {
        code: 'LLM_CONFIG_INVALID',
        hint: 'striart doctor',
        details: { reason: 'NO_BASE_URL', provider },
      },
    );
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const apiKeyEnv = llm.apiKeyEnv ?? defaults.apiKeyEnv;
  if (llm.apiKeyEnv != null) assertSafeApiKeyEnv(llm.apiKeyEnv, llm.allowAnyApiKeyEnv === true);
  const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? null) : null;
  if (apiKey) assertKeySafeBaseUrl(provider, baseUrl, llm.allowInsecureTransport === true);
  const apiVersion = llm.apiVersion ?? (provider === 'azure' ? AZURE_DEFAULT_API_VERSION : null);

  return { provider, model, baseUrl, apiKeyEnv, apiKey, apiVersion };
}

function requireApiKey(resolved) {
  if (!resolved.apiKey) {
    throw new StriartError(
      `Clé API manquante pour le provider "${resolved.provider}" : définis la variable d'environnement ${resolved.apiKeyEnv} (par exemple dans un fichier .env).`,
      {
        code: 'LLM_CONFIG_INVALID',
        hint: 'striart doctor',
        // Le NOM de la variable seulement, jamais sa valeur.
        details: {
          reason: 'NO_API_KEY',
          provider: resolved.provider,
          apiKeyEnv: resolved.apiKeyEnv,
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Requêtes par fournisseur. Chacune rend { text, usage } où `usage` est l'usage
// RÉEL rapporté par le fournisseur (TokenUsage normalisé) ou null. Une sortie
// coupée par la limite de longueur est une ERREUR (jamais acceptée en silence :
// un code fusionné tronqué est pire qu'un échec franc).
// ---------------------------------------------------------------------------

/** Erreur HTTP : retentable ou non selon le statut, Retry-After conservé. */
function httpError(label, res) {
  const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after') ?? null);
  return new LlmCallError(`${label} a répondu HTTP ${res.status}`, {
    status: res.status,
    retryAfterMs,
    retryable: isRetryableStatus(res.status),
    causeCode: res.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX',
  });
}

function truncatedError(label) {
  return new LlmCallError(
    `${label} : réponse coupée par la limite de longueur de sortie (plafond tokens.budgets.perCall.maxOutputTokens ou limite du modèle)`,
    { retryable: false, providerFault: false, causeCode: 'TRUNCATED' },
  );
}

/**
 * Échec du relevé d'un appel : un refus demandé (tokens.onAccountingError
 * 'fail') se propage ; toute autre panne est journalisée avec un code stable
 * — la réponse d'un appel déjà payé n'est pas perdue pour autant.
 */
function accountingCatch(error) {
  if (error instanceof StriartError && error.code === ACCOUNTING_FAILED_CODE) throw error;
  logAccountingFailure(error, 'llm-call-record');
}

// Tous les appels passent par src/net.ts : redirect 'error' imposé (x-api-key / api-key /
// Authorization ne partent jamais vers un hôte cible de redirection, S-M5), HTTPS hors
// boucle locale, liste blanche d'hôtes, mode offline, proxy et CA d'entreprise.
async function requestOllama(resolved, { prompt, format, signal, maxOutputTokens }) {
  const res = await netFetch(`${resolved.baseUrl}/api/generate`, {
    purpose: 'llm',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: resolved.model,
      prompt,
      stream: false,
      ...(format && { format }),
      ...(maxOutputTokens && { options: { num_predict: maxOutputTokens } }),
    }),
    signal,
  });
  if (!res.ok) throw httpError('Ollama', res);
  const data = await res.json();
  if (typeof data.response !== 'string') {
    throw new Error('la réponse Ollama ne contient pas de champ "response"');
  }
  if (data.done_reason === 'length') throw truncatedError('Ollama');
  return { text: data.response, usage: fromOllama(data) };
}

/** OpenAI exige max_completion_tokens (les modèles de raisonnement refusent max_tokens) ; les autres serveurs compatibles ne connaissent que max_tokens. */
function openAiMaxTokensField(resolved) {
  if (resolved.provider === 'azure') return 'max_completion_tokens';
  try {
    return new URL(resolved.baseUrl).hostname === 'api.openai.com'
      ? 'max_completion_tokens'
      : 'max_tokens';
  } catch {
    return 'max_tokens';
  }
}

function parseChatCompletion(label, data) {
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('la réponse ne contient pas choices[0].message.content');
  }
  if (choice.finish_reason === 'length') throw truncatedError(label);
  if (choice.finish_reason === 'content_filter') {
    throw new LlmCallError(`${label} : réponse filtrée par le fournisseur (content_filter)`, {
      retryable: false,
      providerFault: false,
      causeCode: 'FILTERED',
    });
  }
  return { text, usage: fromOpenAi(data.usage) };
}

async function requestOpenAi(resolved, { prompt, format, signal, maxOutputTokens }) {
  const res = await netFetch(`${resolved.baseUrl}/chat/completions`, {
    purpose: 'llm',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      messages: [{ role: 'user', content: prompt }],
      ...(format === 'json' && { response_format: { type: 'json_object' } }),
      ...(maxOutputTokens && { [openAiMaxTokensField(resolved)]: maxOutputTokens }),
    }),
    signal,
  });
  if (!res.ok) throw httpError(`L'API`, res);
  return parseChatCompletion(`L'API`, await res.json());
}

/**
 * Anthropic Messages. Avec un préfixe stable (`stablePrefix`, préfixe EXACT
 * du prompt) et le cache de prompt activé, le préfixe est un bloc marqué
 * `cache_control` et la partie variable un bloc à part : le préfixe est lu au
 * cache (0,1× le tarif d'entrée, 0,05× sur les modèles récents) aux appels
 * suivants. Sous le minimum cacheable du modèle l'API ignore le marqueur sans
 * erreur ; `promptCache.minPrefixTokens` évite de le poser inutilement.
 */
async function requestAnthropic(resolved, { prompt, signal, maxOutputTokens, cacheControl }) {
  // Pas de mode JSON natif : les prompts exigent déjà le format, et
  // `transform` valide/retente côté appelant.
  let content = prompt;
  if (cacheControl) {
    const { prefix, ttl } = cacheControl;
    content = [
      {
        type: 'text',
        text: prefix,
        cache_control: { type: 'ephemeral', ...(ttl === '1h' && { ttl }) },
      },
      ...(prompt.length > prefix.length
        ? [{ type: 'text', text: prompt.slice(prefix.length) }]
        : []),
    ];
  }
  const res = await netFetch(`${resolved.baseUrl}/v1/messages`, {
    purpose: 'llm',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': resolved.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: resolved.model,
      max_tokens: maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content }],
    }),
    signal,
  });
  if (!res.ok) throw httpError(`L'API Anthropic`, res);
  const data = await res.json();
  const text =
    data.content?.find?.((block) => block?.type === 'text')?.text ?? data.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('la réponse ne contient pas content[0].text');
  }
  if (data.stop_reason === 'max_tokens') throw truncatedError(`L'API Anthropic`);
  if (data.stop_reason === 'refusal') {
    throw new LlmCallError(`L'API Anthropic a refusé la requête (stop_reason: refusal)`, {
      retryable: false,
      providerFault: false,
      causeCode: 'REFUSED',
    });
  }
  return { text, usage: fromAnthropic(data.usage) };
}

async function requestAzure(resolved, { prompt, format, signal, maxOutputTokens }) {
  // Azure OpenAI : URL par deployment (model = nom du deployment),
  // auth par header api-key (le Bearer est réservé aux tokens Entra).
  // model et apiVersion viennent de la config : encodés, jamais concaténés bruts
  // (un « ../ » ou un « & » ne doit pas réécrire le chemin ni la requête).
  const url = `${resolved.baseUrl}/openai/deployments/${encodeURIComponent(resolved.model)}/chat/completions?api-version=${encodeURIComponent(resolved.apiVersion)}`;
  const res = await netFetch(url, {
    purpose: 'llm',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': resolved.apiKey,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      ...(format === 'json' && { response_format: { type: 'json_object' } }),
      ...(maxOutputTokens && { max_completion_tokens: maxOutputTokens }),
    }),
    signal,
  });
  if (!res.ok) throw httpError('Azure OpenAI', res);
  return parseChatCompletion('Azure OpenAI', await res.json());
}

const REQUESTS = {
  ollama: requestOllama,
  openai: requestOpenAi,
  anthropic: requestAnthropic,
  azure: requestAzure,
};

/**
 * Substitue les placeholders {{clé}} d'un template de prompt par leurs
 * valeurs — split/join, pas de regex : les valeurs sont de la DONNÉE
 * (contenu de fichiers, logs) qui peut contenir n'importe quoi, y compris
 * des séquences qu'une regex de remplacement interpréterait ($&, $1…).
 * Toutes les occurrences sont remplacées. Même philosophie que la
 * substitution d'argv de session.js : la donnée reste de la donnée.
 *
 * @param {string} template
 * @param {Record<string, string>} vars clé SANS moustaches → valeur
 * @returns {string}
 */
export function fillPromptTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

/**
 * Déballe un JSON rendu dans UN bloc de code markdown (```json … ```). Les
 * fournisseurs sans mode JSON natif (Anthropic) enrobent volontiers leur réponse
 * malgré la consigne « uniquement du JSON » ; la rejeter coûterait un appel payant
 * (observé avec claude-haiku sur le Router : 4 échecs sur 4). Strictement
 * limité à un bloc unique couvrant TOUTE la réponse : rien d'autre n'est deviné
 * (texte autour, plusieurs blocs → inchangé, et `transform` rejette comme avant).
 *
 * @param {string} text
 * @returns {string}
 */
export function unwrapJsonResponse(text) {
  const match = /^\s*```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/.exec(text);
  if (!match || match[1].includes('```')) return text;
  return match[1];
}

/**
 * Message d'erreur SANS donnée sensible : une URL peut porter des identifiants
 * (userinfo, jeton en query) et un message d'erreur de bibliothèque HTTP
 * recopie souvent l'URL ou un fragment de clé. On n'expose que le motif.
 */
export function sanitizeErrorText(text) {
  return String(text ?? '')
    .replace(/\bhttps?:\/\/[^\s)'"]+/gi, '<url>')
    .replace(/\b(?:sk|pk|key|api|token|bearer)[-_ ]?[A-Za-z0-9_\-.]{12,}/gi, '<redacted>')
    .slice(0, 300);
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/** Une erreur quelconque d'un appel → LlmCallError classée (réseau et délai retentables). */
function classifyError(error) {
  if (error instanceof LlmCallError) return error;
  const name = error?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new LlmCallError('délai dépassé', { retryable: true, causeCode: 'TIMEOUT' });
  }
  if (error instanceof TypeError) {
    // fetch() lève un TypeError pour toute panne de transport (DNS, refus, reset).
    const detail = (error.cause as { code?: string } | undefined)?.code ?? error.message;
    return new LlmCallError(`panne de transport (${detail})`, {
      retryable: true,
      causeCode: 'TRANSPORT',
      causeDetail: sanitizeErrorText(detail).slice(0, 80),
    });
  }
  // Réponse 200 mal formée / champ manquant : retentée (comportement historique),
  // sans incriminer la disponibilité du fournisseur. Un JSON illisible (corps du fournisseur ou
  // sortie validée par `transform`) est distingué des autres malformations.
  return new LlmCallError(error?.message ?? String(error), {
    retryable: true,
    providerFault: false,
    causeCode: error instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_RESPONSE',
  });
}

/**
 * Appel LLM générique, encapsulé avec timeout + retry (un LLM local peut
 * être lent au cold-start, un LLM cloud peut rate-limiter). `transform`
 * valide/parse la réponse DANS la boucle de retry : une réponse malformée
 * compte comme une tentative échouée et est retentée.
 *
 * Paramètres de comptabilité (lot T, tous facultatifs, rétro-compatibles) :
 *  - `role` : 'router' | 'merger' | 'memory' | 'judge' | 'review' — sélectionne
 *    le LLM du rôle (`config.llmRoles`) et classe l'usage au registre ;
 *  - `root`, `agent`, `taskId` : attribution (sinon contexte asynchrone
 *    `withTokenContext`, sinon racine retrouvée depuis le dépôt courant) ;
 *  - `stablePrefix` : début EXACT du prompt, identique d'un appel à l'autre
 *    (instructions + données stables) — marqué pour le cache de prompt ;
 *  - `maxOutputTokens` : sortie maximale demandée (le plafond
 *    `perCall.maxOutputTokens` la borne) ;
 *  - `resultCache` : `{ promptVersion, material }` — active le cache local
 *    de résultats idempotents pour ce rôle (si la config l'autorise).
 */
export async function llmGenerate({
  config,
  prompt,
  format = null,
  timeoutMs = 60_000,
  retries = 2,
  retryDelayMs = null,
  transform = (response) => response,
  errorCode = 'LLM_FAILED',
  errorMessage = `Le LLM n'a pas répondu correctement`,
  role = null,
  root = null,
  agent = null,
  taskId = null,
  stablePrefix = null,
  maxOutputTokens = null,
  resultCache = null,
}) {
  const effectiveConfig =
    role && LLM_ROLE_NAMES.includes(role) ? llmConfigForRole(config, role) : config;
  const resolved = resolveLlmConfig(effectiveConfig);
  if (resolved.provider !== 'ollama') requireApiKey(resolved); // erreur de config : inutile de retenter
  const request = REQUESTS[resolved.provider];
  const resilience = resolveLlmResilience(effectiveConfig);
  const circuit = breakerKey(resolved.provider, resolved.baseUrl);

  // Comptabilité : absente hors dépôt Striart initialisé ou si coupée par la config.
  const scope = await openCallScope({
    config: effectiveConfig,
    role: role ?? 'review',
    root,
    agent,
    taskId,
    provider: resolved.provider,
    model: resolved.model,
  });
  // Le cache de prompt ne dépend pas de la comptabilité : réglages résolus dans tous les cas.
  const settings = scope?.settings ?? resolveTokensSettings(effectiveConfig);

  // Cache de résultats idempotents (jamais pour judge/review : réglage validé).
  let cacheId = null;
  if (
    scope &&
    settings?.cache.enabled &&
    resultCache &&
    role &&
    settings.cache.roles.includes(role)
  ) {
    cacheId = cacheKey({
      role,
      provider: resolved.provider,
      model: resolved.model,
      promptVersion: resultCache.promptVersion,
      material: resultCache.material,
    });
    const started = Date.now();
    const cached = await cacheGet(scope.root, cacheId);
    if (cached !== null) {
      try {
        const value = transform(format === 'json' ? unwrapJsonResponse(cached) : cached);
        await recordCacheHit(scope, Date.now() - started);
        return value;
      } catch {
        // L'entrée ne passe plus la validation de l'appelant : purgée, appel réel.
        await cacheDelete(scope.root, cacheId);
      }
    }
  }

  // Garde de budget AVANT tout envoi : fail closed, l'appelant prend son chemin sûr.
  let planned = null;
  if (scope) {
    try {
      planned = await preflight(scope, prompt, maxOutputTokens);
    } catch (error) {
      if (error instanceof StriartError && error.code === 'TOKEN_BUDGET_EXCEEDED') {
        await recordRefusal(
          scope,
          `${error.details?.scope ?? '?'}:${error.details?.metric ?? '?'}`,
        );
      }
      throw error;
    }
  }
  const outputCap = planned?.maxOutputTokens ?? maxOutputTokens;

  const cacheControl =
    resolved.provider === 'anthropic' &&
    settings?.promptCache.enabled &&
    typeof stablePrefix === 'string' &&
    stablePrefix.length > 0 &&
    prompt.startsWith(stablePrefix) &&
    // Estimation conservative du préfixe : en deçà du seuil, pas de marqueur.
    Math.ceil(stablePrefix.length / settings.estimator.charsPerToken) >=
      settings.promptCache.minPrefixTokens
      ? { prefix: stablePrefix, ttl: settings.promptCache.ttl }
      : null;

  const open = breakerAdmit(circuit, resilience.breaker);
  if (open !== null) {
    throw circuitOpenError(errorCode, errorMessage, resolved.provider, resolved.model, open);
  }

  const baseDelay = retryDelayMs ?? resilience.backoff.baseMs;
  let lastError;
  let attemptsMade = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const jitter = backoffDelay(attempt, { baseMs: baseDelay, maxMs: resilience.backoff.maxMs });
      const floor = lastError?.retryAfterMs ?? 0;
      await sleep(Math.max(jitter, floor));
      const stillOpen = breakerAdmit(circuit, resilience.breaker);
      if (stillOpen !== null) break; // le disjoncteur s'est ouvert pendant nos tentatives
    }
    attemptsMade += 1;
    const started = Date.now();
    let reply;
    try {
      reply = await request(resolved, {
        prompt,
        format,
        signal: AbortSignal.timeout(timeoutMs),
        maxOutputTokens: outputCap,
        cacheControl,
      });
    } catch (error) {
      // Refus de la politique réseau (hors ligne, hôte non autorisé, HTTPS, CA, redirection) :
      // décision de l'utilisateur ou erreur d'environnement, jamais une panne du fournisseur —
      // ni retentée, ni comptée au disjoncteur, ni enveloppée dans LLM_FAILED.
      if (error instanceof StriartError && /^(NET_|USER_CONFIG_)/.test(error.code)) {
        breakerRelease(circuit);
        throw error;
      }
      lastError = classifyError(error);
      if (lastError.providerFault) breakerFailure(circuit, resilience.breaker);
      else breakerRelease(circuit);
      if (scope) {
        await recordCall(scope, {
          usage: null,
          responseText: null,
          durationMs: Date.now() - started,
          outcome: 'error',
          estimatedInput: 0,
          promptChars: planned?.promptChars ?? 0,
          detail: lastError.status ? `HTTP ${lastError.status}` : (lastError.name ?? 'error'),
        }).catch(accountingCatch);
      }
      if (!lastError.retryable) break;
      if (
        lastError.retryAfterMs !== null &&
        lastError.retryAfterMs > resilience.backoff.maxRetryAfterMs
      ) {
        break; // le fournisseur demande d'attendre plus que ce qu'on accepte : échec franc
      }
      continue;
    }

    // Réponse reçue : le fournisseur est joignable, et SES jetons sont dépensés
    // que la réponse passe la validation ou non.
    breakerSuccess(circuit);
    let value;
    let rejection = null;
    try {
      value = transform(format === 'json' ? unwrapJsonResponse(reply.text) : reply.text);
    } catch (error) {
      rejection = error;
    }
    if (scope) {
      await recordCall(scope, {
        usage: reply.usage,
        responseText: reply.text,
        durationMs: Date.now() - started,
        outcome: rejection ? 'rejected' : 'ok',
        estimatedInput: planned?.estimatedInput ?? 0,
        promptChars: planned?.promptChars ?? 0,
      }).catch(accountingCatch);
    }
    if (!rejection) {
      if (scope && cacheId) {
        await cachePut(scope.root, cacheId, role, reply.text, {
          ttlMs: settings.cache.ttlMs,
          maxEntries: settings.cache.maxEntries,
        });
      }
      return value;
    }
    lastError = classifyError(rejection);
  }

  const cause = sanitizeErrorText(lastError?.message);
  throw new StriartError(`${errorMessage} (${resolved.provider}:${resolved.model}) : ${cause}`, {
    code: errorCode,
    hint: 'striart doctor',
    details: {
      cause,
      provider: resolved.provider,
      model: resolved.model,
      host: hostOf(resolved.baseUrl),
      attempts: attemptsMade,
      ...(lastError?.causeCode ? { causeCode: lastError.causeCode } : {}),
      ...(lastError?.causeDetail ? { causeDetail: lastError.causeDetail } : {}),
      ...(lastError?.status ? { status: lastError.status } : {}),
    },
  });
}
