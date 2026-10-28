import http from 'node:http';
import tls from 'node:tls';
import { readFile, stat } from 'node:fs/promises';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { readUserConfig, type NetworkConfig, type UserConfig } from './user-config.ts';

/**
 * Couche réseau d'entreprise : point d'entrée UNIQUE des appels sortants de
 * Striart (LLM, webhooks, registre ACP et ses archives, sonde Ollama). Aucun
 * autre module n'appelle `fetch` vers l'extérieur.
 *
 * Ce que la couche impose, appel par appel :
 *  1. URL http(s) valide ;
 *  2. `network.offline` / `STRIART_OFFLINE` : tout hôte non local est refusé (NET_OFFLINE) ;
 *  3. `network.allowedHosts` / `STRIART_ALLOWED_HOSTS` : liste blanche d'hôtes
 *     (NET_HOST_NOT_ALLOWED) ;
 *  4. HTTPS exigé hors boucle locale, avec ou sans clé d'API
 *     (NET_INSECURE_TRANSPORT), sauf `network.allowInsecureHosts` ;
 *  5. vérification TLS jamais coupée (NODE_TLS_REJECT_UNAUTHORIZED=0 refusé) ;
 *  6. aucune redirection suivie (`redirect: 'error'`), sauf un suivi BORNÉ
 *     explicitement demandé (`maxRedirects`) dont chaque saut repasse par 2–5 ;
 *  7. proxy d'entreprise, CA d'entreprise et version TLS minimale appliqués au
 *     processus avant l'envoi.
 *
 * SOURCES — décision de l'utilisateur, jamais d'un dépôt : l'environnement du
 * shell (HTTP(S)_PROXY, NO_PROXY, STRIART_OFFLINE, STRIART_ALLOWED_HOSTS,
 * STRIART_TLS_MIN_VERSION, STRIART_PROXY_AUTH, NODE_EXTRA_CA_CERTS…) et la
 * config UTILISATEUR (`network`, src/user-config.ts). La config du dépôt n'a
 * aucun accès ici et le filtre du `.env` (src/cli/env-file.ts) refuse chacune
 * de ces variables. Les deux sources se CUMULENT du côté restrictif
 * (offline = l'un OU l'autre, liste blanche = intersection, TLS = le plus strict).
 *
 * La boucle locale (localhost, 127.x, [::1]) n'est ni proxifiée, ni soumise à
 * offline / liste blanche / HTTPS, et ne lit même pas la config utilisateur :
 * un Ollama local ne dépend jamais d'elle.
 */

export type NetPurpose = 'llm' | 'webhook' | 'acp-registry' | 'acp-download' | 'probe';

export interface NetFetchInit extends RequestInit {
  /** Pourquoi l'appel est fait (journal et détails d'erreur ; jamais la logique). */
  purpose: NetPurpose;
  /**
   * 0 (défaut) : toute redirection est une erreur. > 0 : suivi borné, chaque
   * saut est revérifié (liste blanche, HTTPS, offline) — pour les archives
   * d'un registre hébergées derrière une redirection.
   */
  maxRedirects?: number;
}

/** Capacités de CE Node pour le proxy d'environnement (injectables pour les tests). */
export interface ProxyCapabilities {
  /** `http.setGlobalProxyFromEnv` existe (Node >= 24.14 / 25.4). */
  runtimeProxyApi: boolean;
  /** Proxy d'environnement activé AU DÉMARRAGE (NODE_USE_ENV_PROXY=1 / --use-env-proxy, Node >= 22.21 / 24.5). */
  startupProxyFlag: boolean;
}

export interface NetDeps {
  env?: NodeJS.ProcessEnv;
  userConfig?: () => Promise<UserConfig>;
  /** Transport sous-jacent ; défaut : `globalThis.fetch` lu à l'appel. */
  transport?: typeof fetch;
  capabilities?: ProxyCapabilities;
}

