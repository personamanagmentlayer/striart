import os from 'node:os';
import path from 'node:path';

/** Marge sous la limite OS la plus stricte pour un socket Unix (104 octets, macOS ; 108, Linux). */
export const MAX_UNIX_SOCKET_PATH = 100;

/**
 * Dossier privé de l'utilisateur courant dans le dossier temporaire (POSIX) —
 * repli commun à tout socket Unix dont le chemin naturel sous `.striart/`
 * dépasserait `MAX_UNIX_SOCKET_PATH` (hôte ACP, hôte de pty). Jamais un nom
 * prévisible dans le dossier temporaire PARTAGÉ : dérivé de l'UID, qu'aucun
 * autre utilisateur local ne peut squatter.
 */
export function privateTmpDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `striart-${uid}`);
}

export function striartDir(root) {
  return path.join(root, '.striart');
}

export function agentsDir(root) {
  return path.join(striartDir(root), 'agents');
}

/**
 * État runtime des pty possédés (socket/pipe d'attache, PID du process
 * hôte) — un dossier PAR agent, mais JAMAIS sous `agentsDir` : ce chemin-là
 * EST le worktree git du clone, y écrire polluerait l'agent avec un fichier
 * non suivi (visible dans son propre `git status`).
 */
export function ptyDir(root) {
  return path.join(striartDir(root), 'pty');
}
