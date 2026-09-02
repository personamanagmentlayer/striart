import { setTimeout as sleep } from 'node:timers/promises';
import { StriartError } from './errors.js';

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

export function resolveLlmConfig(config) {
  const llm = config.llm ?? {};
  const provider = llm.provider ?? 'ollama';
  if (!LLM_PROVIDERS.includes(provider)) {
    throw new StriartError(
      `Provider LLM inconnu : "${provider}". Providers supportés : ${LLM_PROVIDERS.join(', ')}.`,
      { code: 'LLM_CONFIG_INVALID', details: { provider } },
    );
  }
  const defaults = PROVIDER_DEFAULTS[provider];

  // Rétro-compatibilité : ollamaModel / ollamaHost restent la façon simple
  // de configurer le provider par défaut.
  const model = llm.model ?? (provider === 'ollama' ? config.ollamaModel : null);
  if (!model) {
    throw new StriartError(
      `Aucun modèle configuré pour le provider "${provider}". Renseigne llm.model dans striart.config.`,
      { code: 'LLM_CONFIG_INVALID', details: { provider } },
    );
  }

  const rawBaseUrl = llm.baseUrl ?? (provider === 'ollama' ? config.ollamaHost : defaults.baseUrl);
  if (!rawBaseUrl) {
    throw new StriartError(
      `Le provider "${provider}" exige llm.baseUrl (ex: https://ma-ressource.openai.azure.com).`,
      { code: 'LLM_CONFIG_INVALID', details: { provider } },
    );
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const apiKeyEnv = llm.apiKeyEnv ?? defaults.apiKeyEnv;
  const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? null) : null;
  const apiVersion = llm.apiVersion ?? (provider === 'azure' ? AZURE_DEFAULT_API_VERSION : null);

  return { provider, model, baseUrl, apiKeyEnv, apiKey, apiVersion };
}

function requireApiKey(resolved) {
  if (!resolved.apiKey) {
    throw new StriartError(
      `Clé API manquante pour le provider "${resolved.provider}" : définis la variable d'environnement ${resolved.apiKeyEnv} (par exemple dans un fichier .env).`,
      {
        code: 'LLM_CONFIG_INVALID',
        details: { provider: resolved.provider, apiKeyEnv: resolved.apiKeyEnv },
      },
    );
  }
}

async function requestOllama(resolved, { prompt, format, signal }) {
  const res = await fetch(`${resolved.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: resolved.model,
      prompt,
      stream: false,
      ...(format && { format }),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama a répondu HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.response !== 'string') {
    throw new Error('la réponse Ollama ne contient pas de champ "response"');
  }
  return data.response;
}

async function requestOpenAi(resolved, { prompt, format, signal }) {
  const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      messages: [{ role: 'user', content: prompt }],
      ...(format === 'json' && { response_format: { type: 'json_object' } }),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`L'API a répondu HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('la réponse ne contient pas choices[0].message.content');
  }
  return text;
}

async function requestAnthropic(resolved, { prompt, signal }) {
  // Pas de mode JSON natif : les prompts exigent déjà le format, et
  // `transform` valide/retente côté appelant.
  const res = await fetch(`${resolved.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': resolved.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: resolved.model,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`L'API Anthropic a répondu HTTP ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('la réponse ne contient pas content[0].text');
  }
  return text;
}

async function requestAzure(resolved, { prompt, format, signal }) {
  // Azure OpenAI : URL par deployment (model = nom du deployment),
  // auth par header api-key (le Bearer est réservé aux tokens Entra).
  const url = `${resolved.baseUrl}/openai/deployments/${resolved.model}/chat/completions?api-version=${resolved.apiVersion}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': resolved.apiKey,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      ...(format === 'json' && { response_format: { type: 'json_object' } }),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Azure OpenAI a répondu HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('la réponse ne contient pas choices[0].message.content');
  }
  return text;
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
 * Appel LLM générique, encapsulé avec timeout + retry (un LLM local peut
 * être lent au cold-start, un LLM cloud peut rate-limiter). `transform`
 * valide/parse la réponse DANS la boucle de retry : une réponse malformée
 * compte comme une tentative échouée et est retentée.
 */
export async function llmGenerate({
  config,
  prompt,
  format = null,
  timeoutMs = 60_000,
  retries = 2,
  retryDelayMs = 500,
  transform = (response) => response,
  errorCode = 'LLM_FAILED',
  errorMessage = `Le LLM n'a pas répondu correctement`,
}) {
  const resolved = resolveLlmConfig(config);
  if (resolved.provider !== 'ollama') requireApiKey(resolved); // erreur de config : inutile de retenter
  const request = REQUESTS[resolved.provider];

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs * attempt);
    try {
      const response = await request(resolved, {
        prompt,
        format,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return transform(response);
    } catch (error) {
      lastError = error;
    }
  }

  throw new StriartError(
    `${errorMessage} (${resolved.provider}:${resolved.model} @ ${resolved.baseUrl}) : ${lastError.message}`,
    {
      code: errorCode,
      details: {
        cause: lastError.message,
        provider: resolved.provider,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
      },
    },
  );
}
