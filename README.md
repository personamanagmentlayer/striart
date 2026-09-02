<h1 align="center">
  <img src="assets/logo_striart.png" alt="Striart" width="420">
</h1>

<p align="center">
  <strong>Orchestrateur Git multi-agents</strong> pour Claude Code, Aider, Cursor et tout autre agent de coding IA.<br>
  Isolation physique · Routing préventif · Fusion sémantique · Test Gate bloquant
</p>

<p align="center">
  <img alt="version 0.10.0" src="https://img.shields.io/badge/version-0.10.0-6e56cf">
  <img alt="Node.js ≥ 22.18" src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933?logo=node.js&logoColor=white">
  <img alt="422 tests" src="https://img.shields.io/badge/tests-422%20%E2%9C%94-2da44e">
  <img alt="zéro build" src="https://img.shields.io/badge/build-aucun-8250df">
  <img alt="licence MIT" src="https://img.shields.io/badge/licence-MIT-blue">
</p>

<p align="center">
  <a href="#pourquoi-striart--et-pas-simplement-des-worktrees-">Pourquoi Striart</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#guide--3-agents-en-parallèle-sans-conflit">Guide</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#commandes">Commandes</a> ·
  <a href="#les-deux-modes-dexécution">Modes d'exécution</a> ·
  <a href="#configuration-striartconfigmjs-striartrcjson-">Configuration</a> ·
  <a href="#règles-dor">Règles d'or</a>
</p>

<p align="center"><em>🇬🇧 <a href="README.en.md">English version</a> — the French README is the reference.</em></p>

Quand plusieurs agents IA travaillent en parallèle sur le même repo, ils se marchent dessus :
conflits Git, commits gloutons, merges sémantiquement cassés. Striart résout ça avec trois piliers :

1. **Isolation physique** — chaque agent travaille dans un vrai clone Git indépendant, sans remote (`.striart/agents/<nom>/`).
2. **Router préventif** — avant de lancer un agent, un LLM prédit les fichiers touchés et met en file d'attente les tâches en collision.
3. **Fusion sémantique + Test Gate** — les commits des agents sont mergés automatiquement ; en cas de conflit, un LLM fusionne le code ; rien n'est commité tant que `npm test` (ou votre commande) ne passe pas.

Striart n'est pas un cerveau central opaque : c'est un **pacemaker Git**. L'humain voit tout, peut interrompre, corriger, valider.

---

## Pourquoi Striart — et pas simplement des worktrees ?

Isoler les fichiers, c'est 10 % du problème. Un worktree (ou un clone fait à
la main) évite que deux agents écrivent au même endroit *en même temps* — tout
le reste reste à ta charge, à chaque tâche : éviter les collisions *avant*
qu'elles n'arrivent, ramener N branches dans `main`, arbitrer les conflits,
garantir que rien de cassé n'entre. Striart automatise précisément ce reste.

| Besoin | Worktrees à la main | Sous-agents Claude Code (worktrees intégrés) | Striart |
|---|---|---|---|
| Isolation des fichiers | ✅ | ✅ (zéro friction) | ✅ clones complets |
| Solidité face à un agent qui déraille | ⚠️ `.git/` partagé : un `reset --hard` ou un `gc` touche l'état commun | ⚠️ idem | ✅ refs/index propres, pas de remote, secrets exclus — rayon d'explosion borné au clone |
| Prévention des collisions | ❌ à ta charge | ❌ dépend du découpage du modèle | ✅ Router LLM + file d'attente + dépendances `--after` |
| Retour du travail dans `main` | ❌ merges manuels | ❌ à la charge de l'agent | ✅ merge auto, rebase de tous les agents après chaque merge, fusion sémantique 3-way |
| Garde-fou de qualité | ❌ | ❌ | ✅ **Test Gate bloquant** — rien n'entre sans suite verte |
| Multi-fournisseurs | ❌ | ❌ Claude uniquement | ✅ Claude + Aider + Codex + Ollama… côte à côte |
| Durée de vie | la session | la session | ✅ des heures/jours, plusieurs sessions, file persistante |
| Observabilité & contrôle | ❌ | limité à la session | ✅ dashboard temps réel, logs persistants, semi-autonome (tu arbitres les permissions), rollback |

**Clones, pas worktrees — un choix de sûreté.** Les worktrees Git partagent
le `.git/` principal : parfait pour un humain discipliné, dangereux pour un
agent non supervisé qui lance ses propres commandes git. Striart donne à
chaque agent un vrai clone — et en neutralise le coût classique : clone par
chemin local, git **hardlinke nativement les objets** (immuables, donc sûrs),
création quasi instantanée, l'historique ne coûte qu'une fois.

**Emboîtement, pas duel.** Striart est agnostique de l'agent : Claude Code
*est* l'un de ses agents. Le schéma naturel — Striart lui donne un clone
isolé (supervisé, autonome, ou protocolaire via ACP), et *à l'intérieur*,
Claude Code reste libre d'utiliser ses propres worktrees pour ses
sous-agents : les deux mécanismes se composent. Via le serveur MCP, l'agent
peut même piloter Striart au lieu de le contourner. En une phrase :
**worktrees = parallélisme intra-session à friction nulle ; Striart =
orchestration inter-agents avec intégration continue et gate de qualité.**

