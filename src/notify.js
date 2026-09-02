import { logger } from './logger.js';

/**
 * Notifications sortantes — best-effort par contrat : un canal en panne ne
 * doit JAMAIS faire échouer un merge. Deux sources de configuration :
 *
 *  - `notifiers` : la table multi-canaux. Chaque entrée déclare son `type`
 *    explicitement (le format du payload en dérive) et son URL, soit en
 *    clair (`url`), soit — préférable, une URL de webhook est un secret —
 *    via le nom d'une variable d'environnement (`urlEnv`).
 *  - `webhookUrl` : l'ancien canal unique, conservé tel quel. Son type est
 *    deviné par l'URL (comportement historique), il s'ajoute à la table.
 *
 * Payload par type :
 *  - slack   → { text }
 *  - discord → { content }
 *  - generic → { message } (endpoint maison : n8n, ntfy, webhook interne…)
 */

const PAYLOADS = {
  slack: (message) => ({ text: message }),
  discord: (message) => ({ content: message }),
  generic: (message) => ({ message }),
};

/** Variables d'environnement absentes déjà signalées — un warning par process,
 *  pas un par notification : notify est sur le chemin de chaque merge. */
const warnedMissingEnv = new Set();

/**
 * Résout la liste des cibles effectives (type + url) depuis la config.
 * Une entrée `urlEnv` dont la variable est absente est écartée avec un
 * warning (une seule fois par variable) : notify est best-effort, mais
 * l'écart ne doit pas être invisible.
 *
 * @param {import('./types.js').StriartConfig} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{type: keyof typeof PAYLOADS, url: string}>}
 */
export function resolveNotifiers(config, env = process.env) {
  const targets = [];

  // Canal historique : type deviné par l'URL, comme depuis toujours.
  if (config.webhookUrl) {
    targets.push({
      type: config.webhookUrl.includes('discord') ? 'discord' : 'slack',
      url: config.webhookUrl,
    });
  }

  for (const spec of config.notifiers ?? []) {
    let url = spec.url ?? null;
    if (!url && spec.urlEnv) {
      url = env[spec.urlEnv] ?? null;
      if (!url && !warnedMissingEnv.has(spec.urlEnv)) {
        warnedMissingEnv.add(spec.urlEnv);
        logger.warn(
          { urlEnv: spec.urlEnv, type: spec.type },
          `Notifier ${spec.type} ignoré : la variable d'environnement ${spec.urlEnv} est absente`,
        );
      }
    }
    if (url) targets.push({ type: spec.type, url });
  }

  return targets;
}

/**
 * Envoie `message` à tous les canaux configurés, en parallèle.
 * Retourne true si AU MOINS UN canal a accepté la notification, false sinon
 * (aucun canal configuré, ou tous en échec — chaque échec est loggé en
 * warning, jamais propagé).
 *
 * @param {import('./types.js').StriartConfig} config
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export async function notify(config, message) {
  const targets = resolveNotifiers(config);
  if (targets.length === 0) return false;

  const results = await Promise.all(
    targets.map(async ({ type, url }) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(PAYLOADS[type](message)),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return true;
      } catch (error) {
        logger.warn({ err: error.message, type }, 'Notification webhook échouée');
        return false;
      }
    }),
  );

  return results.some(Boolean);
}
