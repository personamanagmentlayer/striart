import path from 'node:path';

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