---

## Installation

Depuis les sources :

```bash
git clone https://github.com/personamanagmentlayer/striart.git
cd striart && npm install && npm link   # expose la commande `striart`
cd /chemin/vers/mon-projet
striart init
```

Sans `npm link`, tout s'appelle aussi directement : `node /chemin/vers/striart/src/cli.js init`.

Il n'y a **rien à compiler** : `bin` pointe sur la source (ESM). Les modules
TypeScript sont exécutés tels quels par le type stripping natif de Node, les
`.js` annotés JSDoc cohabitent, et l'ensemble est vérifié par `tsc` — sans
étape de build.

Prérequis : Node.js 22.18+ (type stripping natif), Git, et un LLM pour le Router/Merger — Ollama en local (défaut) **ou** n'importe quelle API cloud (voir Configuration).

---

## Guide : 3 agents en parallèle sans conflit

```bash
cd mon-projet
striart init                          # crée .striart/, la config, vérifie le LLM

# Onglet 1 — l'orchestrateur
striart watch                         # merge + Test Gate + rebase automatiques

# Lancer 3 agents (le Router vérifie les collisions avant chaque lancement)
striart run "Refactor le module d'authentification" --command "claude" --open
striart run "Ajoute la facturation Stripe" --agent billing --command "aider --model gpt-4o" --open
striart run "Nouveau composant de login" --command "claude" --open
# sans --agent, le nom est dérivé du prompt (ex: refactor-le-module-d-aut)

# ...et pour une tâche cadrée qu'on ne veut pas surveiller, Striart pilote seul :
striart run "Ajoute des tests unitaires à src/parser.js" --autonomous --profile claude
```

`--open` ouvre directement un onglet terminal dans le clone de l'agent (Windows Terminal, Terminal.app, gnome-terminal) et y lance l'outil. Chaque session est indépendante : elle reste ouverte jusqu'à ce que **vous** la fermiez.

Ensuite, tout est automatique :

- Chaque commit d'un agent est détecté par `striart watch`, mergé dans `main`, validé par le **Test Gate** — s'il échoue, le merge est annulé et un ticket est créé.
- En cas de conflit textuel, la **fusion sémantique** (LLM) tente une résolution, revalidée par le Test Gate. Si le gate rejette la fusion, le Merger **réessaie avec le log d'erreur en feedback** (`semanticGateRetries`) avant le ticket humain. Après 3 échecs d'affilée : mode manuel (règle de sécurité).
- Les conflits **hors de portée du LLM** (fichier supprimé d'un côté et modifié de l'autre, renommage concurrent, binaire, lockfile, fichier trop volumineux, submodule, symlink, bit exécutable divergent) ne partent jamais en fusion : ticket humain direct avec la nature du conflit.
- Le **double-renommage invisible** (git rate les deux renommages, le merge est "propre" mais le fichier ressort en double) est traqué par une heuristique de contenu : avertissement `⚠️` au merge + webhook, non bloquant.
- Avec `memoryLayer: true`, chaque merge alimente une **mémoire sémantique partagée** (`.striart-memory.md` dans chaque clone) : les agents savent quelles API les autres viennent d'ajouter ou modifier — la parade au conflit *sémantique* qui n'a pas de conflit Git. Le fichier porte aussi une section **temps réel « travaux en cours »** : les autres tâches (actives et en file) et leurs fichiers prédits par le Router — chacun voit qui travaille où, sans coût LLM.
- Au lancement d'une tâche, les **liens sémantiques** sont signalés (jamais bloquants) : fichiers qui s'importent mutuellement — graphe des imports relatifs **JS/TS, Python, Ruby, PHP** — et packages liés d'un monorepo **npm/yarn, Cargo, Go (go.work), Maven**.
- Après chaque merge réussi, les autres agents sont **rebasés** sur le code le plus récent.
- Si le Router avait mis une tâche en attente, elle démarre dès que l'agent bloquant est arrêté (`striart stop`).

Suivi en temps réel :

```bash
striart status          # agents, mode (auto/supervisé), branches, outils, commits en attente
striart queue           # scheduler : RUNNING / WAITING + blocages
striart dashboard       # http://localhost:3456 — vue web temps réel
striart resolve         # tickets de conflit en attente de résolution humaine
```

---

## Architecture

```text
mon-projet/
├── .striart/                  # généré par striart init, gitignoré
│   ├── agents/
│   │   ├── auth/             # vrai clone Git indépendant, sans remote
│   │   └── billing/          # branche striart/<agent>/task-<uuid>
│   ├── agents.json           # registre : branche, outil, prédictions, base de merge
│   ├── queue.json            # tâches en attente (collisions du Router)
│   ├── locks.json            # verrous optimistes (fichier → agent)
│   ├── state.json            # compteur d'échecs sémantiques / mode manuel
│   ├── main.lock             # verrou inter-processus (transitoire)
│   ├── conflicts/<ticket>/   # base/ours/theirs + llm-attempt + test-output.log
│   └── logs/
└── striart.config.mjs
```

