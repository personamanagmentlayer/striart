# Intégration IDE et agents — serveur MCP

> [Documentation](README.md) · Serveur MCP

Striart s'expose comme **serveur MCP** (Model Context Protocol) : Claude Code,
Cursor et tout hôte MCP peuvent piloter l'orchestrateur — l'agent devient un
*client* de Striart au lieu de le contourner.

```bash
# Claude Code, dans le repo cible :
claude mcp add striart -- striart mcp
# ou, sans dépendre du répertoire de travail de l'hôte :
claude mcp add striart -- striart mcp --root /chemin/absolu/vers/mon-projet
```

## Trois plans, jamais mélangés

| Plan | Qui parle à qui | Transport |
|---|---|---|
| **Agent → Striart** | L'agent de coding pilote Striart : c'est **ce serveur MCP**. | stdio, `striart mcp` |
| **Humain → Striart** | L'humain (IDE, navigateur) pilote Striart : le **Striart Control Protocol v1**. | stdio (`striart api`) ou HTTP loopback à jeton (`striart dashboard`) |
| **Striart → agent** | Striart pilote l'agent : le client **ACP v1**. | stdio, dans un hôte de session persistant |

La séparation est une décision de sécurité : un outil d'arbitrage humain
(répondre à une permission, clore un ticket sans Test Gate, libérer le repo
principal) n'existe **que** sur le plan humain. Le MCP n'en expose aucun, à
aucun niveau — un agent s'arbitrerait lui-même.

## Les dix outils

