# Politique de sécurité

## Signaler une vulnérabilité

**Ne signalez pas une faille par issue publique.** Utilisez un canal privé :

- **GitHub** (préféré) : sur la page GitHub du dépôt, *Security* →
  *Report a vulnerability* (le rapport reste privé le temps du correctif).
- À défaut, ouvrez une issue demandant un canal privé **sans détailler la
  faille** — un moyen de contact direct vous sera fourni.

Vous recevrez un accusé de réception sous 7 jours. Merci de laisser un délai
raisonnable pour corriger avant toute divulgation publique (90 jours par
défaut, négociable selon la gravité).

## Versions supportées

Le projet est en 0.x : seule la **dernière version publiée** reçoit des
correctifs de sécurité.

## Modèle de menace

Striart est un outil de développement **local, mono-utilisateur**, qui tourne
sur la machine du développeur. Le modèle de menace en découle : l'adversaire
réaliste n'est pas quelqu'un qui a déjà un shell sur la machine (il a alors
déjà gagné), mais **du contenu non fiable qui transite par Striart** et **le
navigateur utilisé comme député confus**.

Quatre **ancres de confiance** portent le modèle, et aucune ne vit dans un
dépôt qu'un agent ou un tiers peut modifier : (1) la **clé de signature du
binaire natif**, épinglée dans le code publié et étendue seulement par la
config *utilisateur* (`native.trustedKeyIds`) ; (2) la **config utilisateur**
(`hooks.trustedRoots`, `env.allow`, `native.trustedKeyIds`, `network`,
`gate.envAllow`, `idle.closeRoots`) — JSON de données, droits vérifiés, hors du dépôt ; (3) le **jeton d'instance** du dashboard et du
Control Protocol (32 octets aléatoires, fichier 0600 / ACL utilisateur, jamais
en URL ni en cookie) — le dashboard est en outre servi sous un nom d'hôte
propre à l'instance ; (4) le **registre des clones** (`agents.json`), d'où se
reconstruisent tous les chemins. Le dépôt cible, son `.env`, ses configs
d'outils et ses fichiers d'instructions sont, eux, des **entrées non
fiables**.

Sources d'entrée non fiables, traitées comme telles :

| Source | Traitée comme | Barrière |
|---|---|---|
| Prompt de tâche (issue, fichier…) | donnée, jamais code | substitué en élément d'`argv`, `shell: false` |
| Sortie du LLM Router (chemins prédits) | donnée bruitée | filtrée : ni absolu ni `..` (`isSafeProjectPath`) |
| Sortie du LLM Merger (code fusionné) | proposition à valider | **Test Gate bloquant** avant tout commit |
| Ce que le Router **envoie** au fournisseur du LLM : l'arbre des fichiers suivis, la carte des candidats (symboles et première ligne de documentation de fichiers du dépôt), la demande | contenu du dépôt qui quitte la machine dès que le LLM est distant | Ollama local par défaut ; un fichier correspondant à `secretPatterns` n'est **jamais lu** ; les lignes de la carte passent par le caviardage de secrets (`redactSecrets`) ; au-delà de `tokens.router.maxScanFiles` aucun contenu n'est lu (chemins seuls) ; HTTPS exigé hors boucle locale (`src/net.ts`) ; une liste tronquée est déclarée au LLM |
| Fichiers touchés lus par le filet de chevauchement (`git diff --name-only` entre commits des clones, `overlap`) | chemins produits par un agent, donc non fiables | lecture seule (jamais l'index ni le worktree) ; `isSafeProjectPath`, caractères de contrôle écartés ; chemins caviardés dans les messages ; bornes `overlap.*` ; rebase anticipé jamais sur une session vivante |
| Signaux d'inactivité lus par le GC (`.striart/idle/`, `host.output` de l'hôte de pty, journaux, reflog du clone) | écrits par des process de la machine, y compris celui d'un agent | lecture stricte et bornée (taille, PID de l'hôte, horodatage ISO à la milliseconde) ; toute anomalie rend l'agent **actif** (fail closed) — un agent qui falsifie ces signaux ne peut que se garder lui-même en vie |
| Nom d'agent, id de ticket (CLI, URL) | identifiant contraint | validé par motif, chemins reconstruits du registre |
| Requêtes HTTP du dashboard | potentiellement pilotées par un site tiers **ou par un autre compte local** (la boucle locale est joignable de tous les comptes) | **jeton obligatoire** (lien de connexion à usage unique → cookie `HttpOnly; SameSite=Strict`), contrôle du `Host`, `Sec-Fetch-Site`, `Origin`, en-tête anti-CSRF `X-Striart` |
| stdin du serveur MCP | JSON-RPC d'un hôte — et, derrière lui, d'un agent | borné (1 Mo/ligne, appliqué pendant la lecture), parse isolé ; outils mutants **bornés au clone appelant**, aucun outil d'arbitrage humain |
| stdin de `striart api`, `POST /rpc` du dashboard (Control Protocol) | JSON-RPC d'une extension d'IDE ou d'un navigateur | cadrage borné (1 Mo, message trop gros écarté sans fermer le flux), validation positive des paramètres, schémas publiés ; refusé dans une session d'agent ; transport HTTP derrière le jeton |
| Plan YAML (`striart plan`) | donnée, jamais code | parse pur, validation complète avant tout effet ; une tâche autonome ne référence qu'un `profile` défini en config, jamais une commande |
| Requêtes fs d'un agent ACP (chemins) | identifiant à contraindre | bornées au clone — chemin absolu tiers ou `..` refusé |
| Chemin du repo cible | hors du contrôle de Striart | ouverture de terminal : passé en option de répertoire du lanceur ou cité selon la grammaire de chaque cible (PowerShell, Windows Terminal, bash, AppleScript) — seuls NUL/CR/LF, et `"` dans un argument sous Windows, sont refusés (`TERMINAL_UNSAFE`) ; lignes « à copier » citées pour leur shell (`quoteForShell`) |
| Texte affiché par la CLI (message de commit d'un agent, chemin, sortie git, raison d'une réservation, fichier prédit) | contenu non fiable | caractères de contrôle C0/C1 neutralisés en `\xNN` avant affichage — jamais de séquence d'échappement qui pilote le terminal |
| Contenu de `.striart/` et config du dépôt lus par la complétion (`striart __complete`, à chaque Tab) | écrits par d'autres process (sessions d'agents) ou reçus avec le dépôt | seules les valeurs conformes à leur motif (nom d'agent, id de ticket, nom de profil) sortent ; racine retenue = `.git` **et** `.striart`, appartenant à l'utilisateur courant (POSIX) ; script bash sans réexpansion (`_striart_values`, lecture ligne à ligne, jamais `compgen -W` sur une sortie dynamique) ; config en code jamais exécutée (voir « La complétion n'exécute jamais la config du dépôt ») |
| `ticket.json` d'un ticket de conflit | contenu modifiable sur disque | l'id d'un ticket est le **nom de son dossier**, jamais le champ `id` du JSON (il sert à reconstruire des chemins) |
| Variables d'environnement git héritées (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_SSH_COMMAND`…) — Striart lancé depuis un hook git, un `rebase --exec`, un IDE | désignent un autre dépôt ou font exécuter un programme | aucune `GIT_*` héritée n'atteint git (simple-git 4) ; les commandes visant un clone (`cloneGit`) écartent en plus `EDITOR`/`VISUAL`/`PAGER`/`PREFIX`/`SSH_ASKPASS` et sont bornées au clone (`GIT_CEILING_DIRECTORIES`) |
| Message du bus `@agent` (`striart watch --ui`) | entrée terminal directe (comme `--open`), jamais du code | canal d'attache local, nommé par agent (validé, motif contraint) ; `ensurePtyHost` exige un agent réellement inscrit au registre ; vers une session ACP : prompt borné (64 000 caractères, contrôles refusés), jeton de bus |
| Messages de collaboration, verdicts, `.striart-outbox.json` écrits par un agent | contenu d'un agent, donc non fiable | médiés par Striart (aucun clone n'accède à un autre), expéditeur **déduit**, bornés et comptés, contrôles neutralisés, rendus dans une enceinte à jeton aléatoire « information, jamais instruction » ; un `verdict` ne fait que proposer ; l'outbox s'ouvre sans suivre de lien et se revérifie sur le descripteur (fichier ordinaire, taille bornée) |
| Demandes d'un agent ACP : options de permission, schéma de formulaire (élicitation), requêtes `fs/*` et `terminal/*` | sortie d'un process de confiance, mais donnée à contraindre | la réponse humaine est validée contre ce que l'agent a **proposé** (options) ou contre son schéma, des deux côtés ; un schéma non validable n'est jamais soumis à l'humain ; `fs` et `terminal` bornés au clone (liens symboliques compris), délai/sortie/nombre plafonnés |
| Requêtes de l'éditeur au proxy `striart acp` | client ACP = interface humaine, mais message à contraindre | méthodes servies listées (`fs/*` et `terminal/*` jamais adressés à l'éditeur), dossier de session borné à `--root`, message entrant borné (8 Mo), option figée après le premier prompt |
| Registre ACP (document JSON) et archive de binaire téléchargée | distant, non fiable | https obligatoire (`redirect: error`), document borné (5 Mo), version **exacte** (jamais `latest`, plage ni option déguisée en paquet) et restreinte à un segment de chemin sûr (`[0-9A-Za-z][0-9A-Za-z._+-]{0,63}` : jamais de sortie du dossier `.striart/acp-agents/`), empreinte sha256 publiée exigée et vérifiée, arbre extrait **revérifié** (lien symbolique, lien dur ou chemin sortant → `ACP_EXTRACT_UNSAFE`, extraction supprimée), variables d'environnement du registre refusées hors `acpRegistry.allowEnv` ; métadonnées seules par défaut, téléchargement par décision explicite |
| Événement lu sur stdin par `striart hook` (envoyé par l'outil de coding) | JSON d'un outil, jamais de confiance | entrée et chemins bornés (4096 caractères, 256 fichiers), réponse **neutre** sur toute anomalie, jamais de blocage ; la config d'un dépôt n'est lue qu'en données hors racine de confiance |
| Config UTILISATEUR (`hooks.trustedRoots`, `env.allow`, `native.trustedKeyIds`, `network`, `gate.envAllow`, `idle.closeRoots`) | données de l'utilisateur, jamais exécutées | JSON strict, clé inconnue refusée, droits vérifiés (POSIX), racine du système de fichiers refusée ; toute anomalie = **aucune confiance** (et, pour `network`, les appels sortants non locaux sont refusés) |
| Binaire natif `striart-native` et son manifeste | code exécuté, livré par un paquet npm | manifeste signé (minisign/Ed25519), SHA-256 et taille vérifiés avant chaque exécution, jamais exécuté si altéré ; la **clé** signataire doit figurer dans une liste de confiance **hors du paquet** (clé épinglée dans le code + `native.trustedKeyIds` de la config utilisateur), sinon `NATIVE_INTEGRITY_FAILED` ; manifeste de clé jetable (`ephemeral`) refusé à l'exécution ; sortie JSON validée positivement |
| `.env` de la racine du dépôt | donnée non fiable livrée avec un dépôt — une variable y devient héritée par **tous** les enfants (daemons, sessions, hôte de pty, hooks) | `util.parseEnv` (jamais `loadEnvFile`) + **liste blanche** ; liste noire (`NODE_*`, `LD_*`, `PATH*`, `STRIART_NATIVE_BIN`…) non relâchable ; jamais écrasé sur une variable du shell ; rien chargé dans un clone d'agent ni une session ; seule la config **utilisateur** (`env.allow`) étend la liste |
| Journal de session d'un agent (blocs `striart-verdict-<jeton>` / `striart-handoff-<jeton>`) | contient aussi les sorties d'outils, donc le contenu de fichiers écrits par un autre rôle | seule la balise portant le jeton aléatoire du tour (128 bits, connu du seul briefing du tour) est acceptée ; sans jeton valide, rien (fail closed) ; lecture linéaire du journal |
| Schéma de formulaire, titre et options d'une demande de permission d'un agent ACP | données d'un agent, évaluées/affichées côté humain | motif de schéma analysé structurellement (refus des formes à retour arrière exponentiel : ReDoS) ; titre (8 192 octets), 16 options au plus, noms neutralisés (contrôles, bidi, caractères invisibles) |
| Journaux de session lus par MCP (`striart://…`) | contenu d'un agent, borné au clone appelant | nom de fichier reconnu par motif exact `session-<agent>-<8 hex>.log` : un agent `auth` ne lit pas `session-auth-ui-…` |
| Destinations des appels sortants (`llm.baseUrl`, `ollamaHost`, URL de webhook, `acpRegistry.url`) | écrites dans la config d'un dépôt, donc non fiables | point d'entrée unique `src/net.ts` : HTTPS exigé hors boucle locale, aucune redirection suivie, liste blanche d'hôtes et mode hors ligne **de l'utilisateur** (voir « Appels sortants et réseau d'entreprise ») |
| Réglages réseau (proxy, CA, TLS minimal, hors ligne, liste blanche) | décision de l'utilisateur ; un dépôt hostile voudrait les poser | environnement du shell et config **utilisateur** seulement ; le `.env` d'un dépôt les refuse, la config d'un dépôt n'a pas de clé `network` |
| Tests exécutés par le Test Gate (`testCommand`) | code que l'agent a pu écrire ou modifier | environnement réduit à une **liste blanche** (`gateEnv`) : ni clé d'API, ni webhook, ni jeton |
| Sorties d'outils (Test Gate, sessions d'agents, hooks de la cible, journaux) | peuvent contenir des secrets | caviardage par le contenu et par valeurs exactes avant écriture (voir « Confidentialité des données locales ») |

## Périmètre — ce que Striart promet

Ces invariants sont des engagements de sécurité ; toute manière de les
contourner est une vulnérabilité à signaler :

- **Aucune donnée utilisateur ne devient du code ni un chemin.** Le prompt
  d'une tâche est passé en élément d'`argv` avec `shell: false`, jamais
  interprété par un shell. Les noms d'agents et ids de tickets sont validés,
  les chemins reconstruits depuis le registre, jamais depuis une URL. Les
  chemins prédits par le LLM sont filtrés (ni absolus ni `..`). Une valeur
  substituée qui commence par `-` (prompt, consignes, fichier de consignes,
  commande du gate) reçoit une
  espace de tête : lue comme un argument positionnel, jamais comme une option
  de l'outil lancé. Le `command` d'une tâche de plan, tapé dans le shell du pty,
  n'est qu'un **nom d'exécutable** (`PLAN_INVALID`,
  `COMMAND_NOT_AN_EXECUTABLE_NAME`).
