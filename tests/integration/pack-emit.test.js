import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { analyzeEmittedModule } from '../../scripts/pack.ts';

// Garde de publication sur TOUT src/, sans dépendre de l'état git : chaque
// module est émis en mémoire avec les options de réécriture de
// tsconfig.pack.json, puis passé au contrôle même de scripts/pack.ts. Un
// chemin de module construit à l'exécution (`import(variable)`,
// `new URL('./x.ts', …)`) survit à l'émission et rend le paquet installé
// inutilisable (PACK_UNREWRITTEN_TS) — ce test le refuse dès l'écriture,
// avant même que le fichier soit suivi par git.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

async function listModules(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && /\.(js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts'))
    .map((e) => path.join(e.parentPath, e.name));
}

function emit(code, fileName) {
  return ts.transpileModule(code, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      rewriteRelativeImportExtensions: true,
      verbatimModuleSyntax: true,
    },
  }).outputText;
}

describe('JS publié — aucun chemin .ts ne survit à l’émission', () => {
  it('chaque module de src/ émis ne contient ni chemin .ts ni import relatif introuvable', async () => {
    const modules = await listModules(SRC);
    const tsNames = new Set(modules.filter((f) => f.endsWith('.ts')).map((f) => path.basename(f)));
    const leftovers = [];
    const unresolved = [];
    for (const file of modules) {
      const rel = path.relative(SRC, file).replaceAll('\\', '/');
      const analysis = analyzeEmittedModule(emit(await readFile(file, 'utf8'), file), tsNames);
      for (const hit of analysis.tsPaths) leftovers.push(`${rel}:${hit.line}  ${hit.text}`);
      for (const imp of analysis.relativeImports) {
        const target = path.resolve(path.dirname(file), imp.specifier.replace(/\.js$/, ''));
        const exists = modules.some((m) => m.replace(/\.(js|ts)$/, '') === target);
        if (!exists && !imp.specifier.endsWith('.json')) {
          unresolved.push(`${rel}:${imp.line}  ${imp.specifier}`);
        }
      }
    }
    expect(leftovers).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
