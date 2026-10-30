# Commandes

> [Documentation](README.md) · Commandes

D'abord le **contrat de la CLI** (options globales, codes de sortie, sortie
machine, langue et affichage, complétion), commun à toutes les commandes ;
puis le détail des commandes, par groupe fonctionnel. Toute opération
mutante (`run`, `merge`, `sync`, `stop`, `promote`, `resolve --apply`,
`lock --start`, retry de la file) passe par le
[verrou inter-processus](architecture.md#verrou-inter-processus) — deux CLI
concurrents ne se marchent jamais dessus.

**31 commandes publiques**, groupées dans l'aide (`striart --help`) comme
ci-dessous (comptées le 2026-10-27 sur `node src/cli.js --help`, `help`
exclu). Une seule commande interne, masquée, n'est jamais destinée à un
humain : `__complete` (valeurs dynamiques des scripts de complétion).
`pty-host-run`, l'ancienne commande interne qui lançait l'hôte de pty, a été
supprimée : l'hôte est désormais le binaire natif `striart-native pty-host`
(voir [Architecture](architecture.md#composants-natifs-rust)).

| Commande | Rôle |
|---|---|
| **Mise en place et diagnostic** | |
| `striart init` | Initialise `.striart/` et la config, puis signale ce qui empêcherait la première commande de réussir. |
| `striart doctor` | Diagnostic complet — « pourquoi ça ne marche pas ? ». |
| `striart completion <shell>` | Script de complétion (bash, zsh, fish, PowerShell). |
| **Lancer des agents** | |
| `striart start <agent> [--command <cmd>] [--open] [--allow-historical-secrets]` | Clone isolé + branche de tâche, sans Router. |
| `striart start <agent> --reuse [--force]` | Réutilise le clone conservé d'un agent arrêté. |
| `striart run "<prompt>" [--agent <a>] [--command <cmd>] [--open] [--after <réf>] [--reuse [--force]] [--allow-historical-secrets]` | Router préventif : prédit les fichiers, lance ou met en attente. |
| `striart run "<prompt>" --autonomous [--profile <p>] [--timeout <ms>]` | Mode autonome : Striart pilote l'outil de bout en bout. |
| `striart run "<prompt>" --on-main [--profile <p>] [--timeout <ms>]` | Lance l'agent DIRECTEMENT sur le repo principal (pas de clone), sous session protégée. |
| `striart attach <agent>` | Attache le terminal au pty possédé d'un agent (session ouverte par `--open`). |
| `striart plan <fichier.yaml> [--dry-run] [--mode <m>] [--concurrency <n>] [--on-failure <p>] [--resume <run-id>]` | Tâches-as-code : applique un plan YAML versionné (v1, ou v2 : modes d'orchestration) ; `--resume` rejoue un run v2 interrompu sans relancer les tâches terminées. |
| `striart draft "<objectif>" [--out <fichier>]` | Planner : propose un plan v2 validé pour un objectif — écrit un fichier, ne lance rien. |
| `striart profiles [--catalog \| --detect \| --import-acp <id>]` | Profils d'agents configurés ; catalogue des presets ; outils installés ; import d'un agent du registre ACP. |
| **Orchestrer** | |
| `striart watch [--no-merge]` | Surveille les commits, merge + Test Gate + rebase en continu. |
| `striart watch --daemon \| --status \| --stop` | Watcher en arrière-plan (PID file, journal, détection d'orphelin). |
| `striart watch --ui` | Panneau Ink interactif par-dessus le watcher : tail du pty par agent, commandes `/`, shell `!`, messages `@agent`. |
| `striart merge <agent>` | Merge manuel du dernier commit d'un agent, derrière le Test Gate. |
| `striart sync [agent]` | Rebase un agent (ou tous) sur la branche cible. |
| `striart stop <agent> [--force]` | Termine un agent (le clone reste sur disque), débloque la file. |
| `striart orchestrate <mode> <prompts...>` | Tâche orchestrée en une commande : `review`, `race`, `team` ou `pipeline` (un plan v2 d'un nœud). |
| `striart review [<id>] [--approve \| --request-changes \| --reject] [--comment <t>]` | Relectures humaines d'une tâche `review` : lister, rendre un verdict. |
| **Observer** | |
| `striart status` | Vue d'ensemble : agents, sessions, file, tickets, mode manuel, repo réservé. |
| `striart queue [--retry]` | Tâches démarrées et en attente, avec ce qui les bloque ; `--retry` démarre les débloquées. |
| `striart history [--limit <n>]` | Historique des merges/rollbacks, reconstruit du graphe Git. |
| `striart usage [--since <p>] [--until <p>] [--role <r>] [--agent <a>] [--task <id>]` | Consommation de tokens et coûts, depuis le registre `.striart/usage/`. |
| `striart dashboard [--port <p>] [--daemon \| --status \| --stop \| --link]` | Dashboard web local temps réel (127.0.0.1, SSE), à lien de connexion à usage unique, + pilotage. |
| **Réparer et nettoyer** | |
| `striart rollback` | Défait le dernier merge Striart (reset local ou revert). |
| `striart resolve [--unlock \| --close <id> \| --prepare <id> [--accept-theirs <chemin>…] \| --apply <id>] [--all]` | Tickets de conflit : liste, préparation, application sous Test Gate. |
| `striart lock [--start <raison> [--pid <n>] \| --stop]` | Réserve/libère le repo principal pour une intervention directe. |
| `striart clean [agent] [--stopped \| --all] [--force]` | Libère le disque (garde-fous à deux niveaux). |
| `striart reconcile` | Réconciliation idempotente de tout l'état (sessions mortes, file, verrous). |
| `striart prune [--days <n>] [--dry-run]` | Rétention des clones arrêtés inactifs et tickets résolus. |
| `striart gc [agent] [--close] [--dry-run]` | Ramasse-miettes d'inactivité : détecte les agents oubliés, les avertit et, sur autorisation de l'utilisateur, ferme proprement leur session (jamais leur clone). |
| **Intégration** | |
| `striart promote [--rollback]` | Promotion staging → main (Test Gate global + fast-forward). |
| `striart mcp [--root <chemin>] [--agent <a>] [--read-only [--collab]]` | Serveur MCP stdio (plan agent → Striart : 10 outils, 4 types de ressources), borné au clone appelant. |
| `striart api --stdio [--framing <f>] \| --schema [openrpc\|json-schema]` | Striart Control Protocol v1 sur stdio, pour les extensions d'IDE (plan humain). |
| `striart acp [--root <chemin>] [--profile <p>]` | Striart comme agent ACP v1 pour un éditeur (Zed, JetBrains, Neovim, Emacs…) : un clone isolé + l'agent amont + un merge sous Test Gate. |
| `striart hook install\|uninstall <outil> (--user \| --agent <a>)` | Hooks advisory des outils de coding (collisions, fin de session) — le sous-mode `hook <outil> <événement>` est appelé par l'outil lui-même. |

---

## Le contrat de la CLI

### Options globales

Valables sur toutes les commandes, avant ou après le nom de la commande :

| Option | Effet |
|---|---|
| `-v`, `--version` | Affiche la version (`-V`, alias historique, n'est reconnu qu'en tête de ligne, avant la commande). Avec `--json` : le document `{command: "version", data: {version}}` du contrat, jamais la version nue. |
| `--json` | Sortie machine : un document JSON sur stdout (flux ndjson pour `watch` et `dashboard`) — voir ci-dessous. |
| `--plain` | Texte nu : ni couleur, ni glyphe, ni lien (logs de CI, lecteurs d'écran, consoles anciennes). |
| `--no-color` | Désactive la couleur (comme `NO_COLOR`). |
| `-q`, `--quiet` | Supprime les messages de progression — jamais les erreurs ni les données. |
| `-h`, `--help` | Aide de la commande, avec exemples. |

`striart help` et `striart help <commande>` affichent l'aide et sortent en **0** ;
`striart help <inconnue>` est une erreur d'usage (`UNKNOWN_COMMAND`, sortie 2),
comme `striart hook install <outil inconnu>` (`HOOK_TOOL_UNKNOWN`, sortie 2).

Tout argument placé après `--` est de la donnée : un prompt peut contenir
« --json » sans activer la sortie machine. De même, une option globale
n'agit sur la commande exécutée que si l'analyse de la ligne la reconnaît
comme option : la valeur d'une autre option (`lock --start=--json`,
`lock --start -V`, où « --json » et « -V » sont la raison) reste une valeur,
et `-V` placé ailleurs qu'en tête n'affiche pas la version.

**Gestes réservés à l'humain.** `resolve`, `merge`, `stop`, `lock`,
`rollback` et `promote` sont refusés dans une session d'agent Striart
(`CONTROL_NESTED_SESSION`, sortie 3, repérée par `STRIART_SESSION=1`) : un
agent n'approuve pas son propre ticket, ne lève pas un verrou, n'annule pas un
merge. Garde *advisory* (voir [SECURITY.md](../../SECURITY.md)). Même règle pour
`api`, `acp` et `dashboard`.

**`.env` du dépôt.** La CLI lit le `.env` de la racine du dépôt comme une
donnée non fiable : seule une liste blanche (clés d'API `*_API_KEY`,
variables d'affichage `STRIART_LANG`/`THEME`/`ASCII`/`NO_ANIMATION`, webhooks)
est appliquée, une liste noire (`NODE_*`, `LD_*`, `PATH*`, `STRIART_NATIVE_BIN`…)
l'emporte, une variable déjà définie dans le shell n'est jamais écrasée, et
rien n'est chargé dans un clone d'agent ni dans une session de Striart. Les
noms écartés sont signalés sur stderr — voir
[Configuration](configuration.md#le-llm-du-routermerger) et `env.allow`.

### Codes de sortie

Décidés à un seul endroit (`src/cli/exit.ts`), classés par **nature** et non
par statut — un nouveau statut se range dans une classe existante :

| Code | Signification |
|---|---|
| `0` | Intention atteinte, **ou ajournement voulu par conception** : tâche mise en file, rebase reporté, déjà à jour. |
| `1` | Échec d'exécution ou d'environnement (git, LLM, disque, config, cible introuvable) — relancer peut suffire. |
| `2` | Usage invalide, rejeté **avant toute action** : option inconnue, valeur hors bornes, options incompatibles. |
| `3` | **Refus métier** : une garde de Striart a protégé du travail — conflit de merge, Test Gate rouge, travail non mergé, session vivante, secret historique… Relancer telle quelle ne changera rien : il faut une décision humaine. |
| `130` / `143` | Interrompu par SIGINT (Ctrl+C) / SIGTERM (convention POSIX 128 + n, appliquée aussi sous Windows). |

Conséquence directe : `striart merge agent-a && npm run deploy` ne déploie
jamais après un Test Gate rouge (sortie 3). Le détail fin est dans le
document `--json` (`data.status`, `error.code`).

Cas notables : `striart sync` sort en 0 sur un rebase reporté ou en conflit
(le merge le rattrapera) et en 3 sur `STASH_CONFLICT` ; `striart doctor` sort
en 1 dès qu'un prérequis manque (les avertissements ne changent pas le code) ;
`striart plan` rend la pire issue de ses tâches ; en autonome, `MERGED` et
`QUEUED` sortent en 0 ; `MERGE_BLOCKED`, `COMMIT_REFUSED`, une session
arrêtée par un plafond de tokens (`BUDGET_EXCEEDED`, aussi pour `run
--on-main`), une session dont l'échec a une cause de nature « refus » (agent
ACP non connecté : `ACP_AUTH_REQUIRED`) et tout cas où `commitPolicy:
'human'` renvoie le travail à l'humain — `KEPT` (statut `HUMAN_REVIEW_REQUIRED`
si l'agent a commité) ou session vide — sortent en 3 ; une session échouée,
expirée, interrompue ou vide (hors `human`) sort en 1. Pour un nœud orchestré
(`orchestrate`, plan v2), 3 couvre aussi `REVIEW_REJECTED`,
`REVIEW_EXHAUSTED`, `VERDICT_INVALID`, `READ_ONLY_VIOLATION`,
`SCOPE_VIOLATION`, `TEAM_COMMIT_FORBIDDEN`, `RACE_NO_WINNER` et `KEPT` : une
garde a parlé, pas un incident. Un nœud en `ERROR` suit la nature du code
d'erreur qu'il porte (`SESSION_LIVE`, `AGENT_EXISTS`… → 3). Une attente du verrou principal annulée par Ctrl+C
sort en 130 (le signal l'emporte sur la nature `LOCK_WAIT_CANCELLED`).

Les valeurs sont validées strictement **avant** tout appel au domaine (sortie
2) : `--days 7d`, `--pid 12abc` ou `--timeout 5000abc` sont refusés.
Bornes : `--timeout` de 1 000 ms à une semaine, `--port` de 0 à 65 535,
`--limit` de 1 à 10 000, `--days` de 0 à 36 500, `--pid` entier positif,
`--concurrency` de 1 à 64, `--max-rounds` et `--rounds` de 1 à 10. Les
noms d'agents (`<agent>`, `--agent`) suivent le motif `[a-z0-9][a-z0-9_-]`
(64 caractères au plus), les ids de ticket le nom de leur dossier.

### Sortie machine : `--json`

Toute commande qui produit un résultat accepte `--json` et écrit **un seul
document** sur **stdout** — y compris en cas d'erreur :

```json
{ "schemaVersion": 1, "command": "merge", "ok": true, "data": { "status": "MERGED", "…": "…" } }
{ "schemaVersion": 1, "command": "merge", "ok": false, "error": { "code": "MAIN_DIRTY", "kind": "refusal", "message": "…", "hint": "git status", "details": { } } }
```

- `ok` vaut `true` seulement pour une issue en sortie 0 ; un merge au Test
  Gate rouge rend `ok: false` avec `data.status: "GATE_FAILED"`.
- `error.kind` vaut `usage`, `refusal` ou `failure` — le même classement que
  les codes de sortie 2, 3 et 1.
- `warnings` (présent seulement s'il y en a) liste les avertissements non
  bloquants (`{code, message}`), par exemple `DEPRECATED_OPTION` ou
  `TERMINAL_OPEN_FAILED`.
- `error.details` ne porte que des identifiants (agent, ticket, chemin,
  PID…) et passe en plus par un **caviardage défensif** : tout champ dont le
  nom évoque un secret (env, valeur, profil, en-têtes, URL, token, mot de
  passe, clé d'API…) est remplacé par `"[redacted]"` — voir
  [SECURITY.md](../../SECURITY.md). Seule exception : `profile` reste lisible
  quand c'est un **nom** de profil bien formé (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`,
  identifiant de config que `striart profiles` publie) ; une définition de
  profil (objet : commande, `env`) reste caviardée.
- Quand un même code couvre plusieurs causes, `error.details.reason` les
  distingue par un sous-code **stable**, qui fait partie du contrat (c'est
  lui, et non le texte, qu'un script doit tester) :
  - `PLAN_INVALID` : `YAML`, `NOT_AN_OBJECT`, `UNSUPPORTED_VERSION` (seules
    les versions 1 et 2 existent), `TASKS_EMPTY`, `TASK_NOT_AN_OBJECT`,
    `VERSION_MISSING` (aucune ligne `version:` — attendu `version: 1` ou
    `version: 2`), `PROMPT_MISSING`, `FIELD_NOT_STRING`, `AUTONOMOUS_NOT_BOOLEAN`,
    `TIMEOUT_INVALID`, `DUPLICATE_ID`, `AFTER_FORWARD`,
    `COMMAND_NOT_AN_EXECUTABLE_NAME` (le `command` d'une tâche supervisée doit
    être un **nom d'exécutable** — `[A-Za-z0-9][A-Za-z0-9._+-]{0,63}`, sans
    chemin, espace ni option —, valable en v1 comme en v2 : il est tapé dans le
    shell hébergé du pty ; les options vont dans `agentCommand` ou un profil)
    — avec, selon le cas,
    `task` (position dans le fichier), `taskId`, `field`, `id`, `after`,
    `version` ou `cause` (message du parseur YAML), jamais le contenu d'une
    tâche. Le plan `version: 2` ajoute `UNKNOWN_KEY`, `MODE_INVALID`,
    `OVERRIDES_NEED_V2` (`--mode`, `--concurrency` ou `--on-failure` sur un
    plan v1), `CONCURRENCY_INVALID`, `ON_FAILURE_INVALID`, `KIND_UNKNOWN`,
    `AFTER_INVALID`, `AGENT_INVALID`, `COMMAND_AUTONOMOUS_CONFLICT`,
    `PROFILE_NEEDS_AUTONOMOUS`, `SPEC_NOT_AN_OBJECT`, `FIELD_NOT_BOOLEAN`,
    `REVIEWERS_MISSING`, `REVIEWERS_TOO_MANY`, `HUMAN_REVIEWER_PROFILE`,
    `QUORUM_INVALID`, `ROUNDS_INVALID`, `NAME_INVALID`, `NAME_RESERVED`,
    `NAME_DUPLICATE`, `STEPS_MISSING`, `STEPS_TOO_MANY`, `STEP_ID_INVALID`,
    `STEP_ID_DUPLICATE`, `HANDOFF_INVALID`, `PROMPT_FORBIDDEN`,
    `CANDIDATES_TOO_FEW`, `CANDIDATES_TOO_MANY`, `PICK_INVALID`,
    `LOSERS_INVALID`, `ROLES_TOO_FEW`, `ROLES_TOO_MANY`, `CADENCE_INVALID`,
    `CADENCE_UNAVAILABLE`, `PARALLEL_SCOPE_MISSING` et `SCOPE_INVALID` ;
  - `CONFIG_INVALID` : `UNKNOWN_KEY` (clé de premier niveau inconnue, avec
    `key` et `suggestion`), `INVALID_VALUE` (avec `key`, et `field` pour un champ
    imbriqué : `agentProfiles.<nom>.<champ>`, `acpAgent.<champ>`),
    `UNREADABLE` (avec `cause`), `SAME_BRANCH` (`promote` : `mainBranch` =
    `targetBranch`), `HOST_PATTERN` (`dashboardAllowedHosts` : avec
    `problem` — motif refusé — et l'**index** de l'entrée, jamais sa
    valeur) ;
  - `LLM_CONFIG_INVALID` : `UNKNOWN_PROVIDER`, `NO_MODEL`, `NO_BASE_URL`,
    `NO_API_KEY` (avec `provider` et, pour le dernier, le **nom** de la
    variable `apiKeyEnv`, jamais sa valeur) ;
  - `PROFILE_INVALID` : `COMMAND_EMPTY`, `ARGS_NOT_STRINGS`,
    `PLACEHOLDER_MISSING`, `PLACEHOLDER_FORBIDDEN`, `ACP_TRANSPORT`,
    `ACP_OPTION_INVALID`, `INSTRUCTIONS_CHANNEL_TRANSPORT`,
    `INSTRUCTIONS_FLAG_MISSING` et `ACP_ELICITATION_NEEDS_ASK` (avec
    `field`) ;
  - `LOCK_TIMEOUT` (verrou principal) : `HELD` (détenu par une opération en
    cours), `HOLDER_FROZEN` (détenteur vivant dont le battement est figé —
    jamais cassé), `LOCK_UNREADABLE`, `BREAK_IN_PROGRESS`, `BREAK_FAILED` ;
    `STATE_LOCK_TIMEOUT` (verrou d'état) : `HELD`, `LOCK_UNREADABLE`,
    `BREAK_IN_PROGRESS`, `BREAK_FAILED` (pas de `HOLDER_FROZEN` : un détenteur
    vivant n'est jamais cassé, l'attente expire simplement) ;
  - `NATIVE_UNAVAILABLE` (`DEV_BUILD_MISSING`, `PACKAGE_MISSING`,
    `PLATFORM_UNSUPPORTED`, `PLATFORM_NOT_PUBLISHED`, `ENV_NOT_ABSOLUTE`,
    `ENV_MISSING`, `BINARY_MISSING`), `NATIVE_INTEGRITY_FAILED`
    (`DIGEST_MISMATCH`, `SIGNATURE_INVALID`, `SIGNATURE_UNREADABLE`,
    `MANIFEST_MISSING`, `PACKAGE_VERSION_MISMATCH`,
    `MANIFEST_VERSION_MISMATCH`) et `NATIVE_COMMAND_FAILED` (`TIMEOUT`,
    `SPAWN`, `NO_REPORT`) ;
  - `PTY_SHELL_INVALID` : `RELATIVE_PATH`, `NOT_EXECUTABLE`, shell
    introuvable ; `ORCHESTRATE_USAGE` : `OPTION_NOT_FOR_MODE`,
    `MISSING_OPTION` ; `USER_CONFIG_INVALID` : la cause en clair, avec la
    `key` fautive.

  Les fichiers d'état illisibles (`REGISTRY_CORRUPT`, `QUEUE_CORRUPT`,
  `LOCKS_CORRUPT`, `STATE_CORRUPT`, `MAIN_SESSION_CORRUPT`, `TICKET_CORRUPT`,
  `COLLAB_CORRUPT`, `REVIEW_CORRUPT`, `ORCHESTRATION_STATE_CORRUPT`) portent
  `path` et `cause` (l'erreur du parseur JSON). Le message d'erreur, lui,
  reste du texte humain hors contrat, traduit selon `STRIART_LANG` sans
  perdre le détail actionnable (champ fautif, tâche, cause).

Le `schemaVersion` du document reste **1** : aucun champ n'a changé de sens
depuis 0.11. Les ajouts de la vague du 2026-10-24 sont additifs
(`status --json` gagne `orchestration` et `tokens`, `doctor` gagne les
contrôles `native`, `gate`, `pty`, `state-lock`, `protected`, `mcp`, `profiles`,
`tokens`, `orchestration`, `dashboard` et `relaxations`, puis, au 2026-10-26,
`network`, `state-privacy` et `gate-env`, puis, au 2026-10-27, `idle`, `delivery`
et `performance` : 29 contrôles). Les schémas
publiés (`schemas/striart-document-v1.schema.json` pour ce document,
`schemas/striart-control-v1.openrpc.json` pour le Control Protocol) sont
livrés dans le paquet et imprimés par `striart api --schema`. L'`$id` du
schéma du document est `urn:striart:schema:document:v1` : un identifiant
neutre (ni URL d'une infrastructure privée, ni adresse à résoudre) ; il fait
partie du contrat, au même titre que `schemaVersion`.

`watch` et `dashboard` (commandes longues) écrivent un **flux ndjson** : une
ligne par événement, `{schemaVersion, command, type, at, data}` — `watch`
émet `started`, `commit`, `merge`, `merge-skipped`, `merge-deferred`
(`data: {agent}`, voir [`watch`](#striart-watch---no-merge)), `merge-error`, `sync`,
`reconcile`, `reconcile-error`, `behind`, `fetch-error` ; `dashboard` émet
`listening` (`data: {url, port}`, plus `signInUrl` et `expiresAt` au premier plan). Le flux se termine par un événement
`end` (`data: {ok, outcome, interrupted}`).

Cinq commandes n'ont **pas** de sortie machine, par nature : `mcp`, `api` et
`acp` (stdout est le protocole), `attach` (terminal brut) et `completion` (le
script est déjà la donnée). Avec `--json`, elles refusent en
`UNSUPPORTED_OUTPUT_FORMAT` (sortie 2), comme `watch --ui`. (`striart api`
rend pourtant le même document, enveloppé, à chaque résultat de méthode du
Control Protocol : c'est le protocole qui est la sortie.)

Le texte humain, lui, est **hors contrat** : il peut changer d'une version à
l'autre. Seuls le document `--json`, les codes de sortie et les codes
d'erreur sont stables. **Rupture assumée en 0.11** : les quatre sorties
`--json` qui existaient avant (`status`, `doctor`, `history`, `profiles`)
sont désormais enveloppées — lire `data` au lieu de la racine.

### Flux et journaux

stdout ne porte que les **données** de la commande (résultat humain,
document `--json`, protocole MCP) ; la progression, les avertissements, les
erreurs (hors `--json`) et les journaux pino partent sur **stderr**. Cela vaut
aussi pour ce qui précède le résultat d'une commande longue : la **bannière** de
`watch` (« watcher actif sur … » et son mode) et l'**introduction** de `run --autonomous` /
`run --on-main` sont des lignes de statut, donc sur stderr (muettes en `--json`,
où le document ou le flux porte l'information). Les journaux pino, eux, sont en
français quelle que soit `STRIART_LANG` : ils ne passent pas par le catalogue
i18n (messages d'aide, d'erreur et de rendu seulement).
`striart status | grep agent-a` ou `striart merge a --json | jq` ne voient
jamais une ligne de progression. `STRIART_LOG_LEVEL=debug` détaille les
journaux sur stderr (`trace`, `debug`, `info` par défaut, `warn`, `error`,
`fatal`, `silent`). Sous `watch --ui`, l'écran appartient au panneau : les
journaux vont dans `.striart/logs/watch-ui.log`.

### Langue, couleurs, terminal

| Variable | Effet |
|---|---|
| `STRIART_LANG=fr\|en` | Langue des messages et de l'aide. Sans elle : `LC_ALL`, `LC_MESSAGES`, `LANG`, puis la locale du système ; toute langue autre que le français affiche l'anglais. |
| `STRIART_THEME=default\|colorblind\|mono` | Palette : `colorblind` n'oppose jamais rouge et vert (bleu/magenta), `mono` n'utilise que gras, atténué et souligné. |
| `NO_COLOR`, `FORCE_COLOR` | Couleur ([no-color.org](https://no-color.org)). **Précédence : `NO_COLOR` (non vide) > `FORCE_COLOR` (`0`/`false` l'interdit) > `TERM=dumb` > terminal interactif.** `TERM=dumb` impose le mode `plain` (ni glyphe, ni lien, ni animation) mais n'interdit pas une couleur explicitement forcée : `FORCE_COLOR=1 TERM=dumb` colore, sans glyphes. stdout et stderr sont décidés séparément. |
| `STRIART_ASCII=1` | Glyphes ASCII à la place de ✓ ✗ → … (automatique sur la console Windows historique et `TERM=linux`) — **l'aide comprise** (flèches, tirets, guillemets typographiques de `--help` et des textes statiques ; jamais les données : noms de fichiers, messages de commit). |
| `STRIART_NO_ANIMATION=1` | Pas d'indicateur de progression animé (désactivé aussi en CI et hors terminal). |
| `FORCE_HYPERLINK=0\|1` | Liens cliquables OSC 8 sur les chemins (tickets, clones), détectés sinon (Windows Terminal, VS Code, iTerm2, WezTerm, kitty, ghostty, VTE récent). |

Le niveau d'une ligne est toujours porté par un **mot** (« ok »,
« attention », « erreur ») : le glyphe et la couleur ne font que le doubler —
lisible au lecteur d'écran, en daltonisme, dans un log de CI. Les tableaux
s'adaptent à la largeur du terminal (les colonnes secondaires tombent
d'abord, jamais l'identifiant) et ne sont jamais tronqués hors terminal. Sous
Windows Terminal et ConEmu, une opération longue s'affiche aussi dans la
barre de progression de l'onglet (OSC 9;4). Tout texte non fiable affiché
(message de commit d'un agent, chemin, sortie git, raison d'une réservation)
est neutralisé : ses caractères de contrôle apparaissent sous forme visible
`\xNN` au lieu de piloter le terminal.

Le fichier `.env` est chargé depuis la **racine du dépôt** (et non du
répertoire courant) ; une variable déjà définie dans le shell l'emporte. Il est
filtré par une liste blanche (clés `*_API_KEY`, webhooks, variables
d'affichage) : voir [Configuration](configuration.md#le-llm-du-routermerger).

### `striart completion <shell>`

Écrit sur stdout le script de complétion de `bash`, `zsh`, `fish` ou
`powershell`, généré depuis l'arbre réel des commandes (jamais une liste
tenue à la main) :

```bash
striart completion bash >> ~/.bashrc
striart completion zsh > "${fpath[1]}/_striart"
striart completion fish > ~/.config/fish/completions/striart.fish
striart completion powershell >> $PROFILE
```

Le script porte un en-tête dans la langue de la CLI (`STRIART_LANG`).
Commandes, options et valeurs dynamiques sont complétées : noms d'agents
(`<agent>`, `--agent`, `--after`), ids de tickets (`--close`, `--prepare`,
`--apply`), profils (`--profile`), fichiers (`plan`), et les **énumérations
fermées** de commander (`.choices()` : par exemple le `<mode>` de `orchestrate`,
`--pick`, `--framing`), lues dans la même source que la validation. Les valeurs
dynamiques viennent de la commande interne `striart __complete
agents|tickets|profiles`, qui lit `.striart/` à chaque Tab, sans git ni
verrou ; elle ne propose que des valeurs conformes à leur motif, et seulement
depuis un dépôt initialisé (`.git` **et** `.striart`, appartenant à
l'utilisateur courant sous POSIX). La complétion des profils **n'exécute
jamais** la config du dépôt — un appui sur Tab n'est pas une décision
d'exécuter du code : elle propose les profils par défaut, plus ceux d'une
config **en données** (JSON/YAML, `.striartrc.*`) lue directement. Pour une
config **en code** (`striart.config.mjs`, `.js`, `.cjs`, `.ts`), les noms
viennent du cache `.striart/completion-profiles.json`, publié par
`striart profiles` — commande explicite, qui, elle, charge la config — et
retenu seulement s'il désigne le même fichier de config. Tant que
`striart profiles` n'a pas tourné, seuls les profils par défaut sont
proposés (voir [SECURITY.md](../../SECURITY.md)).

---

## Initialisation et diagnostic

### `striart init`

Crée `.striart/` (agents, conflits, logs, fichiers d'état), ajoute
`.striart/` au `.gitignore`, génère `striart.config.mjs` si aucune config
n'existe, valide la config (une config invalide fait échouer `init`), puis
**enchaîne le diagnostic** de `striart doctor` et affiche ses constats
`attention`/`erreur` avec l'action à mener : dépôt sans commit, branche
cible absente, LLM injoignable… L'initialisation elle-même réussit (sortie
0) ; un prérequis manquant pour la suite est signalé, pas compté comme un
échec. Idempotent. Détail : [Démarrage](demarrage.md#striart-init).

### `striart doctor`

Diagnostic complet — 29 contrôles : version de git, **composant natif**
(binaire `striart-native` : source retenue, signature vérifiée ou non,
version, clé épinglée et clés de confiance de l'utilisateur
`native.trustedKeyIds` — jamais un repli silencieux), **conteneur du Test
Gate** (`gateContainer` : natif, ou `process` = relâchement sans détection
d'orphelins), **hôte de terminal (pty)** (binaire,
shell effectif, `pty.shell`), dépôt et premier commit, initialisation,
config chargée et validée, **branche cible** (absente → erreur : merge,
sync, watch et rollback échoueraient ; branche courante différente →
attention : merge et watch refuseront), LLM joignable (ping Ollama ou
présence de la clé API), **réseau** (politique hors ligne / liste blanche,
proxy actif ou inactif et son mécanisme, CA d'entreprise, TLS minimal ; en
avertissement `network.allowInsecureHosts` et `NODE_TLS_REJECT_UNAUTHORIZED=0` —
config **utilisateur** et shell seulement, voir
[Réseau d'entreprise](configuration.md#réseau-dentreprise-network)), secrets
historiques, **verrou principal** (libre /
opération en cours avec son âge et son dernier battement / détenteur vivant
mais figé, jamais cassé / orphelin / merge tiers ouvert), **verrou d'état**,
**session principale** (libre / occupée — voir `striart lock`), agents
(dont les clones en suppression ou cassés), tickets ouverts, mode manuel,
**chemins protégés** (défauts + `extend`, relâchements), **serveur MCP**
(niveau borné au clone, ou `orchestrator`), **profils d'agents** (presets
vérifiés, expérimentaux, téléchargement ACP, consignes), **tokens et
coûts** (comptabilité, plafonds, prix périmés, empreinte des consignes,
disjoncteur LLM désactivé),
**orchestration**, **dashboard** (hôtes admis en plus de la boucle locale),
**données locales** (`.striart/` réservé à l'utilisateur : nombre d'éléments
inspectés, ou ce qui reste lisible par d'autres comptes — la correction est
`striart init`), **environnement du Test Gate** (variables filtrées, demandes du
dépôt non autorisées par `gate.envAllow`), **GC d'inactivité** (politique
`idle.action` ; avec `close`, si la config utilisateur autorise la fermeture ou
si le dépôt n'est pas dans `idle.closeRoots`), **livraison** (`delivery`,
`pushTimeoutMs`, `commitTimeoutMs` : information, pas relâchement),
**performance** (latence réelle du verrou d'état, `git status` du principal,
taille de `.striart/`, nombre d'agents, âge du plus vieux verrou tenu — chaque
mesure est bornée dans le temps et un constat de lenteur est un avertissement,
jamais une erreur)
et une synthèse **protections relâchées** qui rassemble en un endroit tout
ce que la config a baissé (`hooks.trustedRoots` de la config utilisateur,
`mcp.scope`, relâchements ACP, `acpRegistry.allowBinaryDownload`,
`dashboardAllowedHosts`, `dashboardHostname: 'localhost'`,
`protectedAgentPaths.allow`/`matchCase`, `lock.breakFrozenHolderAfterMs`,
`tokens.*`, `orchestration.*`, profils expérimentaux, `env.allow`,
`gate.envAllow` et `network.allowInsecureHosts` de la config utilisateur,
`idle.enabled: false`, `idle.closePty: true`, `overlap.enabled: false`,
`acpRegistry.allowEnv`, `llm.allowAnyApiKeyEnv` /
`llm.allowInsecureTransport`, `gateContainer: 'process'`, `gateEnv: 'inherit'`,
`privateStateDir: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`,
`unknownConfigKeys: 'warn'` et les trois relâchements de config-as-code
`secretPatterns: []`, `pty.shell` autre que `auto` et
`terminal.launcher: 'custom'`). Une clé de premier niveau inconnue (avec
`unknownConfigKeys: 'warn'`) est aussi un avertissement du contrôle
« configuration » ; `secretPatterns: []` en est un du contrôle « secrets
historiques » (exclusion des secrets et scan historique coupés). Chaque
constat sépare le fait de l'action, et la liste des actions suit le tableau.
Les politiques actives qui ne sont pas des relâchements (`delivery: 'branch'`,
`idle.action: 'warn'` ou `'close'`) sont rapportées à part.

Gravité : `erreur` = la prochaine commande échouera ; `attention` = Striart
fonctionne mais une capacité est dégradée ou une action humaine est
attendue ; `ignoré` = sans objet ici. Le bilan n'annonce « opérationnel »
qu'en l'absence de tout avertissement. Sortie 1 si au moins une erreur.
`striart doctor --json | jq ".data.summary"` compte chaque niveau. Premier
réflexe quand quelque chose refuse de fonctionner — voir
[Dépannage](depannage.md).

## Lancer des agents

### `striart start <agent> [--command <cmd>] [--open] [--allow-historical-secrets]`

Crée le clone isolé et la branche de tâche `striart/<agent>/task-<uuid>`,
**sans passer par le Router** (pas de prédiction de fichiers, pas de mise en
file). Refuse d'emblée une `targetBranch` inexistante (`UNKNOWN_BRANCH`) :
l'agent démarrerait, mais aucun de ses merges ne pourrait aboutir.

- `--command` remplace l'outil de cet agent (sinon `agentCommand` de la
  config, sinon `claude`). Sans `--open`, la commande exacte à lancer est
  affichée : `cd <chemin du clone>; <outil>`, le chemin cité pour le shell
  de la plateforme (guillemets simples POSIX/PowerShell) — un chemin de
  projet contenant `$(…)` ne s'exécute pas au copier-coller.
- `--open` démarre un process **hôte de pty** détaché (un par agent,
  idempotent) — le binaire natif `striart-native pty-host`, qui possède
  réellement le pty (ConPTY sous Windows, pty POSIX ailleurs) et y lance
  l'outil —, puis ouvre un onglet de terminal qui exécute `striart attach
  <agent>`. Le lanceur par défaut (`terminal.launcher: 'auto'`) est Windows
  Terminal quand la session courante en est une (`WT_SESSION`), sinon une
  console PowerShell sous Windows, Terminal.app sous macOS, gnome-terminal
  ailleurs ; il se choisit dans la config (`terminal` :
  Windows Terminal, Terminal.app, iTerm2, gnome-terminal, Konsole, kitty,
  WezTerm, Alacritty, **Warp**, ou une commande personnalisée en argv — voir
  [Configuration](configuration.md#terminal--le-lanceur-de---open)), et
  `auto` reconnaît une session Warp (`TERM_PROGRAM=WarpTerminal`). L'onglet
  lance Node et la CLI par **chemins absolus** : il fonctionne aussi après
  une installation locale, sans `striart` dans le `PATH`. L'outil hébergé
  vit indépendamment de l'onglet : le fermer (voire fermer `striart`) ne
  tue pas la session, et le bus `@agent` de `watch --ui` peut la rejoindre.
  Un échec d'ouverture n'annule rien : l'agent est prêt, un avertissement
  `TERMINAL_OPEN_FAILED` donne la commande à lancer à la main
  (`striart attach <agent>` si l'hôte tourne). Le shell hébergé est
  `pty.shell` (PowerShell sous Windows, `$SHELL` ou bash ailleurs par
  défaut) ; la commande de l'agent prime sur lui.
- **Consignes Striart** : à la création, au `--reuse` et après chaque
  rebase, Striart dépose dans le clone les règles de session (le clone est
  isolé, seul le travail *commité* est intégré, le Test Gate décide, ne
  jamais pousser ni toucher aux fichiers de configuration d'agent) sous le
  nom que lit l'outil (`rules/striart.md` sous `.claude`, `AGENTS.md`, `GEMINI.md`…),
  en fichier **non suivi**, inscrit dans le `.git/info/exclude` *du clone* :
  le statut git reste propre, et le fichier ne peut être commité que par un
  `git add -f` délibéré, que la garde des chemins protégés refuse au merge.
  Quand le dépôt a déjà un `AGENTS.md`, `agentInstructions.agentsMd`
  décide : `override` (défaut — un `AGENTS.override.md` composite pour les
  outils qui le lisent) ou `non-file` (rien à côté d'`AGENTS.md`,
  avertissement). Les outils des profils de mode autonome reçoivent la même
  consigne par leur canal (prompt ACP, fichier de consignes système, ou
  enveloppe du prompt). L'injection est *advisory* : un échec est un
  avertissement journalisé, jamais un refus de création. Réglages :
  [Configuration](configuration.md#agentinstructions--les-consignes-remises-aux-agents).
- `--allow-historical-secrets` clone malgré un refus
  `HISTORICAL_SECRETS_FOUND` (un chemin correspondant à `secretPatterns` a un
  jour existé dans l'historique — voir [Architecture](architecture.md)) :
  décision consciente, à prendre après avoir vérifié ou révoqué le secret.

`--force` **sans** `--reuse` est un alias déprécié de
`--allow-historical-secrets` (même effet, avertissement
`DEPRECATED_OPTION`) ; il disparaîtra en 0.12.

### `striart start <agent> --reuse [--force]`

**Réutilise** le clone conservé d'un agent arrêté : resynchronisation sur la
branche cible courante, nouvelle branche de tâche, fichiers untracked
conservés (`node_modules` — repartir chaud). Refus explicites :

- `REUSE_DIRTY` — l'archive a des modifications non commitées ;
- `REUSE_UNMERGED` — du travail commité n'a jamais été mergé ;
- `REUSE_IN_USE` — le disque du clone a bougé récemment (`presenceMinutes`) ;
- `HISTORICAL_SECRETS_FOUND` — voir ci-dessus.

`--force` assume la **perte de travail** (les trois premiers refus) et rien
d'autre : il ne lève pas le contrôle des secrets historiques, qui exige
`--allow-historical-secrets`. Deux consentements distincts, jamais
confondus. `striart run --reuse` passe par le Router en plus.

### `striart attach <agent>`

Attache un terminal interactif au pty déjà possédé par l'hôte détaché d'un
agent — exactement ce que `--open` lance en interne, invocable directement
pour (re)rejoindre une session (onglet fermé, seconde fenêtre qui observe la
même session). Doit être lancé **depuis le dossier du clone de l'agent
lui-même** (`.striart/agents/<agent>/`, vérifié strictement — le repo
principal est dérivé de ce chemin plutôt que passé en argument ; refusé
avec `ATTACH_WRONG_CWD` sinon). Ne démarre **pas** l'hôte de pty : s'il ne
tourne pas, `attach` échoue (sortie 1) en renvoyant vers
`striart start <agent> --open`. Le terminal est toujours restauré à la
sortie. À distinguer du bus `@agent` de `watch --ui` : `attach` donne le
*vrai* terminal en mode raw, le bus envoie un message à la fois. Plusieurs
clients peuvent s'attacher au même pty (lecture et écriture), et un
redimensionnement demandé par l'un est diffusé aux autres. Un client trop
lent à lire la sortie est **évincé explicitement** par l'hôte (sa file
dépasse `pty.clientQueueBytes`) puis se reconnecte tout seul ; à la
reconnexion, l'historique récent (`pty.replayBytes`) est **rejoué et se
réaffiche dans le terminal réel**. Après quelques évictions consécutives
sans rien lire, `attach` abandonne avec une erreur plutôt que de boucler.

### `striart run "<prompt>" [--agent <a>] [--command <cmd>] [--open] [--reuse] [--force] [--allow-historical-secrets]`

Le chemin normal : le **Router** envoie le prompt au LLM, récupère la liste
des fichiers probablement touchés, la filtre (`isSafeProjectPath` — la sortie
LLM est non fiable), puis la compare aux prédictions des tâches actives et en
file. Intersection → la tâche est **mise en file d'attente** au lieu de
partir au conflit (sortie 0 : ajournement voulu) ; sinon l'agent démarre.
Sans `--agent`, le nom est dérivé du prompt (ex.
`refactor-le-module-d-aut`). `--prompt <p>` est l'équivalent scriptable du
positionnel (les deux à la fois, différents : `OPTION_CONFLICT`). La
branche cible est vérifiée **avant** l'appel au LLM (`UNKNOWN_BRANCH`). La
prédiction est un **filtre grossier**, pas une garantie : sur l'historique réel
de ce dépôt, le rappel mesuré est de l'ordre de la moitié des fichiers touchés
([mesures du 2026-10-26](architecture.md#ce-que-valent-le-router-et-la-fusion-sémantique--mesures-du-2026-10-26)) ;
ce qu'il rate, la fusion sémantique et le Test Gate le rattrapent.

`--allow-historical-secrets` vaut décision consciente face à
`HISTORICAL_SECRETS_FOUND` ; si la tâche est mise en file, cette décision
est mémorisée (`QueueTask.allowHistoricalSecrets`) et honorée au dégagement,
sans redemander une confirmation qu'aucun humain n'est là pour donner. Le
consentement à **perdre du travail** (`--reuse --force`), lui, n'est
**jamais** persisté dans la file : il porte sur l'état d'un clone à
l'instant où il est donné, et rejoué plus tard il couvrirait un travail
apparu entre-temps. `--force` sans `--reuse` : alias déprécié de
`--allow-historical-secrets`, comme pour `start`.

Combinaisons refusées avant toute action (sortie 2) : `--profile` ou
`--timeout` sans `--autonomous`/`--on-main`, `--reuse` sans `--agent`
(`REUSE_NEEDS_AGENT`), `--open`/`--command` avec `--autonomous` ou
`--on-main`, `--autonomous` avec `--on-main`.

Au lancement, les **liens sémantiques** sont signalés à titre informatif
(jamais bloquants) : imports mutuels (JS/TS, Python, Ruby, PHP) et packages
liés d'un monorepo (npm/yarn, Cargo, Go, Maven).

### `striart run … --autonomous [--profile <p>] [--timeout <ms>]`

Striart lance l'outil lui-même (profil d'`agentProfiles`), supervise le
process, merge, passe le Test Gate et supprime le clone si tout est vert.
Détail complet : [Modes d'exécution](modes-execution.md). Précédence du
timeout : `--timeout` > `profile.timeout` > `autonomousTimeoutMs`. Accepte
aussi `--agent`, `--after`, `--reuse [--force]` et
`--allow-historical-secrets`.

Trois contrôles s'ajoutent au cycle, tous paramétrables :

- **Contrat de commit** (`commitPolicy`, global et par profil) : `agent`
  (défaut — l'agent commite seul), `agent-then-striart` (Striart commite ce
  que l'agent a laissé s'il n'a rien commité), `striart` (Striart commite
  toujours le reste), `human` (personne ne commite **ni ne merge** : clone
  conservé pour revue — si l'agent a commité malgré tout, le cycle rend le
  statut `KEPT` avec le `keptCode` `HUMAN_REVIEW_REQUIRED` et **ne merge
  jamais**, quel que soit le mode : cycle simple, modes orchestrés, proxy
  ACP ; sortie 3). Le commit Striart exclut `secretPatterns` et les fichiers qu'il a lui-même
  injectés, a pour auteur le profil d'agent et pour committer l'identité git
  de l'utilisateur, et passe ensuite le même chemin qu'un commit d'agent.
  Refus fail closed : `COMMIT_REFUSED` (clone hors de sa branche, opération
  git en cours, chemins non fusionnés — sortie 3), `COMMIT_FAILED`.
- **Garde des chemins protégés** : un commit qui modifie un fichier
  d'instructions ou de configuration d'agent, ou la config de Striart
  (`AGENTS.md`, `CLAUDE.md`, `.claude`, `.mcp.json`, `striart.config.*`…),
  est refusé au merge avec un ticket `PROTECTED_PATHS_CHANGED`, avant toute
  fusion LLM et avant le Test Gate — `resolve` décide chaque chemin.
- **Plafonds de tokens** (`tokens.budgets`, opt-in) : une session qui
  franchit un plafond est arrêtée proprement (statut `BUDGET_EXCEEDED`,
  clone conservé, sortie 3).

Un commit de l'agent **déjà présent** dans la branche cible (arrivé par un
autre chemin) n'est pas un échec : le travail est intégré, le statut est
`MERGED`, le clone est nettoyé sous les garde-fous habituels — mais le succès
est **bruyant** : avertissement `ALREADY_INTEGRATED` (champ `warnings` du
document `--json`, ligne sur stderr, événement `session:already-integrated`),
`merge.mergeSha` désigne le commit de la cible qui porte déjà le travail, et
**aucun Test Gate n'est rejoué** (rien n'est mergé). Un `UP_TO_DATE` sans
commit déjà intégré (rien de neuf) reste un merge bloqué : jamais de clone
supprimé sur « rien à merger ».

**Ctrl+C (ou SIGTERM) arrête proprement** : l'arbre de process de l'agent est
tué (en ACP, `session/cancel` d'abord), **puis** le PID de session est
dépublié — jamais l'inverse, sans quoi les gardes `SESSION_LIVE` tomberaient
sur un clone encore en écriture. La session rend `CANCELLED`, le cycle
`SESSION_FAILED` avec le clone conservé, et la CLI sort en 130 (143 pour
SIGTERM). Un arrêt demandé pendant le merge ou le Test Gate de fin de cycle
n'interrompt pas ces étapes.

### `striart run … --on-main [--profile <p>] [--timeout <ms>]`

Lance l'agent **directement dans le repo principal**, pas dans un clone :
`runMainSession` réserve une **session principale** (`.striart/main-session.json`,
publie le PID **du process orchestrateur lui-même**, pas celui de l'agent
spawné) sous le verrou principal, bref, puis lance l'outil sans tenir le
verrou pendant la session (qui peut durer des heures). Tant que la session
vit, toute autre opération mutante (`merge`, `sync`, `promote`,
`resolve --apply`, l'auto-merge de `watch`…) est refusée avec
`MAIN_SESSION_LIVE`. Pas de merge de fin de cycle : l'agent travaille déjà
sur la branche cible. Incompatible avec `--agent`, `--after`, `--reuse`,
`--force` et `--allow-historical-secrets` (aucun clone n'est créé). Sortie 0
si la session rend `COMPLETED`, 3 si elle est arrêtée par un plafond de
tokens (`BUDGET_EXCEEDED`) ou par une cause de nature « refus », 1 sinon.

Ctrl+C (ou SIGTERM) tue l'arbre de l'agent **avant** de dépublier la session
principale : jamais un principal déclaré libre pendant que l'agent écrit
encore dans son worktree.

### `striart run … --after <tâche|agent>`

**Dépendance déclarée** : la tâche attend en file la fin (merge + stop) du
travail référencé, puis part automatiquement. Référence inconnue
(`AFTER_UNKNOWN`) ou cycle (`AFTER_CYCLE`) → refus au lancement. C'est la
brique sous-jacente des [plans YAML](plans.md).

### `striart plan <fichier.yaml> [--dry-run] [--mode <m>] [--concurrency <n>] [--on-failure <p>] [--resume <run-id>]`

Voir [Plans — tâches-as-code](plans.md). Un plan `version: 1` est la file et
`--after` rédigés en YAML ; un plan `version: 2` ajoute les modes
d'orchestration (`sequential`/`parallel`, tâches `review`, `race`, `team`,
`pipeline`). `--mode`, `--concurrency` et `--on-failure` surchargent
l'enchaînement, le nombre de tâches simultanées (en `parallel`) et la
politique d'échec (`stop` : plus rien ne démarre ; `skip-dependents` :
seules les dépendantes sautent) du plan v2 ; sur un plan v1 ils sont refusés
(`PLAN_INVALID`, `OVERRIDES_NEED_V2`). `striart plan` rend la pire issue
de ses tâches (refus > échec > succès). Hors `--dry-run`, **Ctrl+C (ou
SIGTERM) arrête proprement** : le signal est transmis à la session autonome
en cours, qui s'arrête comme `run --autonomous` (arbre de l'agent tué, PID
dépublié, clone conservé) ; aucune tâche suivante ne démarre. Le résultat
porte `interrupted: true` et la liste `notApplied` des tâches non lancées,
affichées « non appliquée (arrêt demandé) » ; la CLI sort en 130 (143 pour
SIGTERM) ; le document `--json` rend `ok: false` (un plan interrompu n'a
pas atteint son intention) et la ligne « plan appliqué » passe en
avertissement. Un second Ctrl+C coupe net.

`--resume <run-id>` (v2 seulement, incompatible avec `--dry-run`) rejoue le
**même fichier de plan** après une interruption sans relancer les tâches
déjà terminées — voir [Plans — tâches-as-code](plans.md). L'id du run est
affiché à l'interruption et listé par `striart status --json` sous
`orchestration.runs`.

### `striart draft "<objectif>" [--out <fichier>]`

Planner (voir [Plans — tâches-as-code](plans.md)) :
tourne un objectif en langage naturel en fichier de plan `version: 2`,
validé par l'EXACT même chemin qu'un plan écrit à la main (profil inconnu,
mauvaise dépendance… tout est refusé pareil). Il **ne lance rien** — aucun
agent, aucun merge — et écrit le plan dans `--out` (défaut
`striart-draft-<horodatage>.yaml`), en refusant d'écraser un fichier déjà
existant (`DRAFT_FILE_EXISTS`). L'étape d'approbation humaine est explicite
et séparée : relire le fichier, puis `striart plan <fichier> --dry-run`,
puis `striart plan <fichier>`. Si l'objectif est trop ambigu pour être
planifié sans deviner, le Planner refuse plutôt que de supposer
(`PLANNER_REFUSED`) ; un échec du LLM après nouvelles tentatives est
`PLANNER_FAILED`. Utilise le rôle LLM `planner`
(`config.llmRoles.planner`, voir [Configuration](configuration.md)).

### `striart profiles [--catalog | --detect | --import-acp <id>]`

Sans option, liste les profils configurés (outil, transport argv/ACP,
**noms** des variables d'env — jamais leurs valeurs —, timeout, preset,
statut expérimental, mode d'écriture, contrat de commit, sortie structurée,
canal des consignes) : les IA disponibles pour `--profile` et pour le champ
`profile` des plans. C'est aussi la commande qui publie le cache de
complétion des profils (`.striart/completion-profiles.json`). Les trois
options s'excluent :

- `--catalog` liste les **presets** du catalogue (`src/agents/catalog.ts`) :
  20 prêts (Claude Code et son profil abonnement, Codex, Gemini en ACP,
  Copilot CLI et ACP, Cursor, OpenCode, Goose, Amp, Kilo, Qwen Code, Cline,
  Aider et Aider sur un modèle Ollama local, et les variantes ACP) et 5
  expérimentaux (Gemini en argv, Junie, Junie ACP, Continue, Warp Oz).
  « Prêt » veut dire que l'invocation non interactive, le mode d'écriture et
  la neutralisation de la configuration d'agent du dépôt ont été vérifiés
  dans la documentation officielle de l'outil (sources datées du
  2026-10-24, citées par preset) ; un preset expérimental n'est **pas** dans
  les profils par défaut, il se déclare à la main (`{ preset: '<id>' }`) et
  s'affiche comme relâchement dans `striart doctor`.
- `--detect` sonde les outils installés : recherche du binaire dans le
  `PATH` par le système de fichiers (aucun process, aucun shell), puis
  `<binaire> --version` en argv, lancé dans un dossier temporaire **vide**
  — un outil qui lit la configuration de son dossier courant n'y trouve
  rien, la sonde n'exécute jamais la config du dépôt. Chaque outil est
  `found`, `outdated` (version minimale du preset non atteinte), `missing` ou
  `unknown-version`.
- `--import-acp <id>` dérive un profil ACP **épinglé** d'un agent du
  [registre ACP](https://agentclientprotocol.com) (`acpRegistry.url`,
  https obligatoire). Par défaut : **métadonnées seules** — le profil pointe
  la version publiée (`npx`/`uvx` : spécificateur exact ; binaire : archive
  et empreinte décrites pour une installation par vos soins), aucun binaire
  n'est téléchargé. Une version non épinglée est refusée
  (`ACP_IMPORT_UNPINNED`). `acpRegistry.allowBinaryDownload: true` autorise
  le téléchargement de l'archive de la plateforme courante — refusé sans
  empreinte sha256 publiée (`ACP_IMPORT_NO_INTEGRITY`), vérifié contre elle
  (`ACP_DOWNLOAD_INTEGRITY_MISMATCH`), extrait sous
  `.striart/acp-agents/<id>/<version>/` sans lien symbolique ni chemin
  sortant (`ACP_EXTRACT_UNSAFE`), journalisé, et signalé par `doctor`.

## Orchestrer

### `striart watch [--no-merge]`

Le cœur : surveille les refs de tous les clones, traite chaque commit dans la
[chaîne sérialisée](architecture.md#la-chaîne-sérialisée) (rebase préalable,
merge, fusion sémantique, Test Gate, rebase des autres agents). `--no-merge`
n'observe que. Le watcher **ne merge pas les agents autonomes** — leur merge
appartient à leur fin de cycle. Rejoue `reconcile` périodiquement, enfilé
sur la même chaîne. `striart watch --json` produit le flux ndjson décrit
plus haut.

**Ctrl+C (ou SIGTERM) arrête proprement.** L'opération **en vol** (merge,
fusion sémantique, Test Gate) se termine, et son résultat est rapporté
avant la sortie (« arrêt : fin de l'opération en cours » s'affiche s'il y en
a une ; un second Ctrl+C force). Les merges encore **en file** ne démarrent
pas : chacun est signalé une fois par agent (événement `merge-deferred`,
ligne d'avertissement avec la piste `striart merge <agent>`), de même qu'un
commit vu entre l'arrêt demandé et la fermeture du watcher ; un agent
autonome, que le watcher ne merge jamais, n'est pas signalé. Chaque merge
ajourné est aussi journalisé (niveau `warn`), y compris sous `watch --ui`
où l'événement ne part plus. Le watcher ne reprend pas un commit antérieur
à son démarrage : un merge ajourné ainsi se relance à la main. En daemon, le
même arrêt est déclenché par `--stop` (voir ci-dessous).

**GC d'inactivité.** Tant que `idle.enabled` est vrai (défaut), `watch` lance
toutes les `idle.sweepIntervalMs` (5 min) un balayage du
[GC](#striart-gc-agent---close---dry-run) — **hors de la chaîne de merge** (une
fermeture n'attend pas un merge long) et jamais sous le verrou principal. Avec
l'action par défaut (`report`), il ne fait que détecter ; avec `warn` ou
`close`, il avertit puis, sur autorisation de l'utilisateur, ferme la session
après la grâce. Le flux ndjson porte `idle-warned`, `idle-closed`, `idle-refused`
et `idle-error` ; Ctrl+C attend la fin d'un balayage en vol.

### `striart watch --daemon | --status | --stop`

Le même watcher, en process détaché natif : PID file (`.striart/watch.pid`)
et journal **ndjson** (`.striart/logs/watch.log` — le daemon lance
`watch --json`), détection de daemon orphelin, `--status` et `--stop` pour
l'inspecter et l'arrêter. `--daemon` refuse si un daemon tourne déjà
(`DAEMON_RUNNING`). Sans dépendance à pm2 ni systemd ; la reprise au boot
reste à la main de l'utilisateur (planificateur de l'OS). Le PID file est
écrit atomiquement, et toute écriture ou retrait passe par un verrou
exclusif (`.striart/watch.pid.lock`, création `wx`) : deux `--daemon`
simultanés n'en démarrent qu'un, l'autre reçoit `DAEMON_RUNNING`. Un verrou
tenu au-delà de l'attente (10 s environ) rend `DAEMON_BUSY` ; un verrou de
plus de 30 s, débris d'un démarreur mort, est cassé.

Le PID publié est **reconnu à sa ligne de commande** (`node …/cli.js watch …`),
pas seulement à sa vitalité : après un crash ou un redémarrage, l'OS peut
avoir réattribué ce numéro à un autre process. Un tel PID est signalé
orphelin (`--status`), nettoyé par `--daemon`/`--stop`, et **jamais tué**.
Un process vivant dont l'identité est illisible (autre utilisateur) est
présumé vivant — `--daemon` refuse d'en lancer un second — mais n'est
jamais tué : `--stop` refuse avec `DAEMON_IDENTITY_UNVERIFIED` (sortie 3) et
garde le PID file. `--status --json` dit lequel des deux cas s'applique
(`data.verified`). Avant tout arrêt, l'identité est relue sans cache.

`--stop` est un **arrêt propre sur tous les OS**, Windows compris (où un
signal est un TerminateProcess qui couperait le daemon en plein Test Gate) :
il dépose une demande d'arrêt (`.striart/watch.stop`), que le daemon lit
lui-même, accuse, puis traite comme un SIGTERM — le watcher termine et
rapporte l'opération en vol. Sans accusé sous 5 s (daemon d'une version
antérieure, ou bloqué), repli sur le signal. `--stop` **attend ensuite la
sortie effective** (10 s) : le PID file n'est retiré qu'une fois le process
sorti — sans quoi un second watcher pourrait démarrer pendant que le
premier merge encore. Au-delà du délai, `--stop` rend la main sur « arrêt
demandé : … termine l'opération en cours, puis sort de lui-même »
(`data.stopping: true` en `--json`, piste `--status`) et laisse le PID file,
que le daemon retire lui-même en sortant. Un second `--stop` pendant ce
temps ne re-signale pas (un second signal forcerait la sortie en plein
merge) : il attend. Un daemon lancé par un autre utilisateur ne peut pas
être signalé d'ici : refus `DAEMON_STOP_DENIED` (sortie 3), PID file
conservé.

### `striart watch --ui`

Le même watcher, plus un panneau Ink interactif (**incompatible avec
`--daemon` et avec `--json`** ; exige un vrai terminal en entrée et en
sortie, sinon `UI_REQUIRES_TTY`) : un onglet par agent **supervisé** actif
(les agents autonomes ne sont pas suivis — pas de pty à rejoindre), chacun
affichant en direct le tail du pty possédé de l'agent, plus un onglet
virtuel permanent **« 🖥️ Terminal »** (sélectionné par défaut) qui reçoit
les événements du watcher et la sortie de toute commande `/…`/`!…` lancée
depuis le champ de saisie. Textes du panneau en français ou en anglais
selon `STRIART_LANG`.

Grammaire du champ :

- **`/commande`** lance `striart <commande>` (même binaire, `argv`,
  `shell: false`) et affiche sa sortie dans l'onglet Terminal. `/exit` quitte
  le panneau (comme Ctrl+C) ; `/clear` vide l'onglet Terminal, ou envoie la
  vraie commande d'effacement du shell (`cls`/`clear`) à l'agent
  sélectionné ; `/relaunch [agent]` retape la commande de lancement de
  l'agent (même résolution que `--open`) — utile quand le badge 🟡
  ci-dessous signale que l'outil hébergé s'est arrêté. Les commandes qui
  exigent le premier plan sont refusées ici, avec leur raison (registre des
  commandes) : `watch` (doublerait le watcher hôte), `mcp`, `api` et `acp`
  (protocole sur stdin/stdout), `attach` (doit posséder le terminal réel) ; `dashboard`
  n'est accepté qu'avec `--daemon`/`--stop`/`--status`.
- **`!commande`** lance une vraie commande via le shell par défaut de la
  machine (`defaultShell()`), pipes, redirections et tout binaire installé
  compris ; la sortie part aussi dans l'onglet Terminal.
- **`@agent message`** envoie `message` à l'agent nommé : au pty de l'agent
  **supervisé** (démarre son hôte de pty si besoin), ou — Phase E, livrée
  avec le client ACP complet — à la **session ACP vivante** d'un agent
  autonome, où le texte devient un `session/prompt` supplémentaire joué
  après le tour en cours (par l'hôte de session persistant). Une session
  argv (one-shot : plus de process à qui parler), une session ACP terminée
  ou en fermeture, ou un bus désactivé (`acp.bus: false`) sont refusés
  explicitement, avec la raison.
- **Le texte sans préfixe** part vers l'agent de l'onglet actuellement
  **sélectionné** — `@agent` n'est nécessaire que pour changer de cible.

Autocomplétion sur `/` et `@` (Tab ou Entrée complète la suggestion active ;
une seconde Entrée, une fois la liste vide, soumet). `↑`/`↓` rappellent
l'historique de saisie quand le champ n'est pas vide et qu'aucune suggestion
n'est active ; à champ vide, elles changent d'onglet. Page Up/Page Down font
défiler les 500 lignes de scrollback de l'onglet affiché. Un `•` marque un
onglet dont le contenu a changé pendant qu'un autre était affiché. Un badge
🟡 (vs 🟢) signale — à titre purement informatif, **jamais une relance
automatique** — que le pty de l'outil hébergé semble être retombé sur une
invite de shell nue ; `/relaunch` est le correctif. Les journaux du watcher
vont dans `.striart/logs/watch-ui.log`.

Le panneau se démonte au **premier** SIGINT ou SIGTERM reçu de l'extérieur
(un `kill` depuis un autre terminal, par exemple), comme sur `/exit`.
Contrairement à `watch` au premier plan, quitter le panneau n'attend pas la
fin d'un merge en cours : il est laissé à la récupération après coupure
(verrou retiré à la sortie du process, merge orphelin annulé à la prochaine
acquisition du verrou).

Même frontière de confiance que `--open`/`attach` : un message envoyé via le
bus `@agent`, ou le shell `!`, a exactement le même pouvoir que taper
directement dans le terminal — voir [SECURITY.md](../../SECURITY.md).

### `striart merge <agent>`

Merge manuel du dernier commit d'un agent — même pipeline que le watcher
(rebase préalable, fusion sémantique, Test Gate). Refuse si le repo principal
est sale (`MAIN_DIRTY`), sur la mauvaise branche
(`TARGET_BRANCH_MISMATCH`), si des untracked seraient écrasés
(`UNTRACKED_COLLISION`) ou si la session autonome de l'agent vit
(`SESSION_LIVE`) — voir [Branches et pipeline](branches.md). Une branche
cible sans aucun commit est refusée d'emblée (`UNKNOWN_BRANCH`), et un `HEAD`
qui pointe une autre branche **non née** donne `TARGET_BRANCH_MISMATCH` (piste
`git switch <targetBranch>`), jamais un message brut de git — c'est aussi le
cas de `rollback`, `promote` et `resolve --apply`. Sortie 0 sur
`MERGED`/`UP_TO_DATE`, **3 sur `CONFLICT` ou `GATE_FAILED`** (ticket créé).
Le document `--json` d'un merge réussi distingue `sha` (commit de l'agent)
et `mergeSha` (commit de merge créé sur la branche cible — celui que
`rollback` défait). Trois garde-fous s'ajoutent avant le commit final :
un changement **effectif** d'un chemin protégé (`AGENTS.md`, `.claude`,
`striart.config.*`…) refuse le merge et ouvre un ticket
`PROTECTED_PATHS_CHANGED` (sortie 3), avant toute fusion LLM ; l'exclusivité
du verrou principal est revérifiée avant le commit (`LOCK_LOST` si un autre
process l'a repris) ; et l'état du principal l'est aussi — si quelqu'un a
agi sur `HEAD` ou ouvert un merge pendant l'opération, rien n'est commité
(`MERGE_STATE_CHANGED`, sortie 3). Un commit de l'agent déjà présent dans la
cible rend `UP_TO_DATE` (aucun commit de merge créé).

**Commit de merge et hooks de la cible.** Le commit qui conclut le merge exécute
les hooks du dépôt (`pre-commit`, `pre-merge-commit`, `prepare-commit-msg`,
`commit-msg`) et la signature, sous le délai dur `commitTimeoutMs` (arbre de
process tué au-delà). Un hook **n'est jamais contourné** : un rejet ou un
dépassement annule le merge (le principal est propre), ouvre un ticket
`COMMIT_HOOK_REJECTED` qui garde la sortie du hook (16 Kio au plus, **secrets
caviardés** — même règle que le journal du Test Gate — dans le ticket, le
message d'erreur et le `--json`) et sort en 1. Ce n'est pas un échec du LLM : le
compteur du mode manuel n'est pas touché, et le ticket se ferme au prochain
merge réussi de l'agent. Les autres refus de git (identité absente, signature
impossible) donnent `MERGE_COMMIT_FAILED`.

**Livraison (`autoPush`).** Le push vers `origin` est un effet différé, après la
libération du verrou, du SHA exact testé (voir
[Configuration](configuration.md#livraison-vers-origin--autopush-delivery-délais)).
Le résultat porte `delivery` (mode, branche, SHA, `pushed`, `code`, piste) et
`pushError` (`[CODE] message`) ; en mode `delivery: 'branch'`, la sortie humaine
ajoute la ligne « livré sur origin/striart/… (sha) : à approuver depuis la forge (PR/MR), la branche cible n'a pas été poussée. ».
Un push en échec ne change ni le statut ni la sortie du merge (le travail local
est valide).
### `striart sync [agent]`

Rebase un agent (ou tous) sur la branche cible, avec les mêmes garde-fous que
le watcher (stash auto si disjonction vérifiée, `SKIPPED_SESSION` pour les
sessions vivantes, y compris en sync unitaire). Les
[6 statuts](architecture.md#les-6-statuts-de-la-synchronisation) disent
exactement ce qui s'est passé. Sortie 0, y compris sur un rebase reporté ou
en conflit (ajournement voulu, le merge le rattrapera) ; 3 sur
`STASH_CONFLICT`.

### `striart stop <agent> [--force]`

Termine un agent : retire l'entrée du registre, conserve le clone sur disque,
arrête son hôte de pty éventuel (`--open`), puis débloque la file (les
tâches qui attendaient cet agent partent, et leur commande de lancement est
affichée). Refus :

- `AGENT_HAS_PENDING` — commits non mergés (`--force` les abandonne), ou
  clone **présent mais illisible** par git : le travail en attente est
  inconnu, donc présumé existant (fail closed, `--force` pour passer outre) ;
- `SESSION_LIVE` — la session autonome de l'agent vit : refus **même avec
  `--force`**.

Un clone **disparu du disque** (seule une erreur ENOENT le prouve) n'a plus
aucun travail à perdre : l'agent est retiré du registre sans `--force`.
Toute autre erreur d'accès au dossier est traitée comme un clone présent,
donc vérifié — et refusé s'il est illisible.

L'hôte de pty est arrêté **après** le retrait du registre et **hors** du
verrou principal (il peut mettre quelques secondes à sortir, et le verrou
gèle tout l'orchestrateur), par le même canal que les daemons : demande
d'arrêt `.striart/pty/<agent>/host.stop`, repli sur SIGTERM sans accusé
sous 3 s, puis attente de la sortie (5 s) avant de retirer son PID file —
tant qu'il vit, la garde `SESSION_LIVE` de `clean` tient. Il n'est **jamais
tué à l'aveugle** : identité relue sans cache, un hôte non identifiable ou
appartenant à un autre utilisateur est laissé en place. Le `stop` lui-même
réussit (sortie 0) ; ce qui reste vivant est dit par un avertissement
(champ `warnings` du `--json`, `data.ptyHost` pour le détail) :
`PTY_HOST_STOPPING` (l'hôte s'arrête encore, le clone reste protégé jusqu'à
sa sortie) ou `PTY_HOST_UNTOUCHED` (laissé en place — process non
identifiable, autre utilisateur, ou arrêt en échec : le fermer à la main
avant `striart clean <agent>`).

Le dégagement de la file qui suit l'arrêt peut échouer sans défaire l'arrêt
(un ticket ou une tâche en erreur ne bloque plus les autres) : l'agent est
retiré, la file reste en l'état, et l'échec est rapporté — `data.queueError`
(`{code, message}`), avertissement du même code sur stderr et dans
`warnings` — jamais tu. `striart queue --retry` la reprend. Les artefacts
périphériques de l'agent (hôte de session ACP, *Tab Config* Warp) sont
retirés dans le même élan ; un échec est rapporté en `data.artifacts.errors`
et en avertissement `AGENT_ARTIFACT_FAILED`, sans faire échouer l'arrêt.

### `striart orchestrate <mode> <prompts...>`

Lance **une** tâche orchestrée sans écrire de fichier : la commande construit
un plan `version: 2` d'un seul nœud et l'applique par le même chemin que
`striart plan` (même validation complète avant tout effet, `--dry-run`
compris). Quatre modes, tous en session autonome :

| Mode | Ce qui se passe | Options propres |
|---|---|---|
| `review` | Un **auteur** travaille, 1 à 5 **relecteurs** (agents ou humain) examinent son clone à leur tour, en lecture seule *vérifiée*. Verdict structuré `approve` / `request-changes` / `reject` ; le merge n'a lieu qu'après approbation **puis** Test Gate. | `--author <profil>`, `--reviewer <profil>` (répétable), `--human-reviewer`, `--quorum all\|any\|majority`, `--max-rounds <n>` |
| `race` | Au moins 2 candidats (`orchestration.race.maxCandidates` : 5 par défaut, 10 au plus) sur le même prompt, chacun dans son clone ; le premier dont le merge passe le Test Gate gagne (ou le plus petit diff, ou le choix d'un juge LLM). | `--candidate <profil>` (répétable, 2 au moins), `--pick first-green\|smallest-diff\|judge`, `--losers keep\|archive\|clean` |
| `team` | Plusieurs **rôles** dans le *même* clone : un écrivain à la fois (`turns`), ou une partition statique des fichiers (`parallel`, un commit unique de Striart). | `--role nom=profil[:glob,glob]` (répétable ; `:` seul = lecture seule), `--cadence turns\|parallel`, `--rounds <n>` |
| `pipeline` | Étapes ordonnées, chacune nourrit la suivante (un briefing de faits calculés par Striart, puis l'artefact de l'étape précédente). | `--step-profile <profil>` (répétable, dans l'ordre), `--handoff merge\|clone` |

Un argument de prompt par étape pour `pipeline`, un seul pour les autres.
Communes : `--agent` (nom de l'agent ou base des noms dérivés),
`--timeout <ms>` (par session), `--dry-run`. Une option étrangère au mode
choisi est refusée (`ORCHESTRATE_USAGE`, sortie 2). Ctrl+C arrête proprement
(arbres des agents tués avant toute dépublication, clones conservés). Le
Test Gate reste l'autorité finale : approuvé ne veut jamais dire mergé. Les
réglages (bornes, quorum, politique de perdants, cadence…) sont dans
`orchestration` et `collab` — voir [Configuration](configuration.md) et
[Modes d'exécution](modes-execution.md#les-modes-dorchestration).

### `striart review [<id>] [--approve | --request-changes | --reject] [--comment <texte>]`

Les relectures **humaines** d'une tâche `review` (un relecteur déclaré
`human: true` dans le plan, ou `--human-reviewer` d'`orchestrate`).

- Sans argument : liste les demandes (celles qui attendent un verdict
  d'abord), avec l'état du process qui attend (`alive`).
- Avec un `<id>` (`rev-…`) et une des trois actions : rend le verdict.
  `--request-changes` exige `--comment` (transmis à l'auteur, encadré comme
  contenu non fiable) ; `--reject` ne merge rien et conserve le clone ;
  `--approve` laisse le Test Gate décider ensuite. Une demande qui n'attend
  plus (délai `orchestration.review.humanTimeoutMs` écoulé, déjà répondue) est
  refusée : `REVIEW_NOT_PENDING`.

Les demandes vivent dans `.striart/reviews/` (boîte aux lettres disque,
réponse atomique sous le verrou d'état, fail closed au délai), distincte des
permissions semi-autonomes. Le dashboard et le Control Protocol présentent
les mêmes demandes (`review.list`, `review.answer`).

## Observer

### `striart status`

La vue d'ensemble : un tableau des agents (statut, **session** — `en cours`
seulement quand un PID est vivant, session autonome ou terminal `--open`,
sinon `activité récente` ou rien —, mode 🤖 autonome + profil / 👤
supervisé, branche de tâche, outil, taille additionnelle du clone — les
hardlinks comptent 0 —, commits en attente), puis tout ce qui attend un
humain : tickets ouverts, mode manuel, repo principal réservé, tâches
débloquables. Un clone en cours de suppression apparaît en état `REMOVING`.
`striart status --json` rend exactement la même vue que l'outil MCP
`striart_status` (`agents`, `queue`, `tickets`, `state`, `daemon`,
`mainSession` avec `alive` calculé) plus `orchestration` (plans et groupes
des modes orchestrés, en cours et récents, et les relectures humaines — dont
celles qui attendent un verdict) et `tokens` (comptabilité active,
consommation du jour, plafonds et leur niveau, relâchements ;
`available: false` si la config ou le registre est illisible, sans casser la
vue).

La vue porte aussi les champs additifs `overlaps` (chevauchements
[observés](configuration.md#overlap--le-filet-de-chevauchement-à-lexécution) à
l'exécution entre agents, ou entre un agent et la cible) et `idle` : le verdict du
[GC d'inactivité](#striart-gc-agent---close---dry-run) pour chaque agent, calculé par un
balayage `--dry-run` (rien n'est écrit ni fermé ; `available: false` si le
balayage est impossible). Les sessions vivantes dont tous les signaux dépassent
le seuil apparaissent dans les « choses à traiter », avec la piste
`striart gc --dry-run`.

### `striart queue [--retry]`

Le scheduler : tâches `RUNNING` / `WAITING` et ce qui bloque chacune
(collision, dépendance `--after`) ; une tâche que plus rien ne retient est
marquée prête (`ready`). `--retry` démarre les tâches devenues débloquées.

### `striart history [--limit <n>]`

Historique des merges et rollbacks Striart, **reconstruit depuis le graphe
Git** (pas un journal séparé qui pourrait diverger). Chaque merge dit
comment un conflit éventuel a été tranché (`resolution` : `auto`,
`semantic` avec ses fichiers, ou `manual` avec l'id du ticket résolu par
`resolve --apply`). Défaut : 30 entrées.

### `striart usage [--since <p>] [--until <p>] [--role <r>] [--agent <a>] [--task <id>]`

Consommation de tokens et coûts, lue dans le registre **append-only**
`.striart/usage/AAAA-MM-JJ.ndjson` (jour UTC) : un enregistrement par appel
LLM de Striart (`router`, `merger`, `memory`, `judge`, `review`) et par
session d'agent (`agent`). Le registre ne contient **jamais** de prompt, de
réponse, de contenu de fichier ni de clé : chaque ligne est reconstruite
champ par champ (liste blanche). Tableaux par rôle (avec un TOTAL), par
agent, par tâche (20 premières), par modèle et par jour, puis le taux de
succès du cache de prompt, les réponses servies par le cache de résultats et
l'empreinte des consignes injectées.

- `--since` / `--until` : `7d`, `24h`, `30m`, `today` ou `AAAA-MM-JJ` (UTC,
  jour entier inclus). Période incohérente ou illisible :
  `USAGE_PERIOD_INVALID` (sortie 2).
- `--role` : `router`, `merger`, `memory`, `judge`, `review` ou `agent`.
- Le **coût** n'existe que pour un modèle dont le prix est déclaré
  (`tokens.pricing`, sans prix en dur : un prix change sans prévenir) ; un
  modèle Ollama local compte 0 USD. Les appels sans prix sont comptés à part
  (« non chiffrés »), les relevés estimés (aucun relevé du fournisseur) aussi,
  et une session sans flux structuré est déclarée *unmetered* — seul son
  délai la borne. L'estimateur local de jetons reste du côté prudent (il
  surestime plutôt que de laisser passer un appel au-dessus d'un plafond) et
  se calibre sur l'usage réel relevé.
- La rétention est `tokens.retentionDays` (90 jours), appliquée par
  `striart prune`. Le même résumé alimente `status --json` (champ `tokens`),
  la ligne « Tokens et coûts » de `doctor` et le Control Protocol.
- `npm run bench:tokens` (`scripts/bench-tokens.ts`, hors ligne et
  déterministe) compare, avant et après le lot d'économie de tokens, les
  jetons estimés du Merger (conflit réel à trois voies), de l'arbre du
  Router (le dépôt, puis un monorepo synthétique de 10 000 fichiers), des
  consignes injectées (complet / compact) et de la Memory Layer.

### `striart dashboard [--port <p>] [--daemon | --status | --stop | --link]`

Dashboard web local, lié à `127.0.0.1` uniquement, **temps réel** (SSE —
poussé à chaque changement, sans polling) : état des agents et de leur mode,
bandeau d'état du watcher, logs de session, arbitrage des permissions
semi-autonomes et des questions de l'agent (élicitation), relectures
humaines, état des modes d'orchestration, diagnostic, et pilotage (merge,
stop, relance, rollback, préparation et application de résolution de ticket
sous Test Gate, clôture manuelle). C'est le **client navigateur du Striart
Control Protocol v1** : la page parle JSON-RPC 2.0 (`POST /rpc`) et reçoit
les changements par `GET /events`. Port : `--port`, sinon `dashboardPort` de
la config (3456) ; un port invalide est refusé avant tout démarrage, un
port occupé rend `PORT_IN_USE` avec une suggestion.

**La page.** Elle est servie dans la langue de l'instance (`STRIART_LANG`, puis
la locale — même règle que la CLI ; français et anglais, un seul catalogue
embarqué), en thème **clair ou sombre** selon la préférence du système
(`prefers-color-scheme`). Ordre de lecture et de tabulation : un lien
d'évitement (« Aller au contenu principal »), puis la zone **« À traiter »**
(tickets de conflit à résoudre, agents `BROKEN`/`MISSING`, absence de watcher,
session principale réservée, mode manuel, permissions, questions de l'agent,
relectures), le formulaire de tâche, la maintenance, puis les données (agents,
file, fichiers disputés, tickets, orchestration, historique). Le niveau d'une
information est toujours porté par un mot, jamais par la seule couleur. Les
actions destructrices demandent une confirmation qui nomme la conséquence ;
**« Arrêt forcé… »** vit dans le menu « Autres actions » de chaque agent
(`<details>`, hors de portée d'un clic distrait) et dit ce qu'il fait : il
**retire l'agent du registre sans merger ses commits en attente** — le clone
reste sur disque, mais Striart ne l'intégrera plus —, sans Test Gate. Quand le
flux temps réel est coupé, un état **« Hors ligne »** affiche les données
**datées** (« dernière mise à jour à … ») et signale qu'elles peuvent être
obsolètes ; la reconnexion est automatique. La page n'affiche **pas** l'usage de
tokens (le Control Protocol ne l'expose pas : `striart usage`). Elle n'est
**pas déclarée conforme à WCAG 2.2 AA** : l'audit automatisé (axe) est vert d'après le relevé du mainteneur (non rejoué
par la passe de documentation) et
une revue manuelle reste à faire ; aucun lecteur d'écran réel n'a été testé.
La page est servie sous une CSP stricte dont le script et la feuille de style
sont identifiés **par empreinte, une par langue** (aucun `unsafe-inline`, aucune
source externe) ; `/favicon.ico` répond 204 sans donnée, sans session.

**Liste des agents.** Les agents sont regroupés par état : **« À traiter »**
(`BROKEN` / `MISSING`, commits en attente de merge, ticket de conflit, demande
de permission, question ou relecture en attente), **« En cours »** (session
vivante ou activité récente, hôte ACP en marche) et **« Inactifs »** (le reste,
dont un clone en cours de suppression). À partir de quatre agents, un filtre par
groupe et une recherche par nom apparaissent ; un clic ouvre la fiche de l'agent
(branche, outil, mode, session, taille du clone, commits en attente, fichiers
verrouillés, conflits ouverts, tâches qu'il bloque, inactivité). Ce groupe
« Inactifs » est un **classement d'affichage** : il ne dit rien de la décision du
GC ci-dessous, qui repose sur les signaux d'activité.
**Inactivité (GC).** Un agent dont la session vit mais que le
[GC d'inactivité](#striart-gc-agent---close---dry-run) juge inactif porte une
pastille **« Inactif depuis … »** (information, puis avertissement quand il a
été averti ou qu'il est fermable), une ligne « Inactivité » dans sa fiche, et une
carte dans la zone **« À traiter »** qui dit où il en est (averti, fermable
après telle heure, clone et travail conservés) avec un bouton
**« Lancer gc --dry-run »** pour cet agent. Le dashboard ne ferme **jamais** une
session lui-même : le bouton prévisualise (`workspace.gc` en `dryRun`) ; la
fermeture reste `striart gc` ou le balayage de `striart watch`.

**Connexion par lien à usage unique** (rupture de 0.11 : le dashboard n'est
plus ouvert à quiconque joint la boucle locale). Au démarrage, Striart
affiche un **lien de connexion** (`http://<id-aléatoire>.localhost:<port>/auth?code=…`, un nom propre à
l'instance : voir `dashboardHostname`) ; le
navigateur l'échange contre un cookie de session `HttpOnly; SameSite=Strict`.
Le lien est signé (HMAC-SHA256 du jeton de l'instance), vit
`dashboardLinkTtlMs` (5 min par défaut), ne sert **qu'une fois**, et le cookie
vit `dashboardSessionTtlMs` (12 h). Sans session, l'URL nue répond **401**
(page « connexion requise », aucune donnée du dépôt) et `/rpc` répond une
erreur `CONTROL_UNAUTHENTICATED` ; une fois connecté, les anciennes routes
`/api/*` répondent **410** (remplacées par le protocole). Le jeton lui-même
n'est ni journalisé, ni dans une URL, ni dans un cookie : il vit dans un
fichier lisible par l'utilisateur seul (0600 sous POSIX, ACL réduite à
l'utilisateur sous Windows — refus `CONTROL_TOKEN_UNPROTECTED` si elle ne
peut pas être posée).

- `--daemon` le lance en process détaché natif (même mécanisme que `striart
  watch --daemon`, y compris la reconnaissance du PID publié, le verrou du
  PID file et l'arrêt propre de `--stop` — `.striart/dashboard.stop`,
  `.striart/dashboard.pid.lock`) et affiche, lui, le lien de connexion : le
  daemon n'en émet jamais (sa sortie est un journal sur disque).
- `--link` émet un **nouveau** lien pour le dashboard déjà en cours (celui
  du daemon, ou celui de `--port`) — `CONTROL_INSTANCE_NOT_FOUND` si aucun
  ne tourne. Refusé dans une session d'agent (`CONTROL_NESTED_SESSION`).
- `--status` affiche aussi l'adresse réelle ; `--stop` l'arrête.

Barrières, dans l'ordre, sur **toute** requête (lectures comprises) : en-tête
`Host` égal au nom de l'instance (anti-DNS-rebinding ; l'adresse `localhost` nue
est refusée en 403, sauf `dashboardHostname: 'localhost'`) ou listé dans `dashboardAllowedHosts` ;
`Sec-Fetch-Site` ni cross-site ni same-site (403) ; session valide (401) ;
puis, sur `/rpc`, `Origin` du serveur, `X-Striart: 1` et `Content-Type`
JSON (403 : `CONTROL_ORIGIN_REFUSED` / `CONTROL_CSRF_REFUSED`).
`dashboardAllowedHosts` (vide par défaut) admet en plus un nom public —
Codespaces `*.app.github.dev`, proxy inverse — et **ne relâche que** le
contrôle `Host` : jeton, cookie, `Origin` et anti-CSRF restent exigés ; le
relâchement est journalisé à chaque démarrage et affiché par `doctor`.
Détails et modèle de menace : [SECURITY.md](../../SECURITY.md).

## Réparer et nettoyer

### `striart rollback`

Défait le **dernier merge Striart** : reset local (récupérable via reflog) si
le merge n'est pas poussé, revert sinon (l'historique publié est conservé).
Refuse si le dernier commit de la branche cible n'est pas un merge Striart
(`NOT_A_STRIART_MERGE`) — y compris les merges produits par
`resolve --apply`, désormais reconnus — ou si la branche cible n'a aucun commit
(`UNKNOWN_BRANCH`) ou n'est pas la branche courante (`TARGET_BRANCH_MISMATCH`).
Un `revert` (merge déjà publié) exécute lui aussi les hooks de la cible sous
`commitTimeoutMs` : rejet ou dépassement → `COMMIT_HOOK_REJECTED`, `HEAD`
inchangé, aucun ticket. Les livraisons en vol dans ce process sont attendues
avant de décider « publié ? ».

### `striart resolve [--unlock | --close <id> | --prepare <id> [--accept-theirs <chemin>…] | --apply <id>] [--all]`

Les tickets de conflit (`.striart/conflicts/<ticket>/` : versions
BASE/OURS/THEIRS, tentative LLM, log du Test Gate). Sans option : liste les
tickets ouverts — `--all` y ajoute les tickets déjà résolus. `--close <id>`
marque un ticket résolu **sans repasser par le Test Gate** (à la main, une
fois le conflit réglé hors de Striart) — sur un ticket déjà résolu, c'est un
refus (`TICKET_ALREADY_RESOLVED`, sortie 3), comme `--apply`, pour qu'un script
qui enchaîne les commandes ne croie pas avoir agi ; `--unlock` réactive la fusion
sémantique après le passage en mode manuel (3 échecs d'affilée). Les quatre
actions s'excluent mutuellement.

Un même commit d'agent re-tenté (watch qui redéclenche, merge relancé) ne
crée pas un ticket de plus : le ticket **ouvert** qui le concerne est mis à
jour (`attempts`, `updatedAt`, versions rafraîchies) et les résolutions déjà
préparées (`.resolved`/`.delete`) ne sont jamais touchées. L'id d'un ticket
est le **nom de son dossier**. Les fichiers d'un ticket (`<préfixe>.base`,
`.ours`, `.theirs`, `.llm-attempt`, `.resolved`, `.delete`) portent un nom
dérivé du chemin par un encodage **injectif** (`ticket.fileNaming: 2` : tout
octet hors `[A-Za-z0-9._-]` est écrit `%HH`, un nom trop long est abrégé avec
une empreinte SHA-256) — `a/b.txt` et `a__b.txt` ne partagent plus leurs
fichiers de résolution, ce que faisait la convention 1 (`/` et `\` → `__`),
qui reste lue pour les tickets créés avant. Un ticket de rouge d'exécution
du Test Gate porte `gate: {code?, orphanPids?, truncated?}` (le code stable
du rouge — `GATE_ORPHAN_PROCESS`…, les PID des orphelins tués, le journal
tronqué au plafond).

`--prepare <id>` et `--apply <id>` forment le chemin **testé** de la
résolution humaine — recommandé sur `--close` : la résolution passe par le
même verrou inter-processus et le même Test Gate bloquant que la fusion
automatique, au lieu d'un `git merge` fait à la main hors du cadre de
Striart (source d'un incident réel : collision avec un `striart watch`
actif).

- `--prepare <id>` amorce `<fichier>.resolved` dans le dossier du ticket
  pour chaque fichier en conflit sans résolution déjà préparée, à partir de
  `.theirs` (repli `.ours` puis `.base`) — un point de départ à éditer,
  jamais écrasé si déjà présent. **Exception : les chemins d'un ticket
  `PROTECTED_PATHS_CHANGED`** ne sont jamais amorcés depuis la version de
  l'agent — le `.resolved` est ce qui distingue la décision de l'humain de
  celle de l'agent, un amorçage automatique la lui ferait approuver sans
  lecture. Ils sont rendus *retenus* (`held: true` dans le `--json`, ligne
  d'avertissement avec la commande exacte) ; l'humain écrit le contenu final,
  ou nomme explicitement le chemin à prendre tel que l'agent l'a laissé :
  `--prepare <id> --accept-theirs <chemin>` (option répétable ; refusée sans
  `--prepare`, `OPTION_CONFLICT`).
- `--apply <id>` rejoue le merge **exact** du ticket (`ticket.sha`, pas la
  tête courante de l'agent, qui a pu avancer depuis) et applique les
  fichiers `.resolved` (contenu final, binaire supporté) et `.delete`
  (résolution = suppression) préparés dans le dossier du ticket, sous le
  Test Gate bloquant. Vert → commit (visible dans `striart history` comme
  résolution manuelle), fermeture du ticket (et de ses doublons portant sur
  les mêmes fichiers du même agent), remise à zéro du compteur d'échecs
  sémantiques. Rouge → sortie 3, le ticket reste ouvert, **rien** n'est
  touché au compteur ni au mode manuel (une résolution manuelle ratée n'est
  pas un échec du LLM). Un hook de la cible qui rejette le commit
  (`COMMIT_HOOK_REJECTED`) laisse de même le ticket d'origine ouvert et intact.
  Refusé sans rien modifier si : ticket déjà résolu
  (`TICKET_ALREADY_RESOLVED`), conflit non couvert par fichier
  (`TICKET_NOT_APPLICABLE`), résolution incomplète
  (`RESOLUTION_INCOMPLETE`), agent inconnu, session autonome vivante, ou
  ticket périmé (`STALE_TICKET` — le repo principal ou l'historique de
  l'agent a bougé depuis).

### `striart lock [--start <raison> [--pid <n>] | --stop]`

Réserve ou libère le repo principal pour une **intervention directe hors
Router/agent** : édition manuelle sans commit, résolution d'un conflit à la
main en `git merge` brut. Même mécanisme que `--on-main` (session déclarée
dans `.striart/main-session.json`, garde `assertNoLiveMainSession` dans
`withMainLock`) — corrige un incident réel où une résolution manuelle avait
été annulée par la récupération de merge orphelin pendant qu'un
`striart watch` actif prenait le verrou.

- `--start <raison>` : réserve, sous le verrou principal (deux réservations
  concurrentes ne peuvent pas passer toutes les deux). Le PID surveillé est
  celui du **shell appelant**, à condition que ce soit un shell interactif
  durable : un process qui n'est pas un shell, un shell qui exécute une seule
  commande (`bash -c`, `cmd /c`, `pwsh -Command`) ou la copie éphémère de
  Git Bash/MSYS mourrait avec la commande et désarmerait la réservation
  aussitôt — refus fail closed `LOCK_PID_EPHEMERAL`, avec la commande
  corrective adaptée au shell détecté (`--pid $PID` sous PowerShell,
  `--pid $$` en bash/zsh, `--pid $fish_pid` sous fish,
  `--pid $(cat /proc/$$/winpid)` sous Git Bash). Le shim npm
  `cmd /c striart.cmd` est sauté pour désigner le vrai terminal, et la
  raison y est citée dans la grammaire de ce shell (jamais une ligne qui
  expanserait `$(…)`). Un `--pid <n>` explicite n'est contrôlé que pour sa
  vitalité : un PID mort est refusé (`LOCK_PID_DEAD`) — une réservation qui
  ne protège rien est pire que pas de réservation. Raison vide :
  `LOCK_REASON_EMPTY` ; `--pid` sans `--start` : `OPTION_CONFLICT`.
- `--stop` : libère — **sortie de secours toujours permise**, même si le PID
  déclaré vit encore.
- Sans option : affiche le statut (libre / occupé avec raison, PID et durée /
  PID mort).

**Aucun TTL** (contrairement à `.striart/main.lock`) : une intervention
directe peut légitimement durer des heures ; `striart lock --stop` est la
seule sortie si le PID a été recyclé par l'OS.

### `striart clean [agent] [--stopped | --all] [--force]`

Libère le disque : clones des agents arrêtés par défaut (`--stopped` le dit
explicitement) ; `--all` inclut les actifs **sans travail en attente**
(arrêtés puis supprimés). Deux niveaux de refus, selon ce que Striart sait :

- `IN_USE` — le disque du clone a bougé il y a moins de `presenceMinutes`
  minutes : une **heuristique**, que `--force` peut écraser en connaissance
  de cause ;
- `SESSION_LIVE` — le PID d'une session autonome est vivant, **ou** l'hôte
  de pty d'un terminal ouvert par `--open` tourne : un **fait vérifié**, que
  `--force` ne peut **pas** écraser (`striart stop` arrête l'hôte de pty).

Un travail non commité ou non mergé (`PENDING`, `BUSY`) protège aussi le
clone ; avec `--all`, `--force` assume alors l'abandon du non-mergé. Un
agent nommé sans clone trouvé : `CLONE_NOT_FOUND`.

La suppression d'un clone est **rejouable** : un marqueur
`.striart/removing/<agent>.json` (et `removing: true` au registre d'un agent
actif — état `REMOVING` dans `status`) est posé *avant* le `rm`, retenté avec
une attente exponentielle, puis retiré avec l'entrée du registre. Un `rm`
interrompu (crash, handle Windows tenu) ne laisse donc plus un clone à moitié
supprimé et encore inscrit : `striart reconcile` termine la suppression déjà
décidée — sauf si une session vit dans le clone (fait vérifié, jamais
contourné). Tant qu'elle n'est pas finie, le nom n'est pas réutilisable
(`CLONE_REMOVAL_PENDING`).

Les artefacts périphériques d'un clone supprimé (hôte de session ACP, *Tab
Config* Warp) sont retirés avec lui. Un échec à ce niveau ne défait pas la
suppression : il est rapporté (`data.artifactErrors`, avertissement
`AGENT_ARTIFACT_FAILED`).

### `striart reconcile`

**Réconciliation** (level-triggered) : neutralise les sessions mortes au
registre, débloque la file (même quand aucun commit ne l'a déclenché — ex.
`clean` d'un bloqueur), répare verrous et merges orphelins, et **termine les
suppressions de clone entamées** (marqueurs `.striart/removing/`). Idempotent
— peut être lancé à tout moment sans risque. Rejoué automatiquement par
`striart watch`.

### `striart prune [--days <n>] [--dry-run]`

Rétention : élague les clones arrêtés inactifs, les tickets résolus et les
journaux de session (`session-*.log`) et de terminal (`pty-*.log`) inactifs
depuis N jours (`--days`, sinon config `pruneDays`, défaut 14 ; `0` rend
éligible tout ce qui est arrêté ou résolu) — jamais un agent actif ni un
ticket ouvert. Le registre d'usage des tokens (`.striart/usage/`, fichiers
journaliers et cache de résultats) suit sa propre rétention,
`tokens.retentionDays` (90 jours), indépendante de `pruneDays`. Une
suppression qui échoue (handle tenu sous Windows) est rapportée dans
`failed`, jamais tue. `--dry-run` prévisualise. Une rétention invalide est refusée (sortie
2, ou `INVALID_RETENTION_DAYS` côté API) au lieu de tout supprimer. Un
`striart prune` périodique (cron/tâche planifiée) garde `.striart/` sain.

### `striart gc [agent] [--close] [--dry-run]`

**Ramasse-miettes d'inactivité** (`src/idle/`). Un agent oublié — terminal
laissé ouvert, session ACP ou autonome qui ne produit plus rien — garde un
process, un hôte et un clone vivants indéfiniment. `gc` détecte ces agents puis,
selon `idle.action`, les **signale**, les **avertit** et ferme **leur session**.
Il ne touche **jamais** au clone ni au travail non commité, ne merge pas, ne
rebase pas, ne retire rien du registre : c'est la seule exception à
« un clone dont la session vit est intouchable », et elle ne porte que sur la
session. Réglages : [bloc `idle`](configuration.md#idle--le-gc-dagents-et-de-sessions-inactifs) ;
modèle de menace : [SECURITY.md](../../SECURITY.md).

**Ce qu'est « inactif ».** Un agent n'est inactif que si **tous** ses signaux
dépassent `idle.warnAfterMs` (30 min par défaut) : l'activité est le *maximum*
des horodatages, jamais un signal seul.

| Signal | Source |
|---|---|
| `sessionStart` | création du clone, début de la dernière session, démarrage de l'hôte ACP ou de terminal — une session qui vient de naître n'est pas inactive |
| `sessionOutput` | dernière sortie de l'agent : battement `.striart/idle/beats/<agent>.beat` (session autonome en argv, touché par le process qui la supervise au plus toutes les 10 s) ; journal de session (ACP) ; terminal : `host.output`, publié par l'hôte de pty natif |
| `worktree` | dernière écriture réelle du worktree du clone |
| `refs` | reflog de `HEAD` et références de branches du clone |
| `messages` | boîtes de collaboration du clone (`.striart-inbox.md`, `.striart-outbox.json`) |

**Fail closed.** Un signal illisible, une horloge en avance de plus de 5 s sur
un fichier, ou l'absence de tout signal rendent l'agent **actif**, jamais
inactif. Dès qu'un signal frais est connu, le parcours du worktree est sauté.
Un signal « inobservable » (ce type d'hôte ne le publie pas) ne compte ni pour
ni contre. Un terminal dont la dernière sortie n'est pas observée (hôte natif
antérieur qui ne publie pas `host.output`, programme encore silencieux) ne peut
être fermé que sous `idle.closePty: true` (code `PTY_OUTPUT_UNOBSERVABLE` dans
`closeBlockedBy`).

**Gradation.** Détecter → avertir → délai de grâce → fermer :

- `idle.action: 'report'` (défaut) : détection et rapport seulement (statut,
  événement `idle:detected` une fois par période d'inactivité).
- `'warn'` : en plus, un avertissement (journal, webhooks, événement
  `idle:warned`). Il ne vaut que pour la période d'inactivité en cours : toute
  activité le périme.
- `'close'` : en plus, la session est fermée si l'avertissement date d'au moins
  `idle.graceMs` (5 min), si l'inactivité atteint `idle.closeAfterMs` (2 h) et
  si **l'utilisateur l'a autorisé** pour ce dépôt (`idle.closeRoots` de la
  [configuration utilisateur](configuration.md#configuration-utilisateur-hors-du-dépôt)) ;
  une revérification fraîche, juste avant d'agir, annule la fermeture si un
  signal est apparu entre-temps. Sans autorisation, `close` dégrade en
  avertissement et le rapport le dit (`closeAuthorized: false`).

**Gardes.** Quelle que soit l'inactivité, un agent est *protégé* (jamais touché)
s'il a une demande humaine en attente (permission, question), un ticket de
conflit ouvert, un plan ou un groupe d'orchestration vivant (ou l'appartenance
à un groupe de collaboration), un merge/stop/sync/start/reuse en cours, une suppression
en cours, une session du repo principal ou une exclusion de la config
(`idle.excludeAgents`, `idle.excludeProfiles`). Si une **source de contexte est
illisible** (demandes humaines, tickets, orchestration, verrou, session
principale, état du GC), le balayage reste prudent : aucune fermeture.

**Comment la session est fermée** (jamais un kill à l'aveugle) :

- **ACP** : demande d'arrêt lue par l'hôte (`session/cancel`, arrêt de l'agent) ;
  repli sur le kill d'arbre seulement si l'hôte est identifié.
- **Terminal** (hôte de pty natif) : même protocole d'arrêt de l'hôte.
- **Session autonome en argv** : le process qui la supervise reçoit une demande
  d'arrêt sur disque, l'accuse, puis l'annule par son chemin normal (`CANCELLED`,
  clone conservé). Superviseur vivant mais muet : **aucun kill**
  (`IDLE_CLOSE_NOT_ACKNOWLEDGED`). Sans superviseur connu, l'agent n'est pas
  identifiable (`IDLE_CLOSE_UNVERIFIED`, détail `NO_SUPERVISOR_RECORD`) ; agent
  *orphelin* (superviseur mort) : SIGTERM (POSIX) puis kill d'arbre, après
  vérification de son identité par l'heure de création.

Au plus `idle.maxClosuresPerSweep` (4) sessions sont fermées par balayage.
Jamais la session du repo principal, jamais Striart lui-même.

**Options.**

- `[agent]` : limiter le balayage à cet agent (inconnu : `AGENT_UNKNOWN`).
- `--dry-run` : n'écrit rien (ni état, ni événement) et ne ferme rien ; affiche
  ce qui serait averti ou fermé.
- `--close` : *demande humaine* de fermer. Remplace `idle.action` et
  l'autorisation `idle.closeRoots`, mais **ni** l'avertissement préalable, ni le
  délai de grâce, ni le seuil `closeAfterMs`, ni les gardes.

**Sortie et codes.** `0` : balayage fait. `3` : au moins une fermeture a été
**refusée** par une garde (`IDLE_CLOSE_BLOCKED`, `IDLE_CLOSE_UNVERIFIED`,
`IDLE_CLOSE_NOT_ACKNOWLEDGED`) — la session est intacte, relancer telle quelle
ne changera rien. `1` : un arrêt a échoué (`IDLE_CLOSE_FAILED`). Ces codes sont
portés par le rapport (`refused[].code`), pas levés : un agent récalcitrant
n'arrête pas le balayage. `--json` rend le rapport complet (seuils, agents,
signaux lus, `plan`, `closeBlockedBy`, `warned`, `closed`, `refused`).

**Où il tourne.**

- **À la main** : `striart gc`, puis `striart gc --dry-run` pour prévisualiser.
- **Dans `striart watch`** : un balayage toutes les `idle.sweepIntervalMs`
  (5 min), **hors de la chaîne de merge** et jamais sous le verrou principal ;
  un seul à la fois. Une reprise de veille (le minuteur se réveille très en
  retard) neutralise ce tour — les agents gelés avec la machine n'ont pas eu le
  temps de reprendre. Événements du flux : `idle-warned`, `idle-closed`,
  `idle-refused`, `idle-error`.
- **En lecture seule** : `striart status` (ligne « sessions vivantes inactives » avec la
  piste `striart gc --dry-run`), `striart_status` (MCP) et l'état du Control
  Protocol portent un champ `idle` additif ; `watch --ui` et `watch --plain`
  affichent « inactif depuis N min » ; le dashboard une pastille, une carte et un
  bouton (voir la section du dashboard plus haut). Le plan agent (MCP) n'expose **aucun** outil de GC.
- **Plan humain** : méthode `workspace.gc` du Control Protocol (`dryRun`,
  `close`, `agent`).

L'état persistant (instant des avertissements, fermeture revendiquée) vit dans
`.striart/idle/state.json`, sous le verrou d'état ; l'inactivité elle-même n'est
jamais stockée, elle se recalcule à chaque balayage.
## Intégration

### `striart promote [--rollback]`

Promotion staging → main du [pipeline à deux étages](branches.md#le-pipeline-staging--main) :
Test Gate global (`promoteTestCommand`) puis fast-forward de `mainBranch`.
Sortie 3 si le gate est rouge (ticket `PROMOTION_GATE_FAILED`) ;
`--rollback` remet alors le staging au niveau de main (destructif, opt-in).
Refus : `PROMOTION_DISABLED` (pas de `mainBranch`), `MAIN_DIVERGED`
(`mainBranch` a des commits hors pipeline, ou a bougé pendant le gate : la mise
à jour est un compare-and-swap sur l'ancien SHA, jamais un `git push .` qui
exécuterait les hooks de la cible sous le verrou), `UNKNOWN_BRANCH` (branche
cible ou `mainBranch` inexistante ou sans commit), `TARGET_BRANCH_MISMATCH`.
Avec `autoPush`, `mainBranch` est livrée à `origin` hors verrou — ou, en
`delivery: 'branch'`, une branche `striart/promote/<date>-<sha8>` est livrée à
la place et `mainBranch` distante n'avance pas.

### `striart mcp [--root <chemin>] [--agent <agent>] [--read-only [--collab]]`

Serveur MCP stdio — le **plan agent → Striart** ; voir
[Serveur MCP](mcp.md). Les logs partent sur stderr : stdout est réservé au
protocole. Pas de `--json` (le protocole est la sortie). Lancé dans un dépôt
**non initialisé**, il refuse de démarrer (`NOT_INITIALIZED`, sortie 1, stdout
vide, piste `striart init`) — plutôt que d'exposer des outils qui échoueraient
un à un. Le serveur est
**borné à son appelant** :

- lancé depuis le clone d'un agent (ou avec `--agent`), il n'agit que sur cet
  agent : son merge, ses tickets ;
- lancé hors de tout clone, il est en **lecture seule**, sauf
  `mcp.scope: 'orchestrator'` dans la config (relâchement journalisé et
  affiché par `doctor`) ;
- `--root <chemin>` désigne le dépôt principal sans dépendre du répertoire de
  travail (prioritaire ; `MCP_ROOT_INVALID` si ce n'est pas un dépôt Striart
  initialisé) ; `--agent` doit nommer un agent enregistré et ne peut pas
  contredire le clone du répertoire courant (`MCP_SCOPE_CONFLICT`) ;
- `--read-only` n'expose aucun outil mutant ; `--collab`, avec `--read-only`
  et un agent borné, y ajoute le seul `striart_collab_post` (c'est ce que
  passent les sessions ACP de Striart à leur agent) ; sans agent borné,
  `--collab` est inerte.

### `striart api --stdio [--framing <f>]` et `striart api --schema [openrpc|json-schema]`

Le **Striart Control Protocol v1** sur stdio : le **plan humain** pour les
extensions d'IDE (VS Code, JetBrains) et tout client JSON-RPC 2.0 local. Seule
l'extension VS Code existe à ce jour (`extensions/vscode/`, livrée mais **non
publiée** : voir [VS Code et Cursor](integrations/vscode-cursor.md#extension-vs-code))
; le plugin JetBrains n'est pas livré.
Zéro surface réseau : l'extension lance la CLI comme sous-process, ce qui
fonctionne tel quel en Remote SSH, devcontainer et Codespaces. stdout est le
protocole (les journaux vont sur stderr). Comme `mcp`, il refuse un dépôt non
initialisé (`NOT_INITIALIZED`, sortie 1). Cadrage au choix du client :
`ndjson` (un message par ligne, défaut) ou `content-length` (style LSP,
celui de `vscode-jsonrpc` et `lsp4j`) ; un message au-delà de 1 Mo est
écarté et signalé sans fermer le flux. Les requêtes d'une connexion
s'exécutent en parallèle (bornées), les réponses portent l'`id` de leur
requête, les éléments d'un lot s'exécutent dans l'ordre. L'`id` d'une
requête est une chaîne, `null` ou un **entier sûr** (`Number.isSafeInteger`) :
un nombre fractionnaire ou hors de la plage des entiers exactement
représentables est refusé (`CONTROL_INVALID_REQUEST`, réponse d'`id`
`null`). `session.log`
rend la **queue** du journal de session (64 000 octets au plus, lue depuis la
fin du fichier, jamais chargé en entier : un journal peut peser des centaines
de Mo), recalée sur une frontière de caractère UTF-8.

Les 29 méthodes (négociation `control.initialize`, `rpc.discover`) couvrent
l'état (`state.get`, `state.subscribe` — état courant puis notifications
`state.changed` et `control.notice`, avec numéro de séquence et révision
monotone, coalescence si le client lit trop lentement —, `ticket.get`,
`session.log`, `doctor.run`, `orchestration.state`), les actions
(`task.run`, `agent.merge`, `agent.sync`, `agent.stop`, `queue.retry`,
`reconcile.run`, `staging.promote`, `merge.rollback`, `ticket.prepare`,
`ticket.apply`, `clones.clean`, `workspace.prune`, `workspace.gc` — le
[GC d'inactivité](#striart-gc-agent---close---dry-run)) et les gestes **réservés
à l'humain** : `ticket.close`, `permission.answer`, `elicitation.answer`,
`review.answer`, `mainSession.release`, `semantic.unlock`. Chaque résultat
est un document de `--json` (`{schemaVersion, command, ok, outcome, data}`) ;
chaque erreur porte le même document dans `error.data`. `--schema openrpc`
imprime la description OpenRPC des méthodes, `--schema json-schema` le
schéma du document `--json` (sans argument : `openrpc`) ; les deux sont
livrés dans `schemas/`. **Refusé dans une session d'agent**
(`CONTROL_NESTED_SESSION`, `STRIART_SESSION=1`) : un agent ne doit pas
arbitrer ses propres permissions ni clore ses tickets — garde *advisory*,
voir [SECURITY.md](../../SECURITY.md). Le transport HTTP du même protocole
est celui du [dashboard](#striart-dashboard---port-p---daemon----status----stop----link).

### `striart acp [--root <chemin>] [--profile <profil>]`

Striart comme **agent ACP v1** pour un éditeur (Zed, JetBrains, Neovim,
Emacs, tout client ACP) : JSON-RPC sur stdin/stdout. **Une session ouverte
par l'éditeur = un clone isolé + l'agent amont choisi + un merge sous Test
Gate.** À la création de la session (`session/new`) rien n'est créé :
l'éditeur reçoit les options (agent amont, politique de permission, fin de
session). Au premier prompt, Striart passe par le Router, crée le clone
(secrets, garde de collision, mode autonome — le watcher ne le merge jamais),
et lance l'agent amont par son propre client ACP, dans un hôte de session
persistant, avec ses fichiers et son terminal **bornés au clone** : ceux de
l'éditeur ne sont **jamais** utilisés ni relayés. Les prompts suivants
arrivent par le bus de l'hôte. L'éditeur voit le déroulé, arbitre les
permissions (politique `ask` par défaut : l'humain tranche *dans* l'éditeur,
fail closed au délai) et reçoit l'issue. La fin de session —
`/striart-finish`, fermeture de la session ou déconnexion selon
`acpAgent.onDisconnect` — applique le contrat de commit, merge sous le Test
Gate (ticket si rouge) et nettoie sans `force` ; `/striart-status` affiche
l'état. Les commandes de l'agent amont (`/status`, `/compact`…) sont relayées
telles quelles : celles de Striart sont préfixées.

- `--root` : toute session doit se trouver dans ce dépôt
  (`ACP_PROXY_CWD_OUTSIDE_ROOT` sinon) ; par défaut, déduit du répertoire de
  la session.
- `--profile` : profil amont proposé par défaut (prioritaire sur
  `acpAgent.defaultProfile`). Les profils proposés sont ceux de
  `agentProfiles` déclarés `acp: true`, restreints par `acpAgent.profiles` ;
  sans aucun : `ACP_PROXY_NO_PROFILE`.
- Réglages : `acpAgent` ([Configuration](configuration.md#acpagent--le-proxy-acp-striart-acp)).
  Refusé dans une session d'agent. Intégration par éditeur :
  [Zed](integrations/zed.md), [JetBrains](integrations/jetbrains.md),
  [Neovim](integrations/neovim.md), [Emacs](integrations/emacs.md).

Une requête mal formée de l'éditeur reçoit une erreur JSON-RPC (`code`,
`message`, et le code Striart stable dans `data.code` — les `ACP_PROXY_*` du
[dépannage](depannage.md)). L'authentification annoncée est `striart-local` :
Striart n'a pas de compte.

### `striart hook install|uninstall <outil> (--user | --agent <agent>) [--dry-run]`

Les **hooks advisory** des outils de coding (Claude Code, Codex, Copilot CLI,
Gemini CLI, Cline). Le sous-mode `striart hook <outil> <événement>` est
appelé *par l'outil* à chaque événement (avant et après un outil d'écriture,
fin de session) : il **informe** — un fichier que s'apprête à écrire l'agent
est prédit par le Router ou verrouillé par un autre agent, une session
supervisée se termine — et ne bloque **jamais** : sortie 0 et réponse neutre
sur toute anomalie (outil inconnu, entrée trop longue, JSON invalide,
registre illisible, hors clone). Pour Claude Code, Codex et Gemini CLI, un
code 2 bloquerait l'action ; Copilot refuserait sur tout code non nul.

- `--user` écrit la configuration **de l'utilisateur** de l'outil
  (`settings.json` du dossier `.claude` de l'utilisateur, `~/.codex/hooks.json`,
  `~/.copilot/hooks/striart.json`, `~/.gemini/settings.json`,
  `~/Documents/Cline/Hooks/`) : le hook sert dans tout projet et reste
  neutre hors d'un clone Striart.
- `--agent <nom>` l'écrit dans le **clone** de l'agent, dans un fichier non
  suivi exclu localement de git — jamais dans un fichier versionné
  (`HOOK_TARGET_TRACKED` : l'agent le commiterait et la garde des chemins
  protégés refuserait le merge). Un fichier qui n'est pas de Striart n'est
  jamais écrasé (`HOOK_TARGET_FOREIGN`), un fichier de configuration
  illisible jamais réécrit (`HOOK_CONFIG_UNREADABLE`).
- `--dry-run` montre les fichiers qui changeraient sans rien écrire. Une
  portée absente ou double : `HOOK_SCOPE_REQUIRED` ; outil inconnu :
  `HOOK_TOOL_UNKNOWN` (usage : sortie 2).
- Les réglages `hooks.collisions` et `hooks.notifySessionEnd`
  ([Configuration](configuration.md#hooks--les-hooks-advisory)) coupent
  chacun des deux avis. Un hook installé pour l'utilisateur ne lit que la
  config **en données** du dépôt (jamais un `striart.config.mjs`) ; installé
  dans un clone, il charge la config complète de la racine choisie à
  l'installation (`--root`), comme une racine listée dans
  `hooks.trustedRoots` de la config *utilisateur* — voir
  [SECURITY.md](../../SECURITY.md).
