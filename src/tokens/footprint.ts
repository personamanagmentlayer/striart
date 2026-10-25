/**
 * Empreinte des gabarits de consignes injectées aux agents (lot T), pour
 * doctor : module à part pour que la vue d'état (status) ne charge pas
 * agents/instructions.ts.
 */
import type { StriartConfig } from '../types.js';
import {
  COMPACT_INSTRUCTIONS_TEMPLATE,
  DEFAULT_INSTRUCTIONS_TEMPLATE,
} from '../agents/instructions.ts';
import { estimateTokens } from './estimate.ts';
import { resolveTokensSettings } from './settings.ts';

/** Empreinte (jetons estimés) des gabarits de consignes, pour doctor. */
export function instructionsFootprint(config: StriartConfig | Record<string, unknown>): {
  mode: 'full' | 'compact';
  fullTokens: number;
  compactTokens: number;
} {
  const settings = resolveTokensSettings(config as { tokens?: unknown });
  return {
    mode: settings.instructions.mode,
    fullTokens: estimateTokens(DEFAULT_INSTRUCTIONS_TEMPLATE, settings.estimator),
    compactTokens: estimateTokens(COMPACT_INSTRUCTIONS_TEMPLATE, settings.estimator),
  };
}
