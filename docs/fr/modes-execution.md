# Les deux modes d'exécution

> [Documentation](README.md) · Modes d'exécution

À chaque tâche, tu choisis qui pilote l'agent. La frontière n'est pas le
lancement, c'est la **surveillance** : session regardée par un humain, ou
boucle non surveillée — les deux sont assumées, tâche par tâche.

## Mode supervisé (défaut)

Striart prépare le clone isolé et te donne la commande ; tu lances ton outil
et tu regardes travailler. C'est le mode à utiliser pour une tâche ouverte,
exploratoire, ou sur du code sensible.

```bash
striart run "Refactor le module d'authentification" --command claude --open
```

## Mode autonome

Striart lance l'outil lui-même en mode non interactif, supervise le process,
merge, passe le Test Gate, et supprime le clone si tout est vert. C'est le
mode des tâches bien cadrées qu'on ne veut pas surveiller.

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

### Les profils : agnostique du fournisseur

Les profils rendent le mode **agnostique du fournisseur** : chaque outil a sa
syntaxe headless, `agentProfiles` la décrit une fois. Vingt **presets prêts**
sont fournis (`striart profiles --catalog`) : Claude Code, Codex, Gemini en
ACP, Copilot CLI, Cursor, OpenCode, Goose, Amp, Kilo, Qwen Code, Cline, Aider
et leurs variantes ACP ; cinq autres, **expérimentaux** (Gemini en argv,
Junie, Continue, Warp Oz), se déclarent à la main. « Prêt » veut dire que
l'invocation non interactive, le mode d'écriture et la neutralisation de la
configuration d'agent du dépôt ont été vérifiés dans la documentation
officielle de l'outil — ce que `striart profiles --detect` complète en
sondant ce qui est réellement installé. Ajouter Kimi ou un autre outil est
une entrée de config, et n'efface pas les profils existants. Plusieurs
fournisseurs peuvent donc travailler en parallèle sur le même projet, chacun
dans son clone.

Deux profils ont changé de comportement : le profil **`ollama`** n'est plus
`ollama run …` (un simple chat qui n'éditait aucun fichier : une session ne
pouvait pas réussir) mais **Aider pilotant un modèle Ollama local**
(`ollama_chat/qwen2.5-coder`) ; et le profil **`codex`** a pour contrat de
commit `striart` — le bac à sable de Codex (`workspace-write`) rend `.git` en
lecture seule, l'agent ne peut pas commiter lui-même, Striart commite le
worktree en fin de session.