- **Les clés API ne sont jamais stockées.** Ni dans `striart.config`, ni dans
  `.striart/` : la config ne porte que le *nom* d'une variable
  d'environnement (`apiKeyEnv`, `urlEnv` pour les webhooks). Une config de
  dépôt hostile ne peut pas pour autant les exfiltrer : `llm.apiKeyEnv` doit
  avoir la forme d'une clé (`*_API_KEY`, `*_KEY`, `*_TOKEN`) et ne pas
  désigner un secret d'infrastructure (`GITHUB_*`, `NPM_*`, `AWS_*`, `SSH_*`,
  `STRIART_*`…), et la clé ne part qu'en HTTPS (boucle locale exemptée) —
  `LLM_CONFIG_INVALID` sinon ; `llm.allowAnyApiKeyEnv` et
  `llm.allowInsecureTransport` sont les relâchements explicites, affichés par
  `doctor` — le second ne suffit plus, seul, pour un hôte distant en HTTP : la
  couche réseau exige aussi que l'hôte figure dans `network.allowInsecureHosts`
  de la config **utilisateur**. Le `.env` de la racine du dépôt est lui aussi une donnée **non
  fiable** : il est filtré par une liste blanche (noms `*_API_KEY`, webhooks,
  variables d'affichage), une liste noire non relâchable (`NODE_*`, `LD_*`,
  `PATH*`, `GIT_*`, `*_PROXY`, `STRIART_NATIVE_BIN`, `STRIART_CONFIG_HOME`…)
  l'emporte toujours, et seule la config **utilisateur** (`env.allow`) peut
  étendre la liste blanche. Sans ce filtre, un `.env` livré avec un dépôt
  (`NODE_OPTIONS=--require ./evil.js`, `LD_PRELOAD`) serait de l'exécution de
  code héritée par tous les enfants.
- **Le dashboard n'expose rien hors de la machine, et rien sans jeton.** Lié
  à 127.0.0.1, il n'est plus ouvert à quiconque joint la boucle locale (tout
  compte de la machine le peut). Au démarrage, Striart émet un **lien de
  connexion** : code signé (HMAC-SHA256 du jeton de l'instance, port compris),
  valable `dashboardLinkTtlMs` (5 min par défaut), **à usage unique** (nonce
  consommé, vérification en temps constant), échangé contre un cookie de
  session `HttpOnly; SameSite=Strict` dont la valeur est un identifiant
  aléatoire propre — jamais le jeton —, stocké côté serveur sous forme
  d'empreinte SHA-256, expirant (`dashboardSessionTtlMs`, 12 h) et plafonné en
  nombre. Le jeton (32 octets aléatoires, un par instance) n'est ni journalisé,
  ni dans une URL, ni dans un cookie : il vit dans un fichier lisible par
  l'utilisateur seul (0600 sous POSIX ; ACL protégée réduite au SID de
  l'utilisateur sous Windows, posée par `icacls` et **vérifiée** en SDDL — si
  elle ne peut pas être posée, le dashboard ne démarre pas). Le lien est émis
  par le process de l'utilisateur, jamais par un daemon (dont la sortie est un
  journal sur disque). Barrières, dans l'ordre, sur **toute** requête (lectures
  comprises) : en-tête `Host` égal au nom de l'instance (la défense contre le
  DNS rebinding, où un site tiers fait pointer son domaine vers 127.0.0.1) ; `Sec-Fetch-Site` ni
  cross-site ni **same-site** (un autre port local est « same-site » et
  `SameSite=Strict` ne l'arrêterait pas) ; session valide (401 sans aucune
  donnée du dépôt) ; puis, sur `/rpc`, `Origin` du serveur, `X-Striart: 1` et
  `Content-Type` JSON. Les anciennes routes `/api/*` répondent 410.
  **Nom d'hôte par instance** (`dashboardHostname: 'instance'`, défaut) : le
  dashboard est servi sous `<id-aléatoire>.localhost`, tiré à chaque démarrage.
  Raison : un cookie n'est pas isolé par port (RFC 6265 §8.5) ; sous
  `localhost`, le navigateur enverrait le cookie à tout serveur `localhost:*`
  — le serveur de développement d'un agent, par exemple — qui pourrait le
  rejouer. L'adresse `localhost` nue n'est plus servie (403) ;
  `dashboardHostname: 'localhost'` est un relâchement journalisé et affiché par
  `doctor`. **Contenu servi** : la page est rendue dans la langue de l'instance
  sous une CSP stricte (`default-src 'none'`, `connect-src 'self'`, script et
  feuille de style identifiés **par empreinte SHA-256, une par langue** — ni
  `unsafe-inline`, ni source externe), avec `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store` et
  `nosniff` ; tout le texte variable est écrit par le client via `textContent`
  ou un gabarit échappant. `/favicon.ico` répond 204 sans donnée ni session (le
  navigateur le demande de lui-même, y compris sur la page « connexion requise »).
  `dashboardAllowedHosts` (vide par défaut) relâche **uniquement** le contrôle
  `Host` — pour un tunnel web (Codespaces) ou un proxy inverse —, avec des
  motifs stricts (jamais `*`, ni IP publique, ni IPv6) ; jeton, cookie,
  `Origin` et anti-CSRF restent exigés ; le relâchement est journalisé à chaque
  démarrage et affiché par `doctor`. Limite assumée : un process du **même
  utilisateur** peut lire le fichier de jeton (même frontière que l'accès à
  `.striart/` — voir « Hors périmètre »).
