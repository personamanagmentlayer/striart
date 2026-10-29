import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_NAME_RE } from '../../agent-name.ts';
import type { CommandModule } from '../context.ts';
import { TICKET_ID_RE } from '../parse.ts';

export type CompleteKind = 'agents' | 'tickets' | 'profiles';

export interface CompleteInput {
  kind: CompleteKind;
}

/**
 * Interne — valeurs dynamiques pour les scripts de complétion. Lit les
 * fichiers de `.striart/` directement, sans git ni verrou : appelée à chaque
 * appui sur Tab, elle doit répondre en quelques millisecondes et ne jamais
 * échouer bruyamment (une complétion vide vaut mieux qu'une erreur).
 *
 * Frontière de confiance : ces valeurs finissent dans le shell interactif de
 * l'utilisateur, et `.striart/` est écrit par d'autres process (sessions
 * d'agent, autre utilisateur local). Seules les valeurs conformes au motif de
 * leur identifiant sortent — jamais un `$(…)`, un espace ou un glob — et la
 * racine retenue est celle d'un dépôt git appartenant à l'utilisateur.
 */
export const complete: CommandModule<CompleteInput, { values: string[] }> = {
  async execute(ctx, input) {
    const root = await findStriartRoot(ctx.cwd);
    if (!root) return { data: { values: [] }, outcome: 'ok' };
    // Échec de lecture (registre corrompu, dossier absent) : complétion vide,
    // jamais une erreur affichée au milieu de la ligne de commande.
    const values = await collect(root, input.kind).catch(() => []);
    const safe = values.filter((v) => PATTERNS[input.kind].test(v));
    return { data: { values: safe.sort() }, outcome: 'ok' };
  },

  render(ctx, { data }) {
    for (const value of data.values) ctx.out.print(value);
  },
};

/** Nom de profil proposé : même alphabet que les identifiants Striart. */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const PATTERNS: Record<CompleteKind, RegExp> = {
  agents: AGENT_NAME_RE,
  tickets: TICKET_ID_RE,
  profiles: PROFILE_NAME_RE,
};

/**
 * Racine Striart la plus proche : un dossier qui porte À LA FOIS `.git` et
 * `.striart` (un dépôt initialisé — depuis un clone d'agent, la remontée
 * atteint le principal). Un `.striart` sans `.git` (`/tmp/.striart` posé
 * par un tiers) est ignoré, comme un `.striart` d'un autre utilisateur.
 */
async function findStriartRoot(from: string): Promise<string | null> {
  let dir = path.resolve(from);
  for (;;) {
    const striart = await stat(path.join(dir, '.striart')).catch(() => null);
    if (striart?.isDirectory() && ownedByCurrentUser(striart.uid)) {
      if (await stat(path.join(dir, '.git')).catch(() => null)) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** POSIX : propriétaire = utilisateur courant. Windows : pas d'uid (ACL). */
function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

async function collect(root: string, kind: CompleteKind): Promise<string[]> {
  const base = path.join(root, '.striart');
  if (kind === 'agents') {
    const registry = JSON.parse(await readFile(path.join(base, 'agents.json'), 'utf8'));
    return Object.keys(registry);
  }
  if (kind === 'tickets') {
    const ids: string[] = [];
    for (const entry of await readdir(path.join(base, 'conflicts'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const resolved = await stat(path.join(base, 'conflicts', entry.name, 'RESOLVED')).catch(
        () => null,
      );
      if (!resolved) ids.push(entry.name);
    }
    return ids;
  }
  return completeProfiles(root);
}

/**
 * Profils proposés SANS exécuter la config du dépôt : un appui sur Tab
 * n'est pas une décision d'exécuter du code (config-as-code d'un dépôt
 * cloné, SECURITY.md). Les profils par défaut sont toujours là (fusion par
 * clé de loadConfig) ; une config en données est lue comme telle ; une
 * config en code n'est connue que par le cache que publie `striart
 * profiles` — commande explicite, qui, elle, l'exécute.
 */
async function completeProfiles(root: string): Promise<string[]> {
  const { DEFAULT_CONFIG, findConfigWithoutExecuting } = await import('../../config.ts');
  const names = new Set(Object.keys(DEFAULT_CONFIG.agentProfiles));
  const found = await findConfigWithoutExecuting(root);
  let declared: unknown = null;
  if (found.kind === 'data') declared = found.config.agentProfiles;
  if (found.kind === 'code') {
    const cache = await readProfileCache(root);
    if (cache?.configPath === found.filepath)
      declared = Object.fromEntries(cache.profiles.map((p) => [p, true]));
  }
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    for (const name of Object.keys(declared)) names.add(name);
  }
  return [...names];
}

const PROFILE_CACHE = 'completion-profiles.json';

interface ProfileCache {
  configPath: string;
  profiles: string[];
}

async function readProfileCache(root: string): Promise<ProfileCache | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(root, '.striart', PROFILE_CACHE), 'utf8'));
  } catch {
    // Pas encore publié (aucun `striart profiles`) ou illisible : seuls les
    // profils par défaut sont proposés — jamais une erreur sous le curseur.
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { configPath, profiles } = raw as Record<string, unknown>;
  if (typeof configPath !== 'string' || !Array.isArray(profiles)) return null;
  return { configPath, profiles: profiles.filter((p): p is string => typeof p === 'string') };
}

/**
 * Publie les noms de profils pour la complétion, après une exécution
 * EXPLICITE de la config (`striart profiles`). Données seulement : relues
 * par `__complete`, filtrées par motif comme toute valeur de `.striart/`.
 */
export async function writeProfileCache(
  root: string,
  configPath: string | null,
  profiles: string[],
): Promise<void> {
  if (configPath === null) return;
  const { writeJsonAtomic } = await import('../../json-file.ts');
  await writeJsonAtomic(path.join(root, '.striart', PROFILE_CACHE), { configPath, profiles });
}
