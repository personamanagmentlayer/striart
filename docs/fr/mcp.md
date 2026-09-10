# Intégration IDE et agents — serveur MCP

> [Documentation](README.md) · Serveur MCP

Striart s'expose comme **serveur MCP** (Model Context Protocol) : Claude Code,
Cursor et tout hôte MCP peuvent piloter l'orchestrateur — l'agent devient un
*client* de Striart au lieu de le contourner.

```bash
# Claude Code, dans le repo cible :
claude mcp add striart -- striart mcp
```

## Les sept outils

Mappés directement sur l'orchestrateur — mêmes verrous, mêmes garde-fous que
le CLI et le dashboard :

| Outil | Nature | Rôle |
|---|---|---|
| `striart_status` | lecture | État des agents (statut, mode, branche, commits en attente) + `mainSession` (session déclarée sur le repo principal, `alive` calculé). |
| `striart_queue` | lecture | La file du scheduler et ses blocages. |
| `striart_run` | mutation | Lancer une tâche via le Router (ou la mettre en file). |
| `striart_merge` | mutation | Merger le dernier commit d'un agent (pipeline complet : rebase, fusion sémantique, Test Gate). |
| `striart_resolve` | mutation | Marquer un ticket comme résolu (sans repasser par le Test Gate — après correction manuelle du conflit). |
| `striart_resolve_prepare` | mutation | Amorcer `<fichier>.resolved` pour chaque fichier en conflit du ticket, depuis la version de l'agent (repli ours/base) — jamais écrasé si déjà préparé. |
| `striart_resolve_apply` | mutation | Rejouer le merge exact du ticket avec les résolutions préparées (`.resolved`/`.delete`), sous le Test Gate bloquant — commit et clôture si vert, ticket laissé ouvert sinon (sans toucher au mode manuel). |

## La borne de profondeur d'orchestration

**La profondeur d'orchestration est bornée à 1** : une session autonome porte
un marqueur d'environnement hérité par ses descendants, et les outils mutants
lui sont refusés avec le motif. Un agent peut consulter l'état ; il ne peut ni
engendrer d'agents ni merger — sans cette borne, `striart_run` → agent →
`striart_run` récurserait sans limite, chaque niveau consommant des tokens
sans surveillance.

Cette garde est **advisory** (un agent qui nettoie son environnement peut la
contourner) — le modèle de menace complet est dans
[SECURITY.md](../../SECURITY.md).

## Symétrie MCP / ACP

- **MCP** : l'agent pilote Striart (l'agent est le client) ;
- **ACP** : Striart pilote l'agent (Striart est le client) — voir
  [Modes d'exécution](modes-execution.md#transport-acp-la-session-qui-se-laisse-regarder).

En mode MCP, les logs partent sur stderr : stdout est réservé au protocole.