- **Le canal d'attache du pty possédé (`--open`, `striart attach`, le bus
  `@agent` de `watch --ui`) ne sort jamais de la machine.** Socket Unix ou
  named pipe Windows, jamais une adresse réseau. Côté POSIX, le fichier du
  socket est explicitement mis à `0600` (propriétaire seul) après ouverture
  — sans ce durcissement explicite, l'umask du process aurait pu laisser un
  autre utilisateur local (sans accès en écriture au repo, donc en dehors du
  reste du modèle de menace) s'y attacher et injecter des frappes dans une
  session en cours. L'hôte natif ferme cette fenêtre : le socket naît
  directement en `0600` (umask `0177` le temps du `bind`, dossier parent en
  `0700`). Côté Windows, l'hôte natif crée le named pipe avec une **DACL à un
  seul ACE — l'utilisateur courant** (`D:P(A;;GA;;;<SID>)`, protégée contre
  l'héritage : ni « Everyone », ni les administrateurs d'une autre session),
  refuse les clients distants (`PIPE_REJECT_REMOTE_CLIENTS`) et exige d'être
  la première instance du nom (contre le squat) ; un test Rust relit la DACL
  du pipe et la compare. (Le canal de l'**hôte de session ACP**, lui, est créé
  par Node, dont la DACL par défaut n'a pas été vérifiée indépendamment :
  chaque client s'y annonce avec un jeton — propriétaire en mémoire seulement,
  bus dans un fichier 0600 — ce qui borne le canal aux comptes capables de lire
  `.striart/`.)
- **La sortie machine ne fait pas fuir de secret.** En `--json`, le champ
  `error.details` passe par un caviardage défensif récursif
  (`publicErrorDetails`, `src/errors.js`) : tout champ nommé `env`, `value`,
  `profile`, `header(s)`, `cookie(s)`, se terminant par `url`, ou évoquant un
  secret (`secret`, `token`, `password`, `api_key`, `authorization`,
  `credential`…) est remplacé par `"[redacted]"`. Seule exception : `profile`
  reste lisible quand c'est un **nom** de profil bien formé (identifiant de
  config, publié par `striart profiles`) ; une définition de profil (objet :
  commande, `env`) reste caviardée. En amont, `CONFIG_INVALID`
  ne porte que la cause (`reason`) et la **clé** fautive, `PROFILE_INVALID`
  que la cause et le **champ**, `LLM_CONFIG_INVALID` que le provider et le
  **nom** de la variable de clé — jamais la valeur fautive, l'`env` d'un
  profil ni une clé. Les champs `cause` (`CONFIG_INVALID` illisible,
  `PLAN_INVALID` YAML, `*_CORRUPT`) reprennent le message du parseur, déjà
  présent dans le message d'erreur : ils n'exposent rien de plus que lui. Les journaux ne vont jamais sur
  stdout (stderr, ou un fichier sous `watch --ui`) : ni le document `--json`
  ni le protocole MCP ne peuvent être corrompus par une ligne de log.
- **Une ligne « à copier » ne s'exécute pas à la place de l'utilisateur.**
  La commande de lancement manuel de `start` (`cd <chemin>; <outil>`) et la
  piste de `lock --start` citent chaque valeur non fiable (chemin du dépôt,
  raison libre) selon la grammaire du shell qui la recevra (`quoteForShell`,
  `src/terminal.js`) : guillemets simples en POSIX et PowerShell (aucune
  expansion de `$…` ni substitution de commande), guillemets doubles sous
  `cmd` — où seule une expansion `%VAR%` résiduelle reste possible, aucune
  exécution. L'onglet `--open` lance Node et la CLI par chemins absolus
  (pas de dépendance au `PATH`).
- **Les gardes de session ne se désarment pas sur une interruption.** Sur
  Ctrl+C ou SIGTERM, `run --autonomous` et `run --on-main` tuent d'abord
  l'arbre de l'agent (ACP : `session/cancel`, puis kill), **puis** dépublient
  le `sessionPid` ou la session principale — jamais un clone ou un principal
  déclaré libre pendant que l'agent y écrit encore. `lock --start` refuse un
  PID éphémère (`LOCK_PID_EPHEMERAL`) ou mort (`LOCK_PID_DEAD`) : une
  réservation qui tomberait à la fin de la commande donnerait une fausse
  protection. Un process d'un autre utilisateur (`EPERM`) est jugé vivant.
- **Un PID publié par Striart n'est cru que s'il désigne encore le process
  de Striart, et jamais un PID non identifié n'est tué.** Les daemons
  `watch`/`dashboard`, l'hôte de pty et l'hôte de session ACP d'un agent sont
  reconnus à leur ligne de commande et à leur heure de création, lues par le
  binaire natif (`checkProcessInstance`, `src/process-info.ts`) : un numéro
  réattribué par l'OS à un autre process (après un crash ou un redémarrage)
  est traité comme orphelin — **jamais tué** par `--stop` ou `striart stop`,
  et il ne bloque plus `--daemon`, ni `clean` (`SESSION_LIVE`) à vie. Une
  identité illisible (process d'un autre utilisateur) est présumée vivante
  mais n'est **jamais tuée** : `--stop` refuse (`DAEMON_IDENTITY_UNVERIFIED`),
  `striart stop` laisse l'hôte de pty en place (avertissement
  `PTY_HOST_UNTOUCHED`) — dans les deux cas le PID file est conservé, sans
  quoi `SESSION_LIVE` serait désarmée sur un clone au terminal encore
  vivant. Un process qu'on n'a pas le droit de signaler (`EPERM`) est traité
  de même (`DAEMON_STOP_DENIED`). Toute décision destructive (kill, oubli
  d'un PID file, réutilisation d'un hôte de pty) relit l'identité **sans
  cache** ; le cache d'identité (5 s) ne sert qu'à l'affichage et aux abstentions, et
  il est purgé à la mort constatée d'un PID.
- **Un arrêt demandé n'interrompt pas un merge en vol, sur aucun OS.**
  `--stop` et `striart stop` passent par une demande d'arrêt sur disque
  (`src/stop-request.ts` — `.striart/<nom>.stop`,
  `.striart/pty/<agent>/host.stop`) que le process visé lit, accuse et
  traite comme un SIGTERM, Test Gate compris ; le signal n'est qu'un repli
  sans accusé (sous Windows, c'est un TerminateProcess). Une demande
  accusée n'est jamais re-signalée. La demande ne désigne qu'un `pid`
  vérifié par identité, et elle est retirée au démarrage d'un nouveau
  daemon : une demande restée d'un daemon précédent ne vise jamais son
  successeur, même sous un numéro recyclé. Comme le reste de `.striart/`,
  ce fichier peut être écrit par tout process local ayant accès en
  écriture au dépôt — au pire il demande un arrêt **propre**, ce qu'un tel
  process pourrait obtenir de toute façon (hors modèle de menace).
- **Un verrou n'est jamais cassé si son détenteur peut être vivant.** Le
  verrou principal et le verrou d'état ne sont cassés que sur preuve — process
  mort, PID réattribué (identité relue **sans cache**, heure de création
  comprise), contenu invalide ancien. Un détenteur **vivant** dont le
  battement est figé n'est pas cassé (`HOLDER_FROZEN`) sauf relâchement
  explicite `lock.breakFrozenHolderAfterMs`, journalisé à chaque cassure ;
  un fichier illisible n'est jamais cassé à l'aveugle ; les cassures sont
  sérialisées et comparent contenu et date. Avant un effet irréversible, une
  opération revérifie qu'elle tient toujours le verrou (`LOCK_LOST`) et que
  `HEAD`, `MERGE_HEAD` et l'index sont ceux qu'elle a posés
  (`MERGE_STATE_CHANGED`) — rien n'est commité sinon, et un merge ouvert qui
  n'est pas le sien n'est jamais annulé (`MERGE_RECOVERY_BLOCKED`).
- **Les fichiers d'état s'écrivent atomiquement et sous verrou.** Écriture par
  fichier temporaire unique + `fsync` + renommage, lecture-modification-écriture
  sous le verrou d'état ; un échec laisse l'état précédent intact
  (`STATE_WRITE_FAILED`), jamais un fichier tronqué.
- **Fail closed sur ce qu'on ne peut pas vérifier.** `striart stop` ne
  considère un clone disparu que sur `ENOENT` ; toute autre erreur d'accès,
  ou un clone illisible par git, vaut travail présumé existant (refus sans
  `--force`). `prune` refuse une rétention invalide au lieu de tout
  supprimer.
- **Les secrets trackés sont retirés des clones agents** (`secretPatterns`,
  sparse-checkout) — un échec de ce nettoyage fait échouer le `start`, jamais
  de dégradation silencieuse. L'ensemble exclu est calculé par **git** (`ls-files
  --exclude`), pas par une réimplémentation : un motif `/.env`, `secrets/` ou
  `**/.env` agit comme dans un `.gitignore`. Le scan de l'historique (avant
  tout clonage) lit les chemins en `-z`, sans guillemetage ni détection de
  renommage : un nom non ASCII ou un renommage vers un nom de secret ne
  l'esquive pas. Un motif non supporté (`!`, `#`, vide) est refusé
  (`SECRET_PATTERN_INVALID`) ; `secretPatterns: []` est un relâchement affiché
  par `doctor`.
- **Jamais de commit sans Test Gate vert**, y compris pour une fusion produite
  par LLM. Le gate s'exécute dans le **conteneur de process natif** (Job Object
  / groupe + subreaper) : un descendant du test encore vivant après
  `gateOrphanGraceMs` est tué et rend le gate **rouge**
  (`GATE_ORPHAN_PROCESS`) même si la commande a rendu 0 ; un nettoyage
  incomplet (`JOB_TERMINATE_INCOMPLETE`) ou un binaire natif indisponible
  (`GATE_NATIVE_UNAVAILABLE`) est rouge aussi — jamais un vert par défaut.
  `gateContainer: 'process'` est le relâchement explicite (exécution classique,
  sans détection d'orphelins).
- **La profondeur d'orchestration MCP est bornée** : une session autonome ne
  peut pas engendrer d'agents ni merger via le serveur MCP (voir la frontière
  de confiance ci-dessous pour sa limite exacte).
