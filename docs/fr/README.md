# Documentation Striart

> Documentation complète de Striart, l'orchestrateur Git multi-agents.
> Le [README français](../../README.fr.md) à la racine est la vitrine (référence) ;
> [README.md](../../README.md) y est désormais la version anglaise par défaut. Tout le détail vit ici.
> 🇬🇧 [English documentation](../en/README.md).

## Sommaire

| Page | Contenu |
|---|---|
| [Démarrage](demarrage.md) | Prérequis (repo Git, premier commit, LLM), installation, `striart init`, premier lancement, guide « 3 agents en parallèle ». |
| [Architecture](architecture.md) | Pourquoi des clones et pas des worktrees, la chaîne sérialisée, le flow d'un commit agent, les 6 statuts de synchronisation, le verrou inter-processus à battement et la file équitable, les fichiers d'état et leur verrou, les trois plans (MCP, Control Protocol, ACP), les composants natifs (Rust), les modes d'orchestration, les tokens, la sûreté du stash automatique. |
| [Commandes](commandes.md) | Le contrat de la CLI (codes de sortie, `--json`, langue, complétion) et les 30 commandes en détail : options, garde-fous, codes de refus. |
| [Configuration](configuration.md) | La référence complète de `striart.config.mjs` : toutes les options, leurs défauts et leurs bornes, les providers LLM, `tokens`, `llmResilience`, `agentProfiles` et ses presets, `commitPolicy`, `protectedAgentPaths`, `acpAgent`, `terminal`, `pty`, `mcp`, `orchestration`, la configuration utilisateur. |
| [Branches et pipeline](branches.md) | `targetBranch` sur n'importe quelle branche (`main`, `master`, `dev`…), la contrainte de branche courante, le pipeline staging → main (`striart promote`), `autoPush` et le remote. |
| [Modes d'exécution](modes-execution.md) | Supervisé, autonome, transport ACP et hôte persistant, mode semi-autonome, proxy `striart acp`, modes d'orchestration (`review`, `race`, `team`, `pipeline`), garanties du mode autonome, cohabitation des modes. |
| [Plans — tâches-as-code](plans.md) | Le graphe de tâches YAML versionné : plans v1 et v2 (modes d'orchestration), syntaxe, validation, garde-fous de conception. |
| [Serveur MCP](mcp.md) | Piloter Striart depuis Claude Code, Cursor ou tout hôte MCP : les dix outils, les niveaux (lecture seule, borné à un agent, orchestrateur), `--root`, la borne de profondeur d'orchestration. |
| [Intégrations](integrations/README.md) | Configuration exacte de `striart mcp` et de `striart acp` dans Visual Studio, VS Code, Cursor, Xcode, Eclipse Theia, Devin Desktop (ex-Windsurf), JetBrains, Zed, Neovim, Emacs et Warp : couverture, limites, sécurité, sources vérifiées. |
| [Projets volumineux](projets-volumineux.md) | Maîtriser le coût disque des clones : hardlinks, clone partiel, pnpm, rétention. |
| [Dépannage](depannage.md) | `striart doctor`, tous les codes d'erreur par nature, les tickets de conflit, le mode manuel, `rollback`, `reconcile`, les verrous et fichiers d'état, le composant natif, le dashboard. |

## Autres documents

- [SECURITY.md](../../SECURITY.md) — modèle de menace et frontières de confiance.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — guide contributeur.
- [CHANGELOG.md](../../CHANGELOG.md) — historique des versions.
- [.env.example](../../.env.example) — configuration exacte de chaque provider LLM.
- [examples/plan.example.yaml](../../examples/plan.example.yaml) — plan YAML complet et commenté.