export function currentProxyCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): ProxyCapabilities {
  return {
    runtimeProxyApi:
      typeof (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === 'function',
    startupProxyFlag:
      env.NODE_USE_ENV_PROXY === '1' ||
      execArgv.includes('--use-env-proxy') ||
      /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Hôtes
// ---------------------------------------------------------------------------

const LOOPBACK_HOST_RE = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** Boucle locale : jamais proxifiée, jamais soumise à la politique distante. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOST_RE.test(hostname);
}

const normalizeHost = (host: string): string => host.toLowerCase().replace(/\.$/, '');

/** `exemple.com` (exact) ou `*.exemple.com` (sous-domaines seulement, jamais l'apex). */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = normalizeHost(host);
  return patterns.some((raw) => {
    const pattern = normalizeHost(raw);
    return pattern.startsWith('*.') ? h.endsWith(pattern.slice(1)) : h === pattern;
  });
}

/** Sémantique NO_PROXY usuelle : `*`, hôte exact, `.suffixe` / `suffixe` (frontière de domaine), port ignoré. */
function noProxyMatches(host: string, noProxy: string | null): boolean {
  if (!noProxy) return false;
  const h = normalizeHost(host);
  return noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const bare = entry.replace(/^\*?\./, '').replace(/:\d+$/, '');
      return h === bare || h.endsWith(`.${bare}`);
    });
}

// ---------------------------------------------------------------------------
// Politique résolue (pure)
// ---------------------------------------------------------------------------

export interface ProxyPolicy {
  configured: boolean;
  source: 'user-config' | 'environment' | null;
  /** URL brutes (peuvent porter des identifiants d'environnement) — jamais journalisées ni affichées. */
  http: string | null;
  https: string | null;
  noProxy: string | null;
  /** Variante SANS identifiants, seule affichable. */
  display: { http: string | null; https: string | null; noProxy: string | null };
  /** Identifiants `utilisateur:mot de passe` de STRIART_PROXY_AUTH (jamais de config). */
  auth: string | null;
}

export interface NetworkPolicy {
  offline: boolean;
  /** Une liste par source ; un hôte doit figurer dans TOUTES (intersection). */
  allowLists: string[][];
  allowInsecureHosts: string[];
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3' | null;
  caFile: string | null;
  proxy: ProxyPolicy;
  /** NODE_TLS_REJECT_UNAUTHORIZED=0 dans l'environnement. */
  tlsVerificationDisabled: boolean;
}

function envInvalid(variable: string, reason: string): StriartError {
  return new StriartError(`Variable d'environnement réseau invalide : ${variable} (${reason}).`, {
    code: 'USER_CONFIG_INVALID',
    details: { reason, key: variable },
    hint: 'striart doctor',
  });
}

const TRUE_RE = /^(1|true|yes|on)$/i;
const FALSE_RE = /^(0|false|no|off|)$/i;

function parseBoolEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim();
  if (raw === undefined || FALSE_RE.test(raw)) return false;
  if (TRUE_RE.test(raw)) return true;
  throw envInvalid(name, 'attendu : 1 ou 0');
}

const pick = (env: NodeJS.ProcessEnv, upper: string): string | null => {
  const value = env[upper.toLowerCase()] ?? env[upper];
  return value && value.trim() !== '' ? value.trim() : null;
};

/** URL de proxy sans identifiants, ou `<invalide>` : seule forme affichable. */
export function redactProxyUrl(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '<invalide>';
  }
}

export function resolveNetworkPolicy(
  user: NetworkConfig,
  env: NodeJS.ProcessEnv = process.env,
): NetworkPolicy {
  const allowLists: string[][] = [];
  if (user.allowedHosts.length > 0) allowLists.push([...user.allowedHosts]);
  const envHosts = (env.STRIART_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (envHosts.length > 0) {
    for (const h of envHosts) {
      if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(h)) {
        throw envInvalid('STRIART_ALLOWED_HOSTS', 'nom d’hôte ou *.suffixe attendu');
      }
    }
    allowLists.push(envHosts);
  }

  const envTls = env.STRIART_TLS_MIN_VERSION?.trim();
  if (envTls && envTls !== 'TLSv1.2' && envTls !== 'TLSv1.3') {
    throw envInvalid('STRIART_TLS_MIN_VERSION', 'TLSv1.2 ou TLSv1.3');
  }
  const tlsMinVersion =
    user.tlsMinVersion === 'TLSv1.3' || envTls === 'TLSv1.3'
      ? 'TLSv1.3'
      : (user.tlsMinVersion ?? (envTls as 'TLSv1.2' | null) ?? null);

  let source: ProxyPolicy['source'] = null;
  let httpProxy: string | null = null;
  let httpsProxy: string | null = null;
  let noProxy = user.noProxy ?? pick(env, 'NO_PROXY');
  if (user.proxy) {
    source = 'user-config';
    httpProxy = httpsProxy = user.proxy;
  } else {
    httpProxy = pick(env, 'HTTP_PROXY');
    httpsProxy = pick(env, 'HTTPS_PROXY');
    if (httpProxy || httpsProxy) source = 'environment';
    else noProxy = null;
  }
  const auth =
    env.STRIART_PROXY_AUTH && env.STRIART_PROXY_AUTH.includes(':') ? env.STRIART_PROXY_AUTH : null;
  if (env.STRIART_PROXY_AUTH && !auth)
    throw envInvalid('STRIART_PROXY_AUTH', 'attendu : utilisateur:motdepasse');

  return {
    offline: user.offline || parseBoolEnv(env, 'STRIART_OFFLINE'),
    allowLists,
    allowInsecureHosts: [...user.allowInsecureHosts],
    tlsMinVersion,
    caFile: user.caFile,
    tlsVerificationDisabled: env.NODE_TLS_REJECT_UNAUTHORIZED === '0',
    proxy: {
      configured: source !== null,
      source,
      http: httpProxy,
      https: httpsProxy,
      noProxy,
      display: { http: redactProxyUrl(httpProxy), https: redactProxyUrl(httpsProxy), noProxy },
      auth,
    },
  };
}

