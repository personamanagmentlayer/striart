# Striart pour VS Code

Pilotez votre orchestrateur Git multi-agents [Striart](https://github.com/personamanagmentlayer/striart) depuis VS Code : tous les agents d'un coup d'œil, merge sous Test Gate, résolution des tickets de conflit, réponse aux demandes de permission des agents sans quitter l'éditeur.

> English: [README.md](README.md)

L'extension est un client léger du **Striart Control Protocol v1** (le *plan humain*). Elle lance `striart api --stdio` et ne contient **aucune logique métier** : tout ce qu'elle affiche vient de `state.get` / `state.changed`, et chaque action est une méthode du protocole — mêmes garde-fous, mêmes verrous et même Test Gate que la CLI.

## Ce que vous obtenez

- **Vue Striart** dans la barre d'activité : agents regroupés en **À traiter** (tickets de conflit, demandes de permission et questions, agents prêts à merger, clones cassés), **En cours** et **Inactifs**, plus la **File d'attente**. Le statut est toujours écrit en toutes lettres (pas seulement en couleur).
- **Barre d'état** : agents, conflits, demandes en attente, watcher actif/arrêté, et un état **hors ligne** explicite.
- **Palette de commandes** (préfixe `Striart :`) : Merger un agent, Synchroniser, Arrêter, Nouvelle tâche, Ouvrir le terminal de l'agent, Résoudre un ticket de conflit, Afficher le diff d'un agent, Ouvrir le dashboard (lien à usage unique), Lancer le diagnostic, Annuler le dernier merge, Relancer la file, Se reconnecter, Afficher la sortie.
- **Notifications actionnables** pour les demandes de permission et les questions structurées (élicitations) des agents : répondez depuis VS Code. Fermer une notification ne répond jamais (fail closed ; la demande reste dans la vue jusqu'à son délai).
- **Confirmations proportionnées** : un merge demande une fois et dit ce qui s'exécute ; un arrêt forcé, un rollback ou la clôture manuelle d'un ticket écrivent la conséquence et exigent de saisir le nom exact.
- **Reconnexion automatique** (backoff exponentiel à gigue, tentatives bornées), données périmées clairement marquées hors ligne.
- **Français et anglais** (suit la langue d'affichage de VS Code).

## Prérequis

- Striart installé et un dépôt initialisé (`striart init`).
- L'extension s'exécute là où se trouve le dépôt (Remote SSH, devcontainer et Codespaces fonctionnent) ; dossiers locaux `file:` uniquement.

## Modèle de sécurité

| Sujet | Comportement |
|---|---|
| **Workspace Trust** | Dans un espace non approuvé, l'extension est inerte : **aucun process n'est lancé**. C'est volontairement plus strict que « lecture seule » — `striart api` charge la configuration du dépôt (`striart.config.mjs`), qui est du code. Accorder la confiance la démarre automatiquement. |
| **Quel binaire s'exécute** | Résolu depuis les réglages **utilisateur** uniquement (`striart.binaryPath` et `striart.nodePath` sont de portée `machine` ; les valeurs de `.vscode/settings.json` ou d'un `.code-workspace` sont ignorées et journalisées). Un nom nu est cherché dans le `PATH` hors espace de travail ; un chemin relatif est refusé ; lancement en `argv`, `shell: false`. |
| **Texte des agents** | Tout ce qui vient des agents (prompts, messages de commit, titres de permission) est non fiable : contrôles et caractères bidirectionnels retirés, taille bornée, affiché en texte brut. Une URL demandée par un agent est affichée, jamais ouverte automatiquement. |
| **Entrées du protocole** | Chaque message est validé contre le sous-ensemble de schéma publié et borné à 1 Mio ; une forme inattendue est une erreur explicite, jamais un repli silencieux. |
| **Vie privée** | Aucune télémétrie, aucun accès réseau, aucun secret stocké. |
| **Webviews** | Aucune : TreeView, QuickPick, InputBox et barre d'état natifs. |
| **Terminaux** | « Ouvrir le terminal de l'agent » ouvre un terminal dans le clone et peut *pré-saisir* la commande de l'agent **sans l'exécuter**. |
| **Diff d'agent** | Le seul appel `git` local : `git diff` en lecture seule dans le clone de l'agent, avec `core.fsmonitor`, pilotes de diff externes et conversions de texte désactivés (le clone est modifiable par l'agent). |

Lancé depuis une session d'agent (`STRIART_SESSION=1`), le protocole refuse par conception (un agent ne doit pas s'arbitrer lui-même) ; la vue l'indique alors.

## Réglages

| Réglage | Défaut | Notes |
|---|---|---|
| `striart.binaryPath` | `striart` | Nom de commande (PATH) ou chemin **absolu** vers l'exécutable ou le script d'entrée. Réglages utilisateur uniquement. |
| `striart.nodePath` | `node` | Utilisé quand `binaryPath` est un script ou un shim npm Windows. Réglages utilisateur uniquement. |
| `striart.root` | `""` | Racine du dépôt (absolue ou relative au premier dossier). Restreint en espace non approuvé. |
| `striart.requestTimeoutSeconds` | `30` | Requêtes en lecture seule. |
| `striart.actionTimeoutSeconds` | `3600` | Actions longues (merge + Test Gate…). L'expiration n'annule pas l'opération. |
| `striart.reconnect.initialDelaySeconds` / `maxDelaySeconds` / `maxAttempts` | `1` / `30` / `8` | Backoff ; `0` tentative désactive la reconnexion automatique. |
| `striart.notifications.requests` | `true` | Notifier les demandes des agents. |

Sous Windows, npm installe un shim `striart.cmd` que Node ne sait pas lancer sans shell en sécurité ; l'extension le ramène au script d'entrée du paquet voisin, ou vous demande de pointer `striart.binaryPath` vers `…\node_modules\@jumsay\striart\src\cli.js`.

## Limites connues

- Espaces multi-racines : le premier dossier (ou `striart.root`) est utilisé.
- Lien du dashboard en fenêtre distante : il vise la boucle locale de la machine *distante* ; redirigez le port vous-même.
- Le diff d'agent couvre les commits en attente (`HEAD~n..HEAD`), pas les modifications non commitées. Une méthode du protocole (`agent.diff`) supprimerait l'appel `git` local.

## Développement

```bash
cd extensions/vscode
npm install
npm run build          # bundle esbuild -> dist/extension.cjs
npm run typecheck
npm run test:unit      # client, cadrage, validation, modèle, résolution du binaire (faux serveur)
npm run test:integration   # contre le vrai `striart api` d'un dépôt Git temporaire
npm run test:e2e       # vrai VS Code via @vscode/test-electron (télécharge VS Code)
npm run package        # striart-vscode.vsix (ne publie pas)
```

La publication sur le Marketplace / Open VSX est une étape distincte et manuelle.
