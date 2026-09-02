import { defineConfig } from 'vitest/config';

// Deux projets, deux régimes. Ils n'ont ni le même coût ni le même profil de
// panne, et les mélanger imposait le budget du plus lent au plus rapide :
// les tests unitaires (~10 s) attendaient derrière l'intégration (~6 min) à
// chaque `npm test`.
//
// ATTENTION : les options calibrées (timeouts, include) se déclarent PAR
// PROJET — un `test.testTimeout` posé au niveau racine n'est pas hérité par
// les projets : il aurait l'air actif sans l'être. (Vérifié par sonde à la
// migration vitest 4 : un test unitaire de 21 s meurt bien à 20 s.)
export default defineConfig({
  test: {
    coverage: {
      // Le rapport porte sur la logique métier, pas sur les tests eux-mêmes.
      // Les .ts (type stripping natif) comptent comme les .js ; seuls les
      // .d.ts (déclarations pures, jamais exécutées) sont hors assiette.
      include: ['src/**/*.{js,ts}'],
      exclude: ['src/**/*.d.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.js'],
          // LLM mocké, aucune opération Git réelle : la suite entière tient
          // en ~10 s, le test le plus lent en 2 s (kill d'arbre de process).
          // Au-delà de 20 s un test unitaire n'est pas lent, il est bloqué —
          // et l'échec doit être rapide pour que la boucle de dev le reste.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.js'],
          // Les tests d'intégration font de vraies opérations Git (clone,
          // merge, abort) qui ralentissent fortement quand les workers
          // tournent en parallèle sous Windows (antivirus + verrous
          // fichiers) : les timeouts reflètent la charge de la suite
          // complète, pas un test isolé.
          //
          // NE PAS redéfinir de timeout par test en dessous de cette valeur :
          // un `it(..., 60_000)` a l'air prudent mais ne fait que RÉDUIRE le
          // budget calibré ici, et rend le test vert isolé / rouge en suite
          // complète. Le cas s'est produit : un test de 19 s isolé, plafonné
          // à 60 s, a lâché dès que la suite s'est alourdie (facteur ~3 sous
          // charge). Un test qui a réellement besoin de plus que ce global
          // doit passer une valeur SUPÉRIEURE, avec le motif en commentaire.
          testTimeout: 90_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
