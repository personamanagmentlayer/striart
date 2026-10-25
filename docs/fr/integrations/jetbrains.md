# IDE JetBrains (IntelliJ IDEA, WebStorm, PyCharm…, 2025.2+)

> [Documentation](../README.md) · [Intégrations](README.md) · JetBrains
> 🇬🇧 [English](../../en/integrations/jetbrains.md)

Trois mécanismes JetBrains distincts touchent Striart :

1. **AI Assistant (et Junie)** consomment des serveurs MCP : on y déclare
   `striart mcp` ;
2. **les agents ACP** (`~/.jetbrains/acp.json`) peuvent recevoir les serveurs
   MCP d'AI Assistant, donc Striart ;
3. **le serveur MCP intégré de l'IDE** expose l'IDE lui-même à des agents
   externes — l'autre direction, avec un piège de sécurité (« brave mode »).

Un plugin JetBrains Striart (qui parlera le Control Protocol, `striart api`)
est à venir, sans date annoncée. En attendant, Striart se branche par MCP
(ci-dessous) **et comme agent ACP** par `striart acp`.

## AI Assistant : déclarer Striart

Settings | Tools | AI Assistant | Model Context Protocol (MCP) > Add
(ou `/` dans le chat > Add Command). Transport STDIO, au format :

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp"]
    }
  }
}
```

Le dialogue a un champ **Working directory** (« le dossier depuis lequel le
serveur est lancé ») distinct du JSON : **renseignez la racine du dépôt
cible**. Le niveau du serveur (global ou projet) se choisit dans le même
dialogue — un serveur global avec un répertoire fixe pilote toujours le même
dépôt ; préférez le niveau projet.

## Junie

- Projet : `.junie/mcp/mcp.json` ; utilisateur : `~/.junie/mcp/mcp.json`
  (documentation Junie CLI ; un ancien billet de blog cite `~/.junie/mcp.json`).
- Même format `mcpServers` (`command`, `args`, `env`). Dans le plugin :
  Tools | Junie | MCP Settings | Add.
- **Répertoire de travail — non vérifié** : aucun champ `cwd` documenté ;
  ouvrez le dépôt comme projet, ou passez `--root` (voir la
  [page commune](README.md#choisir-le-dépôt-piloté---root)).

## Agents ACP (`acp.json`)

« Add Custom Agent » crée `~/.jetbrains/acp.json` :

```json
{
  "default_mcp_settings": {
    "use_custom_mcp": true,
    "use_idea_mcp": false
  },
  "agent_servers": {
    "Mon agent": {
      "command": "/chemin/absolu/vers/agent",
      "args": ["acp"]
    }
  }
}
```

- `use_custom_mcp` (vrai par défaut) transmet à l'agent ACP les serveurs MCP
  déclarés dans AI Assistant — **dont Striart** : l'agent ACP voit alors les
  outils Striart sans configuration propre.
- `use_idea_mcp` (faux par défaut) lui transmet le serveur MCP de l'IDE :
  laissez-le à `false` (voir « brave mode » ci-dessous).
- Le protocole ACP exige un `command` **absolu** pour un serveur MCP transmis
  à un agent : si l'agent refuse `striart`, déclarez-le dans AI Assistant
  avec le chemin absolu ([Windows](README.md#windows--la-commande-striart) ;
  ailleurs, `which striart`).
- **Striart lui-même comme agent ACP** : déclarez-le ici, dans `agent_servers`
  (une session de l'IDE = un clone isolé + l'agent amont choisi + un merge
  sous Test Gate) :

  ```json
  {
    "agent_servers": {
      "Striart": { "command": "/chemin/absolu/vers/striart", "args": ["acp"] }
    }
  }
  ```

  `command` doit être **absolu** (`which striart` ; sous Windows, `node` et le
  chemin de `src/cli.js` avec `acp` en argument). Les fichiers et le terminal
  de l'IDE ne sont jamais utilisés par l'agent amont ; `/striart-finish`
  termine la session. **Recette JetBrains réelle : à faire** (non vérifiée
  ici).

## Le serveur MCP intégré de l'IDE — prudence

Settings | Tools | MCP Server > « Enable MCP Server » expose l'IDE (fichiers,
recherche, refactoring, terminal, VCS…) aux clients MCP (Claude Code, Codex,
Junie… via « Auto-Configure »).

- **« brave mode »** (« Run shell commands or run configurations without
  confirmation ») : l'outil `execute_terminal_command` s'exécute alors sans
  confirmation. **Laissez-le désactivé** quand des agents pilotés par Striart
  y ont accès : un agent pourrait lancer `git merge`, `git push` ou
  `git reset` **dans le dépôt principal** à travers l'IDE, hors de son clone,
  hors du verrou et du Test Gate — l'incident même qui a motivé la garde de
  session principale ([Dépannage](../depannage.md)).
- Les outils de l'IDE prennent un `projectPath` : quand le projet ouvert est
  le dépôt principal et non le clone de l'agent, l'agent agit sur le
  principal. Pour un agent qui travaille dans `.striart/agents/<nom>/`,
  ouvrez ce clone comme projet, ou ne lui donnez pas ce serveur.
- Préférez « Project Clients Auto-Configuration » à l'enregistrement global,
  et restreignez la liste « Exposed Tools ».

## Ce qui est couvert

- Outils Striart dans AI Assistant, Junie et les agents ACP qui reçoivent les
  serveurs d'AI Assistant.

## Limites

- Ressources et prompts MCP non documentés côté AI Assistant (Striart n'en
  expose pas).
- Junie et `acp.json` : pas de `cwd` documenté.

## Sécurité

- Aucune invite d'approbation des outils de serveurs externes n'est décrite
  par la documentation d'AI Assistant (**non vérifié**) : ne déclarez Striart
  que dans les projets où vous acceptez qu'un agent lance et merge des tâches.
- Les fichiers MCP de projet (`.junie/mcp/mcp.json`) peuvent être commités :
  pas de secret dedans (rappel de la documentation Junie).

## Sources (vérifiées le 2026-10-24)

- AI Assistant, MCP — <https://www.jetbrains.com/help/ai-assistant/mcp.html>
  (AI Assistant 2026.2, page du 14 août 2026).
- AI Assistant, ACP — <https://www.jetbrains.com/help/ai-assistant/acp.html>
  (7 octobre 2026).
- Serveur MCP de l'IDE — <https://www.jetbrains.com/help/idea/mcp-server.html>
  (IntelliJ IDEA 2026.2, mise à jour 13 mai 2026).
- Junie — <https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html>
  (23 octobre 2026), <https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html>
- ACP, schéma `McpServer` — <https://agentclientprotocol.com/protocol/session-setup>
