/**
 * Battement de SORTIE d'une session autonome en mode argv.
 *
 * Le journal d'une session argv n'est écrit qu'à sa FIN (session.js) : pendant
 * qu'elle tourne, rien sur disque ne dit si l'agent parle encore. Le process qui
 * supervise la session touche donc un fichier minuscule (`idle/beats/<agent>.beat`)
 * à chaque chunk de sortie, au plus une fois par `intervalMs` : son mtime est le
 * signal « sortie » du GC d'inactivité. Contenu vide : aucune donnée de l'agent
 * n'y transite, et il n'est jamais lu comme du JSON.
 *
 * Best effort PAR CONSTRUCTION côté écrivain (un battement raté ne doit jamais
 * faire échouer une session valide) — et sans conséquence côté lecteur : un
 * battement absent ou illisible rend l'agent ACTIF (fail closed, signals.ts).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.ts';
import { outputBeatPath } from './paths.ts';

export const DEFAULT_BEAT_INTERVAL_MS = 10_000;

export interface OutputBeat {
  /** À appeler à chaque chunk de sortie ; écrit au plus une fois par intervalle. */
  note(): void;
  /** Retire le battement (la session est finie) ; attend une écriture en vol. */
  stop(): Promise<void>;
}

export async function startOutputBeat(
  root: string,
  agent: string,
  { intervalMs = DEFAULT_BEAT_INTERVAL_MS, now = () => Date.now() } = {},
): Promise<OutputBeat> {
  const file = outputBeatPath(root, agent);
  let lastWrite = 0;
  let writing: Promise<void> = Promise.resolve();
  let stopped = false;

  const write = (): Promise<void> => {
    lastWrite = now();
    writing = writing.then(async () => {
      if (stopped) return;
      try {
        await writeFile(file, '', { mode: 0o600 });
      } catch (error) {
        logger.debug({ err: error, agent }, 'Battement de sortie non écrit (ignoré)');
      }
    });
    return writing;
  };

  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch (error) {
    logger.debug({ err: error, agent }, 'Dossier des battements non créé (ignoré)');
  }
  await write();

  return {
    note() {
      if (stopped || now() - lastWrite < intervalMs) return;
      void write();
    },
    async stop() {
      stopped = true;
      await writing;
      await rm(file, { force: true }).catch(() => undefined);
    },
  };
}
