/**
 * Authentification du transport HTTP du Striart Control Protocol (dashboard).
 *
 * Modèle (décision D5) :
 *  - un JETON par instance (32 octets aléatoires), créé au démarrage du
 *    serveur, jamais journalisé, jamais dans une URL ni un cookie ;
 *  - un fichier de jeton par instance, lisible par l'utilisateur SEUL
 *    (0600 sous POSIX ; ACL protégée réduite au SID de l'utilisateur sous
 *    Windows, posée par icacls et vérifiée en SDDL) — il permet à un autre
 *    process de CET utilisateur (`striart dashboard --link`, le parent d'un
 *    `--daemon`) d'émettre un lien de connexion ;
 *  - un LIEN À USAGE UNIQUE : code = nonce + expiration + HMAC-SHA256 du
 *    jeton, vérifié en temps constant, nonce consommé (non rejouable),
 *    durée de vie courte (`dashboardLinkTtlMs`) ;
 *  - le lien s'échange contre un COOKIE de session `HttpOnly;
 *    SameSite=Strict; Path=/` dont la valeur est un identifiant aléatoire
 *    propre (jamais le jeton), stocké côté serveur sous forme d'empreinte
 *    SHA-256, avec expiration (`dashboardSessionTtlMs`).
 * Ces contrôles s'ajoutent à Host / Origin / X-Striart (dashboard.js), ils
 * ne les remplacent pas.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from '../errors.ts';
import { striartDir } from '../paths.ts';
import {
  assertPrivate as assertFilePrivate,
  restrictToCurrentUser as restrictFileToCurrentUser,
} from '../private-fs.ts';

export const TOKEN_BYTES = 32;
/** Borne haute absolue d'un lien, quelle que soit la config (validateur de dashboardLinkTtlMs). */
export const MAX_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LINK_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_SESSIONS = 64;

const CODE_RE = /^v1\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/;

export function generateToken(): Buffer {
  return randomBytes(TOKEN_BYTES);
}

function mac(token: Buffer, port: number, nonce: string, exp: string): Buffer {
  return createHmac('sha256', token).update(`striart-signin|v1|${port}|${nonce}|${exp}`).digest();
}