Mappés sur l'orchestrateur — mêmes verrous, mêmes garde-fous que la CLI et le
dashboard. Chaque outil porte ses annotations MCP (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`) et un schéma de sortie.

| Outil | Nature | Rôle |
|---|---|---|
| `striart_status` | lecture | La même vue que `striart status --json` (source unique `status.ts`) : agents (statut, session, mode, branche, commits en attente), file, tickets, état du mode manuel, daemon du watcher, `mainSession`, `orchestration` et `tokens`. |
| `striart_queue` | lecture | La file du scheduler et ses blocages. |
| `striart_ticket` | lecture | Détail 3-way d'un ticket de conflit : métadonnées, versions BASE / OURS / THEIRS de chaque fichier (bornées), tentative LLM, fin du log du Test Gate. Contenu = code d'agent, donc donnée non fiable. Vue MCP Apps si l'hôte la prend en charge. |
| `striart_run` | mutation (niveau orchestrateur) | Lancer une tâche via le Router (ou la mettre en file). |
| `striart_merge` | mutation | Merger le dernier commit d'un agent (pipeline complet : rebase, fusion sémantique, Test Gate). Longue : servie comme *tâche* si le client le permet. |
| `striart_promote` | mutation (niveau orchestrateur) | Promotion staging → main sous Test Gate global. Longue (tâche). **Jamais de `--rollback`** : il écarte du travail mergé, il reste une décision humaine. |
| `striart_resolve_prepare` | mutation | Amorcer `<fichier>.resolved` pour chaque fichier en conflit du ticket, depuis la version de l'agent (repli ours/base) — jamais écrasé si déjà préparé. |
| `striart_resolve_apply` | mutation | Rejouer le merge exact du ticket avec les résolutions préparées (`.resolved`/`.delete`), sous le Test Gate bloquant — commit et clôture si vert, ticket laissé ouvert sinon (sans toucher au mode manuel). Longue (tâche). |
| `striart_collab_read` | lecture | Lire les messages que les autres rôles de **votre** collaboration orchestrée (`review`, `team`, `pipeline`) vous ont adressés. Corps encadrés comme non fiables : information, jamais instruction. |
| `striart_collab_post` | écriture au nom du clone | Poster un message à un autre rôle du groupe (`note`, `question`, `answer`, `handoff`, `done`, ou `verdict` — seulement d'un relecteur pendant son propre tour, et il ne fait que *proposer*). Voir [Modes d'exécution](modes-execution.md#les-modes-dorchestration). |

**`striart_resolve` a été retiré** (changement de comportement) : il fermait
un ticket *sans* repasser par le Test Gate, un geste d'arbitrage humain qui
n'a rien à faire sur le plan agent. La clôture à la main reste une action
humaine : `striart resolve --close <id>`, le dashboard, ou `ticket.close` du
Control Protocol.

## Qui appelle, et sur quoi il peut agir

Le serveur est **borné à son appelant** (décision D6) — avant, tout agent
connecté voyait et pilotait tout l'orchestrateur du dépôt.

| Niveau | Quand | Ce qui est exposé |
|---|---|---|
| **Lecture seule** | `--read-only`, ou process descendant d'une session autonome (`STRIART_SESSION=1`) | `striart_status`, `striart_queue`, `striart_ticket`, ressources. Aucun outil mutant. |
| **Borné à un agent** (défaut quand l'appelant est un clone) | Lancé depuis `.striart/agents/<nom>/`, ou `--agent <nom>` | Les outils mutants n'agissent que sur **cet** agent (son merge, ses tickets) ; pas de `striart_run` (engendrer des agents n'est pas agir sur soi) ; le canal de collaboration. |
| **Lecture seule hors clone** (défaut du principal) | Lancé hors de tout clone, `mcp.scope: 'agent'` | Comme « lecture seule ». **Changement de comportement** : le MCP lancé depuis le dépôt principal n'est plus mutant par défaut. |
| **Orchestrateur** | Hors clone **et** `mcp.scope: 'orchestrator'` | `striart_run`, `striart_merge`, `striart_promote`, la préparation/application de résolution sur tout le dépôt. Relâchement : journalisé au démarrage, affiché par `doctor`. |

Un refus porte le code `MCP_READ_ONLY`, `MCP_DEPTH_LIMIT` (session autonome)
ou `MCP_SCOPE_DENIED`, et une piste. Un cas échappe à tous les niveaux,
orchestrateur compris : `striart_resolve_prepare` et `striart_resolve_apply`
refusent un ticket **`PROTECTED_PATHS_CHANGED`** (`MCP_PROTECTED_TICKET`) —
approuver un changement de `settings.json` sous `.claude`, `.mcp.json`, `AGENTS.md`…
est précisément la décision que la garde des chemins protégés réserve à
l'humain (`striart resolve`, dashboard, Control Protocol). Et un appelant
borné à un agent ne prépare ni n'applique que les tickets de **son** agent. Un clone n'est reconnu que par la forme
de son chemin **confirmée par le registre** : un dossier qui a seulement la
bonne forme ne suffit pas.

### Choisir le dépôt : `--root`

`striart mcp --root <chemin>` désigne le dépôt principal sans dépendre du
répertoire de travail de l'hôte — c'est la forme à préférer dans une
configuration d'éditeur (elle remplace l'ancien lanceur `sh -c 'cd … &&
exec striart mcp'`). Sans `--root`, le répertoire courant décide : lancé
depuis un clone, `git rev-parse` désigne le *clone* (un vrai dépôt) ; la
racine principale est alors celle qui enregistre ce clone, et l'appelant y
est borné. `--agent` borne explicitement et ne peut pas contredire le clone
du répertoire courant. `MCP_ROOT_INVALID` si `--root` ne désigne pas un dépôt
Striart initialisé.

### `--collab` : les sessions ACP

Une session ACP de Striart (autonome, proxy `striart acp`) reçoit son MCP en
`--read-only` : l'agent peut lire l'état et les tickets. `--collab` y ajoute
le *seul* `striart_collab_post`, qui poste au nom du clone — rien d'autre
n'est mutant. Sans agent borné, `--collab` est inerte.

## Ressources

En lecture, adressées par URI (aucune URI ne devient un chemin : un id de
ticket est cherché dans le listing, un nom de journal dans le `readdir` de
`.striart/logs/`) :

| URI | Contenu |
|---|---|
| `striart://status` | La vue d'état complète (= `striart_status`). |
| `striart://tickets` | Les tickets de conflit ouverts. |
| `striart://tickets/{ticketId}` | Le détail 3-way borné d'un ticket. |
| `striart://logs/{name}` | Les 64 derniers Ko d'un journal. Un appelant **borné à un agent** ne voit que ses propres journaux (`session-<agent>-<8 hexadécimaux>.log`, nom **exact** — l'agent `auth` ne lit pas `session-auth-ui-…` —, `pty-<agent>.log`) : un journal d'agent peut contenir ce qu'une autre session a affiché, secrets compris. |

