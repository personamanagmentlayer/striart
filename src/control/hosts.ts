/**
 * Hôtes supplémentaires admis par le contrôle `Host` du dashboard
 * (`dashboardAllowedHosts`).
 *
 * Par défaut le dashboard n'admet que la boucle locale (anti-DNS-rebinding).
 * Derrière un tunnel web (Codespaces `*.app.github.dev`, proxy inverse
 * d'entreprise), le navigateur envoie le nom public : l'utilisateur peut le
 * déclarer ICI, explicitement. Ce module ne fait que valider les motifs et
 * les comparer à un en-tête Host — il ne désactive rien d'autre : jeton,
 * cookie SameSite=Strict, Sec-Fetch-Site, Origin et anti-CSRF restent exigés
 * par le dashboard.
 *
 * Motifs acceptés (sensibles à rien d'autre que la casse, ignorée) :
 *  - nom d'hôte exact          `striart.example.com`, `mon-poste`
 *  - joker en TÊTE de sous-domaine, un seul niveau, sous un suffixe d'au
 *    moins deux étiquettes   `*.app.github.dev`
 *  - IPv4 privée ou de bouclage (10/8, 172.16/12, 192.168/16, 127/8) exacte
 *  - port facultatif           `striart.example.com:8443` (sinon tout port)
 * Refusés : `*`, `*.com`, joker ailleurs qu'en tête, plusieurs jokers, IP
 * publique, IPv6, schéma, chemin, identifiants, espaces, port hors 1-65535.
 */

export interface AllowedHostRule {
  /** Motif tel que normalisé (minuscules) — pour le journal et doctor. */
  pattern: string;
  kind: 'exact' | 'wildcard';
  /** Nom exact, ou suffixe (sans `*.`) pour un joker. */
  host: string;
  /** null = tout port. */
  port: number | null;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_LENGTH = 253;

/** Raisons de refus — des identifiants, jamais la valeur. */
export type HostPatternProblem =
  | 'NOT_A_STRING'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'FORBIDDEN_CHARACTER'
  | 'GLOBAL_WILDCARD'
  | 'WILDCARD_POSITION'
  | 'WILDCARD_SUFFIX_TOO_BROAD'
  | 'INVALID_PORT'
  | 'INVALID_HOSTNAME'
  | 'IPV6_REFUSED'
  | 'PUBLIC_IP_REFUSED';

function isPrivateOrLoopbackIPv4(parts: number[]): boolean {
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Port d'un en-tête / motif : entier décimal strict 1..65535, sinon null. */
function parsePort(raw: string): number | null {
  if (!/^[0-9]{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Découpe `hôte[:port]` ; les crochets IPv6 ne sont jamais admis ici. */
function splitHostPort(
  raw: string,
): { host: string; port: number | null } | { problem: HostPatternProblem } {
  const colon = raw.indexOf(':');
  if (colon === -1) return { host: raw, port: null };
  if (raw.indexOf(':', colon + 1) !== -1) return { problem: 'IPV6_REFUSED' };
  const port = parsePort(raw.slice(colon + 1));
  if (port === null) return { problem: 'INVALID_PORT' };
  return { host: raw.slice(0, colon), port };
}

export function parseAllowedHost(
  entry: unknown,
): AllowedHostRule | { problem: HostPatternProblem } {
  if (typeof entry !== 'string') return { problem: 'NOT_A_STRING' };
  const text = entry.trim().toLowerCase();
  if (text.length === 0) return { problem: 'EMPTY' };
  if (text.length > MAX_HOST_LENGTH + 6) return { problem: 'TOO_LONG' };
  if (text === '*' || text === '*.') return { problem: 'GLOBAL_WILDCARD' };
  if (text.startsWith('[')) return { problem: 'IPV6_REFUSED' };
  // Tout ce qui n'est ni étiquette DNS, ni point, ni joker, ni « : » de port.
  if (!/^[a-z0-9.*:-]+$/.test(text)) return { problem: 'FORBIDDEN_CHARACTER' };

  const split = splitHostPort(text);
  if ('problem' in split) return split;
  const { host, port } = split;
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return { problem: 'INVALID_HOSTNAME' };

  const wildcard = host.startsWith('*.');
  const body = wildcard ? host.slice(2) : host;
  if (body.includes('*')) return { problem: 'WILDCARD_POSITION' };
  const labels = body.split('.');
  if (!labels.every((label) => LABEL.test(label))) return { problem: 'INVALID_HOSTNAME' };

  // IPv4 littérale : quatre étiquettes numériques. Aucun joker sur une IP.
  if (labels.every((label) => /^[0-9]+$/.test(label))) {
    if (wildcard) return { problem: 'WILDCARD_POSITION' };
    const parts = labels.map(Number);
    if (labels.length !== 4 || parts.some((n) => n > 255)) return { problem: 'INVALID_HOSTNAME' };
    if (!isPrivateOrLoopbackIPv4(parts)) return { problem: 'PUBLIC_IP_REFUSED' };
  } else if (/^[0-9]+$/.test(labels[labels.length - 1])) {
    // TLD numérique : ambigu avec une IP, refusé.
    return { problem: 'INVALID_HOSTNAME' };
  }
  if (wildcard && labels.length < 2) return { problem: 'WILDCARD_SUFFIX_TOO_BROAD' };

  return {
    pattern: `${wildcard ? '*.' : ''}${body}${port === null ? '' : `:${port}`}`,
    kind: wildcard ? 'wildcard' : 'exact',
    host: body,
    port,
  };
}

/**
 * Valide la liste de config. Retourne le premier problème avec l'INDEX de
 * l'entrée (jamais sa valeur), ou les règles normalisées.
 */
export function parseAllowedHosts(
  list: unknown,
): { rules: AllowedHostRule[] } | { problem: HostPatternProblem; index: number | null } {
  if (!Array.isArray(list)) return { problem: 'NOT_A_STRING', index: null };
  const rules: AllowedHostRule[] = [];
  for (const [index, entry] of list.entries()) {
    const parsed = parseAllowedHost(entry);
    if ('problem' in parsed) return { problem: parsed.problem, index };
    rules.push(parsed);
  }
  return { rules };
}

/**
 * Un en-tête Host reçu correspond-il à l'une des règles ? Le Host doit être
 * lui-même bien formé (étiquettes DNS ou IPv4, port décimal) : sinon refus.
 * Un joker ne couvre qu'UNE étiquette (`a.b.app.github.dev` ≠ `*.app.github.dev`).
 */
export function hostAllowed(hostHeader: unknown, rules: readonly AllowedHostRule[]): boolean {
  if (rules.length === 0 || typeof hostHeader !== 'string') return false;
  const received = splitHostPort(hostHeader.trim().toLowerCase());
  if ('problem' in received) return false;
  const { host, port } = received;
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
  const labels = host.split('.');
  if (!labels.every((label) => LABEL.test(label))) return false;
  return rules.some((rule) => {
    if (rule.port !== null && rule.port !== port) return false;
    if (rule.kind === 'exact') return host === rule.host;
    const suffix = `.${rule.host}`;
    if (!host.endsWith(suffix)) return false;
    const prefix = host.slice(0, host.length - suffix.length);
    return prefix.length > 0 && !prefix.includes('.');
  });
}