export type ProxyProblem =
  'SCHEME' | 'USER_CONFIG_NEEDS_RUNTIME_API' | 'NEEDS_STARTUP_FLAG' | 'AUTH_NEEDS_RUNTIME_API';

export interface ProxyStatus {
  configured: boolean;
  active: boolean;
  mechanism: 'runtime' | 'startup-flag' | 'none';
  problem: ProxyProblem | null;
}

/** Le proxy configuré est-il réellement applicable par CE Node ? (pur) */
export function describeProxy(policy: NetworkPolicy, caps: ProxyCapabilities): ProxyStatus {
  const { proxy } = policy;
  if (!proxy.configured)
    return { configured: false, active: false, mechanism: 'none', problem: null };
  for (const raw of [proxy.http, proxy.https]) {
    if (!raw) continue;
    let protocol = '';
    try {
      protocol = new URL(raw).protocol;
    } catch {
      /* URL invalide : refusée ci-dessous comme schéma non supporté */
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { configured: true, active: false, mechanism: 'none', problem: 'SCHEME' };
    }
  }
  if (caps.runtimeProxyApi)
    return { configured: true, active: true, mechanism: 'runtime', problem: null };
  if (!caps.startupProxyFlag) {
    return { configured: true, active: false, mechanism: 'none', problem: 'NEEDS_STARTUP_FLAG' };
  }
  // Mécanisme de démarrage : Node lit l'environnement lui-même, ni config utilisateur ni STRIART_PROXY_AUTH.
  if (proxy.source === 'user-config') {
    return {
      configured: true,
      active: false,
      mechanism: 'startup-flag',
      problem: 'USER_CONFIG_NEEDS_RUNTIME_API',
    };
  }
  if (proxy.auth) {
    return {
      configured: true,
      active: false,
      mechanism: 'startup-flag',
      problem: 'AUTH_NEEDS_RUNTIME_API',
    };
  }
  return { configured: true, active: true, mechanism: 'startup-flag', problem: null };
}

function proxyUnsupported(problem: ProxyProblem, host: string): StriartError {
  const hints: Record<ProxyProblem, string> = {
    SCHEME:
      'Le proxy doit être une URL http:// ou https:// (les proxys SOCKS ne sont pas supportés).',
    NEEDS_STARTUP_FLAG:
      'Ce Node ne sait pas lire HTTP(S)_PROXY seul : démarre striart avec NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24.5) ou passe à Node >= 24.14 / 25.4.',
    USER_CONFIG_NEEDS_RUNTIME_API:
      'network.proxy (config utilisateur) exige Node >= 24.14 / 25.4 ; sur ce Node, pose HTTPS_PROXY et NODE_USE_ENV_PROXY=1 dans le shell.',
    AUTH_NEEDS_RUNTIME_API:
      'STRIART_PROXY_AUTH exige Node >= 24.14 / 25.4 ; sur ce Node, mets les identifiants dans l’URL de HTTPS_PROXY (shell).',
  };
  return new StriartError(
    `Un proxy d'entreprise est configuré mais inactif sur ce Node : l'appel vers ${host} est refusé plutôt que de contourner le proxy.`,
    {
      code: 'NET_PROXY_UNSUPPORTED',
      hint: hints[problem],
      details: { host, reason: problem },
    },
  );
}

