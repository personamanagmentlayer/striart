import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import {
  COMPACT_INSTRUCTIONS_TEMPLATE,
  DEFAULT_INSTRUCTIONS_TEMPLATE,
  buildAgentInstructions,
} from '../../src/agents/instructions.ts';
import { isValidInstructionsTemplate } from '../../src/agents/profile-schema.ts';
import { instructionsFootprint } from '../../src/tokens/footprint.ts';

const PROFILE = { command: 'claude', args: ['{{prompt}}'] };
const build = (config, profile = PROFILE) =>
  buildAgentInstructions({
    root: '/tmp/does-not-exist',
    agent: 'agent-a',
    profileKey: 'claude',
    profile,
    config: { ...DEFAULT_CONFIG, ...config },
    mode: 'autonomous',
  });

describe('consignes injectées : mode compact', () => {
  it('le gabarit compact est valide (mêmes placeholders connus)', () => {
    expect(isValidInstructionsTemplate(COMPACT_INSTRUCTIONS_TEMPLATE)).toBe(true);
  });

  it('défaut : gabarit complet, inchangé', async () => {
    const text = await build({});
    expect(text).toContain('# Striart session rules');
  });

  it('compact : environ trois fois moins de jetons, règles essentielles conservées', async () => {
    const full = await build({});
    const compact = await build({ tokens: { instructions: { mode: 'compact' } } });
    expect(compact.length).toBeLessThan(full.length * 0.6);
    expect(compact).toContain('agent-a');
    expect(compact).toContain(DEFAULT_CONFIG.testCommand);
    expect(compact).toContain('Never push');
    expect(compact).toMatch(/protected files/);
    expect(compact).not.toContain('{{');
  });

  it('un gabarit explicite de l’utilisateur prime sur le mode compact', async () => {
    const text = await build({
      tokens: { instructions: { mode: 'compact' } },
      agentInstructions: { ...DEFAULT_CONFIG.agentInstructions, template: 'MIEN {{agent}}' },
    });
    expect(text).toBe('MIEN agent-a\n');
  });

  it('la taille est mesurée (doctor)', () => {
    const fp = instructionsFootprint({ tokens: { instructions: { mode: 'compact' } } });
    expect(fp.mode).toBe('compact');
    expect(fp.compactTokens).toBeLessThan(fp.fullTokens * 0.6);
    expect(DEFAULT_INSTRUCTIONS_TEMPLATE.length).toBeGreaterThan(
      COMPACT_INSTRUCTIONS_TEMPLATE.length,
    );
  });
});
