// Extrait les littéraux passés à l10n.t() dans src/ (clé = message anglais).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const CALL = /l10n\.t\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;

export async function extractL10nStrings(srcDir) {
  const found = new Set();
  for (const file of await walk(srcDir)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(CALL)) {
      // Déséchappe les séquences usuelles d'un littéral JS.
      found.add(match[2].replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'));
    }
  }
  return [...found].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  console.log(JSON.stringify(await extractL10nStrings(srcDir), null, 2));
}
