/**
 * Enveloppe UNIQUE des sorties machine de Striart : le document `--json` de
 * la CLI et les réponses du Striart Control Protocol v1 (stdio et HTTP).
 *
 * Un client (script, extension VS Code/JetBrains, dashboard) lit la même
 * forme quelle que soit la surface :
 *  - succès : `{ schemaVersion, command, ok, outcome?, data, warnings? }` ;
 *  - échec  : `{ schemaVersion, command, ok: false, error: { code, kind,
 *    message, hint, details } }`.
 * Le protocole ajoute `outcome` (le CLI le porte dans son code de sortie).
 * Les schémas publiés (`schemas/`, `src/control/schema.ts`) décrivent ces
 * formes ; `tests/unit/control-contract.test.js` vérifie que les deux
 * surfaces les respectent.
 *
 * Module sans dépendance lourde : main.ts l'importe à chaque démarrage.
 */
import { StriartError, publicErrorDetails } from '../errors.js';
import type { ErrorKind } from '../errors.js';
import type { Outcome } from '../cli/exit.ts';

/** Version du contrat des documents machine (`--json` et protocole). */
export const SCHEMA_VERSION = 1;

/** Version du Striart Control Protocol (négociée par `control.initialize`). */
export const CONTROL_PROTOCOL_VERSION = 1;

export interface ErrorObject {
  code: string;
  kind: ErrorKind;
  message: string;
  hint: string | null;
  details: Record<string, unknown>;
}

export interface DocumentWarning {
  code: string;
  message: string;
}

export interface SuccessDocument<T = unknown> {
  schemaVersion: number;
  command: string;
  ok: boolean;
  outcome?: Outcome;
  data: T;
  warnings?: DocumentWarning[];
}

export interface ErrorDocument {
  schemaVersion: number;
  command: string | null;
  ok: false;
  error: ErrorObject;
}

/** Sous-ensemble des catalogues i18n nécessaire au rendu d'une erreur. */
export interface ErrorMessages {
  errors(code: string, details: Record<string, unknown>): string | null;
  main: { unexpected(message: string): string; debugHint: string };
}

/**
 * Erreur → objet `error` du contrat. Le message est localisé par le
 * catalogue quand il connaît le code, sinon celui de l'erreur.
 *
 * `exposeUnexpected` : une erreur qui n'est PAS une StriartError (bug,
 * exception d'une bibliothèque) peut porter un chemin, une valeur interne.
 * La CLI (même utilisateur, terminal local) l'affiche ; le protocole HTTP
 * ne la renvoie jamais au navigateur — elle est journalisée côté serveur
 * (A10 : jamais d'information interne dans un message d'erreur exposé).
 */
export function errorObject(
  error: unknown,
  m: ErrorMessages,
  { exposeUnexpected }: { exposeUnexpected: boolean },
): ErrorObject {
  if (error instanceof StriartError) {
    return {
      code: error.code,
      kind: error.kind,
      message: m.errors(error.code, error.details) ?? error.message,
      hint: error.hint,
      details: publicErrorDetails(error.details),
    };
  }
  const raw = error instanceof Error ? error.message : String(error);
  return {
    code: 'UNEXPECTED',
    kind: 'failure',
    message: m.main.unexpected(exposeUnexpected ? raw : 'see the Striart log for details'),
    hint: m.main.debugHint,
    details: {},
  };
}

export function successDocument<T>(
  command: string,
  data: T,
  { outcome, warnings }: { outcome?: Outcome; warnings?: DocumentWarning[] } = {},
): SuccessDocument<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: (outcome ?? 'ok') === 'ok',
    ...(outcome ? { outcome } : {}),
    data,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

export function errorDocument(command: string | null, error: ErrorObject): ErrorDocument {
  return { schemaVersion: SCHEMA_VERSION, command, ok: false, error };
}
