# Dépannage

> [Documentation](README.md) · Dépannage

## Premier réflexe : `striart doctor`

```bash
striart doctor                              # tableau des constats + actions à mener
striart doctor --json | jq ".data.summary"  # scriptable : nombre de ok/warn/fail/skip
```

Le doctor fait 29 contrôles : la version de git, le **composant natif**
(binaire `striart-native`, signature, clés de confiance), le **conteneur du
Test Gate**, l'**hôte de terminal (pty)**, le dépôt
et son premier commit, l'initialisation, que la config charge et valide, la
**branche cible** (absente → erreur ; branche courante différente → « merge et
watch refuseront »), que le LLM répond (ping Ollama, ou présence de la clé API
du provider cloud), le **réseau** (politique hors ligne / liste blanche, proxy
actif ou inactif, CA et TLS), les secrets historiques, le **verrou principal** et le
**verrou d'état**, la session principale, les agents, les tickets ouverts, le
mode manuel, les **chemins protégés**, le **serveur MCP**, les **profils
d'agents**, les **tokens et coûts**, l'**orchestration**, le **dashboard**
(hôtes admis), les **données locales** (`.striart/` réservé à
l'utilisateur), l'**environnement du Test Gate** (variables demandées par le
dépôt et non autorisées), le **GC d'inactivité** (politique, autorisation de
fermer), la **livraison** (`delivery`, délais du push et du commit de merge), la
**performance** (latence du verrou d'état, `git status` du principal, taille de
`.striart/`, âge du plus vieux verrou tenu — un constat de lenteur est un
avertissement, jamais une erreur) et une synthèse des **protections relâchées**
par la config.
Chaque constat sépare le **fait** de l'**action** (commande exacte à lancer).
« Opérationnel » n'est annoncé qu'en l'absence de tout avertissement ;
sortie 1 dès qu'un prérequis manque. `striart init` enchaîne ce même
diagnostic après l'initialisation.

## Codes de sortie

| Code | Nature | Que faire |
|---|---|---|
| `0` | Succès, ou ajournement voulu (tâche en file, rebase reporté) | Rien. |
| `1` | Échec d'exécution ou d'environnement | Lire le message et la piste ; relancer peut suffire. |
| `2` | Usage invalide (option, valeur, combinaison) | `striart <commande> --help`. |
| `3` | Refus : une garde a protégé du travail | Décision humaine : lire le code d'erreur ci-dessous. |
| `130` / `143` | Interrompu (Ctrl+C / SIGTERM) | Voir « Interrompre une commande ». |

## Les codes d'erreur