- **Le serveur MCP est borné à son appelant, et n'offre aucun geste d'arbitrage
  humain.** Lancé depuis le clone d'un agent (ou `--agent`), il n'agit que sur
  cet agent ; hors clone — un éditeur ouvert sur le principal — il est en
  **lecture seule** (changement de comportement de 0.11), sauf
  `mcp.scope: 'orchestrator'`, relâchement journalisé et affiché par `doctor`.
  À aucun niveau il n'existe d'outil pour répondre à une permission, clore un
  ticket sans Test Gate (`striart_resolve` a été retiré) ou libérer le
  principal ; et préparer/appliquer la résolution d'un ticket
  `PROTECTED_PATHS_CHANGED` est refusé à tout appelant MCP
  (`MCP_PROTECTED_TICKET`) : approuver un changement de chemin protégé est la
  décision que la garde réserve à l'humain. Un appelant n'est reconnu comme
  clone que par la forme de son chemin **confirmée par le registre**.
- **Le plan humain est refusé à un agent.** `striart api`, `striart acp`,
  `striart dashboard`, l'émission d'un lien de connexion **et** les commandes
  `resolve`, `merge`, `stop`, `lock`, `rollback` et `promote` refusent une
  session autonome (`STRIART_SESSION=1` — `CONTROL_NESTED_SESSION`) : sans cela,
  un agent arbitrerait ses propres permissions, approuverait son propre ticket
  (`resolve --apply`), clorait ses tickets et lèverait la session principale. Garde *advisory*, comme la profondeur MCP (voir
  « frontières »).
- **Un agent ne change pas les fichiers qui l'instruisent, le configurent ou
  configurent Striart.** `protectedAgentPaths` : 81 motifs vérifiés contre la
  documentation des outils (`AGENTS.md`, `CLAUDE.md`, `.claude`, `.mcp.json`,
  `.vscode/settings.json` — l'auto-approbation, cf. CVE-2025-53773 —,
  `.github/hooks/`, …) **et la config de Striart** (`striart.config.*`,
  `.striartrc*`, `.striart/`, la clé `striart` de `package.json`, la
  méta-config de cosmiconfig). Un changement *effectif* refuse le merge et
  ouvre un ticket `PROTECTED_PATHS_CHANGED`, **avant** toute fusion LLM et
  avant le Test Gate, fail closed ; seule une résolution humaine explicite de
  chaque chemin le lève. Ces fichiers sont relus par les sessions suivantes
  avec la confiance qu'on accorde au dépôt : sans la garde, une injection de
  prompt ponctuelle devenait une compromission persistante, ou un agent qui
  réécrit `testCommand` désarmait le Test Gate. `extend` ajoute ; seul `allow`
  en retire, journalisé à chaque merge et affiché par `doctor` ; la
  comparaison est insensible à la casse par défaut.
- **Le binaire natif n'est jamais exécuté s'il n'est pas vérifié.** Résolu
  dans un ordre fixe et visible (`striart doctor`) — jamais un repli muet : le
  paquet de plateforme est contrôlé contre un manifeste **signé** (minisign,
  Ed25519 ; schéma nommé, jamais un défaut implicite), puis SHA-256 et taille,
  à chaque appel ; signature, empreinte ou version divergente →
  `NATIVE_INTEGRITY_FAILED`, rien n'est lancé. La **clé privée** de signature
  n'existe qu'en secret de CI, **jamais dans le dépôt** (seule la clé publique
  l'est, `native/keys/`). `STRIART_NATIVE_BIN` désigne un binaire de son choix
  (chemin absolu) : son intégrité n'est **pas** vérifiée, c'est un choix
  explicite de l'utilisateur que `doctor` signale. **Ancre de confiance** : une
  signature de manifeste prouve que le manifeste, la clé publique du paquet et
  les binaires sont cohérents — pas leur provenance (un paquet principal
  malveillant embarquerait sa propre clé). L'identifiant de la clé signataire
  est donc comparé à une liste qui vit **hors du paquet vérifié** : la clé
  **épinglée dans le code publié** et `native.trustedKeyIds` de la config
  **utilisateur** (jamais celle du dépôt, pour une organisation qui re-signe ses
  archives) ; clé inconnue → `NATIVE_INTEGRITY_FAILED`. Un manifeste signé
  d'une clé **jetable** (`pack:release --ephemeral-signing-key`, réservé à
  `--dry-run`) est marqué `ephemeral` et refusé à l'exécution. La provenance du
  paquet principal reste celle du registre (scope npm `@jumsay`, à revendiquer
  sur le registre public — action de l'utilisateur) et, côté GitHub seulement,
  de l'attestation sigstore (`gh attestation verify`) ; le workflow de la CI auto-hébergée n'en
  produit pas. Limite assumée : le cache de vérification (taille, date, inode)
  ne protège pas d'un process du **même utilisateur** qui remplacerait le
  binaire entre deux vérifications (même frontière que l'accès à `.striart/`). Le binaire s'exécute en
  `argv`, `shell: false`, avec un délai ; sa sortie est validée positivement.
- **Le registre d'usage ne contient jamais de contenu.** `.striart/usage/` est
  reconstruit champ par champ (liste blanche) : ni prompt, ni réponse, ni
  contenu de fichier, ni clé ; les chaînes sont bornées et débarrassées de
  leurs contrôles. Le **cache de résultats** (`.striart/usage/cache/`) garde,
  lui, des sorties de modèle — le Router (chemins prédits) et la Memory Layer
  par défaut, le Merger seulement sur demande explicite (relâchement
  affiché) ; il n'est **jamais** utilisé pour une décision d'arbitrage
  (juge, relecture), est clé sur la version du prompt, le rôle, le modèle et
  les entrées, et chaque lecture est revalidée par l'appelant. Les plafonds
  `tokens.budgets` sont *fail closed* (un appel refusé avant tout envoi) ;
  l'usage entrée/sortie rapporté par un agent ACP est une information non
  fiable (seul le coût est plafonnable). Une comptabilité qui échoue n'est
  jamais silencieuse : journalisée sous `TOKEN_ACCOUNTING_FAILED`, et refusée si
  `tokens.onAccountingError` vaut `fail`. Aucun appel sortant ne suit de
  redirection (`redirect: 'error'`, sauf le suivi borné des archives du registre
  ACP, revérifié saut par saut) : une redirection ne transporte jamais une clé
  vers un autre hôte.

### Appels sortants et réseau d'entreprise

Striart émet des appels sortants vers : le LLM (Ollama, OpenAI-compatible,
Anthropic, Azure), les webhooks de notification, la sonde Ollama de
`init`/`doctor`, le registre ACP (document) et ses archives de binaire. Ils
passent **tous** par `src/net.ts` ; un test unitaire échoue si un autre module de
`src/` appelle `fetch()` ou `http(s).request()` (seul le client navigateur du
dashboard, qui parle à son propre serveur, y échappe). Engagements :

- **HTTPS exigé hors boucle locale, avec ou sans clé d'API**
  (`NET_INSECURE_TRANSPORT`) ; la seule exception est un hôte déclaré dans
  `network.allowInsecureHosts` de la config **utilisateur** (relâchement
  journalisé une fois par hôte et affiché par `doctor`). `localhost`, `127.x` et
  `[::1]` sont exemptés de toute la politique distante.
- **La vérification TLS n'est jamais coupée** : `NODE_TLS_REJECT_UNAUTHORIZED=0`
  dans l'environnement fait refuser l'appel (`NET_INSECURE_TRANSPORT`, raison
  `TLS_VERIFICATION_DISABLED`) ; une chaîne non fiable donne `NET_TLS_UNTRUSTED`
  avec la piste « ajouter la CA d'entreprise ».
- **Aucune redirection n'est suivie** (`NET_REDIRECT_REFUSED`). Seul le registre
  ACP a droit à un suivi borné (3 sauts) pour ses archives, et chaque saut repasse
  par tous les contrôles (liste blanche, HTTPS, hors ligne).
- **Liste blanche d'hôtes et mode hors ligne** (`network.allowedHosts`,
  `network.offline`, `STRIART_ALLOWED_HOSTS`, `STRIART_OFFLINE`) : décisions de
  l'utilisateur ; avec deux sources, la plus restrictive gagne (hors ligne = l'une
  OU l'autre, liste blanche = intersection, TLS = le plus strict).
- **Proxy d'entreprise : fail closed.** Un proxy configuré mais inapplicable sur
  ce Node refuse l'appel (`NET_PROXY_UNSUPPORTED`) au lieu de sortir en direct.
  Un proxy SOCKS est refusé (`NET_PROXY_UNSUPPORTED`, raison `SCHEME`) ;
  `ALL_PROXY` n'est pas lue. L'authentification du proxy se donne par `STRIART_PROXY_AUTH`,
  jamais en config ; elle n'est jamais transmise aux sessions d'agents.
- **Les réglages réseau sont des décisions de l'utilisateur, jamais d'un dépôt.**
  Ils vivent dans le shell et dans la config utilisateur ; le filtre du `.env`
  refuse `*_PROXY`, `NODE_*`, `STRIART_OFFLINE`, `STRIART_ALLOWED_HOSTS`,
  `STRIART_TLS_MIN_VERSION`, `STRIART_PROXY_AUTH` et `STRIART_CA_FILE`, et même
  `env.allow` ne peut pas les viser. Une config utilisateur illisible ne rend
  jamais le réseau « sain » : les appels distants sont refusés.

**Limites assumées.** (1) La couche contrôle le **nom d'hôte**, pas l'adresse IP
résolue : un hôte autorisé dont le DNS est détourné (DNS rebinding) n'est pas
détecté, et un webhook vers une adresse locale reste possible (pas de filtre
SSRF sur la destination). (2) `ALL_PROXY` et SOCKS ne sont pas supportés.
(3) Pas de test de bout en bout avec un vrai proxy HTTPS ni, pour
`network.caFile` transmis aux sessions, avec un outil d'agent réel. (4) Les
variables de proxy ordinaires (`HTTP(S)_PROXY`, `NO_PROXY`) sont **héritées telles
quelles** par les sessions d'agents, identifiants d'URL compris : un mot de passe
mis dans l'URL de `HTTPS_PROXY` est visible de l'outil lancé (préférer
`STRIART_PROXY_AUTH`, quand le Node le permet). (5) `network.caFile` devient
`NODE_EXTRA_CA_CERTS` d'une session **sauf** si le shell en a déjà posé un autre
(le shell gagne, le fait est journalisé) ; l'`env` d'un profil d'agent (config du
dépôt) est appliqué *après* et peut donc le remplacer — le profil est du
config-as-code (voir « Frontières de confiance »).

