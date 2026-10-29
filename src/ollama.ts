import { netFetch } from './net.ts';

/**
 * Sonde un serveur Ollama sur `host` (via la couche réseau, src/net.ts : un hôte
 * distant exige HTTPS, la liste blanche et le mode hors ligne s'appliquent).
 * Ne lève jamais : rend `{ ok, error }`, où `error` est le motif d'un refus de
 * politique réseau (NET_*) — pour que `striart doctor` dise POURQUOI, au lieu
 * d'un « injoignable » trompeur.
 *
 * @param {string} host
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, error: { code: string, message: string, hint: string|null } | null }>}
 */
export async function probeOllama(host, { timeoutMs = 3000 } = {}) {
  try {
    const res = await netFetch(`${host}/api/tags`, {
      purpose: 'probe',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, error: null };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (/^(NET_|USER_CONFIG_)/.test(code)) {
      return { ok: false, error: { code, message: error.message, hint: error.hint ?? null } };
    }
    return { ok: false, error: null };
  }
}

/**
 * Vérifie qu'un serveur Ollama répond sur `host`.
 * Retourne false (jamais de throw) : utilisé par striart init pour
 * un diagnostic, pas comme prérequis bloquant.
 */
export async function pingOllama(host, options = {}) {
  return (await probeOllama(host, options)).ok;
}
