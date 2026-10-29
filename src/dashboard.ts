import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from './config.ts';
import { hostAllowed, parseAllowedHosts } from './control/hosts.ts';
import { logger } from './logger.ts';
import { StriartError } from './errors.ts';
import { detectLocale, loadMessages } from './cli/i18n/index.ts';
import {
  SessionStore,
  SignInVerifier,
  generateInstanceHostname,
  generateToken,
  mintSignInCode,
  parseCookies,
  removeTokenFile,
  sessionCookie,
  sessionCookieName,
  writeTokenFile,
} from './control/auth.ts';
import { MAX_MESSAGE_BYTES } from './control/framing.ts';
import { assertHumanPlane } from './control/guard.ts';
import { ControlHub } from './control/hub.ts';
import { afterWrite, errorResponse, handleMessage, parseError } from './control/rpc.ts';
import { collectControlState } from './control/state.ts';
import { clientScript } from './dashboard-client.ts';
import { renderPage } from './dashboard-page.ts';
import { INFO_STYLE, STYLE } from './dashboard-style.ts';
import type { MethodContext } from './control/methods.ts';

/**
 * Dashboard local = client navigateur du Striart Control Protocol v1,
 * transport HTTP loopback.
 *
 * Surface HTTP (et RIEN d'autre) :
 *  - GET  /auth?code=…  lien de connexion à usage unique → cookie de session ;
 *  - GET  /             la page (exige la session) ;
 *  - POST /rpc          JSON-RPC 2.0 du protocole (session + Origin + X-Striart) ;
 *  - GET  /events       Server-Sent Events : `state.changed`, `control.notice`.
 * Les routes historiques /api/* répondent 410 (rupture assumée de la 0.11).
 *
 * Barrières, dans l'ordre, sur TOUTE requête (lectures comprises) :
 *  1. Host local (anti-DNS-rebinding), ou listé dans `dashboardAllowedHosts`
 *     (relâchement explicite, journalisé, affiché par doctor — il ne touche
 *     QUE ce contrôle) — 403 ;
 *  2. Sec-Fetch-Site ni cross-site ni same-site (un autre port local est
 *     « same-site » : SameSite=Strict ne l'arrête pas) — 403 ;
 *  3. session valide (cookie HttpOnly obtenu par le lien) — 401, sans
 *     aucune donnée du dépôt dans la réponse ;
 *  4. sur /rpc : Origin = ce serveur, X-Striart: 1, Content-Type JSON — 403.
 */

/** Intervalle du battement de cœur SSE (commentaire, maintient le socket). */
const SSE_HEARTBEAT_MS = 25_000;

/** Ré-export historique (tests, consommateurs) : l'état vit dans control/state.ts. */
export const collectDashboardState = collectControlState;

const VERSION = /** @type {{version: string}} */ createRequire(import.meta.url)(
  '../package.json',
).version;

/**
 * La page (squelette HTML, feuille de style, client) vit dans `dashboard-page.ts`,
 * `dashboard-style.ts` et `dashboard-client.ts` : le client est du TypeScript
 * vérifié, dont la source est embarquée telle quelle dans l'unique `<script>`.
 */

/**
 * Page en français (référence) — exportée pour le test de cohérence du client
 * (compilation du script + correspondance des ids et des méthodes). Le serveur,
 * lui, sert la page dans la langue de l'instance (`STRIART_LANG`, comme la CLI).
 */
export const PAGE = renderPage('fr');

const hashOf = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * CSP stricte : aucun script ni style en ligne hors des deux blocs de la
 * page, identifiés par empreinte — ni `unsafe-inline`, ni source externe.
 */