**Un seul processus orchestre tout** : `striart watch` détecte les commits de
tous les agents et traite chaque événement dans une **chaîne sérialisée**
(une chaîne de promesses fait office de verrou global et de file FIFO).
Un seul merge à la fois peut toucher le repo principal — toute la classe de
bugs « que se passe-t-il si C merge pendant que B rebase » est éliminée
structurellement, sans verrou explicite.

### Flow d'un commit agent

```text
Commit détecté sur l'agent A (chokidar sur .git/refs/heads/)
  → filtres : awaitWriteFinish (ref stable) + déduplication par SHA
  → enfilé dans la chaîne sérialisée
┌─────────────────────────────────────────────────────────────────────┐
│  ÉTAPE 0 : rebase préalable de A sur targetBranch (autoRebase)      │
│    worktree occupé → stash -u → rebase → stash pop, UNIQUEMENT si   │
│    les fichiers en cours sont disjoints des commits entrants        │
│    (vérifié par diff, pas supposé) ; sinon rebase reporté           │
│    conflit de rebase → annulé, le merge classique prend le relais   │
│                                                                     │
│  ÉTAPE 1 : git merge FETCH_HEAD --no-commit --no-ff                 │
│    ├─ propre  → continue                                            │
│    └─ conflit → fusion sémantique (LLM, 3 versions BASE/OURS/THEIRS)│
│        échec LLM → abort + ticket humain → FIN                      │
│        (3 échecs d'affilée → mode manuel jusqu'à resolve --unlock)  │
│                                                                     │
│  ÉTAPE 2 : Test Gate (testCommand, timeout testTimeoutMs)           │
│    ├─ vert  → continue                                              │
│    └─ rouge → merge --abort + ticket humain → FIN                   │
│                                                                     │
│  ÉTAPE 3 : commit de merge (+ push origin si autoPush)              │
│                                                                     │
│  ÉTAPE 4 : syncAllAgents (sauf A)                                   │
│    chaque agent B, C... est rebasé immédiatement sur le nouveau     │
│    main — B code toujours contre le code le plus récent             │
│    (mêmes garde-fous stash/disjonction qu'à l'étape 0)              │
└─────────────────────────────────────────────────────────────────────┘
  → maillon suivant de la chaîne (commit arrivé pendant le traitement)
```

En parallèle, un **fetch silencieux** périodique (`fetchIntervalMs`, 20 s)
mesure le retard de chaque agent sans jamais toucher leur working tree —
pure visibilité (logs, dashboard) ; la resynchronisation effective se fait
aux étapes 0 et 4.

### Les 6 statuts de la synchronisation

| Statut | Quand | Action humaine |
|---|---|---|
| `REBASED` (+ `stashed`) | Rebase propre — stash éventuel restauré | Aucune |
| `UP_TO_DATE` | L'agent n'a aucun commit de retard | Aucune |
| `SKIPPED_DIRTY` (+ `overlap`) | Travail en cours chevauchant les commits entrants, ou `autoStash: false` | Aucune immédiate — webhook envoyé si overlap, résolution au prochain commit |
| `REBASE_CONFLICT` (+ `stashKept`) | Les commits de l'agent conflictent avec main (la disjonction ne couvre que le non-commité) | Aucune — la fusion sémantique prend le relais au merge |
| `STASH_CONFLICT` | Stash pop en conflit (théoriquement impossible, disjonction vérifiée) | Intervention — travail en sécurité dans le stash du clone |
| `SKIPPED_SESSION` (+ `pid`) | Une session autonome tourne dans le clone — il est intouchable tant que son PID vit | Aucune — le rebase est **ajourné**, pas annulé : la fin de cycle rebase de toute façon |

Les cinq premiers sont rendus par `syncAgentWithMain`. `SKIPPED_SESSION` est
décidé un cran au-dessus, par `syncAllAgents` : le clone est écarté **avant**
qu'on tente quoi que ce soit dessus. Les garde-fous habituels (worktree sale,
fichiers qui se recoupent) supposent un humain capable de voir ses fichiers
bouger et de réagir ; une session autonome n'a personne pour réagir, et elle
lance ses propres commandes git. Un PID resté au registre après un crash est
neutralisé par le contrôle de vitalité — un clone ne se gèle donc jamais
définitivement.

Le check de disjonction est volontairement conservateur : les renommages
comptent pour leurs **deux** chemins (ancien et nouveau, `--no-renames` côté
commits entrants, chemins `from` inclus côté worktree) — au pire un rebase
reporté inutilement, jamais un faux « safe ».

### Verrou inter-processus

