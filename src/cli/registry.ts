/**
 * Registre UNIQUE des commandes de la CLI : nom, groupe d'aide, format de
 * sortie machine, contrainte de premier plan. Consommé par :
 *  - program.ts (déclaration commander, groupes de l'aide) ;
 *  - completion.ts (scripts de complétion bash/zsh/fish/PowerShell) ;
 *  - watch-ui.ts (autocomplétion « / » et refus des commandes de premier plan) ;
 *  - tests/unit/cli-contract.test.js (synchronisation avec docs/*\/commands).
 * Les textes (résumé, description, exemples) vivent dans les catalogues
 * i18n, indexés par le nom de la commande.
 *
 * Module sans dépendance : importé par l'aide et par `watch --ui`, il ne
 * doit jamais tirer git, pino ou execa.
 */

export type CommandGroup = 'setup' | 'launch' | 'orchestrate' | 'observe' | 'repair' | 'integrate';

/**
 * Pourquoi une commande ne peut tourner que dans un vrai terminal, au
 * premier plan (refusée depuis le champ de `watch --ui`) :
 *  - 'watch'    : doublerait le watcher qui héberge déjà l'UI ;
 *  - 'protocol' : sert un protocole sur stdin/stdout (mcp, api, acp) ;
 *  - 'terminal' : doit posséder le terminal réel en mode raw (attach) ;
 *  - 'server'   : serveur sans fin, sauf formes `--daemon/--stop/--status` ;
 *  - 'internal' : commande interne, jamais lancée par un humain.
 */
export type ForegroundReason = 'watch' | 'protocol' | 'terminal' | 'server' | 'internal';

export interface CommandSpec {
  name: string;
  group: CommandGroup | null;
  /**
   * Sortie machine : un document `--json`, un flux ndjson (`--json` sur une
   * commande longue), ou aucune (écart justifié : protocole, terminal brut).
   */
  json: 'document' | 'stream' | 'none';
  foreground?: ForegroundReason;
  hidden?: boolean;
}

export const GROUP_ORDER: CommandGroup[] = [
  'setup',
  'launch',
  'orchestrate',
  'observe',
  'repair',
  'integrate',
];

export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  { name: 'init', group: 'setup', json: 'document' },
  { name: 'doctor', group: 'setup', json: 'document' },
  { name: 'completion', group: 'setup', json: 'none' },

  { name: 'start', group: 'launch', json: 'document' },
  { name: 'run', group: 'launch', json: 'document' },
  { name: 'attach', group: 'launch', json: 'none', foreground: 'terminal' },
  { name: 'plan', group: 'launch', json: 'document' },
  { name: 'draft', group: 'launch', json: 'document' },
  { name: 'profiles', group: 'launch', json: 'document' },

  { name: 'watch', group: 'orchestrate', json: 'stream', foreground: 'watch' },
  { name: 'merge', group: 'orchestrate', json: 'document' },
  { name: 'sync', group: 'orchestrate', json: 'document' },
  { name: 'stop', group: 'orchestrate', json: 'document' },
  { name: 'orchestrate', group: 'orchestrate', json: 'document' },
  { name: 'review', group: 'orchestrate', json: 'document' },

  { name: 'status', group: 'observe', json: 'document' },
  { name: 'queue', group: 'observe', json: 'document' },
  { name: 'history', group: 'observe', json: 'document' },
  { name: 'usage', group: 'observe', json: 'document' },
  { name: 'trace', group: 'observe', json: 'document' },
  { name: 'dashboard', group: 'observe', json: 'stream', foreground: 'server' },

  { name: 'rollback', group: 'repair', json: 'document' },
  { name: 'resolve', group: 'repair', json: 'document' },
  { name: 'lock', group: 'repair', json: 'document' },
  { name: 'clean', group: 'repair', json: 'document' },
  { name: 'reconcile', group: 'repair', json: 'document' },
  { name: 'prune', group: 'repair', json: 'document' },
  { name: 'gc', group: 'repair', json: 'document' },

  { name: 'promote', group: 'integrate', json: 'document' },
  { name: 'mcp', group: 'integrate', json: 'none', foreground: 'protocol' },
  { name: 'api', group: 'integrate', json: 'none', foreground: 'protocol' },
  { name: 'acp', group: 'integrate', json: 'none', foreground: 'protocol' },
  { name: 'hook', group: 'integrate', json: 'document' },

  { name: '__complete', group: null, json: 'none', hidden: true },
]);

/** Shells pris en charge par `striart completion`. */
export type Shell = 'bash' | 'zsh' | 'fish' | 'powershell';
export const SHELLS: readonly Shell[] = ['bash', 'zsh', 'fish', 'powershell'];

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Commandes visibles par un humain (aide, complétion, autocomplétion). */
export function publicCommands(): CommandSpec[] {
  return COMMANDS.filter((c) => !c.hidden);
}
