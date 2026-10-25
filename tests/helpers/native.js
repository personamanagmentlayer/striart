// Chemins du binaire natif construit (npm run native:build) et de ses
// fixtures de test (exemples du crate, jamais livrés).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NATIVE_RELEASE_DIR = path.join(REPO_ROOT, 'native', 'target', 'release');
const EXE = process.platform === 'win32' ? '.exe' : '';

export function nativeBinaryPath() {
  return path.join(NATIVE_RELEASE_DIR, `striart-native${EXE}`);
}

/** `process-fixture` (process pilotables) ou `protocol-fixture` (faux binaire). */
export function nativeFixturePath(name) {
  return path.join(NATIVE_RELEASE_DIR, 'examples', `${name}${EXE}`);
}