/** Émet un code de connexion à usage unique pour l'instance qui écoute sur `port`. */
export function mintSignInCode(
  token: Buffer,
  {
    port,
    ttlMs = DEFAULT_LINK_TTL_MS,
    now = Date.now(),
  }: { port: number; ttlMs?: number; now?: number },
): { code: string; expiresAt: string } {
  const ttl = Math.min(Math.max(1, ttlMs), MAX_LINK_TTL_MS);
  const nonce = randomBytes(16).toString('base64url');
  const expiresAtMs = now + ttl;
  const exp = expiresAtMs.toString(36);
  const signature = mac(token, port, nonce, exp).toString('base64url');
  return {
    code: `v1.${nonce}.${exp}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export type SignInVerdict = 'ok' | 'invalid' | 'expired' | 'replayed';

/** Vérifie les codes de connexion d'UNE instance ; chaque nonce ne sert qu'une fois. */
export class SignInVerifier {
  private readonly used = new Map<string, number>();
  private readonly token: Buffer;
  private readonly port: number;

  constructor(token: Buffer, port: number) {
    this.token = token;
    this.port = port;
  }

  verify(code: unknown, now = Date.now()): SignInVerdict {
    for (const [nonce, exp] of this.used) if (exp <= now) this.used.delete(nonce);
    if (typeof code !== 'string') return 'invalid';
    const match = CODE_RE.exec(code);
    if (!match) return 'invalid';
    const [, nonce, exp, signature] = match;
    const expected = mac(this.token, this.port, nonce, exp);
    // Forme canonique exigée : 43 car. base64url = 258 bits pour 256 utiles, les 2 bits de
    // bourrage du dernier caractère sont ignorés au décodage — sans ce contrôle, plusieurs
    // chaînes distinctes seraient acceptées pour la même signature (malléabilité).
    if (signature !== expected.toString('base64url')) return 'invalid';
    const given = Buffer.from(signature, 'base64url');
    // Temps constant : longueur fixée par le motif (43 car. = 32 octets).
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
    const expiresAtMs = Number.parseInt(exp, 36);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs > now + MAX_LINK_TTL_MS) return 'invalid';
    if (expiresAtMs <= now) return 'expired';
    if (this.used.has(nonce)) return 'replayed';
    this.used.set(nonce, expiresAtMs);
    return 'ok';
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Sessions navigateur : identifiants aléatoires, conservés sous forme d'empreinte. */
export class SessionStore {
  private readonly sessions = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor({
    ttlMs = DEFAULT_SESSION_TTL_MS,
    max = MAX_SESSIONS,
  }: { ttlMs?: number; max?: number } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  create(now = Date.now()): { id: string; maxAgeSeconds: number } {
    this.prune(now);
    while (this.sessions.size >= this.max) {
      // Éviction de la session qui expire le plus tôt.
      let oldest: string | null = null;
      let oldestExp = Number.POSITIVE_INFINITY;
      for (const [key, exp] of this.sessions)
        if (exp < oldestExp) {
          oldest = key;
          oldestExp = exp;
        }
      if (oldest === null) break;
      this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(digest(id), now + this.ttlMs);
    return { id, maxAgeSeconds: Math.floor(this.ttlMs / 1000) };
  }

  check(id: string | undefined, now = Date.now()): boolean {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return false;
    // La recherche se fait sur l'empreinte : un écart de temps de la table
    // de hachage ne renseigne rien sur l'identifiant lui-même.
    const key = digest(id);
    const exp = this.sessions.get(key);
    if (exp === undefined) return false;
    if (exp <= now) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  private prune(now: number) {
    for (const [key, exp] of this.sessions) if (exp <= now) this.sessions.delete(key);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Un cookie par port : deux dashboards locaux (deux dépôts) ne s'écrasent pas. */
export function sessionCookieName(port: number): string {
  return `striart_session_${port}`;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}

export function sessionCookie(name: string, id: string, maxAgeSeconds: number): string {
  return `${name}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

// --- Fichier de jeton ----------------------------------------------------------

export function controlDir(root: string): string {
  return path.join(striartDir(root), 'control');
}

export function tokenFilePath(root: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StriartError(`Invalid dashboard port ${String(port)}.`, {
      code: 'INVALID_ARGUMENT',
      details: { option: 'port', port },
    });
  }
  return path.join(controlDir(root), `dashboard-${port}.json`);
}

function unprotected(file: string, reason: string, cause?: unknown): StriartError {
  return new StriartError(
    `Cannot restrict the dashboard token file to the current user (${reason}): refused, the dashboard does not start with a token others could read.`,
    {
      code: 'CONTROL_TOKEN_UNPROTECTED',
      details: { path: file, reason },
      hint: 'Check the permissions of the .striart/ folder (owner = you), then retry.',
      cause,
    },
  );
}

/**
 * Mécanisme de restriction à l'utilisateur courant : une seule implémentation,
 * `src/private-fs.ts` (réutilisée pour tout `.striart/`). Ici, seule l'erreur est
 * propre au jeton du dashboard (`CONTROL_TOKEN_UNPROTECTED`, contrat publié).
 */
export { sddlRestrictedTo } from '../private-fs.ts';

async function asTokenError<T>(file: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StriartError && error.code === 'STATE_UNPROTECTED') {
      throw unprotected(file, String(error.details.reason ?? 'unknown'), error.cause ?? error);
    }
    throw error;
  }
}

/** Restreint `file` à l'utilisateur courant, puis le VÉRIFIE (fail closed). */
export function restrictToCurrentUser(file: string): Promise<void> {
  return asTokenError(file, () => restrictFileToCurrentUser(file));
}

/** Le fichier n'est-il lisible que par son propriétaire, l'utilisateur courant ? */
export function assertPrivate(file: string): Promise<void> {
  return asTokenError(file, () => assertFilePrivate(file));
}

