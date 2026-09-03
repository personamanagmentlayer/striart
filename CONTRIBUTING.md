# Contribuer à Striart

Merci de votre intérêt ! Ce document couvre l'essentiel pour qu'une
contribution se passe bien — pour le fond (architecture, décisions clés,
conventions détaillées), la référence est la [documentation](docs/fr/README.md).

## Démarrer

```bash
git clone https://github.com/personamanagmentlayer/striart.git
cd striart
npm install
npm run test:unit    # ~20 s — doit être vert avant de commencer
```

Il n'y a **rien à compiler** : `bin` pointe sur la source (ESM, Node 22.18+ —
le type stripping natif exécute les `.ts` tels quels), le typage (`.ts` et
`.js` annotés JSDoc) est vérifié par `tsc` sans étape de build.

## Boucle de développement

```bash
npm run test:unit        # 244 tests, ~20 s — la boucle courte
npm run test:integration # 178 tests, vrais repos Git temporaires, ~7 min
npm test                 # les deux
npm run typecheck        # tsc --checkJs — le filet de typage
npm run lint             # ESLint (correctness) + Prettier --check
npm run format           # Prettier --write
```

Avant d'ouvrir une PR : `npm run lint && npm run typecheck && npm test` verts.
La CI GitHub Actions rejoue tout sur ubuntu/macos/windows × Node 22/24.

## Les règles qui ne se négocient pas

1. **Vérifier l'existant avant d'écrire.** Cherchez le *comportement* (pas
   seulement le nom que vous comptiez donner) avant d'ajouter une fonction, un
   statut ou une option. Les helpers subtils sont souvent déjà là, parfois
   privés — extraire et partager plutôt que recopier.
2. **Un test qui reproduit le bug avant le correctif** — et vérifiez qu'il
   échoue sans le correctif. Un test qui ne peut pas échouer ne prouve rien.
3. **Le dossier de test décide du budget de temps** : un test qui touche au
   disque ou à git va dans `tests/integration/`, jamais dans `tests/unit/`.
   Ne redéfinissez pas de timeout par test *en dessous* du global calibré
   (voir les projets dans `vitest.config.js`).
4. **Erreurs explicites** : `throw new StriartError(message, {code, details})`,
   jamais de repli silencieux.
5. **Sécurité** : aucune donnée utilisateur ne devient du code ni un chemin
   (`argv` + `shell: false`), les clés API restent dans des variables
   d'environnement, le dashboard reste sur 127.0.0.1. Voir
   [SECURITY.md](SECURITY.md) — et signalez les failles en privé.
6. **Décisions architecturales** (clones complets vs worktrees, Test Gate
   bloquant, verrou principal jamais tenu pendant une opération longue…) :
   ouvrez une issue pour en discuter **avant** d'écrire le code qui les
   remettrait en cause.

## Style

- ESM uniquement, `async/await`, early return, modules en kebab-case,
  fonctions en camelCase.
- **TypeScript réel, exécuté par le type stripping natif de Node (zéro build)** :
  nouveau code en `.ts`, syntaxe effaçable uniquement (`erasableSyntaxOnly` —
  pas d'enum/namespace). Les `.js` annotés JSDoc de l'existant cohabitent et
  migrent au fil des retouches. Un module `.ts` s'importe avec l'extension
  `.ts`. Contrats de données centralisés dans `src/types.d.ts`.
- Git via `simple-git`, filesystem via `fs/promises`, logs via `pino`
  (`src/logger.js`) — pas de `console.log` hors de `cli.js`.
- Le formatage est appliqué par Prettier (`npm run format`) : aucun débat de
  style en revue.

## Commits et PR

- Messages de commit descriptifs, format libre inspiré de Conventional
  Commits (`feat:`, `fix:`, `docs:`, `test:`…), le **pourquoi** dans le corps.
- Une PR = un sujet. Les correctifs d'un même défaut présent à plusieurs
  endroits vont ensemble ; un refactoring opportuniste sans rapport, non.
- Mettez à jour le `CHANGELOG.md` (section `[Non publié]`) pour tout
  changement visible d'un utilisateur.

## Publication (mainteneur)

La publication du paquet est effectuée par le mainteneur sur un registre npm
privé ; elle n'est pas ouverte aux contributions.

## Langue

Le projet est documenté en français (code commenté en français, README
bilingue). Les contributions en anglais sont bienvenues — n'y voyez pas un
obstacle : une PR claire en anglais vaut mieux qu'une PR retenue.
