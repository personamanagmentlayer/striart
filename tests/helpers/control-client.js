import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Client de test du transport HTTP du Striart Control Protocol (dashboard) :
 * connexion par lien à usage unique, appels JSON-RPC, lecture SSE, requêtes
 * HTTP brutes (fetch interdit de forger Host).
 */

/**
 * Les suites de ce client parlent au dashboard par `fetch('http://localhost:…')` :
 * Node ne résout pas `<id>.localhost`, elles demandent donc le repli explicite
 * `dashboardHostname: 'localhost'` (le défaut 'instance' a sa propre suite :
 * dashboard-hostname.test.js). Fusionne avec une config déjà écrite.
 */
export async function useLoopbackDashboard(root, extra = {}) {
  const file = path.join(root, '.striartrc.json');
  let current = {};
  try {
    current = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // Pas encore de config de test : on part de zéro.
  }
  await writeFile(
    file,
    JSON.stringify({
      testCommand: 'node -e "process.exit(0)"',
      ...current,
      ...extra,
      dashboardHostname: 'localhost',
    }),
  );
}

/** Échange un lien de connexion frais contre le cookie de session (`name=value`). */
export async function signIn(server) {
  const { url } = server.striart.signInUrl();
  const res = await fetch(url, { redirect: 'manual' });
  if (res.status !== 303) throw new Error(`sign-in failed: HTTP ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  return { cookie: setCookie.split(';')[0], setCookie, url };
}

export function baseUrl(server) {
  return `http://localhost:${server.address().port}`;
}

/** Appel JSON-RPC authentifié (en-têtes d'un navigateur sur la page servie). */
export async function rpc(server, cookie, method, params = {}, { headers = {}, id = 1 } = {}) {
  const base = baseUrl(server);
  const res = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Striart': '1',
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

/** Données d'un appel réussi (document de résultat), sinon lève avec le document d'erreur. */
export async function call(server, cookie, method, params = {}) {
  const { body } = await rpc(server, cookie, method, params);
  if (body.error) {
    const error = new Error(`${method}: ${body.error.message}`);
    error.document = body.error.data;
    throw error;
  }
  return body.result;
}

/** Requête HTTP brute — permet de forger Host, Origin, Sec-Fetch-Site. */
export function rawRequest(port, routePath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: routePath,
        method,
        headers: { Host: `localhost:${port}`, ...headers },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
          // Flux SSE : on n'attend pas la fin, le statut suffit.
          if (res.headers['content-type']?.startsWith('text/event-stream')) res.destroy();
        });
        res.on('close', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Lecteur de flux SSE : rend la prochaine trame de l'événement demandé,
 * `{ id, event, message }` où `message` est la notification JSON-RPC.
 */
export function sseReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextEvent = async function nextEvent(wanted, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frameEnd = buffer.indexOf('\n\n');
      if (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const id = frame.match(/^id: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (event === wanted && data) return { id, event, message: JSON.parse(data) };
        continue;
      }
      if (Date.now() > deadline) throw new Error(`SSE event "${wanted}" never received`);
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended early');
      buffer += decoder.decode(value, { stream: true });
    }
  };
  /** Ferme le flux (le lecteur verrouille le corps : cancel passe par lui). */
  nextEvent.cancel = () => reader.cancel();
  return nextEvent;
}

/** Attend qu'un prédicat devienne vrai (sondage court, délai borné). */
export async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition never met');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
