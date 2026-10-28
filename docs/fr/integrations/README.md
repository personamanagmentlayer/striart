# Intégrations — IDE, éditeurs et terminaux

> [Documentation](../README.md) · Intégrations
> 🇬🇧 [English](../../en/integrations/README.md)

Striart s'intègre à un outil de **deux façons complémentaires**, qui
correspondent à deux plans distincts (voir
[Architecture](../architecture.md#trois-plans-jamais-mélangés)) :

- **Par son serveur MCP** (`striart mcp`, stdio) — le plan *agent → Striart* :
  l'agent de l'outil lit l'état de l'orchestrateur, merge *son* travail,
  prépare *ses* résolutions, avec les mêmes verrous et le même Test Gate que
  la CLI. Décrit dans [Serveur MCP](../mcp.md).
- **Par le proxy ACP** (`striart acp`, stdio) — Striart *est* l'agent vu par
  un éditeur compatible ACP (Zed, JetBrains, Neovim, Emacs…) : **une session de
  l'éditeur = un clone isolé + l'agent amont choisi + un merge sous Test
  Gate.** Voir [Striart comme agent ACP](#striart-comme-agent-acp--striart-acp)
  ci-dessous.

Le troisième plan, *humain → Striart* (`striart api`, le Control Protocol),
est celui des futures extensions d'IDE — voir « Ce qui arrive ».

Chaque page ci-dessous donne la configuration exacte, ce qui est couvert, les
limites et les points de sécurité propres à l'outil. **Les chemins et formats
ont été vérifiés le 2026-10-24 dans la documentation officielle de chaque
éditeur**, citée en fin de page ; ce qui n'a pas pu l'être est marqué
« **non vérifié** ».

| Outil | Page | Mécanisme |
|---|---|---|
| Visual Studio 2022 (17.14+) / 2026 | [visual-studio.md](visual-studio.md) | `.mcp.json` (`servers`) |
| VS Code et Cursor | [vscode-cursor.md](vscode-cursor.md) | `.vscode/mcp.json` / `.mcp.json` / `.cursor/mcp.json` |
| Xcode 26.3+ | [xcode.md](xcode.md) | configuration des agents lancés dans Xcode |
| Eclipse Theia | [theia.md](theia.md) | préférence `ai-features.mcp.mcpServers` |
| Devin Desktop (ex-Windsurf) | [devin-desktop.md](devin-desktop.md) | `mcp_config.json` (`mcpServers`) |
| IDE JetBrains | [jetbrains.md](jetbrains.md) | AI Assistant (MCP), Junie, `acp.json` — **et `striart acp`** |
| Zed | [zed.md](zed.md) | `context_servers` (MCP) — **et `agent_servers` pour `striart acp`** |
| Neovim (CodeCompanion) | [neovim.md](neovim.md) | `mcp.servers` — **et `striart acp`** |
| Emacs (agent-shell) | [emacs.md](emacs.md) | `agent-shell-mcp-servers` (ACP) — **et `striart acp`** |
| Warp | [warp.md](warp.md) | `.warp/.mcp.json`, AGENTS.md/WARP.md, Tab Configs, lanceur `--open` |

Claude Code est couvert par la page [Serveur MCP](../mcp.md)
(`claude mcp add striart -- striart mcp`).

## Ce qui est commun à tous les outils

### Prérequis

- `striart` installé depuis les sources et joignable (`npm link`, après
  `npm run native:build` — voir [Démarrage](../demarrage.md#installation)) :
  il s'appuie sur un binaire natif (voir
  [Architecture](../architecture.md#composants-natifs-rust)) ;
- le dépôt cible initialisé (`striart init`) — sans quoi les outils répondent
  par une erreur explicite.

### Choisir le dépôt piloté (`--root`)

`striart mcp --root <chemin-absolu>` désigne le dépôt principal **sans
dépendre du répertoire de travail** que l'hôte donne au serveur — c'est la
forme à préférer dans toute configuration d'éditeur :

```json
{ "command": "striart", "args": ["mcp", "--root", "/chemin/absolu/vers/mon-projet"] }
```

Sans `--root`, le répertoire de travail courant décide (racine trouvée par
`git rev-parse --show-toplevel`) ; lancé hors de tout dépôt Git, le serveur
refuse de démarrer (`NOT_A_GIT_REPO` sur stderr), et un `--root` qui ne désigne
pas un dépôt Striart initialisé est refusé (`MCP_ROOT_INVALID`). Quand l'outil
permet de fixer le `cwd` du serveur (VS Code, Warp `working_directory`,
« Working directory » d'AI Assistant JetBrains), les deux marchent ; quand il
ne le documente pas, `--root` évite de deviner. L'ancien lanceur
`sh -c 'cd … && exec striart mcp'` n'est plus nécessaire.

Le chemin est une valeur d'argument : un chemin avec des espaces ou des
caractères spéciaux reste une donnée (aucun shell n'est impliqué).

### Windows : la commande `striart`

Une installation npm globale crée sous Windows un lanceur `striart.cmd`.
Certains hôtes lancent la commande sans shell et ne résolvent pas les `.cmd`
(comportement propre à chaque hôte, **non vérifié** outil par outil). En cas
d'échec au démarrage du serveur, visez Node directement avec un chemin
absolu :

```json
{ "command": "node", "args": ["C:\\Users\\vous\\AppData\\Roaming\\npm\\node_modules\\@jumsay\\striart\\src\\cli.js", "mcp", "--root", "C:\\chemin\\vers\\mon-projet"] }
```

Le dossier exact est donné par `npm root -g`. Cette forme absolue est aussi
celle qu'exige le protocole ACP quand un client transmet le serveur à un
agent : son schéma définit `command` comme « le chemin absolu de
l'exécutable du serveur MCP ».

### Vérifier le serveur hors de l'outil

```bash
cd /chemin/vers/mon-projet
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | striart mcp
```

La réponse JSON-RPC liste les outils sur stdout ; les journaux partent sur
stderr. `striart doctor` diagnostique l'environnement (git, composant natif,
config, LLM, verrous).

### Sécurité — à appliquer partout

- **Les outils mutants restent soumis à approbation.** `striart_run`,
  `striart_merge`, `striart_promote`, `striart_resolve_prepare`,
  `striart_resolve_apply` et `striart_collab_post` lancent des agents, mergent
  et font agir au nom d'un clone. N'activez l'approbation automatique
  (« YOLO », « Run Everything », « brave mode », allowlist générique
  `striart:*`…) que pour les outils en lecture : `striart_status`,
  `striart_queue`, `striart_ticket`, `striart_collab_read`.
- **Le serveur est borné à son appelant** (lot D6). Lancé depuis le clone d'un
  agent (ou avec `--agent`), il n'agit que sur **cet** agent ; lancé hors de
  tout clone — c'est le cas d'un éditeur ouvert sur le dépôt principal — il
  est en **lecture seule**, sauf `mcp.scope: 'orchestrator'` dans la config
  (relâchement, journalisé et affiché par `doctor`). `striart_resolve`
  (clôture sans Test Gate) n'existe plus côté MCP, et aucun niveau n'offre
  l'arbitrage d'une permission : ces gestes sont humains. La borne de
  profondeur (un agent lancé par Striart en mode autonome ne peut pas appeler
  les outils mutants) reste **advisory** — voir [SECURITY.md](../../../SECURITY.md).
- **Un fichier de configuration MCP versionné est du code.** Un `.mcp.json`
  ou `.vscode/mcp.json` commité dans un dépôt que vous clonez peut lancer une
  commande arbitraire : relisez-le avant de faire confiance au dépôt. (Striart,
  de son côté, **protège** ces fichiers contre un agent : un merge qui les
  modifie est refusé — chemins protégés.)
- **Aucun secret dans la configuration du serveur.** `striart mcp` n'en a pas
  besoin ; les clés des providers LLM se lisent depuis les variables
  d'environnement ou le `.env` du dépôt (voir [Configuration](../configuration.md)).

## Striart comme agent ACP : `striart acp`

Les clients ACP (Zed, JetBrains, Neovim avec CodeCompanion, Emacs avec
agent-shell…) lancent un agent comme sous-process stdio. `striart acp` est cet
agent : la configuration est la même partout — une commande et un argument.

```json
{ "command": "striart", "args": ["acp"] }
```

Chaque page d'éditeur donne l'emplacement exact de cette entrée. À savoir :

- **Une session = un clone.** `session/new` ne crée rien ; au premier prompt
  Striart passe par le Router, crée le clone et lance l'agent amont. L'éditeur
  expose des **options de session** : l'agent amont (parmi vos profils
  `acp: true`, restreints par `acpAgent.profiles`), la politique de
  permission (`ask` par défaut : vous tranchez *dans* l'éditeur), le merge
  automatique ou manuel.
- **Les fichiers et le terminal de l'éditeur ne sont jamais utilisés.**
  L'agent amont travaille dans son clone, servi par le client ACP de Striart ;
  vos fichiers ouverts ne sont lus que comme références de contexte. La
  frontière est structurelle.
- **La fin de session** — la commande `/striart-finish`, la fermeture de la
  session ou la déconnexion (selon `acpAgent.onDisconnect`, `keep` par défaut :
  clone conservé sans merge) — applique le contrat de commit, merge sous le
  Test Gate, ouvre un ticket si rouge, et nettoie sans `force`.
  `/striart-status` affiche l'état.
- **Prérequis** : au moins un profil ACP configuré (`striart profiles
  --detect`, `--import-acp <id>`), et son outil installé et authentifié.
  Sans profil : `ACP_PROXY_NO_PROFILE`.
- **Authentification** : Striart n'a pas de compte et annonce une seule
  méthode, `striart-local` ; l'authentification de l'agent amont reste
  l'affaire de son propre outil (`ACP_AUTH_REQUIRED` sinon).
- `--root <dépôt>` borne les sessions à un dépôt ; `--profile <p>` choisit le
  profil amont proposé par défaut. Réglages : [`acpAgent`](../configuration.md#acpagent--le-proxy-acp-striart-acp).

La publication de Striart au **registre ACP** (entrée `registry/acp/striart/`
du dépôt, distribution `npx` du paquet) est préparée mais n'est pas faite :
c'est un acte de l'utilisateur, et le paquet n'est aujourd'hui publié sur
aucun registre (installation depuis les sources, voir le README). D'ici là,
déclarez la commande à la main comme ci-dessus.

### Ce qui arrive

Deux intégrations natives, sur le Control Protocol (`striart api`) :

- une **extension VS Code** — **livrée dans le dépôt** (`extensions/vscode/`,
  version `0.1.0`) mais **pas publiée** : ni VS Code Marketplace, ni **Open VSX**
  (Cursor, Devin Desktop, VSCodium…), sans date annoncée ; voir
  [VS Code et Cursor](vscode-cursor.md#extension-vs-code) ;
- un **plugin JetBrains**, sur le même protocole — **non livré**, sans date
  annoncée.

D'ici là, les pages ci-dessous décrivent l'intégration par MCP et par ACP, qui
fonctionnent avec la version actuelle.
