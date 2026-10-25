/**
 * Configuration des hooks advisory (`hooks` dans striart.config) : défauts,
 * validation stricte, résolution des valeurs partielles. Module sans
 * dépendance (importé par config.js).
 *
 *   hooks: {
 *     collisions: true,        // signaler un fichier prédit/verrouillé par un autre agent
 *     notifySessionEnd: true,  // webhooks à la fin d'une session supervisée
 *   }
 *
 * Les deux sont des INFORMATIONS : aucun réglage ne permet à un hook de
 * Striart de bloquer une action de l'outil (advisory par construction).
 */
export interface HookSettings {
  collisions: boolean;
  notifySessionEnd: boolean;
}

export const DEFAULT_HOOK_SETTINGS: Readonly<HookSettings> = Object.freeze({
  collisions: true,
  notifySessionEnd: true,
});

const KEYS = ['collisions', 'notifySessionEnd'];

export function isValidHookSettings(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Object.keys(o).every((k) => KEYS.includes(k))) return false;
  return KEYS.every((k) => o[k] === undefined || typeof o[k] === 'boolean');
}

export function resolveHookSettings(value: unknown): HookSettings {
  const o =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    collisions: typeof o.collisions === 'boolean' ? o.collisions : DEFAULT_HOOK_SETTINGS.collisions,
    notifySessionEnd:
      typeof o.notifySessionEnd === 'boolean'
        ? o.notifySessionEnd
        : DEFAULT_HOOK_SETTINGS.notifySessionEnd,
  };
}