La chaîne sérialisée protège *dans* le processus `watch`. Entre processus
(un `striart merge` manuel pendant que `watch` tourne, deux CLI…), toute
opération mutante (`run`, `merge`, `sync`, `stop`, `promote`, retry de la
file) passe par un **verrou fichier** `.striart/main.lock` créé en mode
exclusif `wx` — l'atomicité est garantie par le noyau de l'OS. Le verrou
est réentrant dans un même processus, attend son tour par polling (timeout
2 min), **casse automatiquement les verrous orphelins** (processus détenteur
mort, ou TTL de 30 min dépassé — parade à la réutilisation de PID), et à
chaque acquisition, un éventuel merge abandonné par un crash précédent
(`MERGE_HEAD` orphelin) est annulé proprement.

### Pourquoi la sérialisation rend le stash auto sûr

La vérification de disjonction (fichiers en cours de B vs fichiers touchés
par les commits entrants) n'a de valeur que si `main` ne bouge pas entre le
check et le `stash pop` (problème TOCTOU). Comme les merges et les syncs
vivent dans la même chaîne, `main` est **gelé** pendant toute la séquence
check → stash → rebase → pop : ce qui a été mesuré reste vrai jusqu'au bout.

---

## Commandes

| Commande | Rôle |
|---|---|
| `striart init` | Initialise `.striart/`, la config, diagnostique le LLM. |
| `striart start <agent> [--command <cmd>] [--open]` | Clone isolé + branche de tâche, sans Router. |
| `striart start <agent> --reuse [--force]` | **Réutilise** le clone conservé d'un agent arrêté : resync sur le main courant, nouvelle branche, untracked conservés (node_modules — repartir chaud). Refuse une archive sale (`REUSE_DIRTY`), non mergée (`REUSE_UNMERGED`) ou récemment active (`REUSE_IN_USE`) ; `--force` assume la perte. `striart run --reuse` passe par le Router en plus. |
| `striart run "<prompt>" [--agent <a>] [--command] [--open]` | Router préventif : prédit les fichiers, lance ou met en attente (nom d'agent dérivé du prompt si absent). `--prompt <p>` est l'équivalent scriptable du positionnel. |
| `striart run "<prompt>" --autonomous [--profile <p>] [--timeout <ms>]` | **Mode autonome** : Striart lance l'agent lui-même, supervise, merge, passe le Test Gate et supprime le clone si tout est vert. |
| `striart run "<prompt>" --after <tâche\|agent>` | **Dépendance déclarée** : la tâche attend en file la fin (merge + stop) du travail référencé, puis part automatiquement. Réf inconnue ou cycle → refus au lancement. |
| `striart plan <fichier.yaml> [--dry-run]` | **Tâches-as-code** : applique un plan YAML (graphe de tâches + dépendances) versionné dans le repo. `--dry-run` valide et affiche sans rien lancer. |
| `striart profiles [--json]` | Liste les profils d'agents configurés (outil, clés d'env, timeout) — les IA disponibles pour `--profile` et les plans. |
| `striart watch [--no-merge]` | Surveille les commits, merge + Test Gate + rebase en continu. |
| `striart merge <agent>` | Merge manuel du dernier commit d'un agent. |
| `striart sync [agent]` | Rebase un agent (ou tous) sur la branche cible. |
| `striart status [--json]` | État des agents : statut, session active, **mode** (🤖 autonome + profil / 👤 supervisé), branche, outil, taille du clone, commits en attente. |
| `striart queue [--retry]` | Tableau de bord des tâches ; `--retry` relance les débloquées. |
| `striart stop <agent> [--force]` | Termine un agent (le clone reste sur disque), débloque la file. |
| `striart rollback` | Défait le dernier merge Striart : reset local (récupérable via reflog), ou revert si le merge est déjà poussé. |
| `striart doctor [--json]` | Diagnostic complet : git, repo, config, LLM joignable, verrous, tickets — "pourquoi ça ne marche pas ?". |
| `striart watch --daemon [--status\|--stop]` | Watcher en arrière-plan : PID + logs dans `.striart/`, détection de daemon orphelin. |
| `striart history [--limit <n>] [--json]` | Historique des merges et rollbacks Striart, reconstruit depuis le graphe Git. |
| `striart promote [--rollback]` | Promotion staging → main : Test Gate global puis fast-forward de `mainBranch`. |
| `striart resolve [--unlock\|--close <id>\|--all]` | Tickets de conflit ; `--close` marque résolu, `--unlock` réactive la fusion sémantique. |
| `striart clean [agent] [--stopped\|--all [--force]]` | Libère le disque : agents arrêtés par défaut ; `--all` inclut les actifs **sans travail en attente** ; `--force` abandonne aussi le non-mergé. |
| `striart reconcile` | **Réconciliation** (level-triggered) : neutralise les sessions mortes au registre, débloque la file (même quand aucun commit ne l'a déclenché — ex. `clean` d'un bloqueur), répare verrous et merges orphelins. Idempotent. Rejoué automatiquement par `striart watch`. |
| `striart prune [--days <n>] [--dry-run]` | Rétention : élague les clones arrêtés inactifs et les tickets résolus depuis N jours (config `pruneDays`, 14). |
| `striart dashboard [--port <p>]` | Dashboard web local (127.0.0.1 uniquement), **temps réel** (SSE — poussé à chaque changement, sans polling) : état des agents et de leur mode, bandeau d'état du watcher, logs de session, pilotage (merge, stop, relance, rollback, clôture de ticket). |
| `striart mcp` | Serveur MCP stdio : expose l'orchestrateur aux hôtes MCP (Claude Code, Cursor…) — 5 outils, mêmes verrous et garde-fous que le CLI (voir la section dédiée). |

