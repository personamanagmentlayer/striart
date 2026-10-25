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

Il n'y a **rien à compiler en développement côté JavaScript** (le binaire
natif Rust, lui, se construit — voir plus bas) : `bin` pointe sur la source
(ESM, Node 22.18+ — le type stripping natif exécute les `.ts` tels quels), le
typage (`.ts` et `.js` annotés JSDoc) est vérifié par `tsc` sans étape de
build. Seule la **publication** émet du JS (`npm run pack:release`,
`scripts/pack.ts`) : Node refuse délibérément le type stripping des fichiers
situés sous `node_modules`, un paquet contenant des `.ts` ne démarrerait pas
une fois installé.

## Boucle de développement

```bash
npm run dev              # node --watch-path=src src/cli.js (relance à chaque modification)
npm run test:unit        # 1586 tests (LLM mocké, sans Git réel) — la boucle courte
npm run test:integration # 920 tests, vrais repos Git temporaires, binaire natif exigé
npm run test:pack        # 6 tests : paquet publié → npm install → binaire installé (réseau)
npm test                 # unit + intégration (hors réseau) ; test:pack et test:ci couvrent le paquet
npm run typecheck        # tsc --checkJs — le filet de typage (src/ et scripts/)
npm run lint             # ESLint (correctness) + Prettier --check
npm run format           # Prettier --write
npm run pack:release     # archive publiable (JS émis) + SBOM dans dist/ — ne publie pas
npm run bench:startup    # temps de démarrage de la CLI (médiane et p90 vs `node -e 0`)
npm run bench:tokens     # économie de tokens avant/après (Merger, arbre du Router, consignes, Memory), hors ligne
npm run native:build     # binaire natif (cargo build --release) ; native:test, native:lint, native:deny, native:stage, native:keygen
```

Comptes de tests : `npx vitest list` (jamais un `grep` sur les fichiers, qui
sous-compte), 1586 unitaires + 920 d'intégration + 6 du projet `pack`, relevés
le 2026-10-25. Aucune durée n'est promise ici : elles dépendent de la machine
et n'ont pas été remesurées sur ce lot.

Aucun outil de rechargement tiers : `npm run dev` repose sur le
`--watch-path` natif de Node (nodemon a été retiré des dépendances).

`test:pack` est un projet vitest à part (`pack`) : il installe les
dépendances du paquet depuis le réseau (`--prefer-offline` sert le cache npm
quand il est chaud) et ne ralentit donc pas `test:integration`. Il construit
l'archive avec `--allow-dirty` — il vérifie votre arbre de travail, fichiers
non suivis par git **exclus** : un module neuf pas encore `git add` fait
échouer le pack (`PACK_UNRESOLVED_IMPORT`, avec la commande à lancer).

Le garde-fou de publication ne dépend pas de git :
`tests/integration/pack-emit.test.js` émet **tout** `src/` en mémoire avec
les options de `tsconfig.pack.json` et refuse un chemin `.ts` survivant à
l'émission. Conséquence pour le code : un module chargé paresseusement
s'importe par un `import()` **à littéral** (`import('./commands/x.ts')`) —
un spécificateur construit à l'exécution (`import(variable)`,
`new URL('./x.ts', import.meta.url)`) n'est pas réécrit en `.js` et rendrait
le paquet installé inutilisable (`PACK_UNREWRITTEN_TS`).

## Composants natifs (Rust)

Une partie du CLI passe par un binaire natif, `striart-native` (crate
`native/`, workspace cargo) : identité groupée des process (`proc info`,
heure de création comprise), kill d'arbre (`proc tree-kill`), hôte de
terminal (`pty-host`) et conteneur de process (`job run`, qui héberge le
Test Gate). Il parle au paquet par un protocole
argv → JSON (`native/striart-native/src/protocol.rs`, `src/native.ts`).

**Faut-il compiler ?** Dans un checkout du dépôt, `src/native.ts` utilise le
build de développement `native/target/release/striart-native` : **le build
est requis** dès qu'une commande touche aux process (`status`, `lock`,
`stop`, daemons, Test Gate) et pour `npm run test:integration`. Sans lui :
`NATIVE_UNAVAILABLE` (« npm run native:build »), jamais un repli muet. Un
contributeur qui ne touche pas au natif peut désigner un binaire déjà
construit (artefact de CI `native-<plateforme>`) par `STRIART_NATIVE_BIN`
(chemin absolu ; `striart doctor` signale alors une intégrité non vérifiée).

