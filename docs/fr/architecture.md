# Architecture

> [Documentation](README.md) · Architecture

## Les trois piliers

Quand plusieurs agents IA travaillent en parallèle sur le même repo, ils se
marchent dessus : conflits Git, commits gloutons, merges sémantiquement
cassés. Striart résout ça avec trois piliers :

1. **Isolation physique** — chaque agent travaille dans un vrai clone Git
   indépendant, sans remote (`.striart/agents/<nom>/`).
2. **Router préventif** — avant de lancer un agent, un LLM prédit les fichiers
   touchés et met en file d'attente les tâches en collision.
3. **Fusion sémantique + Test Gate** — les commits des agents sont mergés
   automatiquement ; en cas de conflit, un LLM fusionne le code ; rien n'est
   commité tant que `npm test` (ou votre commande) ne passe pas.

Striart n'est pas un cerveau central opaque : c'est un **pacemaker Git**.
L'humain voit tout, peut interrompre, corriger, valider.

## Pourquoi des clones — et pas des worktrees ?

Isoler les fichiers, c'est 10 % du problème. Un worktree (ou un clone fait à
la main) évite que deux agents écrivent au même endroit *en même temps* — tout
le reste reste à ta charge, à chaque tâche : éviter les collisions *avant*
qu'elles n'arrivent, ramener N branches dans la branche cible, arbitrer les
conflits, garantir que rien de cassé n'entre. Striart automatise précisément
ce reste.

| Besoin | Worktrees à la main | Sous-agents Claude Code (worktrees intégrés) | Striart |
|---|---|---|---|
| Isolation des fichiers | ✅ | ✅ (zéro friction) | ✅ clones complets |
| Solidité face à un agent qui déraille | ⚠️ `.git/` partagé : un `reset --hard` ou un `gc` touche l'état commun | ⚠️ idem | ✅ refs/index propres, pas de remote, secrets exclus — rayon d'explosion borné au clone |
| Prévention des collisions | ❌ à ta charge | ❌ dépend du découpage du modèle | ✅ Router LLM + file d'attente + dépendances `--after` |
| Retour du travail dans la branche cible | ❌ merges manuels | ❌ à la charge de l'agent | ✅ merge auto, rebase de tous les agents après chaque merge, fusion sémantique 3-way |
| Garde-fou de qualité | ❌ | ❌ | ✅ **Test Gate bloquant** — rien n'entre sans suite verte |
| Multi-fournisseurs | ❌ | ❌ Claude uniquement | ✅ Claude + Aider + Codex + Ollama… côte à côte |
| Durée de vie | la session | la session | ✅ des heures/jours, plusieurs sessions, file persistante |
| Observabilité & contrôle | ❌ | limité à la session | ✅ dashboard temps réel, logs persistants, semi-autonome (tu arbitres les permissions), rollback |

**Clones, pas worktrees — un choix de sûreté.** Les worktrees Git partagent
le `.git/` principal : parfait pour un humain discipliné, dangereux pour un
agent non supervisé qui lance ses propres commandes git. Striart donne à
chaque agent un vrai clone — et en neutralise le coût classique : clone par
chemin local, git **hardlinke nativement les objets** (immuables, donc sûrs
même si le principal fait un `gc`), création quasi instantanée, l'historique
ne coûte qu'une fois. L'isolation porte sur tout ce qui est **mutable** :
worktree en vraie copie, refs et index propres.

Sont volontairement **interdits** : les alternates (couplage vivant avec le
`gc` du principal) et les hardlinks/symlinks sur le worktree ou
`node_modules` (corruption par écriture in-place, contamination des caches).

**Emboîtement, pas duel.** Striart est agnostique de l'agent : Claude Code
*est* l'un de ses agents. Le schéma naturel — Striart lui donne un clone
isolé (supervisé, autonome, ou protocolaire via ACP), et *à l'intérieur*,
Claude Code reste libre d'utiliser ses propres worktrees pour ses
sous-agents : les deux mécanismes se composent. Via le serveur MCP, l'agent
peut même piloter Striart au lieu de le contourner. En une phrase :
**worktrees = parallélisme intra-session à friction nulle ; Striart =
orchestration inter-agents avec intégration continue et gate de qualité.**