// ---------------------------------------------------------------------------
// Contrôles de politique
// ---------------------------------------------------------------------------

const warnedInsecure = new Set<string>();

function parseUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StriartError('URL sortante invalide.', {
      code: 'NET_URL_INVALID',
      details: { reason: 'UNPARSEABLE' },
      hint: 'striart doctor',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StriartError(`Schéma refusé pour un appel sortant : ${url.protocol}`, {
      code: 'NET_URL_INVALID',
      details: { reason: 'SCHEME', protocol: url.protocol },
      hint: 'striart doctor',
    });
  }
  return url;
}

function assertPolicy(url: URL, policy: NetworkPolicy, purpose: NetPurpose): void {
  const host = normalizeHost(url.hostname);
  if (policy.offline) {
    throw new StriartError(
      `Mode hors ligne : l'appel sortant vers ${host} est refusé (${purpose}).`,
      {
        code: 'NET_OFFLINE',
        details: { host, purpose },
        hint: 'Retire network.offline (config utilisateur) ou STRIART_OFFLINE pour autoriser le réseau.',
      },
    );
  }
  if (policy.allowLists.length > 0 && !policy.allowLists.every((list) => hostMatches(host, list))) {
    throw new StriartError(`L'hôte ${host} n'est pas dans la liste blanche réseau (${purpose}).`, {
      code: 'NET_HOST_NOT_ALLOWED',
      details: { host, purpose },
      hint: 'Ajoute-le à network.allowedHosts (config utilisateur) ou STRIART_ALLOWED_HOSTS, si c’est voulu.',
    });
  }
  if (url.protocol === 'http:') {
    if (!hostMatches(host, policy.allowInsecureHosts)) {
      throw new StriartError(
        `HTTPS requis hors boucle locale : ${host} ne sera pas joint en clair (${purpose}).`,
        {
          code: 'NET_INSECURE_TRANSPORT',
          details: { host, purpose, reason: 'PLAIN_HTTP' },
          hint: 'Utilise https://, ou déclare l’hôte dans network.allowInsecureHosts (config utilisateur) en connaissance de cause.',
        },
      );
    }
    if (!warnedInsecure.has(host)) {
      warnedInsecure.add(host);
      logger.warn(
        { host, purpose },
        'Réseau : appel HTTP en clair autorisé par network.allowInsecureHosts',
      );
    }
  }
  if (policy.tlsVerificationDisabled) {
    throw new StriartError(
      `NODE_TLS_REJECT_UNAUTHORIZED=0 : la vérification TLS est coupée, l'appel vers ${host} est refusé (${purpose}).`,
      {
        code: 'NET_INSECURE_TRANSPORT',
        details: { host, purpose, reason: 'TLS_VERIFICATION_DISABLED' },
        hint: 'Retire NODE_TLS_REJECT_UNAUTHORIZED=0 et ajoute plutôt la CA d’entreprise (NODE_EXTRA_CA_CERTS).',
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Application au processus : proxy, CA, TLS minimal (effet de bord, idempotent)
// ---------------------------------------------------------------------------

const CA_FILE_MAX_BYTES = 4 * 1024 * 1024;

interface AppliedState {
  fingerprint: string | null;
  restoreProxy: (() => void) | null;
  originalMinVersion: string | null;
  originalCa: string[] | null;
}

const applied: AppliedState = {
  fingerprint: null,
  restoreProxy: null,
  originalMinVersion: null,
  originalCa: null,
};

/** Restaure l'état du processus (tests) : proxy global, CA par défaut, TLS minimal. */
export function resetNetState(): void {
  applied.restoreProxy?.();
  if (applied.originalCa) tls.setDefaultCACertificates(applied.originalCa);
  if (applied.originalMinVersion) {
    tls.DEFAULT_MIN_VERSION = applied.originalMinVersion as typeof tls.DEFAULT_MIN_VERSION;
  }
  applied.fingerprint = null;
  applied.restoreProxy = null;
  applied.originalMinVersion = null;
  applied.originalCa = null;
  warnedInsecure.clear();
}

function withAuth(raw: string | null, auth: string | null): string | null {
  if (!raw || !auth) return raw;
  const url = new URL(raw);
  if (url.username) return raw;
  const idx = auth.indexOf(':');
  url.username = auth.slice(0, idx);
  url.password = auth.slice(idx + 1);
  return url.href;
}

/** Charge un fichier PEM d'autorités : au moins un certificat, taille bornée. */
export async function readCaFile(file: string): Promise<string[]> {
  const fail = (reason: string) =>
    new StriartError(`Fichier de CA d'entreprise inutilisable (${reason}).`, {
      code: 'NET_CA_INVALID',
      details: { reason, path: file },
      hint: 'Vérifie network.caFile (config utilisateur) : un fichier PEM contenant « BEGIN CERTIFICATE ».',
    });
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    throw fail((error as NodeJS.ErrnoException).code ?? 'illisible');
  }
  if (!info.isFile()) throw fail('NOT_A_FILE');
  if (info.size > CA_FILE_MAX_BYTES) throw fail('TOO_LARGE');
  const pem = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    throw fail(error.code ?? 'illisible');
  });
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certs) throw fail('NO_CERTIFICATE');
  return certs;
}

