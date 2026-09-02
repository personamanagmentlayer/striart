import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// ESLint est ici pour la CORRECTNESS (variables mortes, cas de switch qui
// fuient, await oubliés…) — le style appartient à Prettier, et
// eslint-config-prettier neutralise toute règle qui empiéterait dessus.
// Le gros du filet reste `npm run typecheck` (tsc).
//
// ── JS et TS cohabitent (migration progressive) ────────────────────────────
// Le dépôt migre vers TypeScript, exécuté par le type stripping natif de Node
// (zéro build). Les .js sont lintés par la config de base, les .ts par
// typescript-eslint. Subtilité de toolchain : typescript-eslint REFUSE
// TypeScript 7 (« does not support TS 7.0 ») — il lit la version du paquet
// `typescript`. On garde donc DEUX TypeScript côte à côte par alias npm
// (voir package.json) : `@typescript/native` (TS 7) fournit le `tsc` du
// typecheck (vitesse), et `typescript` pointe sur `@typescript/typescript6`
// (TS 6.0.x < 6.1.0) que typescript-eslint accepte pour parser les .ts.
export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/', '.striart/'] },
  // Config JS de base — cantonnée aux fichiers JS pour ne pas parasiter le TS.
  { files: ['**/*.js', '**/*.cjs', '**/*.mjs'], ...js.configs.recommended },
  // Config TS — parser typescript-eslint sur les .ts uniquement.
  { files: ['**/*.ts'], extends: [tseslint.configs.recommended] },
  prettier,
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // try/catch autour de git/fs : catch vide toléré UNIQUEMENT s'il est
      // commenté (un catch muet non expliqué est un repli silencieux, interdit).
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Les .ts : mêmes intentions, variante typescript-eslint des règles.
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { caughtErrors: 'none', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Le helper de test CJS a ses propres globals.
    files: ['tests/helpers/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
);
