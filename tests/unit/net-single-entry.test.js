import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Code exécuté DANS le navigateur (fetch relatif vers le serveur du dashboard) : hors périmètre. */
const BROWSER_SIDE = new Set(['dashboard.js', 'dashboard-client.ts']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(?:js|ts)$/.test(entry.name)) yield full;
  }
}

describe('net — point d’entrée unique des appels sortants', () => {
  it('aucun module de src/ n’appelle fetch() ni http(s).request() hors src/net.ts', async () => {
    const offenders = [];
    for await (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === 'net.ts' || BROWSER_SIDE.has(rel)) continue;
      const text = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (
        /(?<![.\w])fetch\s*\(/.test(text) ||
        /\bfetchImpl\s*=\s*fetch\b/.test(text) ||
        /\bhttps?\.(?:request|get)\s*\(/.test(text) ||
        /from\s+['"]node:https['"]/.test(text)
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
