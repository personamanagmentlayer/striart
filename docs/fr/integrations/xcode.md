# Xcode 26.3+

> [Documentation](../README.md) · [Intégrations](README.md) · Xcode
> 🇬🇧 [English](../../en/integrations/xcode.md)

Xcode intervient dans deux directions qu'il ne faut pas confondre :

1. **Xcode serveur MCP** (`xcrun mcpbridge`) : Xcode expose *ses* outils à un
   agent externe. Striart n'est pas concerné directement, mais un agent piloté
   par Striart peut s'en servir.
2. **Xcode hôte d'agents** (Claude Agent, Codex, Gemini, agents ACP) : ces
   agents peuvent recevoir des serveurs MCP supplémentaires — dont `striart mcp`.

## Brancher Striart sur un agent lancé dans Xcode

Apple documente que l'on peut, pour les agents lancés dans Xcode, « définir
un modèle par défaut, ajouter des serveurs MCP et créer ses propres skills »,
dans un dossier de configuration par agent :

- `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig`
- `~/Library/Developer/Xcode/CodingAssistant/codex`
- `~/Library/Developer/Xcode/CodingAssistant/gemini`

« Ces configurations n'affectent les agents que lorsqu'ils sont lancés dans
Xcode. » **Non vérifié** : Apple ne documente ni le nom ni le format des
fichiers attendus dans ces dossiers. Ils suivent vraisemblablement le format
natif de chaque agent (par exemple `mcpServers` pour Claude) ; vérifiez dans
la documentation de l'agent concerné avant de compter dessus. L'entrée à
déclarer est dans tous les cas la même : commande `striart`, arguments
`["mcp"]`.

**Répertoire de travail — non vérifié.** Le serveur doit démarrer dans le
dépôt Git du projet ouvert dans Xcode. Comme ces dossiers sont **globaux à
l'utilisateur**, une entrée sans répertoire explicite pilote le dépôt dont
l'agent hérite le répertoire ; si ce n'est pas garanti, ajoutez
`--root <chemin absolu du dépôt>` aux arguments (voir la
[page commune](README.md#choisir-le-dépôt-piloté---root) ; une entrée par
dépôt).

Agents ACP : Xcode permet d'ajouter un agent compatible ACP (Intelligence >
Agents > « Add an Agent »). Le contenu exact de la feuille de saisie n'est
pas documenté par Apple (**non vérifié**). Striart est un agent ACP par
`striart acp` (commande `striart`, argument `acp`) : la saisie dans cette
feuille n'a **pas** été vérifiée, recette réelle à faire.

## Utiliser Xcode depuis un agent piloté par Striart

Pour qu'un agent (Claude Code, Codex) lancé par Striart dans un clone accède
aux outils d'Xcode :

1. Xcode > Settings > Intelligence > Model Context Protocol : activer
   « Allow external agents to use Xcode tools » ;
2. côté agent, par exemple `claude mcp add --transport stdio xcode -- xcrun mcpbridge`
   ou `codex mcp add xcode -- xcrun mcpbridge` ;
3. **ouvrir le projet du clone dans Xcode** (Apple : ouvrir le projet avant
   d'interroger l'agent externe). Si c'est le projet du dépôt principal qui
   est ouvert, l'agent agirait via Xcode sur le principal, hors de son clone
   — exactement ce que Striart cherche à éviter.

## Ce qui est couvert

- Les outils Striart pour les agents lancés dans Xcode, sous réserve du
  format de configuration propre à chaque agent (non vérifié).

## Limites

- Format des fichiers de configuration non documenté par Apple.
- Pas de répertoire de travail par projet documenté.

## Sécurité

- Xcode signale la connexion et l'activité d'un agent externe.
- Intelligence > Agents in Xcode > Permissions tient les listes « Allowed
  Commands » et « Allowed Tools » : n'y autorisez que `striart_status` et
  `striart_queue` sans confirmation.
- En entreprise, la clé MDM `CodingAssistantAllowExternalIntegrations` à
  `false` coupe les intégrations externes.

## Sources (vérifiées le 2026-10-24)

- Apple, « Giving external agents access to Xcode » —
  <https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode>
- Apple, « Extending and customizing agents » —
  <https://developer.apple.com/documentation/xcode/extending-and-customizing-agents>
- Apple, « Setting up coding intelligence » —
  <https://developer.apple.com/documentation/xcode/setting-up-coding-intelligence>

(Aucune date de mise à jour affichée sur ces pages.)
