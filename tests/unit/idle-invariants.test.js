import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Invariants STRUCTURELS du GC d'inactivité (src/idle/), vérifiés sur le source :
 * ce que le module ne peut pas faire, il ne le fait pas parce que le code qui le
 * ferait n'y est même pas importé — pas parce qu'un test de comportement l'a
 * oublié. Même esprit que le test « tout appel sortant passe par net.ts ».
 */
const IDLE_DIR = fileURLToPath(new URL('../../src/idle/', import.meta.url));

async function sources() {
  const files = (await readdir(IDLE_DIR)).filter((f) => f.endsWith('.ts'));
  return Promise.all(
    files.map(async (f) => ({ file: f, text: await readFile(path.join(IDLE_DIR, f), 'utf8') })),
  );
}

/** Code hors commentaires (les commentaires nomment légitimement ce qui est interdit). */
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');

describe('GC d’inactivité — ce qu’il ne peut pas faire (invariants structurels)', () => {
  it('ne prend JAMAIS le verrou principal (ni withMainLock, ni lock.ts hors lecture du statut)', async () => {
    for (const { file, text } of await sources()) {
      const c = code(text);
      expect(c, file).not.toMatch(/withMainLock/);
      expect(c, file).not.toMatch(/assertMainLockHeld|reserveMainSession|assertNoLiveMainSession/);
    }
    // La seule lecture permise du verrou : son statut, en lecture seule.
    const signals = (await sources()).find((s) => s.file === 'signals.ts');
    expect(signals.text).toMatch(/import \{ readMainLockStatus \} from '\.\.\/lock\.ts'/);
  });

  it('ne merge, ne rebase, ne supprime et ne retire jamais un clone ou un agent du registre', async () => {
    const forbidden = [
      /removeClone|cleanClones|resumeCloneRemovals|removeAgentFromRegistry/,
      /mergeAgentCommit|stopAgent|syncAgentWithMain|syncAllAgents|promoteStaging|rollbackLastMerge/,
      /\bsimpleGit\b|\bcloneGit\b|from 'simple-git'/,
      /killProcessTree\([^)]*meta\.path/,
    ];
    for (const { file, text } of await sources()) {
      const c = code(text);
      for (const pattern of forbidden) expect(c, `${file} ${pattern}`).not.toMatch(pattern);
    }
  });

  it('n’efface que ses propres fichiers (battements, demandes de fermeture), jamais un chemin de clone', async () => {
    for (const { file, text } of await sources()) {
      for (const match of code(text).matchAll(/\brm\(([^)]*)\)/g)) {
        expect(match[1], `${file}: rm(${match[1]})`).toMatch(
          /file|closeRequestPath|outputBeatPath/,
        );
        expect(match[1], file).not.toMatch(/meta\.path|clonePath|agentsDir/);
      }
    }
  });

  it('n’écrit un fichier d’état JSON que par updateJsonLocked (jamais writeFile direct)', async () => {
    for (const { file, text } of await sources()) {
      const c = code(text);
      // Seul le battement (fichier VIDE, jamais lu comme JSON) s'écrit par writeFile.
      if (file === 'heartbeat.ts') continue;
      expect(c, file).not.toMatch(/\bwriteFile\(/);
    }
  });

  it('ne fait aucun appel sortant et n’utilise aucun shell', async () => {
    for (const { file, text } of await sources()) {
      const c = code(text);
      expect(c, file).not.toMatch(
        /\bfetch\(|https?\.request|netFetch|execa|child_process|shell:\s*true/,
      );
    }
  });

  it('console.* est interdit (journal pino uniquement)', async () => {
    for (const { file, text } of await sources()) expect(code(text), file).not.toMatch(/console\./);
  });
});