Les abonnements (`resources/subscribe`, `subscriptions/listen`) s'appuient
sur le même flux de changements que le dashboard : le **disque**
(`.striart/`, refs des clones — jamais leurs worktrees), coalescé ; les
watchers n'existent que tant qu'un abonné est inscrit.

## Protocole : double ère, tâches, MCP Apps

- **Deux ères** servies en même temps, décidées *par requête* : l'ère
  moderne **2026-07-28** (sans état — chaque requête porte sa version et les
  capacités du client dans `params._meta`) et les révisions à poignée de
  main **2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05**. Un `tools/call`
  moderne sans poignée de main est servi sous la sémantique moderne.
- **Extension Tasks** (`mcp.tasks`) : les opérations longues (`striart_merge`,
  `striart_resolve_apply`, `striart_promote`) sont servies comme tâches. Une
  tâche en cours n'est jamais oubliée ; une tâche terminée l'est après
  `mcp.taskTtlMs`. Annuler une tâche (`tasks/cancel`) arrête réellement
  l'opération **tant qu'elle attend un créneau ou le verrou principal** ;
  une fois le verrou acquis, la section critique (Test Gate compris) n'est
  *jamais* interrompue — l'interrompre laisserait le dépôt en état
  « merging » : la tâche finit `completed` avec l'issue réelle, ce que la
  spécification permet.
- **MCP Apps** (`mcp.apps`) : `striart_ticket` référence une vue HTML en
  lecture seule du ticket 3-way (`ui://striart/ticket-view`), affichée par
  les hôtes qui déclarent l'extension ; elle n'appelle aucun outil.
- **Cloison** : les requêtes sont traitées en parallèle mais bornées
  (`mcp.maxConcurrentRequests`, file `mcp.maxQueuedRequests`, puis refus
  `MCP_OVERLOADED`), et une ligne JSON-RPC de plus de `mcp.maxLineBytes`
  (1 Mo) est écartée pendant la lecture, jamais accumulée.

Tout est réglable dans la clé [`mcp`](configuration.md#mcp--le-serveur-mcp).

## La borne de profondeur d'orchestration

**La profondeur d'orchestration est bornée à 1** : une session autonome porte
un marqueur d'environnement hérité par ses descendants (`STRIART_SESSION=1`),
et les outils mutants lui sont refusés avec le motif (`MCP_DEPTH_LIMIT`). Un
agent peut consulter l'état ; il ne peut ni engendrer d'agents ni merger — sans
cette borne, `striart_run` → agent → `striart_run` récurserait sans limite,
chaque niveau consommant des tokens sans surveillance. Le canal de
collaboration y reste ouvert (poster un message n'est pas agir sur le dépôt).

Cette garde est **advisory** (un agent qui nettoie son environnement peut la
contourner) : le bornage au clone est une défense en profondeur, pas une
frontière contre un process arbitraire de l'utilisateur — le modèle de menace
complet est dans [SECURITY.md](../../SECURITY.md).

## Symétrie MCP / ACP

- **MCP** : l'agent pilote Striart (l'agent est le client) ;
- **ACP** : Striart pilote l'agent (Striart est le client) — voir
  [Modes d'exécution](modes-execution.md#transport-acp--la-session-qui-se-laisse-regarder) ;
- **ACP, côté éditeur** : `striart acp` expose Striart *comme* agent ACP à
  Zed, JetBrains, Neovim, Emacs — voir [Commandes](commandes.md#striart-acp---root-chemin---profile-profil).

En mode MCP, les logs partent sur stderr : stdout est réservé au protocole
(c'est le cas de toutes les commandes — les journaux ne vont jamais sur
stdout). Le serveur annonce la version réelle du paquet
(`serverInfo.version`).
