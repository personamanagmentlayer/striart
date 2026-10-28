# Striart face aux alternatives

> État du paysage au **2026-10-26**, d'après les pages publiques de chaque
> projet (liens en bas de page). Ces outils évoluent vite : les versions,
> licences et périmètres cités sont à **revérifier à la source** avant toute
> décision. Les points forts des autres sont indiqués aussi — le bon outil
> dépend du problème.

## Le problème, en une page

Faire travailler **plusieurs agents IA de code sur le même dépôt** ouvre quatre
fronts que l'isolation des fichiers seule ne ferme pas :

1. **Les collisions** — deux agents modifient les mêmes fichiers ; le coût se
   paie au merge, une fois le travail fait.
2. **Le retour du travail** — ramener N branches dans la branche cible,
   dans le bon ordre, en rebasant les agents encore actifs.
3. **Les conflits sémantiques** — un merge qui passe sans marqueur Git peut
   casser le comportement ; un conflit qui bloque coûte une intervention
   humaine.
4. **La confiance** — rien de cassé ne doit entrer, et un agent qui déraille
   (reset, gc, secrets, fichiers de configuration) ne doit pas toucher à l'état
   des autres ni à la configuration qui le contrôle.

Les gestionnaires de sessions parallèles passés en revue plus bas s'appuient
d'abord sur l'isolation (un *worktree* par agent) et l'affichage des sessions,
d'après leurs pages publiques. Striart prend en charge les quatre fronts.

## Ce que Striart apporte

