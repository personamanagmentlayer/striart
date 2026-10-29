// Bundle unique de l'extension : CommonJS (exigé par l'hôte d'extensions), `vscode` externe,
// aucune dépendance d'exécution (tout est dans src/). Sans sourcemap dans le .vsix.
import { build } from 'esbuild';

const production = !process.argv.includes('--dev');

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  minify: production,
  sourcemap: production ? false : 'linked',
  legalComments: 'none',
  logLevel: 'info',
});
