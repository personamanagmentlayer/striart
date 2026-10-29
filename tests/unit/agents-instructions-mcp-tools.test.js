import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildAgentInstructions } from '../../src/agents/instructions.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import { TOOLS } from '../../src/mcp/tools.ts';

/**
 * Les consignes données aux agents nomment des outils MCP : elles ne doivent
 * citer que des outils qui EXISTENT (source : src/mcp/tools.ts) et classer
 * chacun comme le serveur le fait (lecture / mutant). `striart_resolve` a été
 * retiré de l'exposition MCP ; `striart_promote` et `striart_ticket` existent.
 */
const ROOT = path.join(path.parse(process.cwd()).root, 'striart-nonexistent-root');
const TOOL_RE = /striart_[a-z_]+/g;

async function mcpRulesText(mode, compact) {
  const config = {
    ...DEFAULT_CONFIG,
    tokens: {
      ...(DEFAULT_CONFIG.tokens ?? {}),
      instructions: { mode: compact ? 'compact' : 'full' },
    },
  };
  const text = await buildAgentInstructions({
    root: ROOT,
    agent: 'agent-a',
    profileKey: 'claude',
    profile: DEFAULT_CONFIG.agentProfiles.claude,
    config,
    mode,
  });
  // Seule la ligne « outils Striart » nous intéresse (hors bloc collaboration).
  return text
    .split('\n')
    .filter((l) => /MCP|Striart tools|read-only/.test(l))
    .join('\n');
}

describe('consignes agents : outils MCP cités = outils MCP réels', () => {
  const readOnly = [...TOOLS.values()].filter((t) => !t.mutating && !t.collab).map((t) => t.name);
  const mutating = [...TOOLS.values()].filter((t) => t.mutating && !t.collab).map((t) => t.name);

  it('le classement attendu reflète tools.ts (garde-fou du test lui-même)', () => {
    expect(readOnly).toEqual(expect.arrayContaining(['striart_status', 'striart_queue']));
    expect(mutating).toContain('striart_promote');
    expect(TOOLS.has('striart_resolve')).toBe(false);
  });

  for (const mode of ['autonomous', 'attended']) {
    for (const compact of [false, true]) {
      it(`${mode}${compact ? ' (compact)' : ''} : aucun outil fantôme, tous les outils de lecture cités`, async () => {
        const text = await mcpRulesText(mode, compact);
        const cited = new Set(text.match(TOOL_RE) ?? []);
        expect([...cited].filter((n) => !TOOLS.has(n))).toEqual([]);
        expect(cited.has('striart_resolve')).toBe(false);
        for (const name of readOnly) expect(cited.has(name), name).toBe(true);
        if (!compact) for (const name of mutating) expect(cited.has(name), name).toBe(true);
        // Canal de collaboration : outils réels, cités avec leur périmètre.
        if (!compact) {
          expect(cited.has('striart_collab_read')).toBe(true);
          expect(cited.has('striart_collab_post')).toBe(true);
        }
      });
    }
  }
});
