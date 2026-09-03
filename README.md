<h1 align="center">
  <img src="assets/logo_striart.png" alt="Striart" width="420">
</h1>

<p align="center">
  <strong>Orchestrateur Git multi-agents</strong> pour Claude Code, Aider, Cursor et tout autre agent de coding IA.<br>
  Isolation physique · Routing préventif · Fusion sémantique · Test Gate bloquant
</p>

<p align="center">
  <img alt="version 0.10.0" src="https://img.shields.io/badge/version-0.10.0-6e56cf">
  <img alt="Node.js ≥ 22.18" src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933?logo=node.js&logoColor=white">
  <img alt="422 tests" src="https://img.shields.io/badge/tests-422%20%E2%9C%94-2da44e">
  <img alt="zéro build" src="https://img.shields.io/badge/build-aucun-8250df">
  <img alt="licence MIT" src="https://img.shields.io/badge/licence-MIT-blue">
</p>

<p align="center">
  <a href="#pourquoi-striart--et-pas-simplement-des-worktrees-">Pourquoi Striart</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#démarrage-express">Démarrage</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#règles-dor">Règles d'or</a>
</p>

<p align="center"><em>🇬🇧 <a href="README.en.md">English version</a> — the French README is the reference.</em></p>

Quand plusieurs agents IA travaillent en parallèle sur le même repo, ils se marchent dessus :
conflits Git, commits gloutons, merges sémantiquement cassés. Striart résout ça avec trois piliers :

1. **Isolation physique** — chaque agent travaille dans un vrai clone Git indépendant, sans remote (`.striart/agents/<nom>/`).
2. **Router préventif** — avant de lancer un agent, un LLM prédit les fichiers touchés et met en file d'attente les tâches en collision.
3. **Fusion sémantique + Test Gate** — les commits des agents sont mergés automatiquement ; en cas de conflit, un LLM fusionne le code ; rien n'est commité tant que `npm test` (ou votre commande) ne passe pas.

Striart n'est pas un cerveau central opaque : c'est un **pacemaker Git**. L'humain voit tout, peut interrompre, corriger, valider.

---

## Pourquoi Striart — et pas simplement des worktrees ?

Isoler les fichiers, c'est 10 % du problème. Un worktree (ou un clone fait à
la main) évite que deux agents écrivent au même endroit *en même temps* — tout
le reste reste à ta charge, à chaque tâche : éviter les collisions *avant*
qu'elles n'arrivent, ramener N branches dans la branche cible, arbitrer les
conflits, garantir que rien de cassé n'entre. Striart automatise précisément ce reste.

| Besoin | Worktrees à la main | Sous-agents Claude Code (worktrees intégrés) | Striart |
|---|---|---|---|
| Isolation des fichiers | ✅ | ✅ (zéro friction) | ✅ clones complets |
| Solidité face à un agent qui déraille | ⚠️ `.git/` partagé : un `reset --hard` ou un `gc` touche l'état commun | ⚠️ idem | ✅ refs/index propres, pas de remote, secrets exclus — rayon d'explosion borné au clone |
| Prévention des collisions | ❌ à ta charge | ❌ dépend du découpage du modèle | ✅ Router LLM + file d'attente + dépendances `--after` |
| Retour du travail dans la branche cible | ❌ merges manuels | ❌ à la charge de l'agent | ✅ merge auto, rebase de tous les agents après chaque merge, fusion sémantique 3-way |
| Garde-fou de qualité | ❌ | ❌ | ✅ **Test Gate bloquant** — rien n'entre sans suite verte |
| Multi-fournisseurs | ❌ | ❌ Claude uniquement | ✅ Claude + Aider + Codex + Ollama… côte à côte |
| Durée de vie | la session | la session | ✅ des heures/jours, plusieurs sessions, file persistante |
| Observabilité & contrôle | ❌ | limité à la session | ✅ dashboard temps réel, logs persistants, semi-autonome (tu arbitres les permissions), rollback |

Le détail du raisonnement (clones vs worktrees, emboîtement avec les
sous-agents de Claude Code, symétrie MCP/ACP) est dans
**[docs/fr/architecture.md](docs/fr/architecture.md)**.

---

## Installation

Depuis les sources :