/** Applique proxy, CA d'entreprise et TLS minimal au processus (idempotent, tout ou rien). */
export async function applyNetworkSettings(
  policy: NetworkPolicy,
  caps: ProxyCapabilities,
): Promise<void> {
  const status = describeProxy(policy, caps);
  const proxyEnv =
    status.mechanism === 'runtime'
      ? {
          ...(policy.proxy.http
            ? { HTTP_PROXY: withAuth(policy.proxy.http, policy.proxy.auth)! }
            : {}),
          ...(policy.proxy.https
            ? { HTTPS_PROXY: withAuth(policy.proxy.https, policy.proxy.auth)! }
            : {}),
          // La boucle locale (Ollama) ne passe jamais par le proxy d'entreprise.
          NO_PROXY: [policy.proxy.noProxy, 'localhost', '127.0.0.1', '[::1]']
            .filter(Boolean)
            .join(','),
        }
      : null;
  const fingerprint = JSON.stringify({
    proxyEnv,
    ca: policy.caFile,
    tls: policy.tlsMinVersion,
  });
  if (applied.fingerprint === fingerprint) return;

  let ca: string[] | null = null;
  if (policy.caFile) ca = await readCaFile(policy.caFile);

  // Rien n'est modifié avant que tout soit validé.
  applied.restoreProxy?.();
  applied.restoreProxy = null;
  if (proxyEnv) {
    applied.restoreProxy =
      (
        http as unknown as { setGlobalProxyFromEnv: (env: NodeJS.ProcessEnv) => () => void }
      ).setGlobalProxyFromEnv(proxyEnv) ?? null;
  }
  if (policy.tlsMinVersion) {
    applied.originalMinVersion ??= tls.DEFAULT_MIN_VERSION;
    tls.DEFAULT_MIN_VERSION = policy.tlsMinVersion;
  }
  if (ca) {
    applied.originalCa ??= tls.getCACertificates('default');
    try {
      tls.setDefaultCACertificates([...applied.originalCa, ...ca]);
    } catch (error) {
      throw new StriartError(`Certificats de CA refusés par Node : ${(error as Error).message}`, {
        code: 'NET_CA_INVALID',
        details: { reason: 'REJECTED_BY_NODE', path: policy.caFile },
        hint: 'Le fichier doit contenir des certificats PEM valides.',
      });
    }
  }
  applied.fingerprint = fingerprint;
}

// ---------------------------------------------------------------------------
// Erreurs de transport
// ---------------------------------------------------------------------------