export interface TokenFile {
  port: number;
  pid: number;
  token: Buffer;
  createdAt: string;
  /**
   * Nom d'hôte propre à l'instance (`<id-aléatoire>.localhost`, S-I4) sous
   * lequel le dashboard est servi ; null = `localhost` (dashboardHostname:
   * 'localhost', ou fichier antérieur). Le lien de connexion l'utilise.
   */
  hostname: string | null;
}

/** Nom d'hôte d'instance admissible : une étiquette `[a-z0-9-]` sous `.localhost`. */
export const INSTANCE_HOSTNAME_RE = /^[a-z0-9][a-z0-9-]{7,62}\.localhost$/;

/** Génère le nom d'hôte d'une instance : 64 bits aléatoires, stable pour sa vie. */
export function generateInstanceHostname(): string {
  return `s${randomBytes(8).toString('hex')}.localhost`;
}

/**
 * Écrit le fichier de jeton : fichier temporaire créé exclusif (0600),
 * restreint et vérifié AVANT d'y écrire le jeton, puis renommé (le
 * descripteur de sécurité suit le fichier). Jamais de fenêtre où le jeton
 * existe dans un fichier lisible par d'autres.
 */
export async function writeTokenFile(
  root: string,
  {
    port,
    pid,
    token,
    hostname = null,
  }: Omit<TokenFile, 'createdAt' | 'hostname'> & {
    hostname?: string | null;
  },
): Promise<string> {
  const target = tokenFilePath(root, port);
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.close();
    await restrictToCurrentUser(tmp);
    const body = JSON.stringify({
      port,
      pid,
      token: token.toString('base64url'),
      hostname,
      createdAt: new Date().toISOString(),
    });
    const writer = await open(tmp, 'r+');
    try {
      await writer.writeFile(body, 'utf8');
      await writer.sync();
    } finally {
      await writer.close();
    }
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return target;
}

/** Lit le fichier de jeton d'une instance, après en avoir vérifié la confidentialité. */
export async function readTokenFile(root: string, port: number): Promise<TokenFile> {
  const file = tokenFilePath(root, port);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new StriartError(`No running dashboard on port ${port} for this repository.`, {
      code: 'CONTROL_INSTANCE_NOT_FOUND',
      details: { port },
      hint: 'striart dashboard --status',
      cause: error,
    });
  }
  await assertPrivate(file);
  let parsed: {
    port?: unknown;
    pid?: unknown;
    token?: unknown;
    createdAt?: unknown;
    hostname?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StriartError(`Dashboard token file of port ${port} is unreadable.`, {
      code: 'CONTROL_INSTANCE_NOT_FOUND',
      details: { port },
      hint: 'Restart the dashboard: striart dashboard --stop, then striart dashboard --daemon.',
      cause: error,
    });
  }
  const token = typeof parsed.token === 'string' ? Buffer.from(parsed.token, 'base64url') : null;
  if (
    parsed.port !== port ||
    !Number.isInteger(parsed.pid) ||
    !token ||
    token.length !== TOKEN_BYTES ||
    (parsed.hostname != null &&
      !(typeof parsed.hostname === 'string' && INSTANCE_HOSTNAME_RE.test(parsed.hostname)))
  ) {
    throw new StriartError(`Dashboard token file of port ${port} is invalid.`, {
      code: 'CONTROL_INSTANCE_NOT_FOUND',
      details: { port },
      hint: 'Restart the dashboard: striart dashboard --stop, then striart dashboard --daemon.',
    });
  }
  return {
    port,
    pid: parsed.pid as number,
    token,
    createdAt: String(parsed.createdAt ?? ''),
    hostname: typeof parsed.hostname === 'string' ? parsed.hostname : null,
  };
}

/** Retire le fichier de jeton s'il appartient toujours à `pid` (jamais celui d'une autre instance). */
export async function removeTokenFile(root: string, port: number, pid: number): Promise<void> {
  const file = tokenFilePath(root, port);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown };
    if (parsed.pid !== pid) return;
  } catch {
    // Absent ou illisible : rien à retirer qui nous appartienne.
    return;
  }
  await rm(file, { force: true });
}