---

## Les deux modes d'exécution

À chaque tâche, tu choisis qui pilote l'agent.

**Mode supervisé** (défaut). Striart prépare le clone isolé et te donne la
commande ; tu lances ton outil et tu regardes travailler. C'est le mode à
utiliser pour une tâche ouverte, exploratoire, ou sur du code sensible.

```bash
striart run "Refactor le module d'authentification" --command claude --open
```

**Mode autonome.** Striart lance l'outil lui-même en mode non interactif,
supervise le process, merge, passe le Test Gate, et supprime le clone si tout
est vert. C'est le mode des tâches bien cadrées qu'on ne veut pas surveiller.

```bash
striart run "Ajoute des tests unitaires à src/parser.js" --autonomous --profile claude
striart run "Traduis les messages d'erreur en anglais" --autonomous --profile codex --timeout 600000
```

Deux prérequis, faciles à oublier : l'outil doit être **installé et déjà
authentifié** dans le shell d'où tu lances Striart — la session hérite de son
environnement, elle n'ouvre aucune fenêtre de login et ne peut répondre à
aucune invite. Et son profil doit être **réellement non interactif** : une
commande qui attend une confirmation restera bloquée jusqu'au `--timeout`.
Quand la session échoue, le clone est conservé et le log complet reste dans
`.striart/logs/session-<agent>-<taskId>.log`.

Les profils rendent le mode **agnostique du fournisseur** : chaque outil a sa
syntaxe headless, `agentProfiles` la décrit une fois. Claude, Codex, Aider et
Ollama sont fournis ; ajouter Kimi ou un autre outil est une entrée de config,
et n'efface pas les profils existants. Plusieurs fournisseurs peuvent donc
travailler en parallèle sur le même projet, chacun dans son clone.

### Transport ACP — la session qui se laisse regarder