## Les clones n'ont pas de remote `origin`

L'orchestrateur est le seul à pousser. Les agents travaillent dans des clones
orphelins, sur une branche de tâche `striart/<agent>/task-<uuid>`.
L'orchestrateur fait `git fetch ../agent-a/` puis merge dans le repo
principal. Les secrets **trackés** (`secretPatterns` en config : `.env`,
`*.pem`…) sont retirés du worktree des clones via sparse-checkout ; les
untracked ne sont jamais clonés par git.

## Le layout `.striart/`

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

## La chaîne sérialisée

**Un seul processus orchestre tout** : `striart watch` détecte les commits de
tous les agents (chokidar sur `.git/refs/heads/` de chaque clone — refs
stables uniquement, dédupliquées par SHA) et traite chaque événement dans une
**chaîne sérialisée** (une chaîne de promesses fait office de verrou global et
de file FIFO). Un seul merge à la fois peut toucher le repo principal — toute
la classe de bugs « que se passe-t-il si C merge pendant que B rebase » est
éliminée structurellement, sans verrou explicite.

## Flow d'un commit agent

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

### La fusion sémantique 3-way

Quand Git ne peut pas fusionner automatiquement, Striart extrait les trois
versions de chaque fichier en conflit :

- `git show :1:fichier` → version **BASE** (ancêtre commun) ;
- `git show :2:fichier` → version **OURS** (branche cible) ;
- `git show :3:fichier` → version **THEIRS** (branche agent).

Le Merger envoie les trois au LLM avec un prompt adapté au langage du
fichier, valide la sortie, puis la soumet au Test Gate. La sortie d'un LLM
est du **contenu non fiable** : elle n'entre jamais sans que le gate soit
vert (voir [SECURITY.md](../../SECURITY.md)).

## Les 6 statuts de la synchronisation

| Statut | Quand | Action humaine |
|---|---|---|
| `REBASED` (+ `stashed`) | Rebase propre — stash éventuel restauré | Aucune |
| `UP_TO_DATE` | L'agent n'a aucun commit de retard | Aucune |
| `SKIPPED_DIRTY` (+ `overlap`) | Travail en cours chevauchant les commits entrants, ou `autoStash: false` | Aucune immédiate — webhook envoyé si overlap, résolution au prochain commit |
| `REBASE_CONFLICT` (+ `stashKept`) | Les commits de l'agent conflictent avec la branche cible (la disjonction ne couvre que le non-commité) | Aucune — la fusion sémantique prend le relais au merge |
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

## Verrou inter-processus

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

## Pourquoi la sérialisation rend le stash auto sûr

La vérification de disjonction (fichiers en cours de B vs fichiers touchés
par les commits entrants) n'a de valeur que si la branche cible ne bouge pas
entre le check et le `stash pop` (problème TOCTOU). Comme les merges et les
syncs vivent dans la même chaîne, la branche cible est **gelée** pendant
toute la séquence check → stash → rebase → pop : ce qui a été mesuré reste
vrai jusqu'au bout.

## Règles d'or

1. **Jamais de push depuis un agent.** Les clones sont des îlots sans
   remote ; seul l'orchestrateur pousse.
2. **Jamais de commit sans Test Gate vert.** Même si le LLM de fusion est
   « sûr de lui ».
3. **Jamais de suppression d'un clone pendant qu'un agent travaille.**
   `striart stop` conserve le clone, et `striart clean` refuse à deux
   niveaux, selon ce qu'il sait : `IN_USE` quand le disque du clone a bougé
   récemment (`presenceMinutes`) — une heuristique, que `--force` peut donc
   écraser en connaissance de cause ; `SESSION_LIVE` quand le PID d'une
   session autonome est vivant — un fait vérifié, que **`--force` ne peut pas
   écraser**. Un travail non commité ou non mergé (`PENDING`, `BUSY`) protège
   aussi le clone.
4. **Fallback humain obligatoire.** 3 fusions sémantiques échouées d'affilée
   → mode manuel jusqu'à `striart resolve --unlock`. Chaque échec produit un
   ticket complet dans `.striart/conflicts/` (versions BASE/OURS/THEIRS,
   tentative LLM, log du Test Gate).