### Confidentialité des données locales

- **`.striart/` est réservé à l'utilisateur** (`privateStateDir: true`, défaut) :
  dossiers `0700` et fichiers `0600` (POSIX), DACL **protégée** (héritage coupé)
  limitée au SID de l'utilisateur, posée par `icacls` et vérifiée en SDDL
  (Windows). Il contient du code source (versions des tickets), des sorties
  d'outils, les prompts de la file et les jetons du Control Protocol. Un
  resserrement impossible (système de fichiers sans permissions, propriétaire
  étranger, `icacls` en échec) est un **refus** (`STATE_UNPROTECTED`), jamais un
  repli silencieux ; `privateStateDir: false` est le relâchement explicite,
  journalisé et affiché par `doctor`. La protection est posée avant de prendre le
  verrou principal (jamais dessous), une fois par racine et par process, et migre
  de façon idempotente un `.striart/` préexistant. `agents/` et `removing/` ne
  sont **jamais parcourus** : leurs objets git sont des hardlinks partagés avec le
  dépôt principal — changer leur ACL changerait aussi celle du principal — ; leur
  confidentialité reste celle du dépôt. Limite : un process du **même utilisateur**
  reste hors modèle (voir « Hors périmètre »).
- **Le Test Gate ne reçoit pas vos secrets.** Il exécute `testCommand`, donc des
  tests que l'agent a pu écrire. Son environnement est une **liste blanche**
  (chemins, locale, proxy et CA pour `npm install`, `NODE_*`, `npm_config_*`…) sans
  ce dont le nom ressemble à un secret ; les clés d'API (`*_API_KEY`), les URL de
  webhook et les variables que la config désigne pour les porter (`apiKeyEnv`,
  `urlEnv`) en sont **toujours** retirées, ainsi que `STRIART_SESSION`. Le dépôt
  peut *demander* des variables (`gateEnv`) ; seule la config **utilisateur**
  (`gate.envAllow`) les *autorise* — une demande non couverte est écartée et
  annoncée en tête du journal du gate (noms seulement). `gateEnv: 'inherit'`
  (tout l'environnement) est un relâchement explicite affiché par `doctor`.
- **Les journaux et sorties d'outils sont caviardés avant écriture**
  (`src/redact-secrets.ts`) : par le **contenu** (clés de fournisseurs à format
  connu, JWT, en-têtes `Authorization`, identifiants dans une URL, URL de webhook,
  blocs de clé privée, affectations `…KEY=valeur`) et par **valeurs exactes**
  (clés d'API et URL de webhook de l'environnement, `env` d'un profil). Appliqué
  au journal du Test Gate, aux journaux de session et de session ACP, aux
  tickets, à la sortie des hooks de la cible (ticket, message d'erreur et
  `--json`) et aux journaux pino. Coût borné (motifs sans imbrication, tranches de
  256 Kio). **Défense en profondeur, pas une garantie** : un secret sans forme
  reconnaissable n'est trouvé que par sa valeur exacte (≥ 8 caractères), et un
  secret à cheval sur deux tranches d'une même ligne géante échappe aux motifs.

### Livraison vers `origin` et hooks de la cible

- **Un hook de la cible n'est jamais contourné.** Le commit de merge exécute les
  hooks du dépôt (`pre-commit`, `pre-merge-commit`, `prepare-commit-msg`,
  `commit-msg`) et la signature, sans `--no-verify` ; un rejet annule le merge
  (`COMMIT_HOOK_REJECTED`). La promotion avance `mainBranch` par un
  compare-and-swap (`update-ref`) et non par un `git push .`, qui exécuterait les
  hooks `pre-push` de la cible sous le verrou.
- **Le push est borné et sans invite.** Il est fait hors du verrou principal, du
  SHA exact testé, jamais en force, sous un délai dur (`pushTimeoutMs`) qui tue
  l'**arbre** de process (le hook est un petit-fils de git), sans terminal ni
  invite (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), avec un environnement
  purgé de toute variable `GIT_*` héritée, et les jetons d'URL de remote caviardés
  dans tout message. Son authentification est celle de git lui-même (credential
  helper, agent SSH).
- **En mode `delivery: 'branch'`, la forge reste l'autorité d'approbation.**
  Striart ne fait jamais avancer la branche cible distante : il pousse
  `striart/<agent>/<tâche>` (ou `striart/promote/…`), à approuver depuis la forge.
  Le nom de la branche est dérivé de motifs validés, jamais d'une donnée brute.
- **Fenêtre résiduelle assumée** : un `rollback` lancé par un *autre* process
  pendant un push en vol n'est pas empêché ; la divergence détectée est rapportée
  (`PUSH_SUPERSEDED`, `PUSH_NON_FAST_FORWARD`), jamais en silence.

### GC d'inactivité : fermer une session, jamais un clone

`striart gc` et le balayage de `striart watch` (`src/idle/`) peuvent **terminer
des process sur la machine** (l'hôte d'une session ACP ou de terminal, le process
d'une session autonome) : c'est la seule exception à « un clone dont la session
vit est intouchable », et elle est encadrée.

- **L'autorisation de fermer est celle de l'utilisateur, jamais du dépôt.** La
  config du dépôt choisit la politique (`idle.action`, seuils bornés) ; sans
  `idle.closeRoots` dans la config **utilisateur** (hors dépôt, droits vérifiés,
  fail closed si illisible), `close` dégrade en avertissement. Un dépôt hostile
  ne peut donc pas obtenir, par un fichier commité, qu'on termine des process chez
  qui l'ouvre. Il peut désactiver la détection (`idle.enabled: false`) ou en
  durcir les seuils dans leurs bornes ; le premier est un relâchement affiché par
  `doctor`, et une fermeture reste douce et sans perte (voir ci-dessous).
  `striart.config.*` est un chemin protégé : un agent ne peut pas le modifier par
  un merge.
- **Aucune donnée n'est supprimée ni intégrée** : ni clone, ni registre, ni
  branche, ni rebase, ni merge ; le travail non commité reste en place.
- **Gradation obligatoire** : avertissement (journal, webhooks — noms d'agent et
  durées seulement) *après* la dernière activité, délai de grâce, inactivité
  minimale, puis une **revérification fraîche** de tous les signaux et gardes
  juste avant d'agir. Une demande humaine en attente, un ticket ouvert, un plan
  d'orchestration, un merge en cours, la session du repo principal, une
  suppression en cours ou une exclusion protègent un agent ; une source de
  contexte illisible, ou l'état du GC illisible, interdit toute fermeture.
- **Jamais un kill à l'aveugle.** Hôtes ACP et de terminal : leur protocole
  d'arrêt propre ; session autonome : demande d'arrêt sur disque au process qui la
  supervise (il tient le handle du sous-process), **aucun kill** s'il vit sans
  répondre (`IDLE_CLOSE_NOT_ACKNOWLEDGED`) ; seul un agent *orphelin* est arrêté
  (SIGTERM puis kill d'arbre) et seulement après vérification de son identité par
  l'heure de création (`IDLE_CLOSE_UNVERIFIED` sinon, jamais un PID recyclé), relue
  juste avant le kill. Ni soi-même, ni son parent, ni la session du principal.
- **Un terminal dont la sortie n'est pas observée n'est pas fermé** (hôte natif
  antérieur qui ne publie pas `host.output`, programme silencieux) — sauf
  relâchement explicite `idle.closePty`, affiché par `doctor`.
- **Bornes** : au plus `idle.maxClosuresPerSweep` fermetures par balayage ; une
  reprise de veille neutralise le balayage ; `--dry-run` n'écrit rien.
- **Aucun pouvoir ajouté à l'agent** : le serveur MCP n'expose aucun outil de GC ;
  côté plan humain, `workspace.gc` du Control Protocol est refusé dans une session
  d'agent comme le reste du plan.

**Limites assumées.** (1) `striart gc` (y compris `--close` et `--dry-run`) est refusé dans une session
d'agent comme les autres commandes du plan humain ; cette garde est *advisory*
(`STRIART_SESSION` est effaçable par un process du même utilisateur) : même
contournement, en cas d'usage délibéré, que pour `resolve` ou `merge`. (2) L'identité d'un agent orphelin
repose sur l'heure de création du process ; entre la dernière vérification et le
kill subsiste une fenêtre minuscule, non nulle. (3) « Inactif » est une
inférence de signaux de fichiers et de journaux : un agent qui calcule longtemps
sans rien écrire ni sortir peut être jugé inactif, d'où l'avertissement, la
grâce, des seuils de l'ordre de l'heure par défaut et la conservation du clone
et du travail (une fermeture peut coûter un calcul en cours, jamais le code).

## Frontières de confiance — à connaître avant d'activer certains modes
## Frontières de confiance — à connaître avant d'activer certains modes

Ces points ne sont pas des failles : ce sont des **décisions de conception**
où la sécurité dépend d'un choix de l'utilisateur. Les activer, c'est les
accepter.

- **L'outil de coding est du code de confiance.** En mode autonome, Striart
  lance l'outil configuré (`agentProfiles`) en lui **transmettant tout
  l'environnement du process** (`process.env`) — c'est nécessaire : l'outil a
  besoin de ses propres clés API. Vaut à l'identique en transport ACP
  (`acp: true`) : le protocole ajoute des points de contrôle — fs borné au
  clone, permissions répondues par politique — qui sont de la **défense en
  profondeur, pas une sandbox** : l'outil garde son propre accès disque et
  réseau, hors du protocole. Un outil malveillant ou compromis a donc
  accès à tous les secrets de l'environnement. N'exécutez en autonome que des
  outils que vous exécuteriez de toute façon à la main. Pour **cloisonner**,
  deux voies : lancer Striart dans un shell dont l'environnement ne contient
  que les clés strictement nécessaires, ou donner à chaque profil son propre
  `env` (`agentProfiles.<nom>.env`) — chaque outil ne reçoit alors que sa clé.
  Ne jamais **inliner un secret en clair** dans `env` : depuis un
  `striart.config.mjs`, référencer la variable (`env: { KEY: process.env.SOURCE }`) ;
  `striart profiles` n'affiche que les *clés* d'env, jamais les valeurs.
- **La config est du code exécuté.** `striart.config.js` / `.mjs` est chargé
  par `import()` : y placer du code, c'est l'exécuter. `testCommand` est lancé
  dans un shell (c'est sa raison d'être). N'utilisez jamais une config Striart
  reçue d'un tiers sans l'avoir lue — comme n'importe quel fichier de config
  exécutable (`Makefile`, `package.json` scripts…).
- **La garde de profondeur MCP est une défense en profondeur, pas une prison.**
  Elle repose sur la variable `STRIART_SESSION`, qu'un agent techniquement
  capable pourrait retirer de l'environnement d'un sous-process. Elle protège
  contre la récursion *accidentelle*, pas contre un agent qui chercherait
  délibérément à la contourner — ce dernier tombe dans la frontière « l'outil
  de coding est de confiance » ci-dessus. Il en va de même du **bornage au
  clone** du MCP et du **refus du plan humain** aux sessions d'agent : un
  process local qui lance `striart mcp` depuis le principal avec une config
  élargie, ou qui efface `STRIART_SESSION`, n'est pas arrêté. Le bornage
  protège contre l'agent qui pilote Striart *par MCP*, pas contre un process
  arbitraire de l'utilisateur.
- **Les canaux de collaboration entre agents transportent du texte non
  fiable, et seulement du texte.** Un rôle peut poster `note`, `question`,
  `answer`, `handoff`, `done` ; un `verdict` n'est recevable que d'un rôle
  relecteur pendant son propre tour et **ne fait que proposer** — le Test Gate
  décide du merge. Aucune action d'arbitrage humain n'est atteignable par ce
  canal. Le canal d'écriture (`striart_collab_post`) reste ouvert à profondeur 1
  — poster un message n'est pas agir sur le dépôt — et les sessions ACP de
  Striart (`--read-only --collab`) postent au nom de leur clone. Le texte d'un
  agent est rendu à un autre dans une enceinte à jeton aléatoire qu'il ne peut
  pas refermer ; un agent peut malgré tout tenter d'influencer l'autre par le
  *contenu* (injection de prompt entre agents) : c'est le risque résiduel du
  mode `review`/`team`, borné par le fait que chaque agent est dans son clone,
  sous le Test Gate et la garde des chemins protégés.
- **Les hooks et la config utilisateur étendent une confiance, pas un
  pouvoir.** La config utilisateur porte trois décisions de confiance —
  `hooks.trustedRoots`, `env.allow`, `native.trustedKeyIds` — qu'un dépôt ne
  peut pas s'accorder lui-même. `striart hook` n'a aucun effet bloquant et sort toujours en 0.
  Un hook installé *pour l'utilisateur* tourne dans n'importe quel projet : il
  ne lit que la config **en données** du dépôt (jamais un
  `striart.config.mjs`), sauf pour une racine listée dans
  `hooks.trustedRoots` de la config **utilisateur** (hors dépôt, JSON de
  données, droits vérifiés) — décision de confiance prise par l'utilisateur,
  jamais par un dépôt. Installé *dans un clone*, il reçoit en `--root` la
  racine choisie à l'installation. L'installation n'écrit que chez
  l'utilisateur ou dans un fichier **non suivi** du clone (exclu localement) :
  jamais un fichier versionné (`HOOK_TARGET_TRACKED`), jamais un fichier
  étranger. Sous Windows, les outils dont la commande est une chaîne passée à
  un shell reçoivent un lanceur `.cmd` écrit par Striart, sans espace ni
  caractère spécial.
- **`pty.shell` est de la config-as-code.** Le shell hébergé par l'hôte de
  terminal est un exécutable désigné par la config du dépôt : nom nu (résolu
  dans les dossiers **absolus** du `PATH` seulement, jamais le dossier
  courant) ou chemin absolu, jamais passé à un shell, sans repli silencieux
  (`PTY_SHELL_INVALID`). C'est un relâchement que `doctor` affiche.
  `terminal.custom` (lanceur d'onglet personnalisé) relève de la même
  frontière : argv, jamais un shell, placeholders substitués dans l'élément.
- **Warp** : son schéma d'URI n'exécute rien ; Striart écrit une *Tab Config*
  dans le dossier de données de Warp, en mode 0600, par une écriture
  atomique qui refuse de suivre un lien symbolique planté, avec un nom dérivé
  du seul nom d'agent validé et d'une empreinte de (racine, agent). Elle
  contient la commande d'attache citée pour le shell choisi. Warp la lit :
  quiconque peut écrire dans ce dossier peut déjà lancer ce qu'il veut avec
  Warp (même utilisateur). Le fichier est retiré par `stop` et `clean` (un
  échec est rapporté : avertissement `AGENT_ARTIFACT_FAILED`).
- **Le proxy `striart acp` fait de l'éditeur le plan humain.** L'éditeur a ouvert
  la session et y tape ses prompts : c'est l'humain, pas l'agent. Il arbitre
  donc les permissions *dans* l'éditeur (politique `ask`), par les mêmes
  primitives et les mêmes validations que le dashboard. Les capacités `fs/*` et
  `terminal/*` du client ne sont **jamais** appelées ni relayées — c'est
  structurel (`OUTGOING_REQUESTS`), pas une discipline de code —, et les
  serveurs MCP de l'éditeur ne sont pas transmis à l'agent amont (qui ne reçoit
  que celui de Striart, en lecture seule). Une session sans réponse humaine au
  délai refuse (fail closed). Un client qui se déconnecte sans fin explicite
  laisse le clone **conservé sans merge** par défaut (`onDisconnect: 'keep'`).
- **Striart n'écrit jamais à travers un lien dans un clone d'agent.** Un agent
  sandboxé peut planter un lien symbolique, une jonction Windows ou un lien dur
  dans son clone (`.striart-inbox.md -> ~/.ssh/authorized_keys`) ; l'écriture
  suivante de Striart, qui tourne sans bac à sable, ferait l'évasion à sa
  place. Une primitive unique (`src/safe-write.ts`) porte les écritures de la
  mémoire, des consignes injectées, de la boîte de collaboration, de
  `.git/info/exclude` et de la config des hooks : chaque composant du chemin
  est inspecté sans être suivi (lien ou non-dossier refusé, `SAFE_WRITE_UNSAFE`),
  l'écriture passe par un temporaire créé exclusivement puis un `rename`, et
  le parent est re-résolu avant le `rename`. Limite assumée : une course entre
  cette dernière vérification et le `rename` (quelques microsecondes) reste
  possible pour un agent concurrent.
- **Le répertoire du socket de l'hôte ACP est vérifié.** Sous POSIX, le dossier
  privé qui porte le socket de l'hôte de session doit être un vrai dossier de
  l'utilisateur en mode `0700` ; sinon `ACP_SOCKET_DIR_UNSAFE`, rien n'est
  lancé.
- **Le registre ACP et l'import d'un binaire sont une décision explicite.**
  `striart profiles --import-acp` produit par défaut un profil *épinglé* en
  métadonnées seules ; `acpRegistry.allowBinaryDownload` autorise un
  téléchargement (empreinte sha256 exigée, journal, affichage `doctor`). Le
  binaire ainsi installé reste un outil de coding de confiance, hors bac à
  sable. Les variables d'environnement qu'un agent du registre demande sont
  refusées (`ACP_IMPORT_ENV_FORBIDDEN`) hors de `acpRegistry.allowEnv`, et
  toujours pour `NODE_OPTIONS`, `PATH`, `LD_*`… : un registre ne pose pas de
  code dans l'environnement d'une session.
- **La config du dépôt peut baisser des garde-fous — c'est pourquoi chacun est
  nommé.** Un `striart.config.*` reçu avec un dépôt peut poser `mcp.scope:
  'orchestrator'`, `lock.breakFrozenHolderAfterMs`, `protectedAgentPaths.allow`,
  `dashboardAllowedHosts`, `dashboardHostname: 'localhost'`,
  `unknownConfigKeys: 'warn'`, `tokens.accounting: false`,
  `agentInstructions.enabled: false`, `acpAgent.permissions: 'allow'`,
  `gateContainer: 'process'`, `secretPatterns: []`, `llm.allowAnyApiKeyEnv`,
  `llm.allowInsecureTransport`, `acpRegistry.allowEnv`, un `pty.shell` ou un
  `terminal.launcher: 'custom'` exotiques, des profils expérimentaux… Tous sont journalisés au
  moment où ils agissent et rassemblés par la synthèse « protections
  relâchées » de `striart doctor`. La garde des chemins protégés empêche *un
  agent* de modifier cette config par un merge ; elle ne protège pas d'un dépôt
  hostile reçu d'un tiers (« la config est du code exécuté »). Un plafond de
  tokens ne peut pas, aujourd'hui, être posé dans la config utilisateur.
  Une clé de premier niveau inconnue (faute de frappe sur un réglage de
  sécurité) est refusée par défaut (`CONFIG_INVALID`, `UNKNOWN_KEY`) : une
  protection mal orthographiée ne reste pas silencieusement à son défaut.
- **Le mode semi-autonome arbitre, il ne sandboxe pas.** Avec
  `acp: { permissions: 'ask' }`, les demandes de permission transitent par une
  boîte aux lettres disque (`.striart/permissions/`) que le dashboard affiche
  et tranche. Trois propriétés à connaître : la réponse est validée contre les
  options **proposées par l'agent** (l'action dashboard ne peut pas en
  inventer, mêmes gardes Host + anti-CSRF que les autres actions) ; sans
  réponse dans `askTimeoutMs`, **fail closed** — le refus s'applique, jamais
  un accord par défaut ; et tout process local capable d'écrire dans
  `.striart/` peut répondre à la place de l'humain — cohérent avec le
  périmètre (« un attaquant ayant un accès local en écriture » est hors
  modèle), mais à savoir sur une machine partagée. Comme le reste de l'ACP :
  défense en profondeur, pas une sandbox — l'outil garde son propre accès
  disque et réseau hors protocole.
- **Le bus `@agent` de `watch --ui` a le même pouvoir que taper dans le
  terminal.** Un message envoyé via `@agent instruction` est écrit tel quel
  dans le pty de l'agent — c'est *exactement* ce que fait `--open` ou
  `attach`, juste depuis une autre fenêtre. Ce n'est pas une élévation de
  privilège : quiconque peut envoyer un message a, de fait, déjà accès local
  à `watch --ui` lui-même (même frontière que le dashboard). N'exposez
  jamais `watch --ui`, `attach`, ou le dossier `.striart/pty/` à un accès
  distant — rien ici n'est prévu pour ça (cf. le canal d'attache ci-dessus).
  Portée : les agents **supervisés** (mode `attended`) et — Phase E, livrée
  avec l'hôte de session ACP — les sessions autonomes **ACP vivantes**, où le
  message devient un prompt de plus, joué après le tour en cours, par un canal
  local à jeton (les prompts sont bornés, les contrôles refusés). Une session
  argv (plus de process à qui parler) ou une session ACP terminée est refusée
  explicitement, jamais silencieusement.
- **"!" dans `watch --ui` lance un VRAI shell — même frontière que le bus
  `@agent` ci-dessus, poussée un cran plus loin.** `runShellCommand`
  (`watch-ui.ts`) exécute la commande via le shell par défaut de la machine
  (PowerShell sous Windows, `$SHELL`/bash ailleurs — même `defaultShell()`
  que pour héberger les agents), pas via l'argv contraint `striart <tokens>`
  qu'utilise le reste du champ : pipes, redirections, n'importe quel binaire
  installé. Même raisonnement que le bus `@agent` : l'entrée vient
  exclusivement des frappes locales de ce panneau, jamais d'un agent, d'un
  fichier ou d'un réseau, et quiconque peut taper ici a de toute façon déjà
  un vrai shell sur cette machine (l'adversaire réaliste du modèle de menace
  n'est pas quelqu'un qui a déjà un shell local, cf. « Modèle de menace »
  plus haut). Ni argument de commande ni sortie ne repassent par un chemin
  de fichier ou une variable d'environnement Striart — c'est un raccourci
  vers un vrai terminal, pas une nouvelle capacité.
- **Le clone d'un agent est un dépôt que l'agent contrôle.** Striart y neutralise
  `core.hooksPath` et `core.fsmonitor` pour toute commande qui le vise
  (`cloneGit` : l'agent ne peut pas y faire exécuter un programme par la
  prochaine commande git de Striart) et refuse d'y écrire à travers un lien
  (`SAFE_WRITE_UNSAFE`). **Risque résiduel non traité** : les *filter drivers*
  (`filter.<nom>.clean`/`smudge`/`process`) et les `.gitattributes` d'un clone,
  qu'un agent peut poser et que git exécute lors d'un `add`, `checkout` ou
  `diff` lancé par Striart sur ce clone. Le Test Gate et la garde des chemins
  protégés n'y répondent pas (ce n'est ni un fichier mergé ni un changement de
  `testCommand`). Une session autonome tourne déjà avec les droits de l'utilisateur
  (« l'outil de coding est du code de confiance ») ; le risque porte surtout
  sur un agent confiné par un bac à sable, qui y gagnerait une évasion. Non
  traité à ce jour : aucune neutralisation de la config de filtre git d'un
  clone n'est livrée.
- **La mort brutale de l'hôte natif n'a pas la même garantie sur chaque OS.** Sur
  `SIGKILL`/`TerminateProcess` aucun code ne s'exécute : sous **Windows** le
  noyau tue toute la descendance (Job Object `KILL_ON_JOB_CLOSE`) ; sous
  **Linux** seul le programme direct reçoit `PR_SET_PDEATHSIG`, ses descendants
  qui ont quitté le groupe (`setsid`, démon) survivent ; sous **macOS** seul le
  SIGHUP du noyau s'applique. Ce n'est pas un oubli : POSIX n'a pas d'équivalent
  de `KILL_ON_JOB_CLOSE`. Le Test Gate ne s'y fie pas (il lit le rapport du
  conteneur : `complete`, `survivorPids`). À l'arrêt propre, l'hôte tue aussi
  les descendants suivis qui ont quitté le groupe ; sous Windows, la fermeture de
  la console (`CTRL_CLOSE_EVENT`) laisse ~5 s, que `job run` emploie à tuer le
  job et à écrire son rapport.
- **Un process du même utilisateur est hors modèle — y compris pour le binaire
  natif.** Cache de vérification du binaire (taille, date, inode), fichier de
  jeton du dashboard, `.striart/` : un autre process du même compte peut les
  lire ou les remplacer. Les barrières de ce document visent les autres comptes,
  les sites web et les agents.
- **La résolution de `git`, `tar` et du lanceur de terminal sous Windows** passe
  par la recherche d'exécutables du système, qui peut commencer par le dossier
  courant : un `git.exe` commité à la racine d'un dépôt tiers pourrait s'exécuter.
  Constaté plausible, **non vérifié par sonde, non traité** (pas de
  `NoDefaultCurrentDirectoryInExePath`) : ne lancez pas Striart depuis un
  dépôt tiers non relu sous Windows.
- **La complétion n'exécute jamais la config du dépôt.** Un appui sur Tab
  n'est pas une décision d'exécuter du code — rien ne le signale comme tel,
  contrairement à une commande `striart` tapée dans le dépôt (« la config
  est du code exécuté », ci-dessus). `striart __complete profiles` localise
  la config exactement comme le chargement normal (mêmes emplacements, même
  ordre — `findConfigWithoutExecuting`, `src/config.js`) mais avec des
  chargeurs neutralisés pour les formats exécutables (`.js`, `.mjs`, `.cjs`,
  `.ts`, y compris atteints par un `$import`) : une config **en données**
  (JSON/YAML) est lue comme telle ; d'une config **en code**, seuls sont
  proposés les noms du cache `.striart/completion-profiles.json`, publié par
  `striart profiles` (commande explicite, qui charge la config) et retenu
  seulement s'il désigne le même fichier. Ce cache est de la donnée, filtrée
  par motif comme toute valeur de `.striart/`. Tab dans un dépôt reçu d'un
  tiers n'exécute donc rien ; `striart profiles` y reste, lui, une
  exécution de la config.
- **L'authentification git passe par la configuration de git, pas par
  l'environnement.** Depuis simple-git 4, aucune variable `GIT_*` héritée
  (`GIT_SSH_COMMAND`, `GIT_ASKPASS`…) n'atteint les commandes git de
  Striart — y compris l'`autoPush` du repo principal. Le push s'authentifie
  par un credential helper git ou `~/.ssh/config` : un choix de durcissement
  (une variable héritée d'un hook ou d'un IDE ne peut plus détourner git),
  au prix de ce cas d'usage.
- **Le webhook part vers l'URL que vous configurez.** `notifiers` peut pointer
  vers n'importe quelle URL, y compris interne (pas de filtre SSRF sur la
  destination) : c'est votre config, pour votre usage. La couche réseau exige
  HTTPS hors boucle locale et applique la liste blanche et le mode hors ligne de
  l'utilisateur, mais ne contrôle pas l'adresse IP résolue. Ne mettez pas dans
  `notifiers` une URL reçue d'un tiers.
- **L'`env` d'un profil d'agent est du config-as-code, et il passe en dernier.**
  Il est appliqué à la session après l'environnement réseau de Striart : un
  dépôt dont la config est exécutée peut donc, pour la session de son agent,
  remplacer `NODE_EXTRA_CA_CERTS` posé depuis `network.caFile`. Cela ne touche
  ni les appels de l'orchestrateur (qui n'héritent jamais d'un profil) ni la
  politique réseau, mais c'est une raison de plus de ne pas charger la config
  d'un dépôt qu'on n'a pas lue.

## Chaîne d'approvisionnement

- **Le paquet publié est exactement un commit.** `npm run pack:release`
  (`scripts/pack.ts`) ne prend que des fichiers suivis par git, lus depuis
  les objets git indexés (pas l'arbre de travail) ; il refuse liens
  symboliques et sous-modules (`PACK_UNSUPPORTED_MODE`), fichiers marqués
  skip-worktree/assume-unchanged (`PACK_HIDDEN_CHANGES` — une modification
  invisible à `git status`), fichier hors index (`PACK_NOT_IN_INDEX`) et
  arbre modifié (`PACK_DIRTY_TREE`). Il joint un SBOM CycloneDX des
  dépendances de production. Le `package.json` du dépôt porte
  `"private": true` en plus du hook `prepublishOnly` : un `npm publish`
  depuis le dépôt est refusé, même avec `--ignore-scripts`.
- **Le binaire natif fait partie de la chaîne.** Un paquet npm par plateforme
  (Windows, macOS, Linux ; x64 et arm64 ; Linux en musl statique), dépendances
  optionnelles *exactes* du paquet principal, qui embarque le manifeste
  (SHA-256 et taille de chaque binaire) et sa signature ; `scripts/pack.ts`
  refuse (fail closed) un binaire absent, une empreinte divergente, un
  exécutable d'une autre plateforme, un binaire Linux non statique, une clé
  absente ou discordante, et exige que l'archive passe la vérification **exacte**
  du chargement pour chaque plateforme. Le SBOM CycloneDX inclut les binaires
  et les crates (`Cargo.lock`, versionné). Côté Rust : toolchain épinglée,
  `cargo deny` (licences, avis RustSec), `clippy -D warnings`. La clé de
  signature est un secret de CI, lu **uniquement** par le job
  `release-archives` (push d'une branche protégée, `environment: release` à
  relecteurs requis sur GitHub) : une pull request — même d'une branche du
  dépôt — signe, en `--dry-run`, avec une clé jetable (`--ephemeral-signing-key`,
  refusé hors `--dry-run` : `PACK_EPHEMERAL_REQUIRES_DRY_RUN`). Les actions de
  la CI sont épinglées par SHA de commit, le jeton du workflow est en lecture
  seule par défaut, `npm ci --ignore-scripts` précède la signature,
  `release-archives` dépend des tests et de la fumée du paquet installé, et le
  workflow GitHub y joint une attestation de provenance (le workflow de la CI auto-hébergée du mainteneur,
  dont `environment` et `permissions` sont ignorés, n'en produit pas). Une
  rotation passe par `npm run native:keygen -- --secret-out <fichier hors
  dépôt> --rotate` (clé privée jamais sur stdout, jamais dans le dépôt ;
  chiffrée par `--password-env <VARIABLE>`, ou en clair seulement par choix
  explicite `--unencrypted`) ; la clé épinglée du code (`PINNED_NATIVE_KEY_IDS`)
  suit la clé publique `native/keys/`. Une organisation qui signe avec sa propre
  clé passe `--signing-public-key <fichier>` à `pack:release` et déclare le
  `keyId` à ses utilisateurs (`native.trustedKeyIds`).
  `node-pty`, qui exigeait un script d'installation à approuver et des
  prébuilds par version de Node, a été retiré.
- **L'extension VS Code n'est pas publiée** (`extensions/vscode/`, `"private": true`,
  version `0.1.0`). Elle n'a **aucune dépendance d'exécution** (bundle esbuild
  autonome), son propre `package-lock.json` et des devDependencies en versions
  exactes ; l'artefact `.vsix` produit par `npm run package` n'est ni signé ni
  publié, et son installation depuis une source quelconque reste un acte de
  l'utilisateur. Dans un espace de travail non approuvé (Workspace Trust) elle
  ne démarre **aucun** process : `striart api` charge la config du dépôt, qui est
  du code. Le binaire se résout depuis les réglages **utilisateur** seulement
  (`striart.binaryPath`, `striart.nodePath`, portée machine), en `argv` avec
  `shell: false` ; tout texte venu d'un agent est affiché comme texte non fiable.
  Le CI rejoue son lint et ses tests (job `vscode-extension`).
- **La fixture de signature des tests ne protège rien.**
- **La fixture de signature des tests ne protège rien.** Le dépôt versionne une
  clé minisign d'essai à mot de passe **vide**, nommée
  `tests/fixtures/minisign/rsign-empty-password-TEST-ONLY.key` (commentaire de la
  clé : « TEST ONLY … protects nothing, never reuse »), pour tester le
  déchiffrement scrypt et la signature. Elle n'a aucun rapport avec la clé de
  signature des archives, qui n'existe qu'en secret de CI.
- **Audit des dépendances** : `npm audit --audit-level=high` est bloquant en
  CI. Dernier état relevé, au 2026-10-26 (`npm audit`, arbre installé) : 0
  vulnérabilité (simple-git 4.0.2, vitest et `@vitest/coverage-v8` 4.1.12,
  vite 8.3.5 ; nodemon et `node-pty` retirés). La base d'avis évolue : ce
  relevé est daté, non permanent.
- **Bancs réels `bench:router` et `bench:merger`** (`scripts/`, hors du paquet
  publié — `files` ne couvre pas `scripts/` —, opt-in, hors `npm test`) : ils
  lisent `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` et `GROQ_API_KEY` dans le `.env`
  de la racine (parsé, jamais exécuté ; seules ces trois clés sont retenues)
  et font de vrais appels à un fournisseur cloud. Le banc Router envoie
  l'arbre des fichiers, la carte des candidats (symboles, première ligne de
  documentation) et des demandes **du dépôt courant**, et la génération de son
  corpus (`scripts/bench-router-corpus.ts`) envoie les **diffs** des commits (chemins
  masqués) : ne pas les lancer sur un dépôt confidentiel vers un fournisseur qui
  n'a pas votre accord ; le banc Merger n'envoie que ses cas d'or synthétiques.
  `bench:merge` n'a aucun appel réseau.

## Hors périmètre

- La qualité du code produit par les agents de coding eux-mêmes (le Test Gate
  du repo cible en est l'autorité).
- Un attaquant ayant déjà un accès local en écriture au repo ou à
  l'environnement — y compris, sur la même machine, **un autre process du même
  utilisateur** : il lit le fichier de jeton du dashboard, `.striart/`, et peut
  lancer lui-même `striart mcp` ou `striart api`. Les jetons et les barrières
  de ce document protègent contre les autres *comptes*, les sites web et les
  agents, pas contre un process que l'utilisateur exécute déjà.
- Les vulnérabilités des outils tiers invoqués (Claude Code, Aider, Ollama…) —
  signalez-les à leurs mainteneurs.
