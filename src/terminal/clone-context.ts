import path from 'node:path';
import { AGENT_NAME_RE } from '../agent-name.ts';

/**
 * Contexte Striart d'un chemin situé DANS le clone d'un agent :
 * `<root>/.striart/agents/<agent>[/sous/dossier]` → `{ root, agent, clonePath }`.
 *
 * Fonction pure (aucune E/S) : elle lit la FORME du chemin, rien de plus.
 * Un appelant qui en tire une décision (hooks : collision signalée au nom
 * d'un agent) doit confirmer l'agent auprès du registre ; le lanceur de
 * terminal, lui, reçoit un chemin déjà issu du registre (`info.path`).
 *
 * Le nom d'agent extrait est validé (AGENT_NAME_RE) : il devient un nom de
 * fichier (Tab Config Warp) — jamais un segment arbitraire.
 */
export interface CloneContext {
  root: string;
  agent: string;
  clonePath: string;
}

export function inferCloneContext(
  target: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): CloneContext | null {
  if (typeof target !== 'string' || target.length === 0 || /[\0\r\n]/.test(target)) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  let current = p.resolve(target);
  for (;;) {
    const parent = p.dirname(current);
    if (parent === current) return null;
    const grand = p.dirname(parent);
    if (
      sameName(p.basename(parent), 'agents', platform) &&
      sameName(p.basename(grand), '.striart', platform) &&
      AGENT_NAME_RE.test(p.basename(current))
    ) {
      return { root: p.dirname(grand), agent: p.basename(current), clonePath: current };
    }
    current = parent;
  }
}

function sameName(actual: string, expected: string, platform: NodeJS.Platform): boolean {
  // Systèmes de fichiers insensibles à la casse par défaut : Windows et macOS.
  if (platform === 'win32' || platform === 'darwin') {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return actual === expected;
}
