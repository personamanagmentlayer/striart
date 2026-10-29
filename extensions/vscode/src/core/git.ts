/**
 * Les deux seuls accès au disque/à git hors protocole : le dossier du clone
 * d'un agent (reconstruit, jamais pris dans une donnée du serveur) et un diff
 * en lecture seule de ses commits en attente.
 */
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

const DIFF_MAX_BYTES = 8 * 1024 * 1024;
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Dossier du clone d'un agent : reconstruit depuis la racine et le nom validé ; null s'il est absent ou est un lien. */
export async function agentClone(root: string, name: string): Promise<string | null> {
  if (!AGENT_NAME_RE.test(name)) return null;
  const dir = path.join(root, '.striart', 'agents', name);
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink() ? dir : null;
  } catch {
    // Clone absent.
    return null;
  }
}

/**
 * Diff des `count` derniers commits d'un clone. Le clone est écrit par un
 * agent : sa configuration git n'est pas fiable — pas de moniteur de fichiers
 * (`core.fsmonitor` exécute une commande), pas de pilote de diff externe ni de
 * conversion de texte, pas de verrous optionnels, jamais de prompt. Lecture
 * seule, argv, `shell: false`, borné en temps et en taille.
 */
export function gitDiff(git: string, cwd: string, count: number, baseEnv: NodeJS.ProcessEnv): Promise<string> {
  const n = Math.max(1, Math.min(10_000, Math.floor(count)));
  const env = {
    ...baseEnv,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_EXTERNAL_DIFF: '',
  };
  return new Promise((resolve, reject) => {
    execFile(
      git,
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.pager=cat',
        '-c',
        'core.hooksPath=',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--stat',
        '--patch',
        `HEAD~${n}`,
        'HEAD',
        '--',
      ],
      { cwd, env, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: DIFF_MAX_BYTES, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
