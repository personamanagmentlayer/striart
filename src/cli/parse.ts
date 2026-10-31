/**
 * Analyseurs d'arguments (couche L3) : toute valeur fournie en ligne de
 * commande est validée ICI, avant le moindre appel au domaine. Un refus
 * lève `InvalidArgumentError` de commander → erreur d'usage, sortie 2.
 *
 * Validation positive et stricte : `--days 7d`, `--pid 12abc` ou
 * `--timeout 5000abc` sont refusés (un `parseInt` lâche les acceptait).
 */
import { InvalidArgumentError } from 'commander';
import { AGENT_NAME_RE } from '../agent-name.ts';
import { RUN_ID_RE } from '../orchestration/ids.ts';
import { isSafeProjectPath, normalizeFilePath } from '../project-path.ts';
import { TICKET_ID_RE } from '../ticket-id.ts';
import type { Messages } from './i18n/index.ts';

const INTEGER_RE = /^(0|[1-9][0-9]*)$/;

export function integerParser(
  m: Messages,
  { min, max }: { min: number; max: number },
): (value: string) => number {
  return (value) => {
    const trimmed = value.trim();
    const parsed = INTEGER_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new InvalidArgumentError(m.parse.integer(value, min, max));
    }
    return parsed;
  };
}

export function agentNameParser(m: Messages): (value: string) => string {
  return (value) => {
    if (!AGENT_NAME_RE.test(value)) throw new InvalidArgumentError(m.parse.agentName(value));
    return value;
  };
}

/** Texte libre non vide (raison d'une réservation, prompt). */
export function nonEmptyParser(m: Messages): (value: string) => string {
  return (value) => {
    if (value.trim() === '') throw new InvalidArgumentError(m.parse.nonEmpty);
    return value;
  };
}

/** Identifiant de ticket : nom de dossier sous .striart/conflicts/ (agent-sha) — source unique src/ticket-id.js. */
export { TICKET_ID_RE };

/**
 * Chemin de projet relatif donné en option (`--accept-theirs`), accumulé
 * (option répétable). Validation positive : ni absolu, ni lecteur Windows, ni
 * segment `..`, ni antislash ni caractère de contrôle (un chemin git est en
 * `/`) ; un `./` initial est retiré, un chemin vide ou terminé par `/` est
 * refusé. Le résultat est comparé tel quel aux chemins du ticket.
 */
export function projectPathParser(m: Messages): (value: string, previous?: string[]) => string[] {
  return (value, previous = []) => {
    const printable = /^[^\\\u0000-\u001f\u007f]+$/.test(value);
    const clean = printable ? value.replace(/^\.\//, '') : '';
    if (clean.trim() === '' || clean.endsWith('/') || !isSafeProjectPath(clean)) {
      throw new InvalidArgumentError(m.parse.projectPath(value));
    }
    return previous.includes(clean) ? previous : [...previous, clean];
  };
}

export function ticketIdParser(m: Messages): (value: string) => string {
  return (value) => {
    if (!TICKET_ID_RE.test(value)) {
      throw new InvalidArgumentError(m.parse.ticketId(value));
    }
    return value;
  };
}

/** Identifiant de run d'orchestration (`striart plan --resume`) — source unique src/orchestration/ids.ts. */
export function runIdParser(m: Messages): (value: string) => string {
  return (value) => {
    if (!RUN_ID_RE.test(value)) throw new InvalidArgumentError(m.parse.runId(value));
    return value;
  };
}

/** Chemin de sortie d'un fichier généré (`striart draft --out`) : même sûreté que projectPathParser, une seule valeur. */
export function outPathParser(m: Messages): (value: string) => string {
  return (value) => {
    const clean = normalizeFilePath(value);
    if (clean === '' || clean.endsWith('/') || !isSafeProjectPath(clean)) {
      throw new InvalidArgumentError(m.parse.projectPath(value));
    }
    return clean;
  };
}
