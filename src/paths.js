import path from 'node:path';

export function striartDir(root) {
  return path.join(root, '.striart');
}

export function agentsDir(root) {
  return path.join(striartDir(root), 'agents');
}
