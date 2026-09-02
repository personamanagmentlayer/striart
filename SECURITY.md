# Politique de sécurité

## Signaler une vulnérabilité

**Ne signalez pas une faille par issue publique.** Utilisez un canal privé :

- **GitHub** (préféré) : sur le miroir public, *Security* →
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

Sources d'entrée non fiables, traitées comme telles :

| Source | Traitée comme | Barrière |
|---|---|---|
| Prompt de tâche (issue, fichier…) | donnée, jamais code | substitué en élément d'`argv`, `shell: false` |
| Sortie du LLM Router (chemins prédits) | donnée bruitée | filtrée : ni absolu ni `..` (`isSafeProjectPath`) |
| Sortie du LLM Merger (code fusionné) | proposition à valider | **Test Gate bloquant** avant tout commit |
| Nom d'agent, id de ticket (CLI, URL) | identifiant contraint | validé par motif, chemins reconstruits du registre |
| Requêtes HTTP du dashboard | potentiellement pilotées par un site tiers | contrôle du `Host` + en-tête anti-CSRF |
| stdin du serveur MCP | JSON-RPC d'un hôte | borné (1 Mo/ligne), parse isolé |
| Plan YAML (`striart plan`) | donnée, jamais code | parse pur, validation complète avant tout effet ; une tâche autonome ne référence qu'un `profile` défini en config, jamais une commande |
| Requêtes fs d'un agent ACP (chemins) | identifiant à contraindre | bornées au clone — chemin absolu tiers ou `..` refusé |
| Chemin du repo cible | hors du contrôle de Striart | refus si caractères cassant le shell (terminal) |

## Périmètre — ce que Striart promet

Ces invariants sont des engagements de sécurité ; toute manière de les
contourner est une vulnérabilité à signaler :

- **Aucune donnée utilisateur ne devient du code ni un chemin.** Le prompt
  d'une tâche est passé en élément d'`argv` avec `shell: false`, jamais
  interprété par un shell. Les noms d'agents et ids de tickets sont validés,
  les chemins reconstruits depuis le registre, jamais depuis une URL. Les
  chemins prédits par le LLM sont filtrés (ni absolus ni `..`).
- **Les clés API ne sont jamais stockées.** Ni dans `striart.config`, ni dans
  `.striart/` : la config ne porte que le *nom* d'une variable
  d'environnement (`apiKeyEnv`, `urlEnv` pour les webhooks).
- **Le dashboard n'expose rien hors de la machine.** Lié à 127.0.0.1, et
  **toute** requête (lectures comprises) exige un en-tête `Host` local — la
  défense contre le DNS rebinding, où un site tiers fait pointer son domaine
  vers 127.0.0.1 pour lire l'état du repo à travers le navigateur. Les actions
  mutantes exigent en plus l'en-tête anti-CSRF `X-Striart`.
- **Les secrets trackés sont retirés des clones agents** (`secretPatterns`,
  sparse-checkout) — un échec de ce nettoyage fait échouer le `start`, jamais
  de dégradation silencieuse.
- **Jamais de commit sans Test Gate vert**, y compris pour une fusion produite
  par LLM.
- **La profondeur d'orchestration MCP est bornée** : une session autonome ne
  peut pas engendrer d'agents ni merger via le serveur MCP (voir la frontière
  de confiance ci-dessous pour sa limite exacte).

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
  de coding est de confiance » ci-dessus.
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
- **Le webhook part vers l'URL que vous configurez.** `notifiers` peut pointer
  vers n'importe quelle URL, y compris interne (pas de filtre SSRF) : c'est
  votre config, pour votre usage. Ne mettez pas dans `notifiers` une URL reçue
  d'un tiers.

## Hors périmètre

- La qualité du code produit par les agents de coding eux-mêmes (le Test Gate
  du repo cible en est l'autorité).
- Un attaquant ayant déjà un accès local en écriture au repo ou à
  l'environnement.
- Les vulnérabilités des outils tiers invoqués (Claude Code, Aider, Ollama…) —
  signalez-les à leurs mainteneurs.
