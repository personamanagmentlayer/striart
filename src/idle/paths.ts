/**
 * Chemins d'état du GC d'inactivité, tous sous `.striart/idle/` (jamais sous
 * `agents/`, qui est le worktree du clone : y écrire polluerait l'agent).
 */
import path from 'node:path';
import { striartDir } from '../paths.js';

export const idleDir = (root: string): string => path.join(striartDir(root), 'idle');

/** État persistant du GC (avertissements, fermetures), écrit sous le verrou d'état de `idle/`. */
export const idleStatePath = (root: string): string => path.join(idleDir(root), 'state.json');

/** Battement de sortie d'une session autonome : son mtime est l'instant de la dernière sortie de l'agent. */
export const outputBeatPath = (root: string, agent: string): string =>
  path.join(idleDir(root), 'beats', `${agent}.beat`);

/** Demande de fermeture propre d'une session autonome (protocole de stop-request.ts). */
export const closeRequestPath = (root: string, agent: string): string =>
  path.join(idleDir(root), 'close', `${agent}.json`);
