# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/), versionnage [SemVer](https://semver.org/lang/fr/).

## [Non publié]

### Modifié
- **Paquet scopé `@jumsay/striart`** ; miroir public GitHub (`personamanagmentlayer/striart`) publié — instantané expurgé à chaque release.

### Documentation
- **Section « Pourquoi Striart »** (README fr+en) : positionnement explicite face aux worktrees gérés à la main et aux sous-agents en worktree de Claude Code — tableau comparatif (isolation, prévention des collisions, retour dans main, Test Gate, multi-fournisseurs, durée de vie, observabilité), le choix clones-pas-worktrees comme décision de sûreté, et l'emboîtement des deux mécanismes (Claude Code est un agent de Striart ; ses worktrees restent utilisables dans le clone).
- **Audit exhaustif doc ↔ code** (relecture croisée intégrale) : URL de clone et description de la CI recalées, canal de signalement SECURITY réordonné, plan YAML ajouté au tableau des entrées non fiables, codes `REUSE_*` nommés dans la doc utilisateur, plan des modules complété (`events.js`, provider azure, imports multi-langages), timings et compteurs de tests recalés partout (244 unit ~20 s / 178 intégration ~7 min).

### Ajouté
- **Angles morts de couverture corrigés** — les zones faiblement couvertes l'étaient surtout par artefact de mesure (v8 ne voit pas un process enfant) ou par impossibilité de test (ouvrir un vrai terminal) : rendues testables EN PROCESS sans changer le comportement. `startMcpServer` accepte des flux `input`/`output` injectables (défauts stdio inchangés) → la boucle JSON-RPC est testée en process (parse invalide, borne 1 Mo, notifications, garde de profondeur via `env` injecté) ; les 5 handlers d'outils MCP sont exercés en process sur de vrais repos ; `openAgentTerminal` accepte un `spawnFn` injectable → chemins succès/échec/refus testés sans ouvrir de fenêtre ; le dashboard gagne les tests HTTP de l'action `permission` (arbitrage complet, refus typés qui ne consomment pas la demande) et de `GET /api/doctor`.
- **CI interne du mainteneur** : le pipeline (audit, lint, typecheck, unit, intégration × Node 22/24) tourne aussi sur l'infrastructure privée ; la matrice complète 3 OS vit dans le workflow GitHub (`.github/workflows/ci.yml`).

## [0.10.0] — 2026-08-30

Clôture du backlog V2 (décision explicite de lever la condition « attendre le
pilote ») : Memory Layer temps réel, réutilisation de clone, signaux
multi-langages, mode semi-autonome (ACP Phase F). Première version publiée —
sur le registre npm privé du mainteneur, pas npmjs.

### Modifié
- **Node.js minimum relevé : 20 → 22.18** (`engines`, CI, doc). Conséquence directe de la migration TypeScript : `orchestrator.js` importe `plan.ts`, dont l'exécution repose sur le type stripping natif — actif par défaut à partir de Node 22.18 (et 23.6+). Sous Node 20/22.17 le CLI ne démarrait plus (`ERR_UNKNOWN_FILE_EXTENSION`) alors que `engines` l'autorisait ; la contrainte est désormais explicite et refusée à l'installation. Matrice CI : 20/22 → 22/24.
- **Migration TypeScript amorcée** (pilote). La convention « pas de TS compilé, JS + JSDoc » est levée : Node exécutant désormais `.ts` par type stripping natif, l'argument « TS = build » qui la fondait est caduc. On écrit du **TypeScript réel, toujours zéro build**. `src/plan.js` → `src/plan.ts` (premier module migré), en syntaxe effaçable uniquement (`erasableSyntaxOnly`). Toolchain à deux TypeScript par alias npm : `@typescript/native` (TS 7, le `tsc` du typecheck) + `typescript` → `@typescript/typescript6` (TS 6.0.x) que typescript-eslint accepte (il refuse TS 7). ESLint lint donc les `.ts` ; `tsc` gagne `noUnusedLocals`/`noUnusedParameters`. `npm ci`-able (aucun `--legacy-peer-deps`), `npm audit` reste à 0, zéro build conservé (`bin` pointe toujours sur la source).