/** CSP stricte de la page pour une langue : le script embarqué (catalogue de la langue) a son empreinte. */
const pageCsp = (/** @type {'fr'|'en'} */ locale) =>
  [
    "default-src 'none'",
    `script-src ${hashOf(clientScript(locale))}`,
    `style-src ${hashOf(STYLE)}`,
    "connect-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

/**
 * Page sans script (connexion requise, lien refusé) : aucune donnée du dépôt.
 * Bilingue (le visiteur n'a pas encore de session, donc pas de langue d'instance
 * garantie) : chaque langue est balisée `lang` pour les lecteurs d'écran.
 */
function infoPage(title, lines) {
  const body = lines.map(({ lang, text }) => `<p lang="${lang}">${text}</p>`).join('\n');
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Striart — ${title}</title>
<link rel="icon" href="/favicon.ico">
<style>${INFO_STYLE}</style></head>
<body><main><h1>Striart — ${title}</h1>
${body}
</main></body></html>
`;
}
const INFO_CSP = `default-src 'none'; style-src ${hashOf(INFO_STYLE)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const SIGN_IN_REQUIRED = infoPage('connexion requise / sign-in required', [
  {
    lang: 'fr',
    text: 'Ce tableau de bord exige une connexion : ouvre le <b>lien de connexion</b> affiché par <code>striart dashboard</code>, ou obtiens-en un nouveau avec <code>striart dashboard --link</code>.',
  },
  {
    lang: 'en',
    text: 'This dashboard requires signing in: open the <b>sign-in link</b> printed by <code>striart dashboard</code>, or get a new one with <code>striart dashboard --link</code>.',
  },
]);
const SIGN_IN_REFUSED = infoPage('lien refusé / link refused', [
  {
    lang: 'fr',
    text: 'Ce lien de connexion est invalide, expiré ou déjà utilisé (un lien ne sert qu’une fois). Obtiens-en un nouveau : <code>striart dashboard --link</code>.',
  },
  {
    lang: 'en',
    text: 'This sign-in link is invalid, expired or already used (a link works once). Get a new one: <code>striart dashboard --link</code>.',
  },
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * L'en-tête Host désigne-t-il bien la boucle locale ? Défense contre le DNS
 * rebinding : un domaine tiers résolu vers 127.0.0.1 arrive avec son propre
 * Host. À appliquer à TOUTE requête, pas seulement aux actions.
 *
 * Redirection de port (VS Code Remote, devcontainer) : le tunnel transmet
 * `Host: localhost:<port local>` — accepté (le port n'est pas comparé :
 * il peut différer du port d'écoute). Un domaine de redirection web
 * (Codespaces `*.app.github.dev`) est refusé PAR DÉFAUT, à dessein : il
 * faut le déclarer dans `dashboardAllowedHosts` (voir control/hosts.ts).
 */
function hostOf(req) {
  const raw = req.headers.host ?? '';
  // IPv6 littéral « [::1]:3456 » : ne pas couper sur « : » naïvement.
  return raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
}
function isLocalHost(req) {
  return LOCAL_HOSTS.has(hostOf(req).toLowerCase());
}

/**
 * Sec-Fetch-Site : un navigateur moderne dit d'où vient la requête. Un
 * autre port de localhost est « same-site » — SameSite=Strict ne l'arrête
 * pas, cette barrière si. Absent (client non navigateur) : rien à refuser
 * ici, le cookie et l'Origin restent exigés.
 */
function fetchSiteAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

/**
 * Origin exacte de ce serveur, telle que le navigateur la voit (Host transmis).
 * Hôte local : `http://<Host>`. Hôte admis par `dashboardAllowedHosts`
 * (tunnel web, donc souvent https) : `http://` ou `https://` suivi du Host
 * REÇU — jamais le loopback, jamais un autre hôte de la liste.
 */
function originMatches(req, relaxedHost) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  const host = String(req.headers.host).toLowerCase();
  const lower = origin.toLowerCase();
  return lower === `http://${host}` || (relaxedHost && lower === `https://${host}`);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, contentType, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType, ...headers });
  res.end(body);
}
const sendText = (res, status, text) => send(res, status, 'text/plain; charset=utf-8', text);
const sendJson = (res, status, value) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
const sendHtml = (res, status, html, csp) =>
  send(res, status, 'text/html; charset=utf-8', html, { 'Content-Security-Policy': csp });

/** Corps borné : au-delà de MAX_MESSAGE_BYTES, la lecture s'arrête (null). */
function readBody(req: import('node:http').IncomingMessage): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Démarre le dashboard local, lié à 127.0.0.1 uniquement. Rend le serveur
 * http, enrichi de `server.striart` :
 *  - `signInUrl({ttlMs?})` → `{url, expiresAt}` : lien de connexion à usage
 *    unique (à afficher à l'utilisateur, jamais à journaliser) ;
 *  - `baseUrl` : adresse sans secret ;
 *  - `stats()` : abonnés, collectes, déconnexions de clients lents.
 * Le jeton de l'instance est écrit dans `.striart/control/dashboard-<port>.json`
 * (utilisateur seul) pour `striart dashboard --link` ; retiré à l'arrêt.
 */
/**
 * @typedef {object} DashboardControl
 * @property {string} baseUrl
 * @property {(options?: {ttlMs?: number}) => {url: string, expiresAt: string}} signInUrl
 * @property {() => {subscribers: number, collections: number, slowDisconnects: number, revision: number, sessions: number}} stats
 */
/**
 * @param {{root: string, port?: number|null}} params
 * @returns {Promise<http.Server & {striart: DashboardControl}>}
 */
export async function startDashboard({ root, port = null }) {
  // Validations AVANT toute mise en place (watchers, timers, fichiers) :
  // un échec plus tard laissait des handles ouverts.
  assertHumanPlane(process.env, 'striart dashboard');
  const config = await loadConfig(root);
  const listenPort = port ?? config.dashboardPort;
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new StriartError(
      `Port invalide : ${JSON.stringify(listenPort)}. Attendu : un entier entre 0 et 65535.`,
      {
        code: 'INVALID_ARGUMENT',
        details: { option: 'port', value: listenPort },
        hint: 'striart dashboard --port 3456',
      },
    );
  }

  // Hôtes relâchés (dashboardAllowedHosts) : déjà validés au chargement de la
  // config ; on re-parse ici (défense en profondeur) et on refuse de démarrer
  // sur une liste que le chargeur aurait dû écarter.
  const parsedHosts = parseAllowedHosts(config.dashboardAllowedHosts ?? []);
  if (!('rules' in parsedHosts)) {
    throw new StriartError('Valeur invalide pour "dashboardAllowedHosts" dans la config Striart', {
      code: 'CONFIG_INVALID',
      hint: 'striart doctor',
      details: {
        reason: 'HOST_PATTERN',
        key: 'dashboardAllowedHosts',
        problem: parsedHosts.problem,
      },
    });
  }
  const allowedHosts = parsedHosts.rules;

  // Nom d'hôte de l'instance (S-I4). Le cookie de session est host-only : sous
  // `localhost`, un navigateur le renvoie à TOUT serveur `localhost:*` (RFC 6265
  // §8.5) — par exemple le serveur de dev, potentiellement hostile, d'un agent —
  // qui peut le rejouer vers ce dashboard. Sous `<id-aléatoire>.localhost`
  // (résolu en boucle locale par les navigateurs), il n'est jamais envoyé
  // ailleurs, et la boucle locale « nue » n'est PLUS servie.
  const instanceHostname =
    config.dashboardHostname === 'localhost' ? null : generateInstanceHostname();
  /** Le Host désigne-t-il l'adresse locale de CE dashboard ? */
  const isServedLocal = (req) =>
    instanceHostname === null ? isLocalHost(req) : hostOf(req).toLowerCase() === instanceHostname;

  const locale = detectLocale(process.env);
  const m = await loadMessages(locale);
  /** La page, dans la langue de l'instance (même règle que la CLI : STRIART_LANG, puis la locale). */
  const page = renderPage(locale, { repo: path.basename(root) });
  const csp = pageCsp(locale);
  const token = generateToken();
  const sessions = new SessionStore({ ttlMs: config.dashboardSessionTtlMs });
  const hub = new ControlHub({
    root,
    maxBufferedBytes: config.controlSseMaxBufferedBytes,
    maxDelayMs: config.controlStateMaxDelayMs,
  });
  /** @type {SignInVerifier | null} */
  let verifier = null;
  let actualPort = 0;
  let cookieName = '';

  const ctx: MethodContext = {
    root,
    hub,
    m,
    locale,
    version: VERSION,
    transport: 'http',
    connection: null,
  };

  /** @type {Map<http.ServerResponse, string>} */
  const sseClients = new Map();

  const unauthenticatedRpc = () =>
    errorResponse(
      null,
      null,
      new StriartError('Dashboard session missing or expired: sign in again.', {
        code: 'CONTROL_UNAUTHENTICATED',
        hint: 'striart dashboard --link',
      }),
      ctx,
    );

  const refusedOrigin = (reason) =>
    errorResponse(
      null,
      null,
      new StriartError(
        `Request refused by the dashboard: it does not come from the dashboard page (${reason}).`,
        {
          code: 'CONTROL_ORIGIN_REFUSED',
          details: { reason },
          hint: 'Use the dashboard page itself, or striart api --stdio for a program.',
        },
      ),
      ctx,
    );

  const refusedCsrf = () =>
    errorResponse(
      null,
      null,
      new StriartError(
        'Request refused by the dashboard: X-Striart: 1 and Content-Type: application/json are required.',
        {
          code: 'CONTROL_CSRF_REFUSED',
          hint: 'Use the dashboard page itself, or striart api --stdio for a program.',
        },
      ),
      ctx,
    );

  async function serveEvents(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let closed = false;
    let subscriptionId = null;
    req.on('close', () => {
      closed = true;
      sseClients.delete(res);
      if (subscriptionId) hub.unsubscribe(subscriptionId);
    });
    try {
      const subscription = await hub.subscribe(
        {
          policy: 'disconnect',
          write: (method, params) =>
            res.write(
              `id: ${params.seq}\nevent: ${method}\ndata: ${JSON.stringify({ jsonrpc: '2.0', method, params })}\n\n`,
            ),
          bufferedBytes: () => res.writableLength,
          // Coupure explicite : les octets en attente sont abandonnés, le
          // navigateur se reconnecte et reçoit l'état complet.
          disconnect: () => res.destroy(),
          onceDrained: (callback) => res.once('drain', callback),
        },
        { initial: 'frame' },
      );
      subscriptionId = subscription.subscriptionId;
      if (closed) hub.unsubscribe(subscriptionId);
      else sseClients.set(res, subscriptionId);
    } catch (error) {
      logger.warn({ err: error.message }, 'Initial control state unreadable for an SSE client');
    }
  }

  async function serveRpc(req, res) {
    if (req.method !== 'POST') {
      send(res, 405, 'text/plain; charset=utf-8', 'POST only.', { Allow: 'POST' });
      return;
    }
    if (!originMatches(req, !isServedLocal(req))) {
      sendJson(res, 403, refusedOrigin('origin'));
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (req.headers['x-striart'] !== '1' || contentType !== 'application/json') {
      sendJson(res, 403, refusedCsrf());
      return;
    }
    const text = await readBody(req);
    if (text === null) {
      sendJson(
        res,
        413,
        errorResponse(
          null,
          null,
          new StriartError(`Request body exceeds ${MAX_MESSAGE_BYTES} bytes: refused.`, {
            code: 'CONTROL_MESSAGE_TOO_LARGE',
            details: { limit: MAX_MESSAGE_BYTES },
          }),
          ctx,
        ),
      );
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendJson(res, 200, errorResponse(null, null, parseError(), ctx));
      return;
    }
    const response = await handleMessage(message, ctx);
    if (response === null) {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    sendJson(res, 200, response);
    afterWrite(response);
  }

  function serveSignIn(res, url) {
    const verdict = verifier ? verifier.verify(url.searchParams.get('code')) : 'invalid';
    if (verdict !== 'ok') {
      // Jamais le code lui-même dans le journal : seulement le verdict.
      logger.info({ verdict }, 'Dashboard sign-in link refused');
      sendHtml(res, 403, SIGN_IN_REFUSED, INFO_CSP);
      return;
    }
    const { id, maxAgeSeconds } = sessions.create();
    send(res, 303, 'text/plain; charset=utf-8', '', {
      Location: '/',
      'Set-Cookie': sessionCookie(cookieName, id, maxAgeSeconds),
    });
  }

  async function route(req, res) {
    // 1. Barrière anti-DNS-rebinding, AVANT tout routage.
    if (!isServedLocal(req) && !hostAllowed(req.headers.host, allowedHosts)) {
      sendText(res, 403, 'Host non local refusé (protection contre le DNS rebinding).');
      return;
    }
    // 2. Requête initiée par un autre site (ou un autre port local).
    if (!fetchSiteAllowed(req)) {
      if ((req.url ?? '').startsWith('/rpc')) sendJson(res, 403, refusedOrigin('sec-fetch-site'));
      else sendText(res, 403, 'Requête inter-site refusée.');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/auth') {
      if (req.method !== 'GET') {
        send(res, 405, 'text/plain; charset=utf-8', 'GET only.', { Allow: 'GET' });
        return;
      }
      serveSignIn(res, url);
      return;
    }
    // L'icône : le navigateur la demande de lui-même, y compris sur les pages
    // sans session. Réponse vide, sans donnée : ni 401 bruyant dans la console,
    // ni information, ni ressource externe.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    // 3. Session obligatoire pour tout le reste — aucune donnée sans elle.
    if (!sessions.check(parseCookies(req.headers.cookie).get(cookieName))) {
      if (url.pathname === '/rpc') sendJson(res, 401, unauthenticatedRpc());
      else if (url.pathname === '/' || url.pathname === '/index.html')
        sendHtml(res, 401, SIGN_IN_REQUIRED, INFO_CSP);
      else sendText(res, 401, 'Connexion requise : striart dashboard --link');
      return;
    }
    if (url.pathname === '/rpc') return serveRpc(req, res);
    if (url.pathname === '/events') return serveEvents(req, res);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendHtml(res, 200, page, csp);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 410, {
        error:
          'The /api/* routes were replaced by the Striart Control Protocol v1: POST /rpc (JSON-RPC 2.0) and GET /events (Server-Sent Events). See rpc.discover.',
      });
      return;
    }
    sendText(res, 404, '404');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      // Jamais le message interne au client (A10) : il est journalisé ici.
      logger.error({ err: error }, 'Dashboard request failed');
      if (!res.headersSent) sendText(res, 500, 'Erreur interne du dashboard (voir le journal).');
      else res.destroy();
    });
  });

  const heartbeat = setInterval(() => {
    for (const [client, id] of sseClients) {
      if (hub.checkPressure(id)) client.write(':ping\n\n');
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  let tornDown = false;
  // server.close doit AUSSI démonter flux SSE, hub et fichier de jeton : sans
  // ça, les sockets event-stream empêchent close() d'aboutir, les watchers
  // survivent au serveur, et un jeton mort reste sur disque.
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    clearInterval(heartbeat);
    for (const client of sseClients.keys()) client.destroy();
    sseClients.clear();
    await hub.close();
    if (actualPort) await removeTokenFile(root, actualPort, process.pid);
  };
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    void teardown().then(
      () => originalClose(callback),
      (error) => {
        logger.warn({ err: error.message }, 'Dashboard teardown incomplete');
        originalClose(callback);
      },
    );
    return server;
  };

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      void teardown();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(
          new StriartError(`Le port ${listenPort} est déjà utilisé sur 127.0.0.1.`, {
            code: 'PORT_IN_USE',
            details: { port: listenPort },
            hint: `striart dashboard --port ${listenPort + 1}`,
          }),
        );
        return;
      }
      reject(error);
    });
    server.listen(listenPort, '127.0.0.1', () => resolve(undefined));
  });

  const address = server.address();
  actualPort = typeof address === 'object' && address ? address.port : listenPort;
  cookieName = sessionCookieName(actualPort);
  verifier = new SignInVerifier(token, actualPort);
  try {
    await writeTokenFile(root, {
      port: actualPort,
      pid: process.pid,
      token,
      hostname: instanceHostname,
    });
  } catch (error) {
    // Fail closed : sans fichier protégé, pas de serveur.
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    throw error;
  }

  if (allowedHosts.length > 0) {
    // Relâchement explicite : journalisé à CHAQUE démarrage (doctor l'affiche aussi).
    logger.warn(
      { hosts: allowedHosts.map((rule) => rule.pattern), port: actualPort },
      'Dashboard Host check RELAXED by dashboardAllowedHosts: these hosts are served in addition to the loopback; token, SameSite=Strict session cookie, Sec-Fetch-Site, Origin and anti-CSRF checks still apply',
    );
  }

  if (instanceHostname === null) {
    logger.warn(
      { port: actualPort },
      'Dashboard hostname set to "localhost" (dashboardHostname): the session cookie is sent by the browser to every localhost:* server (RFC 6265 section 8.5), e.g. an agent dev server that could replay it. Use "instance" unless your browser cannot resolve *.localhost.',
    );
  }
  const baseUrl = `http://${instanceHostname ?? 'localhost'}:${actualPort}`;
  /** @type {DashboardControl} */
  const control = {
    baseUrl,
    signInUrl: ({ ttlMs = config.dashboardLinkTtlMs } = {}) => {
      const { code, expiresAt } = mintSignInCode(token, { port: actualPort, ttlMs });
      return { url: `${baseUrl}/auth?code=${code}`, expiresAt };
    },
    stats: () => ({ ...hub.stats(), sessions: sessions.size }),
  };
  return Object.assign(server, { striart: control });
}