Toute erreur Striart porte un `code` stable (affiché par la CLI sous le
message, renvoyé tel quel en `--json`, par le MCP, le dashboard et le
Control Protocol) et, le plus souvent, une **piste** : la prochaine commande à
lancer. En `--json`, l'erreur est un document sur stdout (`ok: false`,
`error.code`, `error.kind`, `error.hint`, `error.details`). Quand un même code
couvre plusieurs causes, `error.details.reason` les distingue par un
sous-code stable (liste dans [Commandes](commandes.md#sortie-machine----json)) ;
les `*_CORRUPT` portent `details.cause`. Tous les codes sont listés ci-dessous,
par nature.

**Refus (sortie 3)** — une garde protège du travail, relancer telle quelle ne
changera rien :

| Code | Signification | Issue |
|---|---|---|
| `TARGET_BRANCH_MISMATCH` | Le repo principal n'est pas sur `targetBranch` — y compris quand `HEAD` pointe une autre branche **sans commit** (levé par `merge`, `resolve --apply`, `rollback` et `promote`). | `git switch <targetBranch>`, ou ajuster la config — voir [Branches](branches.md#la-contrainte--le-repo-principal-doit-être-sur-targetbranch). |
| `MAIN_DIRTY` | Le repo principal a des modifications non commitées. | Commit ou stash, puis relancer. |
| `UNTRACKED_COLLISION` | Des fichiers untracked du principal seraient écrasés par le merge. | Les commiter, déplacer ou supprimer. |
| `SESSION_LIVE` | Le clone héberge une session vivante (PID autonome vérifié, hôte de session ACP, ou terminal `--open` pour `clean`). | Attendre la fin de session — ni `stop`, ni `clean`, ni `--force` ne passeront (`striart stop` arrête un terminal `--open`). |
| `MAIN_SESSION_LIVE` | Le **repo principal** est réservé — agent lancé via `--on-main` ou intervention via `striart lock --start`. | Attendre (`striart lock` affiche raison/PID/durée), ou `striart lock --stop` si elle est terminée sans avoir nettoyé. |
| `AGENT_HAS_PENDING` | `stop` : commits non mergés, ou clone illisible par git (travail inconnu, présumé existant). | `striart merge <agent>`, ou `--force` pour abandonner. |
| `REUSE_DIRTY` / `REUSE_UNMERGED` / `REUSE_IN_USE` | L'archive à réutiliser a du travail non commité / non mergé / une activité récente. | Inspecter le clone ; `--reuse --force` assume la perte. |
| `HISTORICAL_SECRETS_FOUND` | Un chemin correspondant à `secretPatterns` a un jour existé dans l'historique du repo (lisible via `git show <sha>:<fichier>` même absent aujourd'hui). | Vérifier/révoquer le secret, puis `--allow-historical-secrets` (`start`, `run`, `run --autonomous`), ou `secretPatterns: []` pour désactiver le contrôle. |
| `AGENT_EXISTS` / `AGENT_QUEUED` | L'agent est déjà actif / a déjà une tâche en file. | `striart status`, `striart queue`, ou `--reuse` pour un clone arrêté. |
| `CLONE_REMOVAL_PENDING` | La suppression du clone de ce nom est entamée et pas terminée : le nom n'est pas réutilisable. | `striart reconcile` (la termine, sauf session vivante). |
| `AFTER_CYCLE` | `--after` créerait un cycle de dépendances. | `striart queue`. |
| `RESOLUTION_INCOMPLETE` / `STALE_TICKET` / `TICKET_NOT_APPLICABLE` / `TICKET_ALREADY_RESOLVED` | `resolve --apply` : résolution manquante, ticket périmé, conflit non fichier par fichier, déjà résolu. | `striart resolve --prepare <id>`, ou relancer un merge normal. |
| `TICKET_CORRUPT` | Le `ticket.json` est illisible : rien ne peut être lu, préparé ni appliqué. | Inspecter le dossier du ticket (le chemin est donné), puis `striart resolve --close <id>`. |
| `TICKET_PATH_UNSAFE` | Un ticket nomme un chemin qui n'est pas un chemin de projet sûr (absolu, remontant par `..`, ou dans `.git`) : rien n'est écrit. Le fichier du ticket a probablement été modifié à la main. | `striart resolve --close <id>`, puis relancer le merge. |
| `PROTECTED_PATHS_CHANGED` | Le commit de l'agent change un chemin protégé (`AGENTS.md`, `.claude`, `striart.config.*`…) sans résolution humaine préparée. | Relancer `striart merge <agent>` pour rafraîchir le ticket avec ces chemins, puis décider chacun (`resolve --prepare` / `--apply`). |
| `MERGE_WINDOW_EXCEEDED` | Un conflit dépasse la fenêtre du Merger (`tokens.merger.maxWindowTokens`) : le modèle le tronquerait. | Résoudre à la main (`resolve --prepare`), ou relever la fenêtre. |
| `TOKEN_BUDGET_EXCEEDED` | Un plafond `tokens.budgets` est atteint : appel LLM refusé *avant* envoi, ou session d'agent arrêtée. | `striart usage` ; relever le plafond ou attendre la fin de la période. Ne compte pas dans le mode manuel. |
| `TOKEN_PRICE_MISSING` | Un plafond de **coût** est posé sans prix déclaré pour ce modèle : il ne peut pas être tenu. | Déclarer le modèle dans `tokens.pricing` (avec `asOf`), ou retirer le plafond de coût. |
| `LOCK_LOST` | Le verrou principal a été perdu (ou n'était pas tenu) pendant une opération : rien n'a été commité. | Voir « Verrou bloqué ? ». |
| `MERGE_STATE_CHANGED` | L'état du principal a changé sous l'opération (`HEAD`, merge ouvert par un tiers) : rien n'a été commité. | Voir « Verrou bloqué ? ». |
| `MERGE_RECOVERY_BLOCKED` | Un merge ouvert dans le principal ne sera **pas** annulé par Striart (une opération antérieure a constaté qu'il n'était pas à elle). | Le terminer (`git commit`) ou l'annuler (`git merge --abort`) à la main. |
| `MAIN_DIVERGED` | `promote` : `mainBranch` a des commits hors pipeline, ou a bougé pendant la promotion (la mise à jour de `mainBranch` est un compare-and-swap sur l'ancien SHA : rien n'a été promu). | Merger `mainBranch` dans `targetBranch` à la main, ou relancer `promote`. |
| `NOT_A_STRIART_MERGE` | `rollback` : le dernier commit n'est pas un merge Striart. | `striart history` ; au-delà, `git revert`. |
| `DAEMON_RUNNING` | Un daemon `watch`/`dashboard` tourne déjà. | `--status`, puis `--stop`. |
| `DAEMON_STOP_DENIED` | `--stop` : le daemon appartient à un autre utilisateur (`EPERM`), impossible de le signaler depuis ce compte. Rien n'est tué ni oublié : le PID file reste en place. | `striart <watch\|dashboard> --status` ; l'arrêter depuis le compte qui l'a lancé. |
| `DAEMON_IDENTITY_UNVERIFIED` | `--stop` : le PID publié est vivant mais son identité est illisible (process d'un autre utilisateur, ligne de commande cachée) — rien n'est tué à l'aveugle, le PID file reste en place. | `striart <watch\|dashboard> --status` ; vérifier le process à la main (`ps`, Gestionnaire des tâches). |
| `DAEMON_PIDFILE_CORRUPT` | Le PID file d'un daemon (`.striart/<watch\|dashboard>.pid`) est illisible ou sans PID valide : impossible de savoir si un daemon tourne. Striart ne le prend **pas** pour « aucun daemon » (cela lancerait un second daemon et laisserait `--stop` sans effet sur le premier). | Inspecter le fichier (`details.path`), le supprimer si aucun daemon ne tourne, puis relancer. |
| `PTY_HOST_ALREADY_RUNNING` | Un hôte de pty natif tient déjà cet agent (verrou exclusif de l'hôte). | S'y attacher : `striart attach <agent>`. |
| `TERMINAL_UNSAFE` | Un chemin ou argument contient NUL/CR/LF (ou `"` sous Windows) : aucun lanceur de terminal ne sait le transmettre. | Lancer l'outil à la main (la commande est affichée). |
| `NATIVE_INTEGRITY_FAILED` | Le binaire natif est altéré ou non vérifiable (empreinte divergente, signature invalide, manifeste absent, versions discordantes) : il n'est **jamais** exécuté. | Réinstaller Striart (`npm install`), puis `striart doctor`. Voir « Composant natif ». |
| `MCP_READ_ONLY` / `MCP_DEPTH_LIMIT` / `MCP_SCOPE_DENIED` / `MCP_PROTECTED_TICKET` | Outil MCP mutant refusé : serveur lancé en `--read-only` / process descendant d'une session autonome / hors du périmètre de l'agent appelant (ou aucun agent borné, ticket d'un autre agent) / `resolve_prepare` ou `resolve_apply` sur un ticket `PROTECTED_PATHS_CHANGED` — approuver un changement de chemin protégé est la décision que la garde réserve à l'humain, refusée à tout appelant MCP. | Voir [Serveur MCP](mcp.md#qui-appelle-et-sur-quoi-il-peut-agir) ; l'humain passe par `striart resolve`. |
| `CONTROL_UNAUTHENTICATED` / `CONTROL_ORIGIN_REFUSED` / `CONTROL_CSRF_REFUSED` / `CONTROL_NESTED_SESSION` | Dashboard ou `striart api` : session absente ou expirée / requête qui ne vient pas de la page / en-têtes anti-CSRF manquants / surface du plan humain appelée depuis une session d'agent. | Voir « Dashboard : connexion refusée ». |
| `ACP_AUTH_REQUIRED` | L'agent ACP exige une authentification, que Striart ne fait jamais seul. | S'authentifier avec l'outil lui-même, ou poser `acp.auth.methodId` (relâchement). |
| `ACP_HOST_BUSY` / `ACP_SESSION_CLOSING` / `ACP_BUS_DISABLED` / `ACP_HOST_AUTH_FAILED` | Une session ACP vit déjà pour cet agent / elle se ferme / le bus est coupé (`acp.bus: false`) / jeton de client refusé par l'hôte. | Attendre la session, ou `striart stop <agent>`. |
| `ACP_IMPORT_UNPINNED` / `ACP_IMPORT_NO_INTEGRITY` / `ACP_DOWNLOAD_INTEGRITY_MISMATCH` / `ACP_EXTRACT_UNSAFE` | `profiles --import-acp` : version non épinglée / aucune empreinte sha256 publiée / empreinte divergente / archive avec lien symbolique ou chemin sortant. | Choisir une distribution épinglée ; ne jamais passer outre une empreinte divergente. |
| `ACP_PROXY_OPTION_LOCKED` / `ACP_PROXY_SESSION_ENDED` / `ACP_PROXY_PROMPT_BUSY` / `ACP_PROXY_COLLISION` / `ACP_PROXY_NO_PROFILE` / `ACP_PROXY_PROFILE_UNAVAILABLE` | `striart acp` : option figée après le premier prompt / session finie / prompt déjà en cours / collision du Router (aucun clone créé) / aucun profil ACP / profil hors de la liste blanche. | Ouvrir une nouvelle session ; `acpAgent.collisionPolicy: 'wait'` ; déclarer un profil `acp: true` (`striart profiles --detect`). |
| `COLLAB_DISABLED` / `COLLAB_NOT_MEMBER` / `COLLAB_KIND_FORBIDDEN` / `COLLAB_LIMIT_REACHED` | Canal de collaboration : coupé (`collab.enabled: false`) / l'agent n'est dans aucun groupe ouvert / `verdict` hors du tour d'un relecteur / borne de messages atteinte. | Voir [Modes d'exécution](modes-execution.md#les-modes-dorchestration). |
| `REVIEW_NOT_PENDING` | Verdict humain demandé sur une relecture qui n'attend plus (délai écoulé, déjà répondue). | `striart review` pour la liste. |
| `HOOK_TARGET_TRACKED` / `HOOK_TARGET_FOREIGN` / `HOOK_PATH_UNSAFE` | `hook install` : la cible est versionnée par le dépôt / existe sans être de Striart / un chemin ne peut pas être écrit fidèlement dans la commande du hook. | `--user` plutôt que `--agent` ; ne jamais écraser un fichier étranger ; `STRIART_HOOK_BIN_DIR` vers un dossier sans espace. |
| `EMPTY_REPO` | Le dépôt n'a aucun commit : aucune branche cible utilisable. | Faire un premier commit. |
| `USER_CONFIG_UNSAFE` | La config **utilisateur** est modifiable par le groupe ou les autres, ou n'appartient pas à l'utilisateur (POSIX) : ignorée, aucune confiance. | `chmod 600` sur le fichier. |
| `AFTER_UNKNOWN` | `--after` ne désigne aucune tâche en file ni agent actif. | `striart queue`. |
| `CONTROL_TOKEN_UNPROTECTED` | Le fichier du jeton ne peut pas être réservé à l'utilisateur : refus, aucun jeton n'est laissé lisible par d'autres. | Droits du dossier d'état. |
| `COMMITTER_IDENTITY_MISSING` / `STRIART_COMMIT_UNSAFE` | Contrat de commit : aucune identité git pour l'utilisateur dans le principal (`user.name`, `user.email`) / le commit Striart contenait des chemins interdits et a été défait. | Configurer l'identité git ; inspecter le clone. |
| `ACP_IMPORT_PLATFORM_UNSUPPORTED` | `--import-acp` : le registre ne propose aucune distribution pour cette plateforme. | Choisir un autre agent, ou déclarer le profil à la main. |
| `ACP_IMPORT_ENV_FORBIDDEN` | `--import-acp` : l'agent du registre demande une variable d'environnement non autorisée (`details.variable`). | La lister dans `acpRegistry.allowEnv` si elle est sûre ; jamais possible pour `NODE_OPTIONS`, `PATH`, `LD_*`… |
| `ACP_SOCKET_DIR_UNSAFE` | POSIX : le dossier privé du socket de l'hôte de session ACP n'est pas un vrai dossier de l'utilisateur en mode `0700` (`details.path`). | L'inspecter, le supprimer (`rm -r <chemin>`), relancer. |
| `PERMISSION_NOT_PENDING` / `ELICITATION_NOT_PENDING` | Arbitrage : demande ou question qui n'attend plus. | Rafraîchir l'état ; la demande a peut-être expiré (fail closed). |
| `SAFE_WRITE_UNSAFE` | Striart refuse d'écrire (mémoire, consignes, boîte de collaboration, exclusion git, config des hooks) parce qu'un composant du chemin est un lien symbolique, une jonction ou un non-dossier dans le clone (`details.reason`, `details.path`) — jamais d'écriture à travers un lien. | Inspecter le chemin dans le clone (un agent l'a peut-être planté), le retirer ; `striart doctor`. |
| `PROMOTION_DISABLED` / `UNSUPPORTED_RESOLUTION_KIND` | `promote` sans `mainBranch` / `--apply` sur un conflit non résolvable fichier par fichier. | Voir [Branches](branches.md#le-pipeline-staging--main) ; `git` à la main puis `resolve --close`. |
| `STATE_UNPROTECTED` | `.striart/` ne peut pas être réservé à l'utilisateur courant (`details.reason` : `icacls`, `acl-open`, `mode-open`, `foreign-owner`, `chmod`, `not-a-directory`) : refusé plutôt que de laisser le code, les journaux et les jetons lisibles par d'autres comptes. Levé par `striart init`, par toute opération sous le verrou principal, au lancement d'une session et à l'écriture d'un ticket. Causes : système de fichiers sans permissions (FAT, exFAT, certains partages), propriétaire étranger, `icacls` en échec (Windows). | Vérifier les droits et le propriétaire de `.striart/`, relancer `striart init` (il resserre l'existant) puis `striart doctor`. Sur un système de fichiers sans permissions : `privateStateDir: false` (relâchement explicite, journalisé et affiché par `doctor`). |
| `NET_OFFLINE` | Mode hors ligne (`network.offline` ou `STRIART_OFFLINE`) : l'appel sortant vers un hôte non local est refusé. La boucle locale (Ollama) n'est jamais concernée. | Retirer `network.offline` / `STRIART_OFFLINE`, ou travailler avec un LLM local. |
| `NET_HOST_NOT_ALLOWED` | L'hôte n'est pas dans la liste blanche réseau (`network.allowedHosts`, `STRIART_ALLOWED_HOSTS` — avec les deux, il doit figurer dans les deux). | L'ajouter à la config **utilisateur** ou à la variable, si c'est voulu. |
| `NET_INSECURE_TRANSPORT` | HTTP en clair vers un hôte distant (`details.reason` : `PLAIN_HTTP` — clé d'API ou non), ou `NODE_TLS_REJECT_UNAUTHORIZED=0` dans l'environnement (`TLS_VERIFICATION_DISABLED`). `llm.allowInsecureTransport` seul (config du dépôt) ne lève pas le refus. | `https://` ; ou déclarer l'hôte dans `network.allowInsecureHosts` (config utilisateur, en connaissance de cause) ; retirer `NODE_TLS_REJECT_UNAUTHORIZED=0` et ajouter la CA d'entreprise (`NODE_EXTRA_CA_CERTS`). |
| `NET_REDIRECT_REFUSED` | Le serveur a répondu par une redirection (`details.reason` : `REDIRECT`) — aucune n'est suivie — ou le suivi borné des archives du registre ACP a dépassé 3 sauts (`TOO_MANY`). | Corriger l'URL (`baseUrl`, webhook, registre) pour viser directement la bonne adresse. |
| `IDLE_CLOSE_BLOCKED` | `striart gc` : la fermeture d'une session inactive a été **refusée par une garde** — session du repo principal (`detail` : `MAIN_SESSION`), session changée entre la décision et l'acte (`SESSION_CHANGED`), plus de session vivante (`NO_LIVE_SESSION`), soi-même ou son parent (`SELF`), ou une source de contexte illisible pendant le balayage (`detail` : `HUMAN_REQUESTS_UNREADABLE`, `TICKETS_UNREADABLE`, `ORCHESTRATION_UNREADABLE`, `LOCK_UNREADABLE`, `MERGE_STATE_UNRESOLVED`, `MAIN_SESSION_UNREADABLE`, `IDLE_STATE_UNREADABLE`). Porté par `refused[].code` du rapport, pas levé : la session est **intacte**. | `striart gc --dry-run` ; corriger la source illisible (`striart doctor`), puis relancer. |
| `IDLE_CLOSE_UNVERIFIED` | `striart gc` : le process visé n'est **pas identifiable**, donc pas touché — session autonome sans superviseur enregistré (`NO_SUPERVISOR_RECORD`), PID recyclé (`IDENTITY`), process d'un autre utilisateur (`DENIED`), ou hôte ACP/terminal dont l'arrêt a été laissé en place. | Arrêter la session soi-même après vérification ; rien n'a été tué à l'aveugle. |
| `IDLE_CLOSE_NOT_ACKNOWLEDGED` | `striart gc` : le process qui **supervise** la session autonome est vivant mais n'a pas accusé la demande d'arrêt propre dans le délai (5 s) — aucun kill n'est tenté. | Vérifier que ce process (`striart run --autonomous`) répond ; sinon l'arrêter soi-même. |

**Usage (sortie 2)** — rejeté avant toute action :

| Code | Signification |
|---|---|
| `UNKNOWN_OPTION`, `UNKNOWN_COMMAND`, `MISSING_COMMAND`, `MISSING_ARGUMENT`, `MISSING_OPTION`, `MISSING_OPTION_VALUE`, `EXCESS_ARGUMENTS`, `INVALID_ARGUMENT`, `OPTION_CONFLICT` | Ligne de commande invalide (une suggestion « vouliez-vous dire… » accompagne une commande mal orthographiée). |
| `INVALID_AGENT_NAME`, `EMPTY_PROMPT`, `REUSE_NEEDS_AGENT`, `PLAN_INVALID` | Entrée invalide quel que soit l'état du dépôt. `PLAN_INVALID` / `COMMAND_NOT_AN_EXECUTABLE_NAME` : le `command` d'une tâche de plan doit être un **nom d'exécutable** (sans chemin, espace ni option) — il est tapé dans le shell du pty ; les options vont dans `agentCommand` ou un profil. |
| `INVALID_RETENTION_DAYS` | `prune` : rétention invalide (refusée au lieu de tout supprimer). |
| `USAGE_PERIOD_INVALID` | `usage` : `--since`/`--until` mal formés (`7d`, `24h`, `today`, `AAAA-MM-JJ`) ou incohérents. |
| `ORCHESTRATE_USAGE` | `orchestrate` : option étrangère au mode choisi, ou option obligatoire du mode manquante (`details.reason`). |
| `REVIEW_VERDICT_INVALID` | `review` : verdict mal formé (`--request-changes` sans `--comment`…). |
| `LOCK_PID_EPHEMERAL` | `lock --start` sans `--pid` depuis un process qui n'est pas un shell interactif durable : la piste donne la commande `--pid` adaptée au shell. |
| `LOCK_PID_DEAD`, `LOCK_REASON_EMPTY`, `INVALID_PID` | Réservation qui ne protégerait rien. |
| `UNSUPPORTED_OUTPUT_FORMAT`, `UI_REQUIRES_TTY`, `ATTACH_WRONG_CWD` | `--json` sur `mcp`/`api`/`acp`/`attach`/`completion`/`watch --ui`, `watch --ui` sans terminal, `attach` hors du clone. |
| `MCP_ROOT_INVALID`, `MCP_SCOPE_CONFLICT` | `mcp` : `--root` ne désigne pas un dépôt Striart initialisé / `--agent` contredit le clone du répertoire courant. |
| `HOOK_TOOL_UNKNOWN`, `HOOK_SCOPE_REQUIRED` | `hook install\|uninstall` : outil inconnu (`claude`, `codex`, `copilot`, `gemini`, `cline`) / ni `--user` ni `--agent` (ou les deux). |
| `PERMISSION_ID_INVALID`, `ELICITATION_CONTENT_INVALID`, `ACP_PROMPT_INVALID` | Réponse humaine mal formée (identifiant, formulaire non conforme au schéma de l'agent) ; message du bus invalide (vide, trop long, caractères de contrôle). |
| `ACP_PROXY_OPTION_UNKNOWN`, `ACP_PROXY_OPTION_INVALID`, `ACP_PROXY_SESSION_UNKNOWN`, `ACP_PROXY_NOT_INITIALIZED`, `ACP_PROXY_AUTH_METHOD_UNKNOWN`, `ACP_PROXY_METHOD_UNSUPPORTED`, `ACP_PROXY_CWD_OUTSIDE_ROOT` | `striart acp` : requête de l'éditeur mal formée ou hors protocole — option de session inconnue/invalide, session inconnue, `initialize` manquant, méthode d'authentification autre que `striart-local`, méthode non servie (`fs/*`, `terminal/*` ne le sont jamais), dossier hors du dépôt servi (`--root`). |
| `COLLAB_MESSAGE_INVALID`, `COLLAB_RECIPIENT_UNKNOWN`, `COLLAB_GROUP_AMBIGUOUS`, `COLLAB_ROLE_AMBIGUOUS` | Message de collaboration mal formé / destinataire inconnu / groupe ou rôle à préciser. |
| `CONTROL_PARSE_ERROR`, `CONTROL_INVALID_REQUEST`, `CONTROL_MESSAGE_TOO_LARGE`, `CONTROL_METHOD_UNKNOWN`, `CONTROL_METHOD_UNAVAILABLE`, `CONTROL_SUBSCRIPTION_UNKNOWN`, `CONTROL_VERSION_UNSUPPORTED` | Control Protocol : message mal formé ou hors contrat (JSON invalide, cadrage `Content-Length` illisible, message de plus de 1 Mo, méthode inconnue ou non servie sur ce transport, abonnement inconnu, version non prise en charge). Corriger la requête. |
| `SECRET_PATTERN_INVALID` | Un motif de `secretPatterns` n'est pas supporté : négation `!`, commentaire `#`, motif vide ou saut de ligne (corriger `secretPatterns` dans la config). |

**Échec (sortie 1)** — exécution ou environnement, peut être transitoire :

| Code | Signification | Issue |
|---|---|---|
| `NOT_A_GIT_REPO` / `NOT_INITIALIZED` | Pas de dépôt Git ; pas de `.striart/` **à la racine** du dépôt (`striart mcp` et `striart api` refusent aussi un dépôt non initialisé, avant tout démarrage). | `git init`, `striart init`. |
| `UNKNOWN_BRANCH` | `targetBranch` (ou `mainBranch`) n'existe pas **ou n'a aucun commit** — vérifié avant tout clonage ou appel au LLM, et par `merge`, `resolve --apply`, `rollback` et `promote` avant toute opération. | Corriger la config (`git branch --list`). |
| `CONFIG_INVALID` / `LLM_CONFIG_INVALID` | Config refusée (seule la **clé** fautive est citée, jamais sa valeur ; pour un motif de `dashboardAllowedHosts`, l'index de l'entrée ; une clé de premier niveau **inconnue** — faute de frappe — porte `UNKNOWN_KEY` et une suggestion) / provider LLM mal configuré. | `striart doctor`, [Configuration](configuration.md). |
| `USER_CONFIG_INVALID` | La config **utilisateur** est invalide (JSON, clé inconnue dans `hooks`, `env`, `native`, `network` ou `gate`, racine non absolue, variable d'environnement réseau mal formée) : ignorée, aucune confiance accordée et les appels sortants non locaux sont refusés. | Corriger le JSON ou la variable (`striart doctor`). |
| `ROUTER_FAILED` / `LLM_FAILED` / `SEMANTIC_MERGE_FAILED` / `MEMORY_FAILED` / `RACE_JUDGE_FAILED` | Le LLM n'a pas répondu ou a rendu une sortie inexploitable (après retries et backoff ; un disjoncteur ouvert échoue sans attendre). `error.details.causeCode` donne la cause stable : `TRANSPORT`, `TIMEOUT`, `HTTP_4XX`, `HTTP_5XX`, `TRUNCATED` (sortie coupée), `FILTERED`, `REFUSED`, `INVALID_JSON`, `INVALID_RESPONSE` ; un échec de fusion sémantique d'un merge porte `errorCode` + `errorDetails` (le texte `error` est le français du noyau). | `striart doctor` (LLM joignable ? clé présente ?) ; relancer — le Router est un filtre, pas une garantie. |
| `AGENT_UNKNOWN` / `TICKET_UNKNOWN` / `CLONE_NOT_FOUND` / `PROFILE_UNKNOWN` / `PLAN_NOT_FOUND` / `REVIEW_UNKNOWN` | Cible introuvable. | `striart status`, `striart resolve --all`, `striart profiles`, `striart review`. |
| `LOCK_TIMEOUT` | Verrou principal non obtenu dans les 2 min. | Voir « Verrou bloqué ? ». |
| `LOCK_WAIT_CANCELLED` / `LOCK_IO_FAILED` | Attente du verrou annulée avant toute acquisition (rien n'a démarré) / E/S du verrou ou de sa file impossibles (droits, antivirus, disque). | Relancer ; vérifier les droits de `.striart/`. |
| `STATE_LOCK_TIMEOUT` / `STATE_LOCK_LOST` / `STATE_LOCK_FAILED` | Verrou d'état (`.striart/state.lock`) : non obtenu / perdu avant l'écriture (rien n'est écrit) / non manipulable (E/S, ou dossier du verrou absent alors que `.striart/` existe). | Voir « Verrou d'état et fichiers d'état ». |
| `STATE_READ_FAILED` / `STATE_WRITE_FAILED` | Un fichier d'état ne peut être lu / écrit même après nouvelles tentatives (l'état précédent reste intact). | Droits, disque plein, antivirus ; relancer. |
| `REGISTRY_CORRUPT` / `QUEUE_CORRUPT` / `LOCKS_CORRUPT` / `STATE_CORRUPT` / `MAIN_SESSION_CORRUPT` / `COLLAB_CORRUPT` / `REVIEW_CORRUPT` / `ORCHESTRATION_STATE_CORRUPT` | Fichier d'état illisible (`details.path`, `details.cause`). | Voir « Verrou d'état et fichiers d'état ». |
| `NATIVE_UNAVAILABLE` / `NATIVE_COMMAND_FAILED` / `NATIVE_PROTOCOL_ERROR` | Binaire natif introuvable pour cette plateforme ou son paquet absent / commande native en échec ou délai / binaire d'une autre version de protocole. | Voir « Composant natif ». |
| `GATE_ORPHAN_PROCESS` / `JOB_TERMINATE_INCOMPLETE` | Test Gate rouge sans test en échec : un descendant du test vivait encore après sa sortie et `gateOrphanGraceMs` (tué) / le nettoyage du conteneur de process n'a pas abouti (process survivants). | Voir « Test Gate rouge sans test en échec ». |
| `PTY_HOST_SPAWN_FAILED` / `PTY_ATTACH_LISTEN_FAILED` / `PTY_HOST_UNKNOWN_AGENT` / `PTY_SESSION_NOT_FOUND` | L'hôte de terminal n'a pas pu démarrer ou écouter / agent hors du registre / aucune session de terminal pour cet agent. | `striart doctor` (ligne « hôte de terminal ») ; `striart start <agent> --open`. `details.nativeCode` nomme la cause native, par exemple `PTY_ENDPOINT_TOO_LONG` : sous POSIX le chemin du socket d'attache (`.striart/pty/<agent>/attach.sock`) dépasse la limite de l'OS (104 octets sous macOS, 108 sous Linux) — travailler depuis un chemin de projet plus court. |
| `PORT_IN_USE` | Le port du dashboard est pris. | `--port <autre>`. |
| `CONTROL_INSTANCE_NOT_FOUND` | `dashboard --link` : aucun dashboard ne tourne pour ce dépôt (ou son fichier de jeton est illisible). | `striart dashboard --daemon`. |
| `DAEMON_BUSY` | Le verrou du PID file d'un daemon (`.striart/<watch\|dashboard>.pid.lock`) est tenu par une autre commande au-delà de l'attente. | Relancer ; `striart <watch\|dashboard> --status`. Un verrou de plus de 30 s est cassé automatiquement. |
| `PROFILE_INVALID` | Profil d'agent mal formé (seul le **champ** fautif est cité, jamais l'env du profil). | `striart profiles`. |
| `ACP_AUTH_METHOD_UNAVAILABLE` | `acp.auth.methodId` n'est pas une méthode du protocole annoncée par l'agent (les méthodes « terminal » ne sont jamais passées à `authenticate`). | Corriger `methodId`. |
| `ACP_HOST_SPAWN_FAILED` / `ACP_HOST_UNREACHABLE` / `ACP_HOST_LOST` / `ACP_HOST_FAILED` / `ACP_HOST_PROTOCOL` / `ACP_SESSION_NOT_FOUND` | Hôte de session ACP : démarrage impossible / injoignable / disparu sans rapporter de résultat (voir `.striart/logs/acp-host-<agent>.log`) / erreur inattendue / trame inattendue / aucune session ACP vivante pour cet agent (une session argv est *one-shot*). | Journal de l'hôte ; relancer la tâche. |
| `ACP_PROXY_QUEUE_TOOK_OVER` / `ACP_PROXY_UPSTREAM_ENDED` | `striart acp` : la file a relancé la tâche avant que Striart puisse la reprendre / la session de l'agent amont a fini avant la fin du tour. | `striart queue` ; l'issue est rapportée dans la session. |
| `ACP_REGISTRY_FETCH_FAILED` / `ACP_REGISTRY_INVALID` / `ACP_EXTRACT_FAILED` | `--import-acp` : registre injoignable / document invalide / extraction impossible. | Réseau ; `acpRegistry.url` — si le refus vient de la politique réseau, voir les codes `NET_*`. |
| `PERMISSION_OPTION_UNKNOWN` / `ELICITATION_INVALID` | Arbitrage : option que l'agent n'a pas proposée / schéma de formulaire refusé (non validable). | Rafraîchir l'état. |
| `SESSION_LOG_UNAVAILABLE` | Aucun log de session pour cet agent (la session n'a peut-être pas démarré). | `striart status`. |
| `MCP_OVERLOADED` / `MCP_RESOURCE_UNKNOWN` | Trop de requêtes MCP simultanées / ressource inconnue. | `mcp.maxConcurrentRequests` ; lister les ressources. |
| `COLLAB_GROUP_UNKNOWN` | Groupe de collaboration inconnu. | `striart status` (champ `orchestration`). |
| `HOOK_CONFIG_UNREADABLE` | `hook install` : la configuration de l'outil est illisible — laissée intacte. | La réparer, puis relancer. |
| `TERMINAL_LAUNCHER_UNSUPPORTED` / `TERMINAL_CONTEXT_MISSING` / `WARP_NOT_FOUND` | `terminal.launcher` indisponible sur cette plateforme / Warp demandé hors d'un clone d'agent / dossier de données de Warp introuvable (installé pour cet utilisateur ?). | Choisir un autre lanceur dans `terminal.launcher`. |
| `CLONE_FAILED` / `SECRETS_EXCLUSION_FAILED` / `MERGE_FAILED` / `MERGE_ABORT_FAILED` / `REUSE_FETCH_FAILED` / `REUSE_NO_CLONE` | Échec git (`MERGE_ABORT_FAILED` : le principal reste en état « merging »). | `striart doctor` ; `git merge --abort` à la main pour `MERGE_ABORT_FAILED`. |
| `MERGE_COMMIT_FAILED` | git a refusé le commit de merge (ou le `revert` d'un `rollback`) pour une raison qui n'est pas un hook : identité git absente, signature impossible : le merge est annulé, le principal est propre, rien n'est commité. | `git config user.name` / `user.email`, ou la signature de commit, puis relancer. |
| `UNEXPECTED` | Erreur non prévue. | `STRIART_LOG_LEVEL=debug` pour la pile complète. |
| `TICKETS_UNREADABLE` | Le dossier `.striart/conflicts/` est illisible (droits, fichier à la place du dossier, E/S) — `details.cause` porte la cause système. | `striart doctor` ; corriger les droits. |
| `TOKEN_ACCOUNTING_FAILED` | `tokens.onAccountingError: 'fail'` : le relevé d'un appel LLM (ou la relecture des cumuls de budget au démarrage d'une session) a échoué — la comptabilité serait aveugle, l'opération est refusée (`details.what` : `usage-ledger-write`, `post-call-budget-evaluation`, `session-budget-baseline`). Avec `'warn'` (défaut) l'échec n'est que journalisé sous ce même code. | Inspecter `.striart/usage/` (droits, disque, antivirus), relancer ; ou repasser à `'warn'`. |
| `DAEMON_SPAWN_FAILED` | Le process détaché du daemon n'a pas pu être lancé (exécutable introuvable, droits, PID non obtenu). `details.cause` donne la raison ; aucun PID file n'est laissé. | `striart doctor` ; corriger la cause, relancer `--daemon`. |
| `PTY_SHELL_INVALID` | `pty.shell` désigne un shell inutilisable : chemin relatif, introuvable dans les dossiers absolus du `PATH`, ou non exécutable. Aucun repli sur `auto`. | Corriger `pty.shell` dans la config, ou le remettre à `auto`. |
| `ACP_AGENT_UNKNOWN` | `profiles --import-acp` : identifiant invalide ou absent du registre ACP. | Choisir un identifiant listé dans `error.details.known` (`--json`). |
| `NET_URL_INVALID` | URL sortante non analysable ou schéma autre que `http(s)` (`details.reason` : `UNPARSEABLE`, `SCHEME`). | Corriger `llm.baseUrl`, `ollamaHost`, l'URL du webhook ou du registre. |
| `NET_PROXY_UNSUPPORTED` | Un proxy d'entreprise est configuré mais **inactif** sur ce Node (`details.reason` : `SCHEME` — SOCKS non supporté —, `NEEDS_STARTUP_FLAG`, `USER_CONFIG_NEEDS_RUNTIME_API`, `AUTH_NEEDS_RUNTIME_API`) : l'appel est refusé plutôt que de contourner le proxy. | Suivre la piste (`NODE_USE_ENV_PROXY=1` sur Node ≥ 22.21 / 24.5, ou Node ≥ 24.14 / 25.4) — voir [Réseau d'entreprise](configuration.md#réseau-dentreprise-network) ; `striart doctor`. |
| `NET_TLS_UNTRUSTED` | La chaîne de certificats n'aboutit pas à une autorité connue (`details.certCode`). | Ajouter la CA d'entreprise (`NODE_EXTRA_CA_CERTS`, `node --use-system-ca`, `network.caFile`) ; jamais `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `NET_CA_INVALID` | `network.caFile` inutilisable (`details.reason` : code système, `NOT_A_FILE`, `TOO_LARGE`, `NO_CERTIFICATE`, `REJECTED_BY_NODE`). | Un fichier PEM d'au plus 4 Mio contenant « BEGIN CERTIFICATE » ; `striart doctor`. |
| `COMMIT_HOOK_REJECTED` | Un hook de la cible (`pre-commit`, `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`) ou la signature a **rejeté**, ou **bloqué au-delà de `commitTimeoutMs`** (arbre de process tué), le commit de merge : le merge est annulé, le principal est propre. Un **ticket** `COMMIT_HOOK_REJECTED` garde la sortie du hook (la fin, 16 Kio au plus, secrets caviardés) ; il se ferme de lui-même au prochain merge réussi de l'agent. Le même code peut venir du `revert` d'un `rollback` publié (aucun ticket, `HEAD` inchangé). Un hook n'est jamais contourné, et ce n'est pas un échec du LLM : le compteur du mode manuel n'est pas touché. | Corriger ce que le hook reproche (sortie : ticket ou message), puis relancer le merge. |
| `DELIVERY_REF_INVALID` | `delivery: 'branch'` : aucune branche de livraison valide ne peut être dérivée (nom d'agent invalide, SHA invalide ; `details.reason`). Levé, ou rapporté dans `delivery.code`. | `striart doctor` ; le merge local reste valide. |
| `IDLE_CLOSE_FAILED` | `striart gc` : l'arrêt d'une session a échoué (`detail` : `NOT_STOPPED`, `STILL_ALIVE`, ou un code système) — la session peut vivre encore. Sortie 1. | `striart status`, puis relancer `striart gc` ; sinon arrêter la session à la main. |
| `IDLE_STATE_CORRUPT` | `.striart/idle/state.json` (avertissements du GC) est illisible : tant qu'il l'est, le balayage ne ferme rien (`holds` : `IDLE_STATE_UNREADABLE`). | Le supprimer (il ne perd que les instants d'avertissement : les agents seront avertis de nouveau), puis `striart gc --dry-run`. |

**Avertissements** (champ `warnings` du `--json`, sortie 0 — pas des erreurs) :
`DEPRECATED_OPTION` (`--force` sans `--reuse`, alias de
`--allow-historical-secrets` jusqu'en 0.12), `TERMINAL_OPEN_FAILED` (l'onglet
`--open` ne s'est pas ouvert), `PTY_HOST_STOPPING` / `PTY_HOST_UNTOUCHED`
(`stop` : l'hôte de terminal s'arrête encore / a été laissé en place),
`AGENT_ARTIFACT_FAILED` (`stop`/`clean` : l'hôte de session ACP ou la *Tab Config* Warp de l'agent n'a pas pu être libéré — l'arrêt ou la suppression, eux, ont réussi), `ALREADY_INTEGRATED` (`run --autonomous`, modes orchestrés, proxy ACP : le commit de l'agent était déjà dans la cible, rien n'a été mergé, aucun Test Gate rejoué, clone nettoyé), `SERIALIZATION_RELAXED` (`run --autonomous`, `plan`, modes orchestrés : une tâche que le Router n'a pas su localiser — sentinelle `**` — n'a pas attendu un clone dont la session s'est terminée en échec, sans commit à merger ; `relaxedBlockers` nomme les clones, une collision sur un fichier précis reste bloquante), un avertissement portant le code d'une erreur de domaine (`stop` : le dégagement de la file a échoué après l'arrêt — `data.queueError` ; `striart queue --retry`),
`ACP_BINARY_DOWNLOADED` (`--import-acp` avec
`acpRegistry.allowBinaryDownload` : binaire téléchargé, empreinte vérifiée),
`CONTROL_LINK_PENDING` (`dashboard --daemon` : le daemon n'a pas encore publié
son adresse, relancer `striart dashboard --link`) et `HOOK_ADVISORY_SKIPPED`
(un hook a répondu en neutre sans rien bloquer).

Les **statuts** de résultat (`CONFLICT`, `GATE_FAILED`, `SKIPPED_SESSION`,
`CANCELLED`, `BUDGET_EXCEEDED`, `COMMIT_REFUSED`, `REVIEW_REJECTED`…) ne sont
pas des erreurs : ils figurent dans `data.status` du document `--json`. Un
merge en `GATE_FAILED` sort en 3 avec un ticket ; un clone sauté par `clean`
porte sa raison (`IN_USE`, `SESSION_LIVE`, `PENDING`, `BUSY`) dans `skipped`.

| Commande | `data.status` | Sens | Sortie |
|---|---|---|---|
| `merge`, `watch` | `MERGED` | Commit de l'agent mergé, Test Gate vert (`mergeSha` : le commit que `rollback` défait). | 0 |
| | `UP_TO_DATE` | Rien à merger ; avec `alreadyMerged: true` le commit était déjà dans la cible (`mergeSha` le désigne, aucun gate rejoué). | 0 |
| | `CONFLICT` | Raison (`reason`) : `MERGE_CONFLICT`, `UNMERGEABLE_CONFLICT` (binaire, mode de fichier…), `SEMANTIC_MERGE_FAILED`, `PROTECTED_PATHS_CHANGED`. Un ticket est ouvert. | 3 |
| | `GATE_FAILED` | Test Gate rouge : merge annulé, ticket ouvert. | 3 |
| `resolve --apply` | `MERGED` / `GATE_FAILED` | Résolution appliquée sous gate / gate rouge (ticket laissé ouvert, mode manuel intact). | 0 / 3 |
| | `ALREADY_CLEAN` | Le commit était déjà mergé ou le conflit ne se reproduit plus : rien à appliquer, ticket (et doublons) fermé. | 0 |
| `promote` | `PROMOTED` / `UP_TO_DATE` / `GATE_FAILED` | `mainBranch` avancée en fast-forward / rien à promouvoir / gate global rouge (`rolledBack`). | 0 / 0 / 3 |
| `rollback` | `ROLLED_BACK` | Dernier merge Striart défait (`mode` : `reset` local ou `revert` publié). | 0 |
| `run --autonomous`, modes orchestrés | `QUEUED`, `MERGED`, `EMPTY`, `SESSION_FAILED`, `MERGE_BLOCKED`, `COMMIT_REFUSED`, `COMMIT_FAILED`, `KEPT` | Voir « Sessions autonomes » ; `EMPTY` : session sortie en 0 sans aucun commit. | 0 / 0 / 1 / 1 / 3 / 3 / 1 / 3 |
| proxy `striart acp` | idem, plus `NOTHING_STARTED` ; `keptCode: MERGE_DEFERRED` | Aucune session démarrée / merge laissé à l'humain (`MANUAL`) ou éditeur déconnecté (`DISCONNECTED`, `onDisconnect: 'keep'`). | — |
| contrat de commit (champ `commit`) | `COMMITTED`, `NOTHING_TO_COMMIT`, `SKIPPED_AGENT_COMMITTED` | Striart a commité `files` / rien de commitable (`excluded` : secrets et fichiers injectés) / `agent-then-striart` et l'agent a commité lui-même. | — |

La `reason` d'un ticket (`ticket.reason`) est l'une de `MERGE_CONFLICT`, `UNMERGEABLE_CONFLICT`, `GATE_FAILED`, `SEMANTIC_MERGE_FAILED`, `SEMANTIC_GATE_FAILED` (la fusion LLM a passé le gate… puis l'a perdu après retentatives), `PROMOTION_GATE_FAILED`, `COMMIT_HOOK_REJECTED` (un hook de la cible a rejeté le commit de merge) ou `PROTECTED_PATHS_CHANGED`.

**Codes de livraison** (`autoPush`) — rapportés dans `data.delivery.code` et en préfixe de `pushError` (`[PUSH_TIMEOUT] …`), **jamais levés** : le merge local reste valide, l'échec est visible, rien n'est forcé. `PUSH_TIMEOUT` (au-delà de `pushTimeoutMs` : hook `pre-push`, authentification ou réseau bloqué, arbre de process tué), `PUSH_NON_FAST_FORWARD` (`origin` a avancé hors de Striart ; si le remote porte déjà ce SHA, c'est un succès `alreadyDelivered`), `PUSH_REJECTED` (le remote ou un hook `pre-push` refuse : branche protégée, droits), `PUSH_FAILED` (autre échec de `git push`, ou vérification locale impossible), `PUSH_SUPERSEDED` (le SHA n'est plus dans la branche locale — un rollback est passé —, rien n'est publié) ; `DELIVERY_REF_INVALID` figure plus haut. La piste du rapport donne la commande exacte (`git push origin <sha>:refs/heads/<branche>`). Voir [Configuration](configuration.md#livraison-vers-origin--autopush-delivery-délais).

## Tickets de conflit et mode manuel

Chaque échec de fusion produit un ticket complet dans
`.striart/conflicts/<ticket>/` : versions `base`/`ours`/`theirs`, tentative
LLM (`llm-attempt`), log du Test Gate (`test-output.log`). Un même commit
re-tenté met à jour son ticket ouvert (`attempts`) au lieu d'en créer un
nouveau. Les tickets s'écrivent atomiquement ; un `ticket.json` illisible est
rendu partout (CLI, dashboard, Control Protocol, MCP) comme un ticket
`CORRUPT` avec sa cause, jamais comme un ticket vide. Un ticket issu d'un
rouge d'**exécution** du Test Gate porte `gate: {code, orphanPids, truncated}`
(code stable, PID des orphelins tués, journal tronqué au plafond
`gateMaxOutputBytes`) — voir « Test Gate rouge sans test en échec ».

```bash
striart resolve                 # liste les tickets ouverts
striart resolve --all           # … y compris les tickets déjà résolus
striart resolve --prepare <id>  # amorce <fichier>.resolved depuis la version de l'agent (sauf chemins protégés : --accept-theirs <chemin>)
striart resolve --apply <id>    # rejoue le merge exact du ticket, sous verrou + Test Gate
striart resolve --close <id>    # marque un ticket résolu SANS repasser par le Test Gate
```

`--prepare`/`--apply` sont le chemin **testé** : la résolution passe par le
même verrou inter-processus et le même Test Gate bloquant que la fusion
automatique, au lieu d'un `git merge` fait à la main hors du cadre de
Striart (source d'un incident réel : collision avec un `striart watch`
actif). `--close` reste utile si le conflit a déjà été réglé autrement.

**Mode manuel** : après 3 fusions sémantiques échouées d'affilée, Striart
désactive la fusion LLM (règle de sécurité — un LLM qui échoue en boucle ne
doit pas continuer à toucher au code). `striart resolve --unlock` la
réactive une fois la cause traitée. Un refus de budget de tokens
(`TOKEN_BUDGET_EXCEEDED`) n'est pas un échec du LLM et ne compte pas.

**Ticket `PROTECTED_PATHS_CHANGED`** : l'agent a changé un fichier qui
configure ou instruit les agents (`AGENTS.md`, `.claude`, `.mcp.json`,
`.vscode/settings.json`, `striart.config.*`…). Le merge a été refusé *avant*
toute fusion. Relire le diff de ces chemins ; pour accepter, les résoudre
explicitement (`resolve --prepare` puis `--apply`). La liste se règle
(`protectedAgentPaths.extend` / `allow`).

## Défaire un merge : `striart rollback`

Défait le **dernier merge Striart** de la branche cible :

- merge non poussé → `reset` local (récupérable via reflog) ;
- merge déjà poussé → `revert` (l'historique publié est conservé).

Refuse si le dernier commit de la branche cible n'est pas un merge Striart —
il ne défait jamais un commit humain. `striart history` reconstitue la liste
des merges (automatiques, sémantiques ou résolus à la main) et des rollbacks
depuis le graphe Git.

## État incohérent : `striart reconcile`

Après un crash, un `kill -9`, un débranchage : `striart reconcile` remet
tout d'équerre — sessions mortes neutralisées au registre, file débloquée,
verrous orphelins cassés, merge abandonné (`MERGE_HEAD` orphelin) annulé
proprement, **suppressions de clone entamées terminées**. **Idempotent** : le
lancer « pour rien » ne coûte rien. `striart watch` le rejoue
automatiquement.

## Interrompre une commande (Ctrl+C)

- **Commandes courtes** (`merge`, `sync`, `stop`…) : coupées net (sortie
  130). La récupération après coupure est éprouvée : le verrou tenu par le
  process est retiré à sa sortie, un merge laissé en plein vol est annulé à
  la prochaine acquisition du verrou. Une attente du verrou principal est
  elle annulable proprement (`LOCK_WAIT_CANCELLED`, rien n'a démarré) ; une
  fois le verrou acquis, l'opération n'est jamais interrompue en son milieu.
- **Commandes longues** (`watch`, `dashboard`) : arrêt propre — le merge en
  vol (Test Gate compris) se termine et son résultat est affiché ; les
  merges encore en file ne démarrent pas et sont signalés
  (`merge-deferred`, piste `striart merge <agent>`) : le watcher suivant ne
  les reprendra pas, relancez-les à la main. `watch --ui` se démonte, lui,
  sans attendre le merge en vol.
- **Sessions** (`run --autonomous`, `run --on-main`, `plan` hors
  `--dry-run`, `orchestrate`, `striart acp`) : arbre de l'agent tué (ACP :
  `session/cancel` d'abord), **puis** dépublication de la session — le clone
  (autonome) est conservé, la session rend `CANCELLED`. `plan` ne lance
  aucune tâche suivante et liste celles restées non appliquées
  (`notApplied`) ; il sort en 130/143, `ok: false` en `--json`. Un second
  Ctrl+C coupe net.
- **Daemons** (`watch --daemon`, `dashboard --daemon`) : `--stop` passe par
  une demande d'arrêt lue par le daemon lui-même — arrêt propre aussi sous
  Windows, où un signal serait un arrêt brutal.

## Verrou bloqué ?

Le verrou principal (`.striart/main.lock`) est tenu par un **battement de
cœur** : son détenteur le rafraîchit toutes les 5 s. Une attente de verrou
expire après 2 min (`LOCK_TIMEOUT`) avec un message explicite qui nomme le
détenteur, son âge et le nombre d'opérations en file devant vous (la file est
**équitable**, servie par numéro d'arrivée, `.striart/lock-queue/`). Un verrou
n'est cassé que sur **preuve** que son détenteur n'existe plus :

| `details.reason` de `LOCK_TIMEOUT` | Signification | Que faire |
|---|---|---|
| `HELD` | Une opération longue (merge, Test Gate) tient le verrou, et bat. | Attendre. |
| `HOLDER_FROZEN` | Le détenteur est **vivant** mais son battement est figé (process gelé : débogueur, `SIGSTOP`, boucle synchrone). Il n'est **jamais** cassé par défaut — le casser laisserait deux process dans la section dès son dégel. | Arrêter le PID indiqué si il est coincé, ou autoriser la cassure avec `lock.breakFrozenHolderAfterMs` (≥ 60 000, relâchement journalisé). |
| `LOCK_UNREADABLE` | Le fichier est illisible (droits, partage Windows) : jamais cassé à l'aveugle. | Vérifier les droits de `.striart/`. |
| `BREAK_IN_PROGRESS` / `BREAK_FAILED` | Un autre process casse un verrou périmé / le verrou périmé ne peut pas être supprimé (antivirus, droits). | Patienter ; fermer ce qui tient `.striart/main.lock`. |

Les cas où le détenteur a disparu — process mort, PID réattribué à un autre
programme, ancien format de plus de 30 min, contenu invalide ancien — sont
cassés automatiquement, sous un verrou de cassure
(`.striart/lock-queue/break.lock`) qui compare contenu **et** date avant de
supprimer : deux casseurs simultanés ne peuvent plus supprimer le verrou neuf
l'un de l'autre. Si un verrou semble coincé : `striart doctor` (la ligne
« Verrou principal » dit lequel des cas s'applique), puis `striart reconcile`.

**`LOCK_LOST`** : l'opération a constaté, juste avant un effet irréversible
(commit, écriture dans le principal), qu'elle ne tenait plus le verrou
(cassé par un autre process, ou jamais tenu). **`MERGE_STATE_CHANGED`** :
`HEAD` ou le `MERGE_HEAD` du principal n'est plus celui que l'opération avait
posé — quelqu'un a agi dessus. Dans les deux cas, **rien n'est commité** et le
dépôt reste récupérable (la prochaine opération Striart annule un merge laissé
ouvert, sauf si l'opération a constaté qu'il ne lui appartenait pas : alors
un marqueur `.striart/merge-state-changed.json` fait refuser toute opération
— `MERGE_RECOVERY_BLOCKED` — tant que ce merge n'est pas terminé ou annulé à
la main ; supprimer le marqueur permet à Striart de l'annuler lui-même).
Vérifier qui a agi (`git status`, `git log -3`, `striart doctor`) avant de
relancer.

## Verrou d'état et fichiers d'état

Les fichiers d'état (`agents.json`, `queue.json`, `state.json`, `locks.json`,
`main-session.json`, tickets, demandes de permission, relectures…) sont
écrits **atomiquement** (fichier temporaire unique, `fsync`, renommage,
nouvelles tentatives bornées sous Windows quand un autre process tient la
cible) ; toute lecture-modification-écriture passe par un **verrou d'état**
court, `.striart/state.lock` (millisecondes, jamais tenu pendant une
opération longue ; ordre de prise fixe : verrou principal puis verrou
d'état). `STATE_LOCK_TIMEOUT` : un détenteur **vivant** et identifié n'est
jamais cassé, même vieux — l'attente expire (raisons `HELD`,
`LOCK_UNREADABLE`, `BREAK_IN_PROGRESS`, `BREAK_FAILED`) ; un verrou orphelin
(détenteur mort, PID recyclé, contenu illisible ancien) est cassé
automatiquement, sous le verrou de cassure `state.lock.break`. La ligne
« Verrou d'état » de `doctor` dit si un verrou est libre, orphelin ou coincé.
`STATE_LOCK_LOST` : le verrou a été perdu avant l'écriture — rien n'a été
écrit, relancer. Un `*_CORRUPT` ne se répare pas tout seul : le fichier est
du JSON (`jq . .striart/<fichier>.json` donne l'erreur) ; le restaurer ou le
supprimer (`agents.json` se reconstruit mal — préférer le restaurer), puis
`striart reconcile`. Les fichiers `*.tmp` d'une écriture interrompue sont
balayés par `striart reconcile`.

## Composant natif

Striart s'appuie sur un petit binaire Rust, `striart-native` : identité des
process (PID recyclés), arbre de process (kill du Test Gate et des sessions),
hôte de terminal (pty), conteneur de process. Il est livré par un paquet de
plateforme (`@jumsay/striart-native-<os>-<cpu>`, dépendance optionnelle du
paquet principal), **vérifié** contre un manifeste signé (minisign) avant
chaque exécution. `striart doctor` (ligne « Composant natif ») dit quelle
source est retenue et si la signature est vérifiée.

| Code / raison | Cause | Issue |
|---|---|---|
| `NATIVE_UNAVAILABLE` `PACKAGE_MISSING` | Le paquet de plateforme n'est pas installé (dépendances optionnelles ignorées). | `npm install` sans `--omit=optional`. |
| `NATIVE_UNAVAILABLE` `DEV_BUILD_MISSING` | Depuis un checkout du dépôt, le binaire n'est pas construit. | `npm run native:build` (toolchain Rust requise). |
| `NATIVE_UNAVAILABLE` `PLATFORM_UNSUPPORTED` / `PLATFORM_NOT_PUBLISHED` | Aucun binaire publié pour cette plateforme (publiées : Windows, macOS et Linux, x64 et arm64 ; Linux en musl statique). | Construire à la main et pointer `STRIART_NATIVE_BIN` (chemin absolu — son intégrité n'est alors **pas** vérifiée, `doctor` le dit). |
| `NATIVE_UNAVAILABLE` `ENV_NOT_ABSOLUTE` / `ENV_MISSING` / `BINARY_MISSING` | `STRIART_NATIVE_BIN` relatif ou pointant un fichier absent / binaire absent de son paquet. | Corriger la variable ; réinstaller. |
| `NATIVE_INTEGRITY_FAILED` | Empreinte SHA-256 divergente, signature du manifeste invalide, manifeste absent, versions du paquet principal et du paquet natif différentes. Le binaire n'est **jamais** exécuté (fail closed). | Réinstaller Striart (`npm install`) ; ne jamais contourner. |
| `NATIVE_COMMAND_FAILED` / `NATIVE_PROTOCOL_ERROR` | La commande native a échoué ou expiré / le binaire répond hors de son protocole (autre version de Striart ?). | `striart doctor --json` ; réinstaller. |

Si le binaire natif est indisponible, `killProcessTree` ne devient pas muet :
l'erreur `NATIVE_*` est journalisée au niveau `error`, puis seul le process
de tête (et, sous POSIX, son groupe) est tué.

## Test Gate rouge sans test en échec

Le Test Gate s'exécute dans le conteneur de process natif. Il rend rouge, avec
un `code` dans le résultat, des cas où le test lui-même n'a pas échoué :

| Code | Sens | Issue |
|---|---|---|
| `GATE_ORPHAN_PROCESS` | La commande a rendu 0 (ou non), mais des descendants vivaient encore `gateOrphanGraceMs` après sa sortie : ils ont été tués et le gate est rouge. Le journal liste les PID. | Corriger le test qui laisse un serveur ou un watcher derrière lui ; ou augmenter `gateOrphanGraceMs` si l'extinction est lente. |
| `JOB_TERMINATE_INCOMPLETE` | Le nettoyage du conteneur n'a pas pu garantir qu'aucun process ne survit. | `striart doctor` ; vérifier les process restants à la main. |
| `GATE_INTERRUPTED` | Le conteneur natif a reçu un signal d'interruption (Ctrl+C, arrêt du process) pendant le test : exécution abandonnée, rien n'est commité. | Relancer. |
| `GATE_NATIVE_UNAVAILABLE` | Binaire natif indisponible ou non vérifié, ou rapport du conteneur inexploitable : le gate **n'est pas exécuté** (fail closed). | Voir « Composant natif » ; relâchement explicite : `gateContainer: 'process'` (sans détection d'orphelins). |

**Un test qui échoue « parce qu'une variable manque »** : le gate ne reçoit pas
tout l'environnement de l'orchestrateur, seulement une liste blanche (voir
[`gateEnv`](configuration.md#gateenv--lenvironnement-du-test-gate)). Si le dépôt
demande une variable (`gateEnv: ['MON_APP_*']`) que la config utilisateur
n'autorise pas (`gate.envAllow`), le journal du gate s'ouvre sur « gateEnv :
variables demandées par le dépôt mais non autorisées par la config utilisateur
(gate.envAllow), non transmises : … » (noms seulement) et `striart doctor` le
signale (ligne « Environnement du Test Gate »). Les clés d'API (`*_API_KEY`) et
les URL de webhook ne sont **jamais** transmises, quoi qu'on demande.

## Dashboard : connexion refusée

- **401 « connexion requise »** sur l'URL nue : normal, le dashboard exige un
  lien de connexion à usage unique. `striart dashboard --link` en émet un
  nouveau (valable `dashboardLinkTtlMs`, 5 min par défaut, une seule fois).
- **Lien « invalide, expiré ou déjà utilisé »** : un lien ne sert qu'une fois
  et pour l'instance qui l'a émis (le port en fait partie). En réémettre un.
- **403 `Host` non local** : le nom par lequel vous joignez le dashboard n'est
  ni celui de l'instance (`<id-aléatoire>.localhost`, affiché dans le lien de
  connexion — l'adresse `localhost` nue n'est plus servie) ni listé dans
  `dashboardAllowedHosts` (Codespaces,
  proxy). Motifs stricts — voir [Configuration](configuration.md#dashboard-et-control-protocol).
- **403 inter-site / `CONTROL_ORIGIN_REFUSED` / `CONTROL_CSRF_REFUSED`** : la
  requête ne vient pas de la page du dashboard (autre site, autre port local,
  `X-Striart: 1` manquant). Un script doit utiliser `striart api`.
- **410 sur `/api/…`** : ces routes ont été remplacées par le Control Protocol
  (`POST /rpc`, `GET /events`) en 0.11 ; voir `rpc.discover` ou
  `striart api --schema openrpc`.
- **`CONTROL_NESTED_SESSION`** : `striart api`, `acp`, `dashboard` ou `--link`,
  mais aussi `resolve`, `merge`, `stop`, `lock`, `rollback` et `promote`,
  appelés depuis une session d'agent (`STRIART_SESSION=1`) — refusé exprès :
  un agent n'arbitre pas à la place de l'humain. Lancer la commande depuis un
  terminal hors de la session.
- **`.env` : « variable(s) non autorisée(s), ignorée(s) »** : le `.env` du
  dépôt est une donnée non fiable, seules les clés d'API et les variables
  d'affichage sont appliquées. Pour en admettre d'autres, `env.allow` dans la
  [configuration utilisateur](configuration.md#configuration-utilisateur-hors-du-dépôt) ;
  `NODE_*`, `LD_*`, `PATH*`, `STRIART_NATIVE_BIN`… ne le seront jamais.
- **Bandeau « Hors ligne » / « Flux interrompu »** : le flux temps réel est
  coupé (le dashboard a été arrêté, la machine s'est mise en veille, un proxy a
  fermé la connexion). Les données restent affichées, **datées** (« dernière
  mise à jour à … ») et signalées comme potentiellement obsolètes ; la
  reconnexion est automatique et rejoue l'état complet. Si le message devient
  « Session absente ou expirée », relancer `striart dashboard --link` et ouvrir
  le nouveau lien.

## Repo principal réservé (`MAIN_SESSION_LIVE`)

`striart run --on-main` ou `striart lock --start` déclarent une session sur
le repo principal lui-même (pas un clone) : tant que le PID surveillé vit,
toute opération mutante (merge, sync, promote, `resolve --apply`,
l'auto-merge de `watch`) est refusée. **Aucun TTL** : contrairement à
`main.lock`, rien ne casse automatiquement une session déclarée trop
longtemps — `striart lock` (sans option) affiche la raison, le PID et la
durée ; `striart lock --stop` libère dans tous les cas (sortie de secours,
même si le PID vit encore).

`lock --start` refusé en `LOCK_PID_EPHEMERAL` ? Le process appelant n'est pas
un shell interactif durable (script, `bash -c`, Git Bash) : la réservation
tomberait à la fin de la commande. Relancer avec la commande donnée par la
piste, qui désigne le shell à surveiller (`--pid $PID` sous PowerShell,
`--pid $$` en bash/zsh…).

## Sessions autonomes

- **Session bloquée** : un profil non réellement non-interactif (commande qui
  attend une confirmation) reste bloqué jusqu'au timeout
  (`--timeout` > `profile.timeout` > `autonomousTimeoutMs`), puis l'arbre de
  process est tué (`session/cancel` d'abord en ACP).
- **Session échouée** : le clone est **conservé** avec un `keptReason` ; le
  log complet est dans `.striart/logs/session-<agent>-<taskId>.log` (hors du
  clone — il survit à sa suppression ; en ACP il s'écrit au fil de l'eau).
- **Session arrêtée par un plafond** (`BUDGET_EXCEEDED`) : `striart usage` dit
  quel plafond de `tokens.budgets` ; le travail interrompu n'est pas mergé.
- **Clone conservé sans merge** : `NO_COMMIT` (commit de l'agent attendu),
  `NO_CHANGES`, `ONLY_EXCLUDED_CHANGES` (seuls des secrets ou fichiers
  injectés restaient), `COMMIT_REFUSED` / `COMMIT_FAILED` (commit Striart
  impossible), `MERGE_BLOCKED` (conflit, gate rouge, chemin protégé) ou
  `CLEANUP_SKIPPED` (merge réussi, nettoyage refusé par un garde-fou) ou
  `HUMAN_REVIEW_REQUIRED` (statut `KEPT`, sortie 3 : `commitPolicy: 'human'` et
  l'agent a commité — **aucun merge automatique**, jamais, quel que soit le mode).
  Le `keptCode` du document `--json` le dit.
- **Succès « bruyant »** : si le commit de l'agent était déjà dans la cible
  (arrivé par un autre chemin), le statut est `MERGED` avec l'avertissement
  `ALREADY_INTEGRATED` ; rien n'est mergé et le Test Gate n'est **pas** rejoué.
  Vérifier que le travail attendu est bien dans la branche cible.
- **Outil non authentifié** : la session hérite de l'environnement du shell
  d'où Striart est lancé — authentifiez l'outil dans ce shell d'abord. En
  ACP, `ACP_AUTH_REQUIRED` le dit explicitement.
- **Commit qui ne passe pas avec Codex** : son bac à sable rend `.git` en
  lecture seule — le preset a `commitPolicy: 'striart'` (Striart commite le
  worktree).
- **Profil `ollama`** : c'est désormais Aider sur un modèle Ollama local ;
  `aider` doit être installé (`striart profiles --detect`).

## GC d'inactivité : pourquoi cet agent n'est-il pas fermé ?

`striart gc --dry-run` (ou `--json`) explique chaque décision, agent par agent :

- **`reasons`** (agent *actif*) : `SIGNAL_FRESH:<signal>` (au moins un signal plus
  récent que `idle.warnAfterMs`), `SIGNAL_UNKNOWN:<signal>` (signal illisible :
  fail closed, l'agent est réputé actif), `CLOCK_SKEW` (horodatage dans le futur),
  `NO_SIGNAL`.
- **`blockers`** (agent *protégé*, jamais touché) : `HUMAN_REQUEST` (permission ou
  question en attente), `OPEN_TICKET`, `ORCHESTRATED` (plan, groupe ou
  collaboration), `MERGE_IN_PROGRESS`, `MAIN_SESSION`, `REMOVING`, `EXCLUDED`
  (`idle.excludeAgents` / `excludeProfiles`).
- **`closeBlockedBy`** (agent inactif mais non fermable) : `NO_LIVE_SESSION`
  (rien à fermer : session terminée ou jamais lancée), `ACTION_REPORT` /
  `ACTION_WARN` (`idle.action` ne va pas jusqu'à `close`), `NOT_WARNED` (premier
  balayage : l'avertissement part d'abord), `GRACE_RUNNING` (la grâce court,
  `closeNotBefore` donne l'heure), `BELOW_CLOSE_THRESHOLD` (inactif depuis moins
  de `idle.closeAfterMs`), `NOT_AUTHORIZED` (le dépôt n'est pas dans
  `idle.closeRoots` de la config utilisateur, ou elle est illisible —
  `striart doctor`), `PTY_OUTPUT_UNOBSERVABLE` (terminal dont la dernière sortie
  n'est pas publiée : `idle.closePty: true`, ou un hôte natif reconstruit qui
  publie `host.output`).
- **`holds`** (au niveau du balayage) : une source de contexte est illisible, donc
  aucune fermeture n'est permise (voir `IDLE_CLOSE_BLOCKED`).

Un balayage `striart watch` neutralisé par une reprise de veille ne décide rien
pendant ce tour. Pour désactiver : `idle.enabled: false` (relâchement affiché par
`doctor`).

## Router : tâche sérialisée, collisions manquées

- **« Ma tâche attend pour rien »** : `striart queue` dit ce qui la bloque ; le
  champ `routing` de `striart run --json` et de l'agent dans `striart status --json`
  (`serialized`, affiché aussi par `striart run`) dit pourquoi le Router l'a
  sérialisée derrière tout le monde — `vague` (portée `broad`, confiance
  basse, prédiction vide…, avec ses `reasons`), `budget` (`TOKEN_BUDGET_EXCEEDED` /
  `TOKEN_PRICE_MISSING`) ou `tree-truncated` (plus de `tokens.router.tree.maxFiles`
  fichiers suivis). Un autre préréglage (`tokens.router.preset`) ou un seuil
  (`vague.minConfidence`) ajuste le compromis ; voir
  [Configuration](configuration.md#tokensrouter--la-fiabilité-du-router).
- **Un clone en échec ne retient pas la sentinelle** : avertissement
  `SERIALIZATION_RELAXED` et événement `task:serialization-relaxed` ; `relaxedBlockers`
  liste les clones en échec (`SESSION_FAILED`, statut). Une collision sur un fichier
  précis, elle, bloque toujours.
- **Deux agents se sont chevauchés sans que le Router l'annonce** : normal, il ne
  voit pas tout (voir [ce que valent le Router et la fusion](architecture.md#ce-que-valent-le-router-et-la-fusion-sémantique--mesures-du-2026-10-26)).
  Le filet à l'exécution le signale (événement `overlap:observed`, champ
  `overlaps` de `striart status`) ; le Merger et le Test Gate font le reste.
- **`doctor` : « performance » en avertissement** : latence du verrou d'état
  au-dessus de 100 ms, `git status` du principal au-dessus de 2 s, ou verrou tenu
  depuis plus de 5 min. Exclure `.striart/` de l'antivirus et de l'indexation ;
  `striart lock` / `striart status` pour le détenteur.

## Modes orchestrés, relectures, collaboration
## Modes orchestrés, relectures, collaboration

- `striart orchestrate` / `plan` v2 s'arrête en `REVIEW_REJECTED`,
  `REVIEW_EXHAUSTED`, `VERDICT_INVALID`, `READ_ONLY_VIOLATION`,
  `SCOPE_VIOLATION`, `TEAM_COMMIT_FORBIDDEN`, `RACE_NO_WINNER`, `JUDGE_FAILED`
  (le juge d'une course `pick: judge` a échoué et `race.judgeFallback` vaut
  `fail` : sortie 1, un échec d'exécution, pas un refus), `WAIT_TIMEOUT`
  ou `SKIPPED` : ce sont des **statuts** du nœud (pas des erreurs), lisibles
  dans `striart status` (`orchestration`) et le document `--json`.
- Une relecture humaine qui attend : `striart review` (liste) puis
  `striart review <id> --approve|--request-changes|--reject`. Sans réponse
  sous `orchestration.review.humanTimeoutMs`, le nœud échoue (fail closed).
- Un relecteur agent qui a écrit dans le clone de l'auteur fait échouer la
  relecture (`READ_ONLY_VIOLATION`) ; `orchestration.review.reviewerWrites:
  'discard'` annule plutôt ses écritures (relâchement).

## Hooks advisory

Un hook installé par `striart hook install` n'a **jamais** d'effet bloquant :
une réponse vide ou un avertissement sur stderr (`HOOK_ADVISORY_SKIPPED`) est
le comportement normal hors d'un clone, ou si la config du dépôt n'est pas de
confiance. Pour qu'un hook installé *pour l'utilisateur* charge la config
complète (code) d'un dépôt, listez-le dans `hooks.trustedRoots` de la config
utilisateur — voir [Configuration](configuration.md#configuration-utilisateur-hors-du-dépôt).

## Terminal (`--open`) et Warp

- L'onglet ne s'ouvre pas (`TERMINAL_OPEN_FAILED`) : l'agent est prêt, la
  commande à lancer à la main est affichée. Changer de lanceur :
  `terminal.launcher`.
- Warp : l'onglet s'ouvre via une *Tab Config* écrite dans le dossier de
  données de Warp (`WARP_NOT_FOUND` si Warp n'y est pas installé pour cet
  utilisateur). Le fichier `striart-<agent>-<empreinte>.toml` est supprimé par
  `stop` et `clean` ; si la suppression échoue, l'avertissement
  `AGENT_ARTIFACT_FAILED` le dit (le retirer alors à la main).
- Le shell hébergé est lent à démarrer sous Windows (PowerShell 5.1 charge vos
  profils) : `pty.shellArgs: ['-NoLogo', '-NoProfile']`, ou `pty.shell: 'pwsh'`.
- `striart attach` après une éviction (client trop lent) : l'historique récent
  est rejoué et se réaffiche dans le terminal.

## Push refusé après la mise à jour 0.11

Depuis simple-git 4, git n'hérite plus d'aucune variable `GIT_*` de
l'environnement : un `autoPush` (ou le push d'une promotion) qui reposait
sur `GIT_SSH_COMMAND` ou `GIT_ASKPASS` échoue (`pushError`, merge local
conservé). Configurer l'authentification dans git lui-même : credential
helper en HTTPS, `~/.ssh/config` et agent SSH en SSH — voir
[Branches et pipeline](branches.md#autopush-et-le-remote).

Depuis la livraison hors verrou, un push ne peut en outre **ni demander de
saisie** (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`) **ni durer
indéfiniment** (`pushTimeoutMs`, arbre de process tué) : une authentification qui
exigeait une invite échoue tout de suite (`PUSH_FAILED`, `PUSH_REJECTED`) au lieu
de geler ; un hook `pre-push` ou un réseau bloqué donne `PUSH_TIMEOUT`. Les codes
et leurs pistes : voir « Codes de livraison » plus haut.

## Réseau d'entreprise : appels refusés (`NET_*`)

Derrière un proxy ou un pare-feu d'entreprise, un appel sortant (LLM, webhook,
registre ACP) peut être refusé par la politique réseau de Striart — c'est voulu
(fail closed). Démarche : `striart doctor`, ligne « Réseau » (politique effective,
proxy actif ou inactif, CA, TLS) ; puis le code :

- `NET_PROXY_UNSUPPORTED` : le proxy est configuré mais ce Node ne sait pas
  l'appliquer — `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21 / 24.5, `HTTPS_PROXY` du
  shell) ou Node ≥ 24.14 / 25.4 (`network.proxy`) ; les proxys SOCKS et
  `ALL_PROXY` ne sont pas supportés ;
- `NET_TLS_UNTRUSTED` : un proxy qui inspecte le TLS présente sa propre CA —
  l'ajouter (`NODE_EXTRA_CA_CERTS`, `node --use-system-ca`, `network.caFile`),
  jamais couper la vérification ;
- `NET_HOST_NOT_ALLOWED` / `NET_OFFLINE` : liste blanche ou mode hors ligne
  posés par l'utilisateur lui-même (config utilisateur ou variables du shell) ;
- `NET_INSECURE_TRANSPORT` : un `http://` distant, y compris un Ollama sur une
  autre machine — `https://` ou `network.allowInsecureHosts` (config
  utilisateur seulement ; `llm.allowInsecureTransport` du dépôt ne suffit plus) ;
- ces réglages ne se posent **jamais** depuis un dépôt : le `.env` les ignore
  (variables nommées sur stderr) et la config du dépôt n'a pas de clé `network`
  (clé inconnue, `CONFIG_INVALID`).

Détail et limites : [Réseau d'entreprise](configuration.md#réseau-dentreprise-network).

## Le watcher

- `striart watch --status` — le daemon tourne-t-il ? PID ? journal dans
  `.striart/logs/watch.log` (ndjson : une ligne JSON par événement).
- Un daemon orphelin est détecté et signalé : PID file sans process, **ou**
  PID réattribué par l'OS à un autre process après un crash ou un
  redémarrage (le daemon est reconnu à sa ligne de commande — un process
  étranger n'est jamais tué). Même reconnaissance pour l'hôte de pty d'un
  agent `--open` et pour l'hôte de session ACP.
- `--stop` rend « arrêt demandé… » ? Le watcher termine son merge en cours
  (plus de 10 s) ; il retirera son PID file en sortant — `--status` pour
  suivre. Relancer `--stop` ne le brusque pas : la demande déjà accusée
  n'est pas re-signalée.
- `striart stop` avertit `PTY_HOST_STOPPING` ou `PTY_HOST_UNTOUCHED` ? Le
  terminal `--open` de l'agent s'arrête encore, ou a été laissé en place
  (non identifiable, autre utilisateur, arrêt en échec) : le clone reste
  protégé (`SESSION_LIVE`) tant qu'il vit — le fermer à la main avant
  `striart clean <agent>`.
- Le watcher ne surveille que `.git/refs/heads/` des clones — jamais les
  worktrees : une modification de fichier sans commit ne déclenche rien
  (c'est voulu : seuls les commits comptent). Les fichiers d'état
  transitoires de `.striart/` (verrous, temporaires) ne le réveillent pas.

## Où sont les logs ?

| Quoi | Où |
|---|---|
| Journaux de la CLI | stderr (`STRIART_LOG_LEVEL=debug` pour le détail) — jamais stdout |
| Journal du watcher en daemon | `.striart/logs/watch.log` (ndjson, rotation par taille : `logMaxBytes`, `logGenerations`) |
| Journal du dashboard en daemon | `.striart/logs/dashboard.log` |
| Journal de `watch --ui` | `.striart/logs/watch-ui.log` |
| Hôte de pty d'un agent (`--open`) | `.striart/logs/pty-<agent>.log` |
| Hôte de session ACP d'un agent | `.striart/logs/acp-host-<agent>.log` |
| Logs de session autonome | `.striart/logs/session-<agent>-<taskId>.log` |
| Tickets de conflit | `.striart/conflicts/<ticket>/` |
| Registre des agents | `.striart/agents.json` |
| File d'attente | `.striart/queue.json` |
| Registre d'usage des tokens | `.striart/usage/AAAA-MM-JJ.ndjson` (`striart usage`) |
| Plans, groupes, relectures, messages | `.striart/orchestration/`, `.striart/reviews/`, `.striart/collab/` |
| Historique des merges | `striart history` (reconstruit du graphe Git) |