Un profil peut déclarer `acp: true` : Striart dialogue alors avec l'outil en
**ACP (Agent Client Protocol)** — JSON-RPC sur stdio, le standard
« client ↔ agent de coding » v1 (Gemini CLI et Copilot CLI nativement, Claude
Code via l'adaptateur officiel, 25+ agents) — au lieu de lui passer le prompt
en argv et d'attendre le code de sortie. Position symétrique du serveur MCP :
**MCP = l'agent pilote Striart, ACP = Striart pilote l'agent.**

```js
agentProfiles: {
  'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  'gemini-acp': { command: 'gemini', args: ['--experimental-acp'], acp: true },
  // Lecture seule de fait : toute permission demandée est refusée.
  audit: { command: 'claude-agent-acp', args: [], acp: { permissions: 'reject' } },
  // SEMI-AUTONOME : chaque permission est arbitrée par l'humain au dashboard.
  prudent: { command: 'claude-agent-acp', args: [], acp: { permissions: 'ask', askTimeoutMs: 300000 } },
}
```

Même contrat de bout en bout (Router, merge, Test Gate, politique de
suppression du clone : l'orchestrateur ne voit pas la différence de
transport), mais quatre choses changent :

- **La session cesse d'être opaque** : messages, plan et appels d'outils sont
  transcrits en continu dans le log de session — il raconte le déroulé, pas
  seulement la fin.
- **Les invites deviennent des messages** : une demande de permission est
  répondue par la politique du profil (`allow` par défaut — le niveau de
  confiance des profils headless, tous en `--yes` ; ou `reject`), et tracée
  au log. Plus de session bloquée sur une confirmation jusqu'au timeout.
- **Ou arbitrée par toi** (`permissions: 'ask'`) — le mode **semi-autonome** :
  chaque demande apparaît en tête du dashboard avec un bouton par option
  proposée par l'agent ; sans réponse sous `askTimeoutMs` (défaut 120 s),
  **fail closed** — le refus s'applique, jamais un accord par défaut. La
  décision et son origine (humain ou délai) sont tracées au log de session.
- **Le filesystem passe par un point de contrôle** : les lectures/écritures
  que l'agent délègue à Striart sont **bornées au clone** — chemin hors du
  clone, refus.
- **L'arrêt est propre** : au timeout, `session/cancel` d'abord (l'agent peut
  finaliser), kill d'arbre en filet.

Avec `acp: true`, `args` ne contient **pas** `{{prompt}}` : le prompt passe
par le protocole (un placeholder y est refusé au chargement de la config —
un seul canal). Les profils argv restent le chemin des outils sans ACP, les
deux cohabitent librement.

### Ce que le mode autonome garantit

Le clone n'est supprimé que sur le **chemin entièrement vert** : sortie 0, au
moins un commit, merge réussi, Test Gate vert. Tout autre chemin le conserve et
dit pourquoi — session échouée, délai dépassé, sortie sans le moindre commit,
conflit, ou gate rouge. Le nettoyage n'utilise **jamais** `--force` : si l'agent
a laissé du travail non commité, le clone survit. Les logs de session vivent
sous `.striart/logs/`, hors du clone, donc ils lui survivent toujours.

### Les deux modes cohabitent sur le même repo

Rien n'oblige à choisir globalement : un agent autonome et un agent supervisé
peuvent travailler côte à côte. C'est le **PID de session**, publié au registre
le temps qu'elle vit, qui rend l'état vérifiable plutôt que supposé :

- **`striart watch` ne merge pas les agents autonomes.** Leur merge appartient à
  leur fin de cycle. Sans ce filtre, le watcher mergeait leurs commits
  *intermédiaires* et entrait en course avec le merge final — repo principal
  bloqué en état « merging » quand la course était perdue.
- **`striart sync` saute leur clone** (`SKIPPED_SESSION`) : on ne se dispute pas
  l'index avec une session qui lance ses propres commandes git. Le rebase est
  ajourné, pas annulé.
- **`striart clean` refuse de le supprimer, même avec `--force`**
  (`SESSION_LIVE`) : `--force` sert à passer outre une heuristique, pas un fait.

Un PID resté au registre après un crash est neutralisé par le contrôle de
vitalité : rien ne reste gelé.

### Ce qu'il faut assumer

Sans humain qui relit, **le Test Gate devient la seule autorité** : la qualité
de `testCommand` sur ton repo devient portante. Un projet dont les tests sont
faibles obtiendra du code mergé que personne n'a lu.

Et `--timeout` borne le temps, **pas la dépense** : un agent autonome consomme
des tokens sans surveillance.

---

## Tâches-as-code — plans versionnés

Au lieu de retaper une séquence de `striart run`, décris un **graphe de
tâches** dans un fichier YAML committé avec le code — inspiré de Bruno (les
collections d'API en fichiers texte co-localisés au repo) : on le diffe, on le
revoit en PR, on le rejoue.

```yaml
# refonte-auth.yaml
version: 1
tasks:
  - id: schema
    prompt: |
      Ajoute une colonne jwt_version à la table users.
  - id: auth
    prompt: Fais passer l'authentification aux JWT.
    after: schema          # dépendance SÉMANTIQUE (aucune collision ne la déduirait)
  - id: tests
    prompt: Ajoute des tests pour le flux JWT.
    after: auth
    autonomous: true       # Striart pilote l'outil
    profile: claude
```

```bash
striart plan refonte-auth.yaml --dry-run   # valide et affiche, ne lance rien
striart plan refonte-auth.yaml             # applique
```

`apply` **équivaut exactement** à la séquence de `striart run` décrite, les
`id` de plan résolus en noms d'agents pour les `after` : aucune sémantique
nouvelle, ça compose la file, `--after` et `reconcile`. Deux garde-fous de
conception :

- **Un plan est de la donnée, jamais du code** — pas de fichier exécutable :
  un plan circule (commit, PR, partage), l'exécuter serait la faille de la
  config-as-code. Le prompt reste de la donnée, une tâche autonome référence
  un **profil** (défini par l'admin en config), pas une commande shell brute.
- **`after` ne peut désigner qu'une tâche définie plus haut** dans le fichier —
  règle simple qui rend le graphe acyclique par construction. La validation
  complète tombe **avant** toute application : un plan invalide n'applique
  aucune tâche.

Exemple complet et commenté : [`examples/plan.example.yaml`](examples/plan.example.yaml).

---

## Intégration IDE et agents — serveur MCP

Striart s'expose comme **serveur MCP** (Model Context Protocol) : Claude Code,
Cursor et tout hôte MCP peuvent piloter l'orchestrateur — l'agent devient un
*client* de Striart au lieu de le contourner.

```bash
# Claude Code, dans le repo cible :
claude mcp add striart -- striart mcp
```

Cinq outils, mappés directement sur l'orchestrateur (mêmes verrous, mêmes
garde-fous que le CLI et le dashboard) : `striart_status`, `striart_queue`
(lecture), `striart_run`, `striart_merge`, `striart_resolve` (mutation).

**La profondeur d'orchestration est bornée à 1** : une session autonome porte
un marqueur d'environnement hérité par ses descendants, et les outils mutants
lui sont refusés avec le motif. Un agent peut consulter l'état ; il ne peut ni
engendrer d'agents ni merger — sans cette borne, `striart_run` → agent →
`striart_run` récurserait sans limite, chaque niveau consommant des tokens
sans surveillance.

En mode MCP, les logs partent sur stderr : stdout est réservé au protocole.

---

## Configuration (`striart.config.mjs`, `.striartrc.json`, …)

Tout a un défaut raisonnable — la config minimale tient en trois lignes :

```js
export default {
  testCommand: 'npm test',   // la commande du Test Gate — le seul réglage vraiment portant
  targetBranch: 'main',      // branche où merger
};
```

<details>
<summary><strong>Référence complète commentée</strong> — toutes les options et leurs défauts (cliquer pour déplier)</summary>

```js
export default {
  testCommand: 'npm test',        // Test Gate : 'yarn test', 'make test', 'pytest'...
  targetBranch: 'main',           // branche où merger/pousser
  // Pipeline staging → main (optionnel) : les agents mergent dans targetBranch
  // (ex: 'striart/staging') et `striart promote` fait avancer mainBranch en
  // fast-forward après un Test Gate global — main n'est jamais dans un état
  // intermédiaire, même une milliseconde.
  mainBranch: null,               // ex: 'main' (null = promotion désactivée)
  promoteTestCommand: null,       // gate global d'intégration (null → testCommand)
  autoPush: false,                // true → push origin après chaque merge vert
  autoRebase: true,               // rebase des agents sur main avant merge
  autoStash: true,                // stash auto pendant le rebase si le travail en cours
                                  // est disjoint des commits entrants (vérifié)
  semanticMerge: true,            // fusion des conflits par LLM
  semanticGateRetries: 1,         // retentatives du Merger avec le log du gate en feedback
  secretPatterns: ['.env', '.env.*', '*.pem', '*.key', 'credentials.json'],
                                  // secrets TRACKÉS retirés du worktree des clones ([] = off)
  memoryLayer: false,             // mémoire sémantique partagée entre agents (résumé LLM par merge)
  memoryMaxEntries: 30,           // taille max de .striart/memory.md (entrées les plus récentes)
  presenceMinutes: 10,            // un clone dont le disque a bougé depuis moins de N minutes
                                  // est réputé occupé : striart clean le saute (règle d'or n°3)
  agentCommand: null,             // outil affiché après start/run — null → 'claude' en exemple
                                  // (surchargeable par agent via --command)

  // Mode autonome : comment lancer chaque outil SANS interaction humaine.
  // {{prompt}} est substitué comme élément d'argv (jamais via un shell).
  // Déclarer un profil AJOUTE un fournisseur, sans effacer ceux d'origine.
  // `striart profiles` liste les profils configurés (outil, env, timeout).
  agentProfiles: {
    claude: { command: 'claude', args: ['-p', '{{prompt}}'] },
    codex:  { command: 'codex',  args: ['exec', '{{prompt}}'] },
    aider:  { command: 'aider',  args: ['--yes', '--message', '{{prompt}}'] },
    ollama: { command: 'ollama', args: ['run', 'qwen2.5-coder', '{{prompt}}'] },
    // Champs optionnels par profil — pour un vrai multi-IA :
    //   env     : variables PROPRES à ce profil, fusionnées par-dessus
    //             l'environnement (cloisonner une clé par outil, fixer MODEL…).
    //             Depuis un .mjs, référence un secret sans l'inliner :
    //             env: { OPENAI_API_KEY: process.env.MON_OPENAI }
    //   timeout : délai max de session (ms) — précédence :
    //             --timeout > profile.timeout > autonomousTimeoutMs
    //   acp     : transport ACP (Agent Client Protocol) — Striart dialogue
    //             avec l'outil en JSON-RPC stdio au lieu de l'argv. `true` ou
    //             { permissions: 'allow' | 'reject' | 'ask', askTimeoutMs? }.
    //             'ask' = SEMI-AUTONOME : chaque permission est arbitrée par
    //             l'humain au dashboard, fail closed au délai (défaut 120 s).
    //             Avec acp, args ne contient PAS {{prompt}} (le prompt passe
    //             par le protocole).
    // codex: { command: 'codex', args: ['exec', '{{prompt}}'],
    //          env: { OPENAI_API_KEY: process.env.MON_OPENAI }, timeout: 1800000 },
    // 'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  },
  autonomousTimeoutMs: 1800000,   // délai max d'une session autonome (kill de l'arbre au-delà)
  webhookUrl: null,               // canal unique historique (type deviné par l'URL)
  // Table multi-canaux — s'ajoute à webhookUrl. Le type est explicite
  // (slack → {text}, discord → {content}, generic → {message}) ; l'URL vient
  // de `url` ou de `urlEnv` (nom d'une variable d'env — préférable, une URL
  // de webhook est un secret), jamais des deux.
  notifiers: [],                  // ex: [{ type: 'slack', urlEnv: 'SLACK_WEBHOOK_URL' }]
  dashboardPort: 3456,
  testTimeoutMs: 600000,          // délai max du Test Gate (kill de l'arbre de process au-delà)
  fetchIntervalMs: 20000,         // fetch silencieux du watch (0 = désactivé)
  cloneFilter: null,              // 'blob:none' : clone partiel pour les très gros historiques
  pruneDays: 14,                  // rétention de striart prune (clones arrêtés, tickets résolus)

  // LLM du Router/Merger — Ollama local par défaut :
  ollamaModel: 'llama3.1:8b',
  ollamaHost: 'http://localhost:11434',
  // Prompts du Router/Merger surchargeables intégralement (null → défaut) —
  // ex: les réécrire en anglais pour un modèle local plus fiable en anglais.
  // Placeholders OBLIGATOIRES (validés au chargement) : router {{task}}+{{files}} ;
  // merger {{file}}+{{base}}+{{ours}}+{{theirs}}+{{feedback}} (retry post-gate).
  prompts: { router: null, merger: null },
  // ...ou n'importe quel provider :
  // llm: { provider: 'openai', model: 'gpt-4o-mini' },                       // clé via OPENAI_API_KEY
  // llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },      // clé via ANTHROPIC_API_KEY
  // llm: { provider: 'azure', model: '<deployment>', baseUrl: 'https://<ressource>.openai.azure.com' },
  // llm: { provider: 'openai', model: 'x', baseUrl: 'http://localhost:1234/v1' }, // LM Studio, vLLM, llama.cpp...
};
```

</details>

**Tous les providers du marché sont supportés** — nativement (`ollama`,
`openai`, `anthropic`, `azure`) ou via leur endpoint compatible OpenAI :
Gemini, Mistral, Groq, DeepSeek, xAI, Together, Fireworks, OpenRouter,
Perplexity, Cohere, et en on-premise LM Studio, vLLM, llama.cpp, TGI.
AWS Bedrock et Google Vertex (auth SigV4/OAuth) passent par un proxy LiteLLM.
Le **[.env.example](.env.example)** documente la config exacte de chacun.

Les clés API ne sont **jamais** dans la config : uniquement le nom d'une variable d'environnement (`apiKeyEnv`), chargée depuis le shell ou un `.env`.

---

## Projets volumineux

L'isolation par vrais clones se paie en disque — voici comment la maîtriser :

- **L'historique est déjà quasi gratuit** : le clone se fait par chemin local,
  git hardlinke `.git/objects` (objets immuables → sûr même si le principal
  fait un `gc`). Seul le worktree est une vraie copie — c'est le prix de
  l'isolation, incompressible sans risque.
- **Très gros historiques** : `cloneFilter: 'blob:none'` en config — les blobs
  anciens sont récupérés à la demande depuis le repo principal (conservé en
  remote fetch-only, push neutralisé).
- **`node_modules`** : utilisez **pnpm** dans le projet cible (store global
  partagé par hardlinks, géré par un outil conçu pour). Ne partagez jamais
  `node_modules` par symlink entre agents : les caches d'outillage
  (`node_modules/.cache`, Vite, webpack) y écrivent en permanence.
- **Suivi et nettoyage** : `striart status` et le dashboard affichent la
  taille additionnelle de chaque clone (les hardlinks comptent 0) ;
  `striart clean` supprime les clones des agents arrêtés, et
  `striart prune` applique une rétention (clones arrêtés inactifs et tickets
  résolus depuis `pruneDays` jours — `--dry-run` pour prévisualiser).
  Un `striart prune` périodique (cron/tâche planifiée) garde `.striart/` sain.

---

## Règles d'or

1. **Jamais de push depuis un agent.** Les clones sont des îlots sans remote ; seul l'orchestrateur pousse.
2. **Jamais de commit sans Test Gate vert.** Même si le LLM de fusion est « sûr de lui ».
3. **Jamais de suppression d'un clone pendant qu'un agent travaille.** `striart stop` conserve le clone, et `striart clean` refuse à deux niveaux, selon ce qu'il sait : `IN_USE` quand le disque du clone a bougé récemment (`presenceMinutes`) — une heuristique, que `--force` peut donc écraser en connaissance de cause ; `SESSION_LIVE` quand le PID d'une session autonome est vivant — un fait vérifié, que **`--force` ne peut pas écraser**. Un travail non commité ou non mergé (`PENDING`, `BUSY`) protège aussi le clone.
4. **Fallback humain obligatoire.** 3 fusions sémantiques échouées d'affilée → mode manuel jusqu'à `striart resolve --unlock`. Chaque échec produit un ticket complet dans `.striart/conflicts/` (versions BASE/OURS/THEIRS, tentative LLM, log du Test Gate).

---

## Développement

**422 tests** (244 unitaires + 178 d'intégration sur de vrais repos Git),
typecheck `tsc` sur tout le code (TS natif + JS annoté JSDoc), zéro étape de
build — `bin` pointe sur la source.

```bash
npm install
npm run test:unit        # 244 tests, ~20 s — la boucle de dev
npm run test:integration # 178 tests, ~7 min — vrais repos Git temporaires
npm test                 # les deux
npm run lint             # ESLint (correctness) + Prettier --check
npm run test:ci          # typecheck + tout + coverage
```

Voir [CONTRIBUTING.md](CONTRIBUTING.md) et [SECURITY.md](SECURITY.md).

Licence MIT.
