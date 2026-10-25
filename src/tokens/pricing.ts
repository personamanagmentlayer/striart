/**
 * Table de prix CONFIGURABLE (`tokens.pricing`) — aucun prix en dur.
 *
 * Un prix change sans prévenir et dépend du contrat de l'utilisateur : le
 * livrer figé dans le code serait une information périmée présentée comme un
 * fait. La table est donc vide par défaut ; chaque entrée porte sa date de
 * relevé (`asOf`, obligatoire) et `striart doctor` signale les entrées plus
 * vieilles que `pricingStaleAfterDays`.
 *
 * Exception documentée : un fournisseur `ollama` (modèle local, ni facture ni
 * API tierce) est compté à 0 USD sans déclaration — c'est une propriété du
 * transport, pas un prix.
 */
import type { TokenUsage } from '../types.js';
import type { PriceEntry, TokensSettings } from './settings.ts';

export type PriceLookup =
  { priced: true; price: PriceEntry | null; local: boolean } | { priced: false };

/** `provider:model` d'abord, puis `model` seul ; ollama = local gratuit. */
export function lookupPrice(
  pricing: TokensSettings['pricing'],
  provider: string | null,
  model: string | null,
): PriceLookup {
  if (model) {
    const exact = provider ? pricing[`${provider}:${model}`] : undefined;
    if (exact) return { priced: true, price: exact, local: false };
    const byModel = pricing[model];
    if (byModel) return { priced: true, price: byModel, local: false };
  }
  if (provider === 'ollama') return { priced: true, price: null, local: true };
  return { priced: false };
}

/** Coût en USD d'un usage, ou `null` si le modèle n'a pas de prix déclaré. */
export function costOf(
  usage: TokenUsage,
  pricing: TokensSettings['pricing'],
  provider: string | null,
  model: string | null,
): number | null {
  const found = lookupPrice(pricing, provider, model);
  if (!found.priced) return null;
  if (found.local || !found.price) return 0;
  const p = found.price;
  const million = 1_000_000;
  // Lecture/écriture de cache sans tarif propre : facturées comme de l'entrée
  // normale (surestimation prudente).
  return (
    (usage.input * p.inputPerMTok +
      usage.cacheRead * (p.cacheReadPerMTok ?? p.inputPerMTok) +
      usage.cacheWrite * (p.cacheWritePerMTok ?? p.inputPerMTok) +
      usage.output * p.outputPerMTok) /
    million
  );
}

/** Entrées de prix plus vieilles que `staleAfterDays` (pour doctor). */
export function stalePrices(
  pricing: TokensSettings['pricing'],
  staleAfterDays: number,
  now = Date.now(),
): Array<{ key: string; asOf: string; ageDays: number }> {
  const out: Array<{ key: string; asOf: string; ageDays: number }> = [];
  for (const [key, price] of Object.entries(pricing)) {
    const ageDays = Math.floor((now - Date.parse(`${price.asOf}T00:00:00Z`)) / 86_400_000);
    if (ageDays > staleAfterDays) out.push({ key, asOf: price.asOf, ageDays });
  }
  return out;
}
