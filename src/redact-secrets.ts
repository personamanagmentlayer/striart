/**
 * Caviardage de SECRETS dans du texte libre (journaux, sorties d'outils,
 * messages d'erreur) — par le CONTENU, là où `publicErrorDetails`
 * (errors.js) caviarde par NOM de champ.
 *
 * Défense en profondeur, pas une garantie : un secret sans forme reconnaissable
 * (mot de passe quelconque dans une phrase) ne peut pas être trouvé par motif.
 * D'où deux niveaux :
 *  - des MOTIFS de formats connus (clés de fournisseurs, JWT, en-têtes
 *    Authorization, identifiants dans une URL, webhooks, blocs de clé privée,
 *    affectations `…KEY=valeur`) ;
 *  - des VALEURS exactes connues de l'appelant (`values` : clés d'API lues dans
 *    l'environnement, URL de webhook, env d'un profil) — le seul moyen sûr de
 *    retirer un secret qui n'a aucun format.
 *
 * Coût borné : tous les motifs ont des quantificateurs bornés (aucune
 * imbrication, donc aucun backtracking catastrophique) et le texte est traité
 * par tranches de `CHUNK_BYTES`, coupées de préférence sur un saut de ligne —
 * un journal de 100 Mio coûte un temps linéaire, jamais une explosion.
 * Limite connue : un secret à cheval sur une coupure de tranche hors saut de
 * ligne (une seule ligne de plus de `CHUNK_BYTES` sans espace) n'est pas vu par
 * les motifs (les `values` exactes, elles, sont cherchées sur le texte entier).
 */

export const REDACTED = '[redacted]';

/** Taille d'une tranche traitée d'un coup (caractères). */
const CHUNK_BYTES = 256 * 1024;
/** Longueur maximale d'un bloc de clé privée PEM recherché. */
const PEM_MAX = 8192;
/** Valeur exacte trop courte pour être cherchée sans défigurer le texte. */
const MIN_VALUE_LENGTH = 8;

type Rule = [pattern: RegExp, replacement: string | ((...match: string[]) => string)];

const RULES: readonly Rule[] = Object.freeze([
  // Blocs de clé privée (terminés, puis tronqués par une coupure).
  [
    new RegExp(
      `-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\\s\\S]{0,${PEM_MAX}}?-----END [A-Z ]{0,40}PRIVATE KEY-----`,
      'g',
    ),
    `[redacted private key]`,
  ],
  [
    new RegExp(`-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\\s\\S]{0,${PEM_MAX}}`, 'g'),
    `[redacted private key]`,
  ],
  // En-têtes d'authentification : on garde le nom de l'en-tête, jamais la valeur.
  [
    /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]{6,512}/gi,
    `$1${REDACTED}`,
  ],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,512}/gi, `$1${REDACTED}`],
  // Identifiants dans une URL : scheme://utilisateur:motdepasse@hôte
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:'"]{1,256}:[^\s/@'"]{1,256}@/gi, `$1${REDACTED}@`],
  // Webhooks (l'URL EST le secret).
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}/g, REDACTED],
  [
    /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}/g,
    REDACTED,
  ],
  // Clés et jetons de fournisseurs à format connu.
  [/\bsk-ant-[A-Za-z0-9_-]{20,256}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,256}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,255}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{50,255}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,255}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,255}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,2048}\.eyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}/g, REDACTED],
  // Affectations `…api_key=valeur`, `"token": "valeur"`, `PASSWORD: valeur`. Les
  // valeurs purement numériques ou booléennes (`max_tokens=100`) restent lisibles.
  [
    /\b([A-Za-z0-9_.-]{0,60}(?:api[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key)[A-Za-z0-9_.-]{0,30}["']?\s*[=:]\s*)(?!(?:(?:\d+|true|false|null|undefined|none|unset|empty|absent|present|missing)\b|\[redacted))("[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s"',;&]{1,512})/gi,
    // Les guillemets de la valeur sont conservés : un JSON caviardé reste un JSON.
    (_all, key, value) =>
      value.startsWith('"')
        ? `${key}"${REDACTED}"`
        : value.startsWith("'")
          ? `${key}'${REDACTED}'`
          : `${key}${REDACTED}`,
  ],
]);

/** Coupe `text` en tranches d'au plus CHUNK_BYTES, sur saut de ligne si possible. */
function* chunks(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_BYTES);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start) end = newline + 1;
      // Ne coupe pas un bloc PEM qui commence près de la fin de la tranche.
      const begin = text.lastIndexOf('-----BEGIN', end);
      if (
        begin > start &&
        end - begin < PEM_MAX + 100 &&
        !text.slice(begin, end).includes('-----END')
      ) {
        end = begin;
      }
    }
    yield text.slice(start, end);
    start = end;
  }
}

export interface RedactOptions {
  /** Valeurs secrètes exactes à retirer (clés d'API, URL de webhook…) ; ≥ 8 caractères. */
  values?: readonly (string | null | undefined)[];
}

/** Valeurs exactes retenues : assez longues, dédoublonnées, les plus longues d'abord. */
function usableValues(values: RedactOptions['values']): string[] {
  const kept = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value === 'string' && value.length >= MIN_VALUE_LENGTH) kept.add(value);
  }
  return [...kept].sort((a, b) => b.length - a.length);
}

/**
 * Retire d'un texte les secrets reconnus (voir l'en-tête). Ne lève jamais :
 * un non-texte est converti en chaîne.
 */
export function redactSecrets(input: unknown, options: RedactOptions = {}): string {
  let text = typeof input === 'string' ? input : String(input ?? '');
  if (text.length === 0) return text;
  for (const value of usableValues(options.values)) {
    if (text.includes(value)) text = text.split(value).join(REDACTED);
  }
  let out = '';
  for (const piece of chunks(text)) {
    let current = piece;
    for (const [pattern, replacement] of RULES) {
      pattern.lastIndex = 0;
      current = current.replace(pattern, replacement as never);
    }
    out += current;
  }
  return out;
}

/**
 * Variables d'environnement dont la VALEUR est à retirer des journaux : tout
 * nom évoquant un secret (clé d'API, jeton, mot de passe, webhook…) et les
 * variables nommées par l'appelant (`extraNames` : `apiKeyEnv` de la config).
 */
const SECRET_NAME_RE =
  /(?:API_?KEY|SECRET|TOKEN|PASSW(?:OR)?D|CREDENTIAL|PRIVATE_?KEY|WEBHOOK|AUTH(?:ORI[SZ]ATION)?$)/i;

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function secretValuesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  extraNames: readonly string[] = [],
): string[] {
  const names = new Set(extraNames);
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && (names.has(name) || isSecretEnvName(name))) out.push(value);
  }
  return out;
}
