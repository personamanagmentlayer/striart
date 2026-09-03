# Démarrage

> [Documentation](README.md) · Démarrage

## Prérequis

- **Node.js 22.18+** — Striart s'exécute sans build grâce au type stripping
  natif de Node (les modules TypeScript sont exécutés tels quels).
- **Git** — dans le `PATH`.
- **Un repo Git avec au moins un commit.** Striart s'initialise à la racine
  d'un repo Git existant (`striart init` cherche la racine et échoue sinon), et
  les agents sont de **vrais clones** : un repo sans le moindre commit ne peut
  pas être cloné ni fournir de base de merge — la création d'agent échouerait.
  Pour un projet vierge :

  ```bash
  cd mon-projet
  git init -b main          # ou -b dev, -b master… — voir Branches et pipeline
  git add -A
  git commit -m "chore: état initial"
  ```

  Le nom de la branche créée doit correspondre à `targetBranch` dans la config
  (défaut : `main`). Rien n'impose `main` : `master`, `dev` ou toute autre
  branche fonctionnent à l'identique — voir **[Branches et pipeline](branches.md)**.
- **Un LLM pour le Router et le Merger** — Ollama en local (défaut) **ou**
  n'importe quelle API cloud (Anthropic, OpenAI, Azure, tout endpoint
  compatible OpenAI). Voir [Configuration](configuration.md#le-llm-du-routermerger).

## Installation

Depuis les sources :

```bash
git clone https://github.com/personamanagmentlayer/striart.git
cd striart && npm install && npm link   # expose la commande `striart`
```

Sans `npm link`, tout s'appelle aussi directement :
`node /chemin/vers/striart/src/cli.js init`.

Il n'y a **rien à compiler** : `bin` pointe sur la source (ESM). Les modules
TypeScript sont exécutés tels quels par le type stripping natif de Node, les
`.js` annotés JSDoc cohabitent, et l'ensemble est vérifié par `tsc` — sans
étape de build.

## `striart init`

À la racine du repo cible :

```bash
cd mon-projet
striart init
```

`init` est idempotent et ne touche jamais un fichier existant. Il :

1. crée `.striart/` (gitignoré) : `agents/`, `conflicts/`, `logs/`,
   `queue.json`, `locks.json`, `agents.json` ;
2. ajoute `.striart/` au `.gitignore` du repo s'il n'y est pas déjà ;
3. génère `striart.config.mjs` **si aucune config n'existe** (cosmiconfig
   accepte aussi `striart.config.js`, `.striartrc.json`, etc.) ;
4. diagnostique le LLM configuré — ping d'Ollama, ou présence de la clé API
   pour un provider cloud. **Avertissement seulement, jamais bloquant** : on
   peut initialiser d'abord et configurer le LLM ensuite.

Deux réglages à vérifier avant le premier agent :

- **`testCommand`** — la commande du Test Gate, le seul réglage vraiment
  portant : rien n'est mergé tant qu'elle ne rend pas 0. Sur un projet sans
  suite de tests, le défaut `npm test` échouera systématiquement — ajustez-le
  (voir [Configuration](configuration.md)).
- **`targetBranch`** — la branche où les agents mergent (défaut `main`). Le
  repo principal doit être **positionné sur cette branche** au moment des
  merges — voir [Branches et pipeline](branches.md).

Puis vérifiez l'ensemble :

```bash
striart doctor    # git, repo, config, LLM joignable, verrous, tickets
```

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

`--open` ouvre directement un onglet terminal dans le clone de l'agent
(Windows Terminal, Terminal.app, gnome-terminal) et y lance l'outil. Chaque
session est indépendante : elle reste ouverte jusqu'à ce que **vous** la
fermiez.

Ensuite, tout est automatique :

- Chaque commit d'un agent est détecté par `striart watch`, mergé dans la
  branche cible, validé par le **Test Gate** — s'il échoue, le merge est
  annulé et un ticket est créé.
- En cas de conflit textuel, la **fusion sémantique** (LLM) tente une
  résolution, revalidée par le Test Gate. Si le gate rejette la fusion, le
  Merger **réessaie avec le log d'erreur en feedback** (`semanticGateRetries`)
  avant le ticket humain. Après 3 échecs d'affilée : mode manuel (règle de
  sécurité).
- Les conflits **hors de portée du LLM** (fichier supprimé d'un côté et
  modifié de l'autre, renommage concurrent, binaire, lockfile, fichier trop
  volumineux, submodule, symlink, bit exécutable divergent) ne partent jamais
  en fusion : ticket humain direct avec la nature du conflit.
- Le **double-renommage invisible** (git rate les deux renommages, le merge
  est « propre » mais le fichier ressort en double) est traqué par une
  heuristique de contenu : avertissement `⚠️` au merge + webhook, non bloquant.
- Avec `memoryLayer: true`, chaque merge alimente une **mémoire sémantique
  partagée** (`.striart-memory.md` dans chaque clone) : les agents savent
  quelles API les autres viennent d'ajouter ou modifier — la parade au conflit
  *sémantique* qui n'a pas de conflit Git. Le fichier porte aussi une section
  **temps réel « travaux en cours »** : les autres tâches (actives et en file)
  et leurs fichiers prédits par le Router — chacun voit qui travaille où, sans
  coût LLM.
- Au lancement d'une tâche, les **liens sémantiques** sont signalés (jamais
  bloquants) : fichiers qui s'importent mutuellement — graphe des imports
  relatifs **JS/TS, Python, Ruby, PHP** — et packages liés d'un monorepo
  **npm/yarn, Cargo, Go (go.work), Maven**.
- Après chaque merge réussi, les autres agents sont **rebasés** sur le code le
  plus récent.
- Si le Router avait mis une tâche en attente, elle démarre dès que l'agent
  bloquant est arrêté (`striart stop`).

## Suivi en temps réel

```bash
striart status          # agents, mode (auto/supervisé), branches, outils, commits en attente
striart queue           # scheduler : RUNNING / WAITING + blocages
striart dashboard       # http://localhost:3456 — vue web temps réel
striart resolve         # tickets de conflit en attente de résolution humaine
```

## Pour aller plus loin

- [Architecture](architecture.md) — ce qui se passe sous le capot à chaque commit.
- [Commandes](commandes.md) — la référence complète du CLI.
- [Modes d'exécution](modes-execution.md) — supervisé, autonome, ACP, semi-autonome.
- [Dépannage](depannage.md) — quand quelque chose refuse de marcher.
