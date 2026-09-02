/**
 * Vérifie qu'un serveur Ollama répond sur `host`.
 * Retourne false (jamais de throw) : utilisé par striart init pour
 * un diagnostic, pas comme prérequis bloquant.
 */
export async function pingOllama(host, { timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