### Ajouté
- **Mode SEMI-AUTONOME (ACP, Phase F)** — troisième mode entre supervisé et autonome. Un profil `acp: { permissions: 'ask', askTimeoutMs? }` route chaque demande de permission de l'agent vers l'humain : la session dépose la demande dans une boîte aux lettres disque (`.striart/permissions/`, `src/permissions.ts`), le dashboard l'affiche en tête de page (un bouton par option proposée par l'agent, SSE) et transmet la décision. Sans réponse dans le délai (défaut 120 s) : **fail closed** — le refus s'applique, jamais un accord par défaut ; chaque décision est tracée au log de session avec son origine (humain / fail closed). `reconcile` purge les demandes expirées orphelines. L'option de réponse est validée contre celles réellement proposées par l'agent — l'UI ne peut pas inventer une réponse que le protocole refuserait.
- **Réutilisation de clone** (`striart start <agent> --reuse [--force]`, `striart run --reuse`) : réhabilite l'archive d'un agent arrêté au lieu d'exiger `clean` + `start` — resynchronisation sur le main courant (fetch par chemin local), nouvelle branche de tâche, exclusions de secrets ré-appliquées selon la config courante, ré-enregistrement (`reused: true`). Les untracked survivent (node_modules, outillage local : repartir chaud). Garde-fous : refus si travail non commité (`REUSE_DIRTY`) ou commits absents du main (`REUSE_UNMERGED`) — la perte s'assume par `--force` ; activité disque récente → `REUSE_IN_USE` (heuristique `presenceMinutes`, contournable). La file mémorise l'intention (`QueueTask.reuse`) et le dégagement réhabilite ; un échec `REUSE_*` au dégagement maintient la tâche en attente au lieu de faire échouer le passage.
- **Memory Layer temps réel** (piste 2 de la collaboration entre agents) : chaque clone reçoit dans `.striart-memory.md`, en plus des API mergées, une section « travaux en cours » listant les AUTRES tâches (actives et en file) avec les fichiers PRÉDITS par le Router — données déjà calculées, zéro appel LLM, advisory strict. Vue par destinataire (chacun voit les autres, pas lui-même), rafraîchie à chaque mutation du registre ou de la file, écriture IDEMPOTENTE (le fichier vit dans le worktree : une écriture par tick fausserait la détection de présence) ; `CLONE_MEMORY_FILE` est exclu de la mesure d'activité (une écriture de Striart n'est pas une session de coding).
- **Signaux sémantiques multi-langages** : le graphe d'imports couvre désormais Python (`from .x import y`), Ruby (`require_relative`) et PHP (`require`/`include` relatifs) en plus de JS/TS — uniquement les références relatives, résolubles sans config de build (conservateur, advisory). Les workspaces agrègent quatre écosystèmes sous la même forme : npm/yarn, **Cargo** (`[workspace] members`), **Go** (`go.work` + `module`/`require`/`replace`), **Maven** (`<modules>` + artifactId) — l'aval (avertissements du start) ne connaît pas l'écosystème.
- **Couverture des modules `.ts`** : l'assiette vitest passe à `src/**/*.{js,ts}` (les `.d.ts`, jamais exécutés, restent exclus) — `plan.ts` et `acp.ts` étaient testés mais non mesurés.
- **Intégration ACP (Agent Client Protocol)** — le mode autonome gagne un second transport, protocolaire. Un profil `acp: true` fait dialoguer Striart avec l'outil en JSON-RPC ndjson sur son stdio (`src/acp.ts`, 2e module TS, artisanal comme `mcp.js` — zéro dépendance) au lieu de lui passer le prompt en argv : handshake v1 exigé, session ouverte dans le clone, prompt en bloc de contenu du protocole. À contrat `SessionResult` égal (l'orchestrateur ne voit pas le transport — PID publié, timeouts, politique de suppression du clone inchangés), quatre gains : le **déroulé de session transcrit au log** (messages, plan, appels d'outils — la session cesse d'être opaque) ; les **demandes de permission répondues par politique** de profil (`allow` défaut / `reject`, tracées — plus de session bloquée sur une invite) ; les **accès fs délégués bornés au clone** (chemin hors clone → erreur JSON-RPC) ; l'**arrêt propre** au timeout (`session/cancel` puis kill d'arbre en filet). `{{prompt}}` est interdit dans les args d'un profil ACP (un seul canal — validé au chargement), obligatoire sinon. `striart profiles` affiche le transport. Position symétrique du serveur MCP : MCP = l'agent pilote Striart, ACP = Striart pilote l'agent. Roadmap d'intégration (phases A-E livrées, F « semi-autonome » à l'étude) dans `roadmap/roadmap.md` ; frontière de confiance documentée (SECURITY.md : défense en profondeur, pas une sandbox).
- **Gestion enrichie des profils d'agents** — pour un vrai multi-IA. Un profil peut désormais déclarer son propre `env` (variables fusionnées par-dessus l'environnement au lancement : cloisonner une clé API par outil, fixer `MODEL`…) et son propre `timeout` (précédence `--timeout` > `profile.timeout` > `autonomousTimeoutMs`). Nouvelle commande `striart profiles [--json]` qui liste les profils configurés (outil, **clés** d'env — jamais les valeurs — et timeout). Et `striart plan` valide désormais que chaque profil référencé existe **avant** tout lancement, `--dry-run` compris : un plan multi-IA citant une IA mal orthographiée échoue à la revue, pas au milieu de l'application. `STRIART_SESSION` reste non surchargeable par un `env` de profil (la garde de profondeur MCP ne se désarme pas). Documenté en frontière de confiance (SECURITY.md) : `env` de profil sert à cloisonner les secrets, jamais à les inliner.
- **Dashboard : parité CLI étendue** — nouvelles actions, toutes mappées sur les mêmes fonctions d'orchestrateur (mêmes verrous, mêmes garde-fous que le CLI) : lancement **autonome** depuis le formulaire (mode + profil, validation dans la requête puis session en arrière-plan — la réponse HTTP n'attend jamais la session), unlock du mode manuel, promote, sync (global et par agent), reconcile, clean (sans `--all`/`--force`), prune, stop forcé par agent, et `GET /api/doctor` avec panneau de diagnostic. Plafonds relevés : historique 10 → 30 merges, heatmap top 15 → 30, log de gate 4 → 16 Ko, log de session 20 → 64 Ko. Écarté consciemment : `plan` (workflow fichier/terminal) et `start` sans tâche.
- **Tâches-as-code** (`striart plan <fichier.yaml>`, inspiré de Bruno) : un plan YAML déclare un graphe de tâches et leurs dépendances, versionné avec le code — diffé, revu en PR, rejouable. `--dry-run` valide et affiche sans rien lancer. `apply` équivaut exactement à la séquence de `striart run` décrite (`id` de plan résolus en noms d'agents pour `--after`) : aucune sémantique nouvelle, il compose la file, `--after` et `reconcile`. Deux garde-fous : un plan est de la **donnée** jamais du code (pas de fichier exécutable ; une tâche autonome référence un `profile`, pas une commande brute), et `after` ne référence qu'une tâche définie plus haut (graphe acyclique par construction, validation complète avant tout effet de bord). Format YAML (dépendance `yaml`, `npm audit` reste à 0), exemple commenté dans `examples/plan.example.yaml`.

### Corrigé
- **Gardes `SESSION_LIVE` descendues dans les primitives** (revue à 10 findings du lot dashboard). Le garde « session autonome vivante » (`SKIPPED_SESSION`) descend de `syncAllAgentsImpl` dans `syncAgentWithMainImpl` : le sync **unitaire** (CLI, bouton du dashboard) ne peut plus rebaser sous une session vivante. `assertNoLiveSession` (`SESSION_LIVE`, non contournable par `--force`) s'applique désormais à `stopAgent` **et** `mergeAgentCommit` — retirer du registre ou merger une session vivante désarmait les protections aval et risquait de bloquer le repo en état « merging » ; un PID mort reste neutralisé par le contrôle de vitalité, et le cycle autonome dépublie son PID avant son merge final. `DEFAULT_PROFILE` exporté par `session.js` et consommé par orchestrateur, dashboard et CLI (fin du défaut `'claude'` dupliqué). Dashboard : noms d'agents validés par le parseur partagé (`validateAgentName` — champ malformé refusé en 4xx au lieu d'escalader vers la portée globale, nom d'un lancement autonome validé avant le 200), échec d'une tâche autonome de fond loggué en pino, `summarizeSync` nomme les agents en conflit, sélection du profil et prompt préservés côté client. Dette assumée : double `loadConfig` par lancement autonome du dashboard.

### Notes
- Paquet scopé pour le registre npm privé du mainteneur ; le token de publication passe par une variable d'environnement dans un `.npmrc` local jamais commité.
- 21 commandes CLI, **409 tests** (237 unitaires ~20 s, 172 intégration ~7 min, 43 fichiers), typecheck `tsc`, ESLint et Prettier verts, `npm audit` : 0 vulnérabilité. Couverture 72,8 % des instructions / 73,7 % des fonctions (`cli.js` volontairement non couvert ; `.ts` désormais mesurés).

## [0.9.1] — 2026-08-12

Lot sécurité (audit complet de toutes les surfaces) et réconciliation
(pattern k8s appliqué aux invariants internes).

### Ajouté
- **Réconciliation** (`striart reconcile`, pattern k8s appliqué aux invariants internes) : passe level-triggered et idempotente, sous le verrou principal, qui converge l'état réel — neutralise les PID de session morts au registre (fin des sessions fantômes au dashboard) et **débloque la file quel que soit l'événement**, là où `retryQueue` n'était rejoué que sur `stopAgent`. Ferme le trou du bloqueur retiré par un autre chemin (`striart clean`, crash) : une tâche `--after` ou en collision ne reste plus coincée jusqu'à une action manuelle. Rejouée à chaque tick de `striart watch`. Écarté : l'abstraction de control-plane déclaratif (contredirait « aucun état parallèle » — Git et `queue.json` sont déjà l'état).

