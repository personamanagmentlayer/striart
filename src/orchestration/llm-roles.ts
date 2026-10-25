/**
 * LLM par rôle de Striart (décision O6, lot O) : `config.llmRoles.<rôle>`
 * remplace le bloc global `llm` pour ce rôle seulement — Router en local,
 * juge de course dans le cloud, ou l'inverse. Un rôle absent ou null replie
 * sur `llm` : la clé est additive, une config existante ne change pas de
 * comportement.
 *
 * Le résolveur rend une config COMPLÈTE dont seul `llm` diffère : chaque
 * appel à `llmGenerate({ config })` reste inchangé, la sélection est faite
 * en amont, sans toucher à la couche provider (llm.js) ni à ses garanties
 * (clé d'API par variable d'environnement seulement, timeouts, retries).
 */
import type { StriartConfig } from '../types.js';
import type { LlmRoleName } from './settings.ts';

export function llmConfigForRole<T extends Pick<StriartConfig, 'llm'> & Partial<StriartConfig>>(
  config: T,
  role: LlmRoleName,
): T {
  const spec = config.llmRoles?.[role] ?? null;
  return spec ? { ...config, llm: spec } : config;
}