| Problème | Réponse de Striart |
|---|---|
| Deux agents sur les mêmes fichiers | **Router préventif** : un LLM prédit les fichiers touchés, les tâches en collision sont mises en file (`--after`), avant le lancement. |
| Un agent qui déraille abîme l'état commun | **Clones complets** (pas de worktrees) : refs et index propres, pas de remote, secrets retirés du clone, objets hardlinkés pour un coût disque faible. Rayon d'explosion = le clone. |
| N branches à ramener | **Chaîne de merge sérialisée** sous verrou, rebase de tous les agents après chaque merge de `striart watch`. |
| Conflit de fusion | **Fusion sémantique 3-way** par LLM (par régions au-delà d'un seuil), sortie validée. |
| Peur de la fusion « sûre d'elle » | **Test Gate bloquant** : jamais de commit sans `testCommand` vert ; sinon `merge --abort` + ticket humain complet. |
| Un agent modifie ce qui le pilote | **Chemins protégés** : instructions, config d'agent et config de Striart refusées avant fusion et avant le gate. |
| Sessions longues et autonomes | Mode **autonome** (profils, ACP), budgets de **tokens** à plafonds (fail closed), verrous à battement, reprise après crash. |
| Plusieurs outils d'agents | **20 presets prêts** (Claude, Codex, Gemini, Copilot, Cursor, Aider…) côte à côte ; Striart n'en privilégie aucun. |
| Plusieurs agents sur UNE tâche | Modes d'orchestration : **relecture croisée, course, équipe, pipeline**, plans YAML versionnés. |
| Visibilité et contrôle | Dashboard temps réel (jeton, lien à usage unique), `striart watch --ui`, arbitrage des permissions, `rollback`, `doctor`. |
| Intégration éditeur | **MCP** (l'agent pilote Striart, borné à son clone), **Control Protocol** (humain), **ACP** client et proxy `striart acp` (Striart *est* l'agent vu par l'éditeur). |

Philosophie : un **pacemaker Git**, pas un cerveau central. L'humain voit tout,
peut interrompre, corriger, valider.

## Panorama des projets similaires

### Gestionnaires de sessions parallèles (worktrees + interface)

| Projet | Ce que c'est | Où il est fort | Ce qu'il ne traite pas (d'après ses pages publiques) |
|---|---|---|---|
| **[Claude Squad](https://github.com/smtg-ai/claude-squad)** | Application terminal : plusieurs agents (Claude Code, Codex, Gemini, Aider…), un worktree + une session tmux chacun, revue avant application. Licence AGPL-3.0 (à vérifier). | Simplicité, prise en main immédiate, multi-agents. | Prévention des collisions, fusion assistée, gate de tests. |
| **[Conductor](https://conductor.build/compare/claude-code)** | Application macOS propriétaire : espaces de travail isolés pour Claude Code et Codex, état de revue, vérifications, flux de PR. | Interface soignée, flux PR de bout en bout. | Mono-plateforme (macOS), propriétaire. |
| **Crystal → [Nimbalyst](https://superset.sh/compare/conductor-vs-crystal)** | Application libre multiplateforme : Claude Code et Codex en parallèle dans des worktrees, revue et merge dans l'application. Le projet a été renommé (développement actif sous Nimbalyst, d'après les sources — à vérifier). | Multiplateforme, revue de diff intégrée. | Routage préventif, fusion sémantique. |
| **[Vibe Kanban](https://www.mindstudio.ai/blog/vibe-kanban-vs-paperclip-vs-claude-code-dispatch)** | Tableau kanban qui orchestre des agents en worktrees parallèles. Une source indique l'arrêt de l'éditeur en avril 2026 (une seule source : à vérifier). | Vue d'ensemble « tableau de tâches ». | Idem ; pérennité à contrôler. |
| **[bernstein](https://github.com/topics/git-worktrees)** | Orchestrateur déterministe d'agents CLI (aucun modèle dans la boucle de coordination), un worktree par tâche, exécutions rejouables. Statut bêta d'après la fiche. | Déterminisme, rejouabilité. | Fusion assistée par LLM, gate de tests intégré. |

### Fusion sémantique et agents

| Projet | Ce que c'est | Rapport à Striart |
|---|---|---|
| **[Weave (Ataraxy Labs)](https://github.com/ataraxy-labs/weave)** | Pilote de fusion Git à **granularité d'entité** (fonctions, classes) via tree-sitter, sans LLM ; serveur MCP pour que les agents réservent des entités. Jeune (versions 0.x). | Approche **déterministe** du même problème de faux conflits. Striart traite les conflits restants par LLM *puis* les soumet au Test Gate ; les deux approches ne s'excluent pas. |
| **[Résolution de fusion proposée par agent](https://agentpatterns.ai/code-review/agent-proposed-merge-resolution/)** | Patron de conception : la résolution du modèle est une *proposition* tant qu'un contrôle de build/tests n'a pas validé l'arbre qui sera réellement intégré. | C'est le principe du **Test Gate** de Striart, appliqué par construction à chaque fusion. |

### Protocoles et éditeurs

| Projet | Rapport à Striart |
|---|---|
| **[Agent Client Protocol (Zed)](https://zed.dev/acp)** | Standard ouvert (JSON-RPC sur stdio, Apache 2.0) entre éditeurs et agents. Striart l'utilise dans les deux sens : *client* ACP (il pilote l'agent) et *proxy* `striart acp` (l'éditeur voit Striart comme un agent, avec un clone, un merge et un gate par session). |
| **Sous-agents et worktrees intégrés de Claude Code** | Zéro friction pour une session. Le contexte est partagé mais l'isolation se limite au worktree (`.git/` commun), sans routage ni gate (à vérifier dans la documentation d'Anthropic). Se combine avec Striart : un agent lancé par Striart peut utiliser ses propres sous-agents. Voir [Architecture](architecture.md). |

## Quand choisir quoi

- **1 à 2 agents, tâches clairement séparées** : des worktrees à la main ou le
  support intégré de votre outil suffisent. Striart n'est pas nécessaire.
- **Vous voulez surtout une interface pour suivre des sessions** : Claude
  Squad, Conductor ou Nimbalyst sont plus directs.
- **Vous voulez réduire les faux conflits de fusion de façon déterministe** :
  Weave traite cette partie, sans LLM.
- **Plusieurs agents, plusieurs outils, du travail non surveillé, et la garantie
  qu'aucun commit n'entre sans suite de tests verte** : c'est le périmètre de
  Striart — prévention, retour du travail, fusion, gate, garde-fous et
  observabilité dans un seul outil qui s'exécute en local (LLM local par défaut ; un fournisseur LLM cloud est optionnel).

## Sources

- [Running Parallel Claude Code Agents on a Single Codebase](https://medium.com/@koriigami/running-parallel-claude-code-agents-on-a-single-codebase-927d70e7349d)
- [Git Worktrees for AI Agents](https://pasqualepillitteri.it/en/news/7951/git-worktrees-ai-agents-claude-code-parallel)
- [Conductor vs Claude Code](https://conductor.build/compare/claude-code) ·
  [Conductor vs Crystal](https://superset.sh/compare/conductor-vs-crystal)
- [Claude Squad — README](https://cdn.jsdelivr.net/gh/smtg-ai/claude-squad@main/README.md)
- [Vibe Kanban vs alternatives](https://www.mindstudio.ai/blog/vibe-kanban-vs-paperclip-vs-claude-code-dispatch)
- [Weave — Ataraxy Labs](https://socket.dev/npm/package/@ataraxy-labs/weave) ·
  [Agent-Proposed Merge Resolution](https://agentpatterns.ai/code-review/agent-proposed-merge-resolution/)
- [Agent Client Protocol](https://zed.dev/acp)