### Sécurité
Audit complet de toutes les surfaces (modèle de menace écrit dans SECURITY.md).
- **Dashboard — DNS rebinding (sévérité haute) corrigé.** Le contrôle de l'en-tête `Host` ne couvrait que les actions POST : les lectures (`/api/state`, `/api/events` SSE, `/api/ticket`, `/api/session-log`) étaient ouvertes. Un site tiers faisant pointer son domaine vers 127.0.0.1 pouvait lire à travers le navigateur l'état du repo, le code source des tickets et les logs de session. Le contrôle d'hôte s'applique désormais à **toute** requête, avant tout routage. Testé (Host forgé en HTTP brut, `fetch` interdisant cet en-tête).
- **Ouverture de terminal — quoting shell durci.** `cwd`/`command` étaient interpolés dans des lignes de shell ; un chemin de projet contenant une apostrophe, un backtick ou un retour ligne cassait le quoting. Refus explicite (repli « lance à la main ») au lieu d'une ligne malformée.
- **Serveur MCP — borne anti-OOM.** Une ligne stdin > 1 Mo est rejetée (erreur de parse) sans faire gonfler le tampon readline ; le serveur survit.
- **Router — chemins LLM filtrés.** Les fichiers prédits absolus ou contenant `..` sont écartés à la source (`isSafeProjectPath`) : une hallucination hors de l'arbre ne pollue plus les clés de verrou.
- **CI** : `npm audit --audit-level=high` bloque désormais toute régression de vulnérabilité (une fois sur la matrice, l'audit ne dépendant ni de l'OS ni de Node).
- **Frontières de confiance documentées** (SECURITY.md) : environnement complet hérité par les sessions autonomes (l'outil de coding est du code de confiance), config-as-code, garde de profondeur MCP advisory, webhooks sans filtre SSRF.

### Notes
- 19 commandes CLI, **330 tests** (184 unitaires ~15 s, 146 intégration ~7 min), typecheck `tsc`, ESLint et Prettier verts, `npm audit --audit-level=high` : 0 vulnérabilité.

## [0.9.0] — 2026-08-10

Trois lots : « prêt pour GitHub » (ce qu'un visiteur rencontre en premier),
« architecture anti-hardcoding » (la variation se déclare en config, les
conséquences passent par un bus, le kernel décide seul), et « intégration »
(dashboard temps réel, serveur MCP, dépendances de tâches).

### Ajouté
- **Dépendances de tâches** (`striart run --after <tâche|agent>`) : la tâche attend en file la fin du travail référencé (merge + stop) puis démarre automatiquement — première brique de la collaboration entre agents, sans canal nouveau (la file, et le Test Gate reste l'autorité). Référence inconnue refusée (`AFTER_UNKNOWN` — ni départ sous fausse garantie ni attente éternelle), cycles refusés (`AFTER_CYCLE`, marche bornée, robuste à une file éditée à la main). Visible dans `striart queue` et le dashboard (colonne Après), compatible `--autonomous`.
- **Serveur MCP** (`striart mcp`) : Striart s'expose à tout hôte MCP (Claude Code, Cursor…) — 5 outils (`striart_status`, `striart_queue`, `striart_run`, `striart_merge`, `striart_resolve`) mappés directement sur l'orchestrateur, mêmes verrous et garde-fous que le CLI et le dashboard. **Profondeur d'orchestration bornée à 1** : une session autonome (marqueur `STRIART_SESSION` hérité) se voit refuser les outils mutants avec le motif — un agent consulte l'état, il n'engendre pas d'agents. Stdio JSON-RPC sans dépendance nouvelle ; en mode MCP les logs partent sur stderr, stdout étant le canal du protocole.
- **Test de cohérence du client dashboard** : le JS navigateur vit dans une template string, hors de portée d'ESLint, tsc et des tests serveur — un test unitaire compile désormais le script de la page telle que servie, vérifie que tout id consommé existe dans le HTML et que toute action cliente a son handler serveur.

### Sécurité
- **Migration vitest 2 → 4** : `npm audit` passe de 6 vulnérabilités (2 critiques, chaîne dev vitest→vite→esbuild) à **0**. Le fichier workspace (déprécié) devient `test.projects` dans `vitest.config.js` ; les timeouts calibrés par projet sont préservés et re-vérifiés par sonde (un test unitaire de 21 s meurt bien à 20 s).

### Architecture
- **Dashboard temps réel** : le navigateur ne poll plus toutes les 2 s — un flux SSE (`/api/events`) pousse l'état à chaque changement. Le dashboard étant un process distinct de `watch`, la source de vérité inter-process est le disque : fichiers d'état de `.striart/` (chokidar, en excluant `agents/`, `logs/` et le verrou) et refs des agents (`watchAgents` réutilisé) ; le bus in-process ajoute les toasts instantanés des actions locales. Recalculs coalescés (300 ms), battement de cœur 25 s, reconnexion automatique + polling de secours à 5 s. Ergonomie : re-render ciblé par section (une section inchangée n'est pas retouchée — sélections et défilement préservés), confirmation inline en deux temps au lieu de `window.confirm` (une modale bloquait la page, mises à jour comprises), indicateur 🟢 direct / 🔴 reconnexion, tableaux défilants et responsive. `server.close()` démonte flux et watchers — pas de socket fantôme.
- **Table `notifiers` multi-canaux** : `[{ type: 'slack'|'discord'|'generic', url | urlEnv }]` — le type se déclare, il ne se devine plus par l'URL. `urlEnv` (nom de variable d'environnement) recommandé : une URL de webhook est un secret, même discipline que `apiKeyEnv`. `webhookUrl` continue de fonctionner à l'identique et cumule avec la table.
- **Bus d'observabilité** (`src/events.js`) : le kernel émet 18 types d'événements structurés (union discriminée dans `types.d.ts`), les abonnés informent sans jamais décider. Un abonné qui throw est isolé ; in-process, pas de journal disque ; les erreurs n'y passent jamais (elles remontent à l'appelant). Le pont notify relaie les messages à l'identique — comportement webhook inchangé, prouvé par la suite d'intégration. Prépare le SSE du dashboard.
- **Prompts Router/Merger surchargeables** (`prompts: { router, merger }`) : templates complets avec placeholders obligatoires validés au chargement (router `{{task}}`+`{{files}}` ; merger `{{file}}`+`{{base}}`+`{{ours}}`+`{{theirs}}`+`{{feedback}}` — le retry post-gate survit à la surcharge). Cas d'usage : réécrire les prompts en anglais pour un modèle local plus fiable en anglais, ou les durcir pour un modèle faible. `fillPromptTemplate` substitue en split/join : la donnée reste de la donnée.

### Corrigé
- **Windows : codes de sortie lisibles.** Un Test Gate ou une session autonome qui mourait sur ENOENT affichait « exit 4294963238 » (wrap uint32 de -4058) dans le message de merge, le ticket et les logs. `normalizeExitCode` (dans `process-tree.js`, partagé) replie les valeurs au-dessus de 2^31-1 en signé ; la sémantique du succès (`=== 0`) ne change pas.

### Ajouté
- **ESLint + Prettier**, branchés en CI (`npm run lint` / `npm run format`). Répartition nette : ESLint ne fait que de la correctness, le style appartient à Prettier, le vrai filet reste `tsc --checkJs`. Les `.md` sont exclus du formatage. Première passe : 5 trouvailles bénignes corrigées (3 imports morts, 2 initialiseurs jamais lus), reformatage du dépôt dans un commit séparé.
- **`CONTRIBUTING.md`** (démarrage, boucle de dev, règles non négociables, renvoi à CLAUDE.md comme source de fond) et **`SECURITY.md`** (canaux de signalement privés, et surtout le périmètre : les invariants de sécurité du projet déclarés comme engagements).
- **`README.en.md`** : traduction intégrale, le README français reste la référence.
- Roadmap : question « collaboration entre agents » ouverte — constat (coexistence, pas collaboration ; quatre canaux indirects), deux pistes dans la philosophie du projet (dépendances entre tâches en file, Memory Layer temps réel), bus de messages écarté.

### Documentation
- Doc resynchronisée sur le code de la 0.8.0, après relecture croisée README / roadmap / CLAUDE.md contre les sources : 6e statut de synchronisation `SKIPPED_SESSION` documenté (le tableau en annonçait 5), cohabitation des deux modes (watcher, sync, clean face à une session vivante), règle d'or n°3 réécrite avec ses deux niveaux (`IN_USE` heuristique contournable par `--force`, `SESSION_LIVE` vérifié et non contournable).
- Corrections d'options de config : `agentCommand` était documenté avec `'claude'` pour défaut alors qu'il vaut `null` ('claude' n'est qu'un exemple d'affichage) ; `memoryMaxEntries` et `presenceMinutes` manquaient.
- Prérequis du mode autonome explicités : l'outil doit être installé et **déjà authentifié** dans le shell (la session hérite de son environnement, elle ne peut répondre à aucune invite), et son profil réellement non interactif.
- Métriques resynchronisées : 262 tests, couverture 79,4 % des instructions / 92,0 % des fonctions (la roadmap annonçait encore 249 tests et des chiffres de la 0.6.0).

### Notes
- 18 commandes CLI, **316 tests** (35 fichiers — projets `unit` ~15 s et `integration` ~7 min), typecheck `tsc`, ESLint et Prettier verts, `npm audit` : 0 vulnérabilité.
- Couverture (vitest 4, base de mesure remaniée par rapport à la 0.8.0) : 71,4 % des instructions / 73,2 % des fonctions — `cli.js` volontairement non couvert tire le global vers le bas, la logique métier est bien au-dessus (router, notify, queue, state, merger, events à 100 %).
- Questions ouvertes tranchées : serveur MCP (livré), collaboration piste 1 `--after` (livrée), bus de messages entre agents (écarté), extension VS Code (écartée tant que non réclamée).

## [0.8.0] — 2026-08-08

Lot « mode autonome » : Striart peut piloter l'agent de bout en bout, et les
deux modes d'exécution cohabitent sur le même repo.

### Ajouté
- **Mode autonome** (`striart run --autonomous`) : Striart lance lui-même l'agent de coding en mode non interactif, supervise sa session, merge, passe le Test Gate et supprime le clone. Second mode d'exécution, en regard du mode supervisé où l'humain pilote — le choix appartient à l'utilisateur, tâche par tâche.
- **Profils d'agents multi-fournisseurs** (`agentProfiles`) : table d'invocation non interactive par outil (claude, codex, aider, ollama fournis ; tout autre ajoutable). Permet de superviser des agents de fournisseurs différents sur le même projet. Le prompt est substitué comme élément d'argv, jamais via un shell — aucune injection possible depuis son texte.
- `--profile` et `--timeout` sur `striart run`, `autonomousTimeoutMs` en config (délai au-delà duquel l'arbre de process de l'agent est tué).
- Logs de session sous `.striart/logs/session-<agent>-<taskId>.log` — hors du clone, donc conservés après sa suppression.
- Dashboard et `striart status` : colonne MODE (🤖 autonome + profil / 👤 supervisé), consultation du log de session depuis l'UI, et **bandeau d'état du watcher** — rien ne lance `striart watch` automatiquement, l'absence de watcher est désormais visible au lieu d'être devinée.

### Corrigé
- **Un clone dont la session autonome tourne est intouchable.** Le PID de la session est publié au registre (`sessionPid`) le temps qu'elle vit, ce qui rend son état vérifiable au lieu d'être supposé :
  - `syncAllAgents` n'y rebase plus (statut `SKIPPED_SESSION`). Les garde-fous du rebase supposaient un humain capable de voir ses fichiers bouger et de réagir ; une session autonome n'a personne pour réagir et lance ses propres commandes git. Rien n'est perdu : `mergeAgentCommit` rebase de toute façon en fin de cycle, le rebase est ajourné, pas annulé.
  - `striart clean` refuse la suppression **même avec `--force`** (raison `SESSION_LIVE`). `--force` sert à passer outre des heuristiques ; un process vivant est un fait vérifié, pas une supposition.
  - Auto-guérison : un PID resté au registre après un crash est neutralisé par le contrôle de vitalité, il ne gèle pas le clone indéfiniment.
- **Les deux modes cohabitent sur le même repo.** Le watcher mergeait tout agent dont la branche de tâche bougeait, sans distinction de mode : il mergeait donc les commits *intermédiaires* d'une session autonome, et entrait en course avec son merge final. Symptôme observé quand la course est perdue : le repo principal reste bloqué en état « merging », intervention manuelle requise. Le watcher laisse désormais les agents autonomes à leur propre fin de cycle (`shouldWatcherMerge`).

### Sécurité
- Le clone n'est supprimé que sur le chemin entièrement vert (sortie 0, au moins un commit, merge réussi, gate vert). Session échouée, délai dépassé, sortie sans commit, conflit ou gate rouge conservent le clone avec un motif explicite.
- Le nettoyage autonome n'utilise jamais `force` : les garde-fous existants (travail non commité ou non mergé, clone verrouillé) gardent le dernier mot.

### Modifié
- `killProcessTree` extrait de `gate.js` vers `process-tree.js`, partagé avec le superviseur de session (logique multiplateforme non dupliquée). `isProcessAlive` y rejoint, mutualisé depuis `daemon.js`.
- **Fiabilité de la suite de tests** : suppression des 22 timeouts par test inférieurs au global de 90 s. Ils ne « protégeaient » rien — ils réduisaient le budget délibérément calibré pour la charge de la suite complète, produisant des tests verts isolés et rouges en suite. Un test de 19 s plafonné à 60 s a lâché dès que la suite s'est alourdie (facteur ~3 sous charge). La règle est désormais écrite dans `vitest.config.js`.
- Correction de métrique : la 0.7.0 annonçait 201 tests, le compte réel était 224 (le comptage par `grep` sous-estimait).
- **Suite de tests découpée en deux projets vitest** (`vitest.workspace.js`) : `unit` (131 tests, ~10 s, LLM mocké) et `integration` (131 tests, ~6 min, vrais repos Git). Les deux moitiés comptent le même nombre de tests mais pas le même temps : 97 % de la durée venait de l'intégration, et `npm test` imposait ce budget à chaque itération de dev. `npm run test:unit` rend désormais la main en secondes. Les timeouts sont déclarés par projet — 20 s pour l'unitaire (au-delà, un test mocké est bloqué, pas lent), 90 s pour l'intégration (budget calibré sous charge, inchangé).
- CI : typecheck, unitaires et intégration deviennent trois étapes distinctes — un typecheck cassé rend la main en ~30 s au lieu d'attendre l'intégration, et la durée de chaque suite est lisible. Le `--coverage` en est retiré : aucun rapport n'était publié ni aucun seuil vérifié, il était calculé puis jeté sur les six combinaisons de la matrice. `npm run test:ci` le conserve en local.

### Notes
- 17 commandes CLI, **262 tests** (28 fichiers, unitaires + intégration sur repos Git réels), typecheck `tsc` vert.
- Point à assumer, hérité du mode autonome : sans relecture humaine, le Test Gate devient la seule autorité. La qualité de `testCommand` sur le repo cible est portante.

## [0.7.0] — 2026-08-07

Lot « exploitabilité » : observabilité, autonomie du watcher, pilotage.

### Ajouté
- `striart doctor` — diagnostic complet (git, repo, config, LLM joignable, verrous, tickets), `--json`.
- `striart history` — merges/rollbacks reconstruits depuis le graphe Git, `--json` ; `striart status --json`.
- **Présence de session** : activité du worktree (`presenceMinutes`) → colonne SESSION, `striart clean` protège les clones récemment actifs (règle d'or n°3).
- `striart watch --daemon` / `--status` / `--stop` — watcher en arrière-plan (PID file, logs, détection d'orphelin).
- Dashboard : lancement de tâche depuis l'UI, actions merge/stop/relance/clôture/rollback (anti-CSRF), historique des merges.
- Intégration continue : matrice GitHub Actions ubuntu/macos/windows × Node 20/22.

### Notes
- 17 commandes CLI, 224 tests (26 fichiers, unitaires + intégration sur repos Git réels), typecheck `tsc` vert.
- Questions ouvertes tranchées : daemon background (n°1) — process détaché natif, sans pm2 ni systemd.

## [0.6.0] — 2026-08-06

### Ajouté

**Gestion des conflits — couverture complète du spectre**
- Classification pré-LLM des conflits (`classifyConflict`) : suppression/modification, conflits de chemin (rename/rename), binaires, lockfiles, fichiers trop volumineux, submodules, symlinks et bit exécutable divergent partent en ticket humain typé (`UNMERGEABLE_CONFLICT`) au lieu d'une fusion LLM hasardeuse.
- Détection du double-renommage invisible pour git (merge "propre" avec fichier en double) — avertissement non bloquant `renameHazards`.
- Retry sémantique : le Merger corrige sa propre fusion avec le log du Test Gate en feedback (`semanticGateRetries`) avant tout ticket humain.
- `abortMerge` robuste : un repo bloqué en état "merging" lève `MERGE_ABORT_FAILED` au lieu d'un échec silencieux ; collisions de fichiers untracked identifiées (`UNTRACKED_COLLISION`).
- Préservation du bit exécutable à travers la fusion sémantique.

**Commandes**
- `striart rollback` — défait le dernier merge Striart (reset local récupérable, ou revert si poussé), avec recalage de l'agent.
- `striart doctor` — diagnostic complet : git, repo, config, LLM joignable, verrous, tickets ; `--json` pour la CI.
- `striart history` — historique des merges/rollbacks reconstruit depuis le graphe Git ; `--json`.
- `striart status --json`.

**Sécurité**
- Nettoyage des secrets trackés au clonage (`secretPatterns`) via sparse-checkout — statut git propre, échec explicite jamais silencieux.

**Intelligence collective**
- Memory Layer (`memoryLayer`) : résumé LLM des API changées après chaque merge, diffusé aux clones (`.striart-memory.md`) — advisory strict.
- Avertissements sémantiques par graphe d'imports JS/TS (avertir, jamais bloquer).
- Conscience des workspaces monorepo : packages liés par dépendance déclarée signalés au start.

**Dashboard**
- Pilotage : merge, stop, relance de file, clôture de ticket, rollback depuis l'UI (anti-CSRF par en-tête custom).
- Vue détail des tickets : BASE/OURS/THEIRS/tentative LLM côte à côte, log du gate.
- Heatmap des fichiers disputés (verrous + file d'attente + historique des conflits).
- Section historique des merges.

## [0.5.0] — 2026-08-05

Version de départ du pilote : isolation par clones hardlinkés, Router
préventif, fusion sémantique + Test Gate bloquant, file d'attente, verrou
inter-processus, promotion staging→main, rétention (`prune`/`clean`),
watch, dashboard lecture seule, tous providers LLM.