```bash
git clone https://github.com/personamanagmentlayer/striart.git
cd striart && npm install && npm link   # expose la commande `striart`
cd /chemin/vers/mon-projet
striart init
```

Prérequis : Node.js 22.18+ (type stripping natif — rien à compiler), Git,
**un repo Git avec au moins un commit**, et un LLM pour le Router/Merger —
Ollama en local (défaut) **ou** n'importe quelle API cloud. Tout le détail :
**[docs/fr/demarrage.md](docs/fr/demarrage.md)**.

---

## Démarrage express

```bash
cd mon-projet
striart init                          # crée .striart/, la config, vérifie le LLM

# Onglet 1 — l'orchestrateur
striart watch                         # merge + Test Gate + rebase automatiques

# Lancer des agents (le Router vérifie les collisions avant chaque lancement)
striart run "Refactor le module d'authentification" --command "claude" --open
striart run "Ajoute la facturation Stripe" --agent billing --command "aider --model gpt-4o" --open

# ...et pour une tâche cadrée qu'on ne veut pas surveiller, Striart pilote seul :
striart run "Ajoute des tests unitaires à src/parser.js" --autonomous --profile claude

# Suivi
striart status / queue / dashboard / resolve
```

---

## Documentation

La documentation complète vit dans **[docs/fr/](docs/fr/README.md)**
(🇬🇧 [docs/en/](docs/en/README.md)) :

| Page | Contenu |
|---|---|
| [Démarrage](docs/fr/demarrage.md) | Prérequis, installation, `striart init`, guide « 3 agents en parallèle ». |
| [Architecture](docs/fr/architecture.md) | Clones vs worktrees, chaîne sérialisée, flow d'un commit, les 6 statuts de sync, verrous. |
| [Commandes](docs/fr/commandes.md) | Les 21 commandes en détail : options, garde-fous, codes de refus. |
| [Configuration](docs/fr/configuration.md) | Référence complète de `striart.config.mjs`, providers LLM, prompts. |
| [Branches et pipeline](docs/fr/branches.md) | `targetBranch` sur n'importe quelle branche (`dev`, `master`…), pipeline staging → main. |
| [Modes d'exécution](docs/fr/modes-execution.md) | Supervisé, autonome, ACP, semi-autonome (arbitrage des permissions). |
| [Plans](docs/fr/plans.md) | Tâches-as-code : le graphe de tâches YAML versionné. |
| [Serveur MCP](docs/fr/mcp.md) | Piloter Striart depuis Claude Code, Cursor ou tout hôte MCP. |
| [Projets volumineux](docs/fr/projets-volumineux.md) | Maîtriser le coût disque des clones. |
| [Dépannage](docs/fr/depannage.md) | `striart doctor`, codes d'erreur, tickets, `rollback`, `reconcile`. |

---

## Règles d'or

1. **Jamais de push depuis un agent.** Les clones sont des îlots sans remote ; seul l'orchestrateur pousse.
2. **Jamais de commit sans Test Gate vert.** Même si le LLM de fusion est « sûr de lui ».
3. **Jamais de suppression d'un clone pendant qu'un agent travaille.** `striart clean` refuse à deux niveaux : `IN_USE` (heuristique, `--force` possible en connaissance de cause) et `SESSION_LIVE` (fait vérifié, que **`--force` ne peut pas écraser**).
4. **Fallback humain obligatoire.** 3 fusions sémantiques échouées d'affilée → mode manuel jusqu'à `striart resolve --unlock`, avec un ticket complet par échec dans `.striart/conflicts/`.

---

## Développement

**422 tests** (244 unitaires + 178 d'intégration sur de vrais repos Git),
typecheck `tsc` sur tout le code (TS natif + JS annoté JSDoc), zéro étape de
build — `bin` pointe sur la source.

```bash
npm install
npm run test:unit        # 244 tests, ~20 s — la boucle de dev
npm run test:integration # 178 tests, ~7 min — vrais repos Git temporaires
npm test                 # les deux
npm run lint             # ESLint (correctness) + Prettier --check
npm run test:ci          # typecheck + tout + coverage
```

Voir [CONTRIBUTING.md](CONTRIBUTING.md) et [SECURITY.md](SECURITY.md).

Licence MIT.