```bash
# Rust via rustup (https://rustup.rs) ; la toolchain épinglée
# (native/rust-toolchain.toml) s'installe d'elle-même à la première commande.
# Windows : MSVC Build Tools (charge « Développement Desktop en C++ »).
npm run native:build   # cargo build --release (binaire + fixtures de test)
npm run native:test    # cargo test (unitaires + bout en bout du binaire)
npm run native:lint    # rustfmt --check + clippy -D warnings
npm run native:deny    # cargo-deny : licences + avis RustSec (cargo install cargo-deny --locked)
```

Les scripts cargo passent par `cd native` : rustup lit `rust-toolchain.toml`
depuis le dossier courant — lancé depuis la racine, cargo prendrait la
toolchain par défaut de la machine. `Cargo.lock` est versionné, toute
dépendance passe `cargo deny check` (`native/deny.toml`).

Les tests d'intégration (et `test:pack`) reconstruisent le binaire avant de
démarrer (`tests/helpers/native-setup.js`, ≈ 1 s quand rien n'a changé) : un
binaire périmé ne peut pas faire passer la suite. Sans cargo ni binaire, ils
échouent avec la marche à suivre — aucun test n'est sauté en silence. Sans
cargo mais avec un binaire déjà construit, sa conformité aux sources ne peut
pas être prouvée : la suite refuse de démarrer, sauf choix explicite
`STRIART_NATIVE_ALLOW_STALE=1` (à vos risques : un binaire périmé peut faire
passer des tests qu'il ne devrait pas).

**Tests hermétiques.** Striart s'initialise sur son propre dépôt (dogfooding) :
sans précaution, un test unitaire qui appelle un LLM sans racine remonterait
jusqu'au vrai `.striart/` du dépôt et y écrirait registre d'usage et cache. Le
projet `unit` pose donc `STRIART_TOKENS_NO_DISCOVERY=1` (coupe la découverte
*implicite* de la racine ; une racine explicite — dossier temporaire — reste
honorée) et son setup vérifie fichier par fichier que `.striart/usage` n'a pas
bougé. Un test qui a besoin d'un dépôt passe une racine temporaire explicite,
ou va dans `tests/integration/`.

**Distribution** : un binaire par plateforme (win32-x64, win32-arm64,
darwin-x64, darwin-arm64, linux-x64, linux-arm64), chacun dans son paquet npm
`@jumsay/striart-native-<plateforme>` (champs `os`/`cpu`), dépendances
optionnelles EXACTES du paquet principal (patron esbuild : npm n'installe que
celui de la machine). Linux : binaires **musl statiques** — un seul binaire
par CPU, valable sur glibc comme sur musl (Alpine) ; pas de variante libc.
Le paquet principal embarque `native-manifest.json` (SHA-256 et taille de
chaque binaire) et sa signature `native-manifest.sig.json`, vérifiés au
chargement contre `native/keys/<schéma>.pub` : empreinte ou signature
invalide → `NATIVE_INTEGRITY_FAILED`, le binaire n'est jamais exécuté.

**Signature** (schéma par défaut : minisign, Ed25519 ; registre
`src/native-signature.ts` — ajouter cosign ou Authenticode = un module + une
ligne). La clé publique est versionnée (`native/keys/minisign.pub`) ; la clé
privée n'existe qu'en **secret de CI** `STRIART_NATIVE_SIGNING_KEY` (+
`STRIART_NATIVE_SIGNING_KEY_PASSWORD` si elle est chiffrée), jamais dans le
dépôt. Rotation :

```bash
npm run native:keygen -- --secret-out /chemin/hors/depot/striart-native.key --rotate
# → native/keys/minisign.pub (à commiter) ; copier le contenu du fichier privé
#   dans le secret de CI, puis effacer le fichier.
```

La clé privée est chiffrée (scrypt) avec le mot de passe de la variable
nommée par `--password-env <VARIABLE>` ; l'écrire en clair est un choix
explicite (`--unencrypted`, à réserver à un coffre qui la chiffre déjà) —
aucun défaut implicite, et `--password-env` et `--unencrypted` s'excluent.
Sans `--rotate`, une clé publique existante n'est jamais remplacée (les
paquets déjà publiés restent vérifiés par l'ancienne).

**Ancre de confiance.** La clé publique voyage dans le paquet qu'elle
authentifie ; elle ne prouve donc pas la provenance. Le `keyId` signataire est
comparé à `PINNED_NATIVE_KEY_IDS` (constante de `src/native.ts`, **hors du
paquet vérifié**) et à `native.trustedKeyIds` de la config *utilisateur*.
Une **rotation** change donc deux choses dans le même commit :
`native/keys/minisign.pub` **et** `PINNED_NATIVE_KEY_IDS` (l'ancienne valeur
reste listée tant que des releases qu'elle a signées sont supportées).
Une organisation qui signe avec sa propre clé passe
`pack:release --signing-public-key <fichier>` (le keyId est alors à déclarer
chez chaque utilisateur, `native.trustedKeyIds`).
`--ephemeral-signing-key` (clé jetable, manifeste marqué `ephemeral`, refusé à
l'exécution) **exige `--dry-run`** (`PACK_EPHEMERAL_REQUIRES_DRY_RUN`) et est
incompatible avec `--signing-public-key` : aucune archive installable ne sort
jamais signée d'une clé jetable.

Le format est celui de l'outil `minisign` / `rsign2` : une clé générée par
eux s'utilise telle quelle (vecteurs d'interopérabilité dans
`tests/fixtures/minisign/`).

Avant d'ouvrir une PR : `npm run lint && npm run typecheck && npm test` verts
(et `npm run native:lint && npm run native:test` si vous touchez à `native/`).
La CI GitHub Actions rejoue tout sur ubuntu/macos/windows × Node 22/24, y compris le job `pack-smoke` (paquet publié installé puis exécuté).
Les secrets de signature ne sont lus que par le job `release-archives`, sur
un push de branche protégée, dans l'`environment` GitHub `release` (relecteurs requis) ; une
pull request, même d'une branche du dépôt, ne les voit jamais et signe en
`--dry-run` avec une clé jetable. Les actions sont épinglées par SHA de
commit, le jeton du workflow est en lecture seule par défaut,
`npm ci --ignore-scripts` précède toute signature, et `release-archives`
dépend des tests, de la fumée du paquet installé et des tests musl. Seul le
workflow GitHub joint une attestation de provenance (`gh attestation
verify`) ; l'autre CI n'en produit pas.

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
- **TypeScript réel, exécuté par le type stripping natif de Node (zéro build en développement — la publication émet du JS)** :
  nouveau code en `.ts`, syntaxe effaçable uniquement (`erasableSyntaxOnly` —
  pas d'enum/namespace). Les `.js` annotés JSDoc de l'existant cohabitent et
  migrent au fil des retouches. Un module `.ts` s'importe avec l'extension
  `.ts`. Contrats de données centralisés dans `src/types.d.ts`.
- Git via `simple-git` (4.x — une commande qui vise un clone passe par
  `cloneGit`), filesystem via `fs/promises`, logs via `pino`
  (`src/logger.js`, toujours sur stderr). Toute sortie de la CLI passe par
  `Output` (`src/cli/output.ts`) : `console.*` est interdit par ESLint dans
  `src/cli/` et `src/cli.js`. Dans `src/cli/**/*.ts`, ESLint refuse aussi
  tout import de `fs`/`node:fs` (`no-restricted-imports`) : la CLI démarre
  à chaque appui sur Tab, un accès disque synchrone s'y paierait à chaque
  fois — `fs/promises` uniquement.
- Un nouveau code d'erreur se classe dans `ERROR_KINDS` (`src/errors.js` :
  usage → sortie 2, refus → 3, sinon 1), se traduit dans les deux catalogues
  `src/cli/i18n/` (le catalogue anglais doit connaître tout code levé —
  `tests/unit/cli-contract.test.js`) et se documente dans
  `docs/fr/depannage.md` et `docs/en/troubleshooting.md`. Une nouvelle clé de
  config se documente dans `docs/fr/configuration.md` + `docs/en/configuration.md`
  avec son défaut et ses bornes réels (`src/config.js`). Une nouvelle
  commande s'inscrit au registre (`src/cli/registry.ts`), dans les deux
  catalogues `src/cli/i18n/` et dans `docs/fr/commandes.md` +
  `docs/en/commands.md` (vérifié par `tests/unit/cli-contract.test.js`).
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
