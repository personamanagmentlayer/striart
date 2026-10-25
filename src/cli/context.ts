/**
 * Contrat entre le noyau de la CLI (main.ts) et chaque commande.
 *
 * Une commande ne décide NI du format ni du code de sortie :
 *  - `execute` rend une valeur du domaine (`data`) et une issue (`outcome`) ;
 *  - `render` présente cette valeur à un humain (stdout) ;
 *  - main.ts choisit entre `render` et le document `--json`, et traduit
 *    l'issue en code de sortie (exit.ts).
 * Les commandes longues (watch, dashboard) écrivent leurs événements au fil
 * de l'eau via `ctx.out`, et rendent leur issue à l'arrêt.
 */
import type { Capabilities } from './caps.ts';
import type { Outcome } from './exit.ts';
import type { Locale, Messages } from './i18n/index.ts';
import type { Output } from './output.ts';

export interface CommandWarning {
  code: string;
  message: string;
}

export interface CommandResult<T = unknown> {
  data: T;
  outcome: Outcome;
  /** Avertissements non bloquants : affichés sur stderr, et dans `warnings` du document JSON. */
  warnings?: CommandWarning[];
  /**
   * La commande a déjà écrit un flux ndjson : en `--json`, main.ts le
   * termine par un événement `end` au lieu d'un document (un flux reste
   * homogène : une ligne = un événement typé).
   */
  streamed?: boolean;
}

export interface Ctx {
  /** Nom de la commande (champ `command` du document JSON). */
  command: string;
  json: boolean;
  out: Output;
  m: Messages;
  locale: Locale;
  caps: Capabilities;
  cwd: string;
  /** Racine du dépôt git courant (calculée une fois ; renseigne `out.root`). */
  repoRoot(): Promise<string>;
  /** Déclenché à l'arrêt demandé (Ctrl+C) : les commandes longues s'en servent pour se terminer proprement. */
  signal: AbortSignal;
}

export interface CommandModule<Input, Data = unknown> {
  execute(ctx: Ctx, input: Input): Promise<CommandResult<Data>>;
  /** Absent pour les commandes qui ne produisent qu'un flux (mcp, attach…). */
  render?(ctx: Ctx, result: CommandResult<Data>): void;
}