const TLS_UNTRUSTED_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function causeChain(error: unknown): Array<{ code?: string; message?: string }> {
  const chain: Array<{ code?: string; message?: string }> = [];
  let current: unknown = error;
  for (let i = 0; i < 6 && current && typeof current === 'object'; i += 1) {
    chain.push(current as { code?: string; message?: string });
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function mapTransportError(error: unknown, url: URL, purpose: NetPurpose): unknown {
  if (error instanceof StriartError) return error;
  const chain = causeChain(error);
  const host = normalizeHost(url.hostname);
  const certError = chain.find((c) => c.code && TLS_UNTRUSTED_CODES.has(c.code));
  if (certError) {
    return new StriartError(
      `Certificat non fiable pour ${host} (${certError.code}) : la chaîne n'aboutit pas à une autorité connue.`,
      {
        code: 'NET_TLS_UNTRUSTED',
        details: { host, purpose, certCode: certError.code },
        hint: "Ajoute la CA d'entreprise : NODE_EXTRA_CA_CERTS=<fichier.pem> (lue au démarrage), `node --use-system-ca` / NODE_USE_SYSTEM_CA=1, ou network.caFile (config utilisateur). Jamais NODE_TLS_REJECT_UNAUTHORIZED=0.",
      },
    );
  }
  if (chain.some((c) => /unexpected redirect/i.test(c.message ?? ''))) {
    return new StriartError(
      `${host} a répondu par une redirection : refusée (aucune n'est suivie).`,
      {
        code: 'NET_REDIRECT_REFUSED',
        details: { host, purpose, reason: 'REDIRECT' },
        hint: "Corrige l'URL (baseUrl, webhook, registre) pour viser directement la bonne adresse.",
      },
    );
  }
  return error;
}

// ---------------------------------------------------------------------------
// Appel
// ---------------------------------------------------------------------------

async function prepare(url: URL, purpose: NetPurpose, deps: NetDeps): Promise<void> {
  if (isLoopbackHost(url.hostname)) return;
  const env = deps.env ?? process.env;
  const user = await (deps.userConfig ?? readUserConfig)();
  const policy = resolveNetworkPolicy(user.network, env);
  assertPolicy(url, policy, purpose);
  const caps = deps.capabilities ?? currentProxyCapabilities(env);
  const status = describeProxy(policy, caps);
  const bypass = noProxyMatches(url.hostname, policy.proxy.noProxy);
  const needsProxy =
    status.configured &&
    !bypass &&
    (url.protocol === 'https:' ? policy.proxy.https : policy.proxy.http) !== null;
  if (needsProxy && !status.active)
    throw proxyUnsupported(status.problem ?? 'NEEDS_STARTUP_FLAG', normalizeHost(url.hostname));
  await applyNetworkSettings(policy, caps);
}

export async function netFetch(
  input: string | URL,
  init: NetFetchInit,
  deps: NetDeps = {},
): Promise<Response> {
  const { purpose, maxRedirects = 0, ...rest } = init;
  let url = parseUrl(input);
  const transport = () => deps.transport ?? globalThis.fetch;
  for (let hop = 0; ; hop += 1) {
    await prepare(url, purpose, deps);
    let response: Response;
    try {
      response = await transport()(url.href, {
        ...rest,
        redirect: maxRedirects > 0 ? 'manual' : 'error',
      });
    } catch (error) {
      throw mapTransportError(error, url, purpose);
    }
    if (maxRedirects === 0 || !(response.status >= 300 && response.status < 400)) return response;
    const location = response.headers?.get?.('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || hop >= maxRedirects) {
      throw new StriartError(`Trop de redirections (${purpose}) : refusé.`, {
        code: 'NET_REDIRECT_REFUSED',
        details: { host: normalizeHost(url.hostname), purpose, reason: 'TOO_MANY' },
        hint: "Corrige l'URL pour viser directement la bonne adresse.",
      });
    }
    url = parseUrl(new URL(location, url));
  }
}

// ---------------------------------------------------------------------------
// Inspection (striart doctor)
// ---------------------------------------------------------------------------

export interface NetworkReport {
  policy: NetworkPolicy;
  proxy: ProxyStatus;
  caps: ProxyCapabilities;
  /** NODE_EXTRA_CA_CERTS / --use-system-ca, tels que Node les a reçus au démarrage. */
  extraCaCerts: string | null;
  systemCa: boolean;
  nodeVersion: string;
}

export function inspectNetwork(
  user: NetworkConfig,
  env: NodeJS.ProcessEnv = process.env,
): NetworkReport {
  const caps = currentProxyCapabilities(env);
  const policy = resolveNetworkPolicy(user, env);
  return {
    policy,
    proxy: describeProxy(policy, caps),
    caps,
    extraCaCerts: env.NODE_EXTRA_CA_CERTS?.trim() || null,
    systemCa:
      env.NODE_USE_SYSTEM_CA === '1' ||
      process.execArgv.includes('--use-system-ca') ||
      /(?:^|\s)--use-system-ca(?:\s|$)/.test(env.NODE_OPTIONS ?? ''),
    nodeVersion: process.versions.node,
  };
}
