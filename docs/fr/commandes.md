# Commandes

> [Documentation](README.md) · Commandes

Vue d'ensemble, puis le détail par groupe fonctionnel. Toute opération
mutante (`run`, `merge`, `sync`, `stop`, `promote`, retry de la file) passe
par le [verrou inter-processus](architecture.md#verrou-inter-processus) —
deux CLI concurrents ne se marchent jamais dessus.

| Commande | Rôle |
|---|---|
| `striart init` | Initialise `.striart/`, la config, diagnostique le LLM. |
| `striart start <agent> [--command <cmd>] [--open]` | Clone isolé + branche de tâche, sans Router. |
| `striart start <agent> --reuse [--force]` | Réutilise le clone conservé d'un agent arrêté. |
| `striart run "<prompt>" [--agent <a>] [--command] [--open]` | Router préventif : prédit les fichiers, lance ou met en attente. |
| `striart run "<prompt>" --autonomous [--profile <p>] [--timeout <ms>]` | Mode autonome : Striart pilote l'outil de bout en bout. |
| `striart run "<prompt>" --after <tâche\|agent>` | Dépendance déclarée : attend la fin du travail référencé. |
| `striart plan <fichier.yaml> [--dry-run]` | Tâches-as-code : applique un plan YAML versionné. |
| `striart profiles [--json]` | Liste les profils d'agents configurés. |
| `striart watch [--no-merge]` | Surveille les commits, merge + Test Gate + rebase en continu. |
| `striart watch --daemon [--status\|--stop]` | Watcher en arrière-plan (PID file, logs, détection d'orphelin). |
| `striart merge <agent>` | Merge manuel du dernier commit d'un agent. |
| `striart sync [agent]` | Rebase un agent (ou tous) sur la branche cible. |
| `striart status [--json]` | État des agents : statut, session, mode, branche, outil, taille. |
| `striart queue [--retry]` | Tableau de bord des tâches ; `--retry` relance les débloquées. |
| `striart stop <agent> [--force]` | Termine un agent (le clone reste sur disque), débloque la file. |
| `striart rollback` | Défait le dernier merge Striart (reset local ou revert). |
| `striart doctor [--json]` | Diagnostic complet — « pourquoi ça ne marche pas ? ». |
| `striart history [--limit <n>] [--json]` | Historique des merges/rollbacks, reconstruit du graphe Git. |
| `striart promote [--rollback]` | Promotion staging → main (Test Gate global + fast-forward). |
| `striart resolve [--unlock\|--close <id>\|--all]` | Tickets de conflit. |
| `striart clean [agent] [--stopped\|--all [--force]]` | Libère le disque (garde-fous à deux niveaux). |
| `striart reconcile` | Réconciliation idempotente de tout l'état (sessions mortes, file, verrous). |
| `striart prune [--days <n>] [--dry-run]` | Rétention des clones arrêtés inactifs et tickets résolus. |
| `striart dashboard [--port <p>]` | Dashboard web local temps réel (127.0.0.1, SSE) + pilotage. |
| `striart mcp` | Serveur MCP stdio (5 outils sur l'orchestrateur). |

---

## Initialisation et diagnostic

### `striart init`

Crée `.striart/` (agents, conflits, logs, fichiers d'état), ajoute
`.striart/` au `.gitignore`, génère `striart.config.mjs` si aucune config
n'existe, et diagnostique le LLM (avertissement, jamais bloquant).
Idempotent. Détail : [Démarrage](demarrage.md#striart-init).

### `striart doctor [--json]`

Diagnostic complet : version de git, validité du repo, config chargée et
validée, LLM joignable (ping Ollama ou présence de la clé API), verrous en
place, tickets ouverts, **branche courante vs `targetBranch`** (un écart
affiche « merge/watch refuseront »). Premier réflexe quand quelque chose
refuse de fonctionner — voir [Dépannage](depannage.md).

## Lancer des agents

### `striart start <agent> [--command <cmd>] [--open]`

Crée le clone isolé et la branche de tâche `striart/<agent>/task-<uuid>`,
**sans passer par le Router** (pas de prédiction de fichiers, pas de mise en
file). `--command` remplace l'outil affiché (`agentCommand` en config) ;
`--open` ouvre un onglet terminal dans le clone et y lance l'outil.

### `striart start <agent> --reuse [--force]`

**Réutilise** le clone conservé d'un agent arrêté : resynchronisation sur la
branche cible courante, nouvelle branche de tâche, fichiers untracked
conservés (`node_modules` — repartir chaud). Refus explicites :

- `REUSE_DIRTY` — l'archive a des modifications non commitées ;
- `REUSE_UNMERGED` — du travail commité n'a jamais été mergé ;
- `REUSE_IN_USE` — le disque du clone a bougé récemment (`presenceMinutes`).

`--force` assume la perte. `striart run --reuse` passe par le Router en plus.

### `striart run "<prompt>" [--agent <a>] [--command] [--open] [--reuse]`

Le chemin normal : le **Router** envoie le prompt au LLM, récupère la liste
des fichiers probablement touchés, la filtre (`isSafeProjectPath` — la sortie
LLM est non fiable), puis la compare aux prédictions des tâches actives et en
file. Intersection → la tâche est **mise en file d'attente** au lieu de
partir au conflit ; sinon l'agent démarre. Sans `--agent`, le nom est dérivé
du prompt (ex. `refactor-le-module-d-aut`). `--prompt <p>` est l'équivalent
scriptable du positionnel.

Au lancement, les **liens sémantiques** sont signalés à titre informatif
(jamais bloquants) : imports mutuels (JS/TS, Python, Ruby, PHP) et packages
liés d'un monorepo (npm/yarn, Cargo, Go, Maven).

### `striart run … --autonomous [--profile <p>] [--timeout <ms>]`

Striart lance l'outil lui-même (profil d'`agentProfiles`), supervise le
process, merge, passe le Test Gate et supprime le clone si tout est vert.
Détail complet : [Modes d'exécution](modes-execution.md). Précédence du
timeout : `--timeout` > `profile.timeout` > `autonomousTimeoutMs`.

### `striart run … --after <tâche|agent>`

**Dépendance déclarée** : la tâche attend en file la fin (merge + stop) du
travail référencé, puis part automatiquement. Référence inconnue ou cycle →
refus au lancement. C'est la brique sous-jacente des
[plans YAML](plans.md).

### `striart plan <fichier.yaml> [--dry-run]` et `striart profiles`

Voir [Plans — tâches-as-code](plans.md). `striart profiles [--json]` liste
les profils configurés (outil, clés d'env attendues, timeout) — les IA
disponibles pour `--profile` et pour le champ `profile` des plans.

## Orchestrer

### `striart watch [--no-merge]`

Le cœur : surveille les refs de tous les clones, traite chaque commit dans la
[chaîne sérialisée](architecture.md#la-chaîne-sérialisée) (rebase préalable,
merge, fusion sémantique, Test Gate, rebase des autres agents). `--no-merge`
n'observe que. Le watcher **ne merge pas les agents autonomes** — leur merge
appartient à leur fin de cycle. Rejoue `reconcile` automatiquement.

### `striart watch --daemon [--status|--stop]`

Le même watcher, en process détaché natif : PID file et logs sous
`.striart/` (`logs/watch.log`), détection de daemon orphelin, `--status` et
`--stop` pour l'inspecter et l'arrêter. Sans dépendance à pm2 ni systemd ; la
reprise au boot reste à la main de l'utilisateur (planificateur de l'OS).

### `striart merge <agent>`

Merge manuel du dernier commit d'un agent — même pipeline que le watcher
(rebase préalable, fusion sémantique, Test Gate). Refuse si le repo principal
est sale (`MAIN_DIRTY`) ou sur la mauvaise branche
(`TARGET_BRANCH_MISMATCH`) — voir [Branches et pipeline](branches.md).

### `striart sync [agent]`

Rebase un agent (ou tous) sur la branche cible, avec les mêmes garde-fous que
le watcher (stash auto si disjonction vérifiée, `SKIPPED_SESSION` pour les
sessions vivantes). Les [6 statuts](architecture.md#les-6-statuts-de-la-synchronisation)
disent exactement ce qui s'est passé.

### `striart stop <agent> [--force]`

Termine un agent : retire l'entrée du registre, conserve le clone sur disque,
débloque la file (les tâches en attente sur cet agent partent). Refuse de
stopper un agent dont la session autonome vit (`SESSION_LIVE`), même avec
`--force`.

## Observer

### `striart status [--json]`

État de chaque agent : statut, session active, **mode** (🤖 autonome +
profil / 👤 supervisé), branche de tâche, outil, taille additionnelle du
clone (les hardlinks comptent 0), commits en attente de merge.

### `striart queue [--retry]`

Le scheduler : tâches `RUNNING` / `WAITING` et ce qui bloque chacune.
`--retry` relance les tâches devenues débloquées.

### `striart history [--limit <n>] [--json]`

Historique des merges et rollbacks Striart, **reconstruit depuis le graphe
Git** (pas un journal séparé qui pourrait diverger).

### `striart dashboard [--port <p>]`

Dashboard web local, lié à `127.0.0.1` uniquement, **temps réel** (SSE —
poussé à chaque changement, sans polling) : état des agents et de leur mode,
bandeau d'état du watcher, logs de session, arbitrage des permissions
semi-autonomes, et pilotage (merge, stop, relance, rollback, clôture de
ticket — protégé anti-CSRF, en-tête `Host` vérifié sur toute requête).

## Réparer et nettoyer

### `striart rollback`

Défait le **dernier merge Striart** : reset local (récupérable via reflog) si
le merge n'est pas poussé, revert sinon (l'historique publié est conservé).
Refuse si le dernier commit de la branche cible n'est pas un merge Striart.

### `striart resolve [--unlock|--close <id>|--all]`

Les tickets de conflit (`.striart/conflicts/<ticket>/` : versions
BASE/OURS/THEIRS, tentative LLM, log du Test Gate). Sans option : liste.
`--close <id>` marque un ticket résolu ; `--unlock` réactive la fusion
sémantique après le passage en mode manuel (3 échecs d'affilée) ; `--all`
clôt tout.

### `striart clean [agent] [--stopped|--all [--force]]`

Libère le disque : clones des agents arrêtés par défaut ; `--all` inclut les
actifs **sans travail en attente**. Deux niveaux de refus, selon ce que
Striart sait :

- `IN_USE` — le disque du clone a bougé il y a moins de `presenceMinutes`
  minutes : une **heuristique**, que `--force` peut écraser en connaissance
  de cause ;
- `SESSION_LIVE` — le PID d'une session autonome est vivant : un **fait
  vérifié**, que `--force` ne peut **pas** écraser.

Un travail non commité ou non mergé (`PENDING`, `BUSY`) protège aussi le
clone ; `--force` assume alors l'abandon du non-mergé.

### `striart reconcile`

**Réconciliation** (level-triggered) : neutralise les sessions mortes au
registre, débloque la file (même quand aucun commit ne l'a déclenché — ex.
`clean` d'un bloqueur), répare verrous et merges orphelins. Idempotent —
peut être lancé à tout moment sans risque. Rejoué automatiquement par
`striart watch`.

### `striart prune [--days <n>] [--dry-run]`

Rétention : élague les clones arrêtés inactifs et les tickets résolus depuis
N jours (config `pruneDays`, défaut 14). `--dry-run` prévisualise. Un
`striart prune` périodique (cron/tâche planifiée) garde `.striart/` sain.

## Intégration

### `striart promote [--rollback]`

Promotion staging → main du [pipeline à deux étages](branches.md#le-pipeline-staging-main) :
Test Gate global (`promoteTestCommand`) puis fast-forward de `mainBranch`.

### `striart mcp`

Serveur MCP stdio — voir [Serveur MCP](mcp.md). Les logs partent sur stderr :
stdout est réservé au protocole.
