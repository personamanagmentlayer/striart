# Documentation Striart

> Documentation complète de Striart, l'orchestrateur Git multi-agents.
> Le [README français](../../README.fr.md) à la racine est la vitrine (référence) ;
> [README.md](../../README.md) y est désormais la version anglaise par défaut. Tout le détail vit ici.
> 🇬🇧 [English documentation](../en/README.md).

## Sommaire

| Page | Contenu |
|---|---|
| [Démarrage](demarrage.md) | Prérequis (repo Git, premier commit, LLM), installation, `striart init`, premier lancement, guide « 3 agents en parallèle ». |
| [Architecture](architecture.md) | Pourquoi des clones et pas des worktrees, la chaîne sérialisée, le flow d'un commit agent, les 6 statuts de synchronisation, le verrou inter-processus, la sûreté du stash automatique. |
| [Commandes](commandes.md) | Les 21 commandes du CLI, en détail : options, garde-fous, codes de refus. |
| [Configuration](configuration.md) | La référence complète de `striart.config.mjs` : toutes les options, leurs défauts, les providers LLM, les prompts surchargeables. |
| [Branches et pipeline](branches.md) | `targetBranch` sur n'importe quelle branche (`main`, `master`, `dev`…), la contrainte de branche courante, le pipeline staging → main (`striart promote`), `autoPush` et le remote. |
| [Modes d'exécution](modes-execution.md) | Supervisé, autonome, transport ACP, mode semi-autonome (arbitrage humain des permissions), garanties du mode autonome, cohabitation des modes. |
| [Plans — tâches-as-code](plans.md) | Le graphe de tâches YAML versionné : syntaxe, validation, garde-fous de conception. |
| [Serveur MCP](mcp.md) | Piloter Striart depuis Claude Code, Cursor ou tout hôte MCP ; la borne de profondeur d'orchestration. |
| [Projets volumineux](projets-volumineux.md) | Maîtriser le coût disque des clones : hardlinks, clone partiel, pnpm, rétention. |
| [Dépannage](depannage.md) | `striart doctor`, les codes d'erreur, les tickets de conflit, le mode manuel, `rollback`, `reconcile`, les verrous. |

## Autres documents

- [SECURITY.md](../../SECURITY.md) — modèle de menace et frontières de confiance.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — guide contributeur.
- [CHANGELOG.md](../../CHANGELOG.md) — historique des versions.
- [.env.example](../../.env.example) — configuration exacte de chaque provider LLM.
- [examples/plan.example.yaml](../../examples/plan.example.yaml) — plan YAML complet et commenté.