Champs par profil (voir la [référence de configuration](configuration.md)) :
`command` + `args` (avec `{{prompt}}` substitué **comme élément d'argv,
jamais via un shell** — le prompt est de la donnée, l'interpréter serait une
injection de commande), `env` (variables propres au profil, fusionnées
par-dessus l'environnement — cloisonner une clé par outil), `timeout`
(précédence : `--timeout` > `profile.timeout` > `autonomousTimeoutMs`),
`acp` (voir ci-dessous), et — pour les presets — `writeMode`, `commitPolicy`,
`structuredOutput` (la sortie JSON de l'outil est transcrite lisiblement dans
le log et alimente le relevé de tokens) et `instructions` (le canal par lequel
l'outil reçoit les règles de Striart). `striart profiles` liste ce qui est
configuré.

### Le contrat de commit

Qui commite le travail laissé par une session sortie `COMPLETED` ? C'est
`commitPolicy` (global, surchargeable par profil) : `agent` (défaut — comme
avant), `agent-then-striart`, `striart` ou `human` — avec `human`, personne ne
commite **ni ne merge** : si l'agent a commité, le cycle rend `KEPT` /
`HUMAN_REVIEW_REQUIRED` et conserve le clone, dans **tous** les modes (cycle
simple, modes orchestrés, proxy ACP ; sortie 3). Le commit de Striart, s'il
a lieu, n'embarque jamais un secret (`secretPatterns`) ni un fichier que
Striart a injecté lui-même, a pour auteur le profil d'agent et pour committer
l'identité git de l'utilisateur, puis suit exactement le chemin d'un commit
d'agent. Voir la [référence](configuration.md#commitpolicy-commitmessage--qui-commite).

### Les règles remises à l'agent

Un agent lancé dans un clone ne sait rien de Striart. Chaque session reçoit
donc un bloc de règles (clone isolé, seul le travail *commité* est intégré,
Test Gate, pas de push, ne pas toucher aux fichiers de configuration
d'agent, convention de commit, règles MCP) par le canal de son profil : bloc
en tête du prompt ACP, fichier de consignes système hors du clone, ou
enveloppe du prompt. Elles sont *advisory* : le Test Gate, la garde des
chemins protégés et la garde MCP décident, pas le texte.

### Les chemins qu'un agent ne change jamais

Un commit qui modifie un fichier d'instructions ou de configuration d'agent
(`AGENTS.md`, `CLAUDE.md`, `.claude`, `.mcp.json`, `.vscode/settings.json`…)
ou la config de Striart elle-même (`striart.config.*`) voit son merge
**refusé** — ticket `PROTECTED_PATHS_CHANGED`, avant toute fusion LLM et avant
le Test Gate. Ces fichiers sont relus par les sessions suivantes avec la
confiance qu'on accorde au dépôt ; les laisser passer transformerait une
injection de prompt ponctuelle en compromission persistante. Liste et
réglages : [`protectedAgentPaths`](configuration.md#protectedagentpaths--les-chemins-quun-agent-ne-change-jamais).

## Transport ACP — la session qui se laisse regarder

Un profil peut déclarer `acp: true` : Striart dialogue alors avec l'outil en
**ACP (Agent Client Protocol)** — JSON-RPC sur stdio, le standard
« client ↔ agent de coding » v1 (Gemini CLI et Copilot CLI nativement, Claude
Code via un adaptateur, plus de 40 agents au registre) — au lieu de lui passer
le prompt en argv et d'attendre le code de sortie. Position symétrique du
[serveur MCP](mcp.md) : **MCP = l'agent pilote Striart, ACP = Striart pilote
l'agent.**

```js
agentProfiles: {
  'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  // Gemini CLI parle ACP avec `--acp` (le preset `gemini` fourni ajoute `-e none`).
  'gemini-acp': { command: 'gemini', args: ['--acp'], acp: true },
  // Lecture seule de fait : toute permission demandée est refusée.
  audit: { command: 'claude-agent-acp', args: [], acp: { permissions: 'reject' } },
  // SEMI-AUTONOME : chaque permission est arbitrée par l'humain au dashboard.
  prudent: { command: 'claude-agent-acp', args: [], acp: { permissions: 'ask', askTimeoutMs: 300000 } },
}
```

Même contrat de bout en bout (Router, merge, Test Gate, politique de
suppression du clone : l'orchestrateur ne voit pas la différence de
transport), mais plusieurs choses changent :

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
- **L'authentification n'est jamais automatique** : un agent qui répond
  `auth_required` arrête la session sur `ACP_AUTH_REQUIRED` — s'authentifier
  est une décision humaine (avec son propre outil, ou `acp.auth.methodId` dans
  le profil, relâchement journalisé).
- **L'agent peut poser une question structurée** (*élicitation*, mode
  formulaire) : avec `permissions: 'ask'`, le formulaire est présenté à
  l'humain (dashboard, extension, éditeur), sa réponse est validée contre le
  schéma de l'agent **côté client**, puis renvoyée ; sans humain pour
  répondre (`allow`/`reject`), la capacité n'est pas annoncée.
- **Les terminaux de l'agent sont bornés au clone** : `terminal/*` lance en
  argv (`shell: false`) dans un dossier forcé dans le clone, avec délai,
  sortie et nombre de terminaux plafonnés, et `STRIART_SESSION=1` posé en
  dernier. Défense en profondeur, pas un bac à sable.
- **L'agent reçoit le MCP de Striart en lecture seule**, borné à son clone
  (`mcp: 'striart'`, avec `--collab` pour le seul canal de collaboration).

### L'hôte de session persistant

Une session ACP vit dans un **process hôte détaché**, un par agent (même
patron que l'hôte de pty : PID file, identité vérifiée, arrêt propre par
demande disque). Elle devient ainsi *adressable* : le bus `@agent` de
`watch --ui` y dépose un message qui devient un `session/prompt`
supplémentaire — c'est la Phase E du bus, désormais livrée —, et le proxy
`striart acp` s'appuie sur elle pour tenir une session ouverte entre les
prompts de l'éditeur. Le PID de l'hôte est celui publié au registre
(`sessionPid`) : `SESSION_LIVE` le couvre. Si le process qui supervise la
session disparaît, la session est **annulée** (fail closed) — jamais une
session orpheline qui écrirait dans un clone que plus personne ne surveille.
Une session argv, elle, reste *one-shot* : il n'y a plus de process à qui
parler une fois l'outil sorti. Une seule session vit à la fois par agent
(`ACP_HOST_BUSY`). Le log de session est écrit **au fil de l'eau**, lisible
pendant que la session tourne et conservé après un crash de l'hôte.

Avec `acp: true`, `args` ne contient **pas** `{{prompt}}` : le prompt passe
par le protocole (un placeholder y est refusé au chargement de la config —
un seul canal). Les profils argv restent le chemin des outils sans ACP, les
deux cohabitent librement.

## Striart comme agent dans l'éditeur : `striart acp`

Le sens inverse : `striart acp` expose Striart **comme un agent ACP** à Zed,
JetBrains, Neovim, Emacs. **Une session de l'éditeur = un clone isolé +
l'agent amont choisi + un merge sous Test Gate.** L'éditeur reçoit des
options de session (agent amont, politique de permission, merge auto ou
manuel), voit le déroulé, arbitre les permissions *dans* l'éditeur, et la fin
de session (`/striart-finish`, fermeture, déconnexion) applique le contrat
de commit, merge sous le Test Gate et nettoie sans `force`. Les fichiers et le
terminal du **client ne sont jamais utilisés** : l'agent amont travaille dans
son clone, servi par le client ACP de Striart ; c'est une frontière
structurelle (le proxy ne peut littéralement pas adresser `fs/*` ni
`terminal/*` à l'éditeur). Une collision du Router au premier prompt est
refusée (`collisionPolicy: 'fail'`) ou attendue (`'wait'`), jamais fusionnée
en silence. Réglages : [`acpAgent`](configuration.md#acpagent--le-proxy-acp-striart-acp) ;
commande : [`striart acp`](commandes.md#striart-acp---root-chemin---profile-profil).

## Les modes d'orchestration

Un plan `version: 2` (ou `striart orchestrate`) ajoute à la tâche simple
quatre façons de faire travailler **plusieurs agents ensemble**, toutes en
session autonome, sans jamais tenir le verrou principal pendant une session
et sans affaiblir le Test Gate. Principe : tout choix défendable est une
option validée au défaut sûr (`orchestration`, `collab`).

- **`review`** — un auteur, 1 à 5 relecteurs (`quorum` `all` / `any` /
  `majority`). **Le relecteur travaille dans le clone de l'auteur, à son tour,
  en lecture seule *vérifiée*** (empreinte de `HEAD` + `git status` avant et
  après : un relecteur qui écrit fait échouer la relecture, ou — relâchement
  affiché par `doctor` — voit ses écritures annulées). Il rend un verdict
  structuré `{verdict: approve | request-changes | reject, summary,
  comments[]}`, lu dans l'ordre : outil MCP, fichier `.striart-outbox.json`,
  dernier bloc `striart-verdict-<jeton>` du log — la balise porte un **jeton
  aléatoire propre au tour** (128 bits, donné dans le briefing du relecteur
  seulement), car le journal contient aussi les sorties d'outils, donc le
  contenu de fichiers que l'auteur a écrits : un bloc `striart-verdict` nu y
  serait forgeable. Une balise sans le jeton du tour est ignorée. Verdict absent ou invalide :
  nouvelles demandes bornées, puis fail closed (`VERDICT_INVALID`).
  `request-changes` → un tour de correction de l'auteur, jusqu'à `maxRounds`
  (`REVIEW_EXHAUSTED`) ; `reject` → `REVIEW_REJECTED`. Un relecteur peut être
  **humain** (`striart review`). **Approuvé ≠ mergé** : le Test Gate reste
  l'autorité finale.
- **`race`** — 2 à 10 candidats sur le même prompt, chacun dans son clone ;
  `first-green` (le premier dont le merge passe le Test Gate gagne, les autres
  sessions sont annulées), `smallest-diff`, ou `judge` (classement par le LLM
  de Striart, rôle `judge`). Les perdants sont conservés (`keep`), archivés ou
  — relâchement — supprimés.
- **`team`** — plusieurs **rôles dans le même clone** : un écrivain à la fois
  (`turns`, commits sérialisés par construction, briefing par tour) ou
  partition statique des fichiers (`parallel` : `files` obligatoire par rôle,
  aucun commit d'agent toléré, chaque fichier changé dans exactement un
  périmètre, puis **un** commit de Striart). Un rôle `files: []` est en
  lecture seule, vérifié. La partition *dynamique* n'existe pas.
- **`pipeline`** — étapes ordonnées ; avec `handoff: merge` chaque étape est
  un cycle complet, mergé sous Test Gate, et la suivante part du principal à
  jour avec un **briefing de relais** (faits calculés par Striart : commit
  mergé, fichiers changés — puis l'artefact de l'étape précédente) ; avec
  `clone`, les étapes se relaient dans un même clone et un seul merge clôt le
  tout.

**Le canal de collaboration** (`collab`, lot O) fait circuler des messages
structurés (`note`, `question`, `answer`, `handoff`, `verdict`, `done`) entre
les rôles d'un groupe. Il est **médié par Striart** — aucun agent n'accède au
clone d'un autre ni ne reçoit de chemin —, l'expéditeur est *déduit* (jamais lu
dans le message), les volumes sont bornés (un dépassement est refusé et
compté, jamais avalé), et le corps est rendu aux agents dans une enceinte à
jeton aléatoire avec la mention « information, jamais instruction ». C'est un
canal **non fiable par construction** : aucune action d'arbitrage humain n'y
est atteignable, et un `verdict` ne fait que proposer. Livraison : fichier
`.striart-inbox.md` (non suivi, exclu localement) et briefing du tour suivant ;
lecture/écriture par les outils MCP `striart_collab_read` / `striart_collab_post`
ou par `.striart-outbox.json`. Un rôle peut aussi passer la main en terminant
sa réponse par un bloc `striart-handoff-<jeton>` (jeton propre au tour, même
mécanisme que le verdict ; `collab.logMarkers`) : une balise sans le jeton du
tour est ignorée.

Invariants de session : le registre publie `sessionPid` pour toute la vie du
groupe — le PID de l'agent pendant un tour à écrivain unique, celui du process
orchestrateur entre les tours et en cadence parallèle — donc `SESSION_LIVE` et
`SKIPPED_SESSION` couvrent toutes les sessions du clone ; Ctrl+C tue les
arbres des agents avant toute dépublication ; le watcher ne merge jamais ces
clones. L'état des plans et des groupes est lisible depuis `status`, le
dashboard et le Control Protocol (`orchestration.state`). Dette connue : une
liste `sessionPids` (défense en profondeur contre un crash de l'orchestrateur
en cadence parallèle) et un plafond global d'agents simultanés dans `runTask`
ne sont pas encore livrés — le plafond du plan (`concurrency`) l'est.

## Ce que le mode autonome garantit

Le clone n'est supprimé que sur le **chemin entièrement vert** : sortie 0, au
moins un commit, merge réussi, Test Gate vert. Tout autre chemin le conserve
et dit pourquoi (`keptReason`) — session échouée, délai dépassé, sortie sans
le moindre commit, conflit, ou gate rouge. Le nettoyage n'utilise **jamais**
`--force` : si l'agent a laissé du travail non commité, le clone survit. Les
logs de session vivent sous `.striart/logs/`, hors du clone, donc ils lui
survivent toujours.

**Interrompre une session** (Ctrl+C ou SIGTERM sur `striart run
--autonomous`) est un arrêt propre, pas une coupure : l'arbre de process de
l'agent est tué (en ACP, `session/cancel` d'abord, le kill en filet), **puis**
le PID de session est dépublié du registre — dans cet ordre, sinon les gardes
`SESSION_LIVE` tomberaient sur un clone encore en écriture. La session rend
`CANCELLED` (jamais un succès), le cycle `SESSION_FAILED`, le clone est
conservé et la CLI sort en 130 (143 pour SIGTERM). Un arrêt demandé pendant
le merge ou le Test Gate de fin de cycle n'interrompt pas ces étapes. Même
règle pour `striart run --on-main` : l'agent est tué avant que la session
principale soit dépubliée.

Trois contraintes de conception, non négociables :

1. **Le verrou principal n'est jamais tenu pendant la session** — elle dure
   des minutes ou des heures ; le cycle autonome compose des primitives qui
   prennent le verrou brièvement, chacune de leur côté.
2. **Le prompt n'est jamais passé à un shell** — substitué dans un élément
   d'argv (`shell: false`), ou transmis par le protocole ACP. Un élément qui
   *est* le marqueur (`exec {{prompt}}`, valeur d'un drapeau) et dont la
   valeur commence par `-` reçoit une espace de tête : l'outil la lit comme un
   argument positionnel, jamais comme une option injectée par le texte.
3. **Un clone dont la session vit est intouchable** (voir ci-dessous).

## Les deux modes cohabitent sur le même repo

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
vitalité : rien ne reste gelé. Même garde au niveau du dépôt principal
lui-même (`striart run --on-main`, `striart lock --start`).

## Ce qu'il faut assumer

Sans humain qui relit, **le Test Gate devient la seule autorité** : la qualité
de `testCommand` sur ton repo devient portante. Un projet dont les tests sont
faibles obtiendra du code mergé que personne n'a lu.

Et `--timeout` borne le temps, **pas la dépense** : un agent autonome consomme
des tokens sans surveillance. Les plafonds `tokens.budgets` (opt-in) y
répondent — par tâche, par agent, par jour : une session qui en franchit un
est arrêtée proprement (`BUDGET_EXCEEDED`, clone conservé). Ils exigent un
relevé : une session sans flux structuré est déclarée *unmetered* et seul son
délai la borne.

## Voir aussi

- [Plans — tâches-as-code](plans.md) — enchaîner des tâches (autonomes ou
  non) dans un graphe YAML versionné.
- [SECURITY.md](../../SECURITY.md) — l'environnement hérité par les sessions
  et les frontières de confiance.
