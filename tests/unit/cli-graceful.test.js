import { describe, expect, it } from 'vitest';
import { isGraceful } from '../../src/cli/main.ts';

describe('isGraceful : commandes arrêtées proprement au premier signal', () => {
  it('commandes longues et sessions supervisées', () => {
    expect(isGraceful('watch', {})).toBe(true);
    expect(isGraceful('run', { autonomous: true })).toBe(true);
    expect(isGraceful('run', { onMain: true })).toBe(true);
    expect(isGraceful('run', {})).toBe(false);
    expect(isGraceful('status', {})).toBe(false);
  });

  // Un merge lancé par MCP tourne sous verrou, Test Gate compris : un
  // process.exit au premier signal laissait le dépôt en état « merging ».
  it('mcp : arrêt propre (les opérations en vol vont à leur terme)', () => {
    expect(isGraceful('mcp', { root: null, agent: null, readOnly: false })).toBe(true);
  });

  // Un plan peut lancer des sessions autonomes : le couper net laissait
  // l'agent vivre sans surveillance, sa fin de cycle jamais exécutée.
  it('plan appliqué : arrêt propre ; plan --dry-run : rien à arrêter', () => {
    expect(isGraceful('plan', { file: 'p.yaml', dryRun: false })).toBe(true);
    expect(isGraceful('plan', { file: 'p.yaml', dryRun: true })).toBe(false);
  });
});
