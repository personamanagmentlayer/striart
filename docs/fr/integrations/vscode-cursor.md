# VS Code et Cursor

> [Documentation](../README.md) · [Intégrations](README.md) · VS Code et Cursor
> 🇬🇧 [English](../../en/integrations/vscode-cursor.md)

En attendant l'extension Striart (VS Code Marketplace et Open VSX, en
préparation, sans date annoncée), Striart s'utilise dans VS Code et Cursor
comme serveur MCP stdio déclaré dans un fichier `mcp.json`.

## VS Code

### Configuration

VS Code connaît deux formats :

| Fichier | Clé | `cwd` | Remarque |
|---|---|---|---|
| `.vscode/mcp.json` (espace de travail) ou `mcp.json` du profil utilisateur | `servers` | oui | format VS Code ; marqué « deprecated » dans l'assistant d'ajout, toujours lu |
| `.mcp.json` à la racine de l'espace de travail | `mcpServers` | **non** | format Copilot portable |
| `$COPILOT_HOME/mcp-config.json` (repli `~/.copilot/mcp-config.json`) | `mcpServers` | oui | format Copilot, utilisateur |

Le dépôt piloté se fixe avec `--root`
([page commune](README.md#choisir-le-dépôt-piloté---root)) : VS Code
interpole `${workspaceFolder}` dans `args`, ce qui évite toute surprise dans
un espace multi-racines. (Par défaut, le serveur démarre dans le dossier de
l'espace de travail.)

`.vscode/mcp.json` :

```json
{
  "servers": {
    "striart": {
      "type": "stdio",
      "command": "striart",
      "args": ["mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

Format portable (`.mcp.json` à la racine — le même fichier est lu par
Claude Code ; pas de `cwd` : le serveur hérite du répertoire de lancement, et
lancé depuis le clone d'un agent il est borné à cet agent) :

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

Ajout en ligne de commande (profil utilisateur, format VS Code) :

```bash
code --add-mcp '{"name":"striart","type":"stdio","command":"striart","args":["mcp"]}'
```

Une entrée de profil utilisateur sert **tous** les espaces de travail : elle
pilote le dépôt du dossier ouvert, pas un dépôt fixe.

### Ce qui est couvert

- Les outils Striart dans le mode agent de Copilot. Striart expose aussi des
  ressources (`striart://…`) et aucun prompt.
- Limite VS Code : 128 outils actifs au plus par requête — Striart en ajoute
  peu (liste dans [Serveur MCP](../mcp.md)).

### Sécurité

- `.vscode/mcp.json` et `.mcp.json` héritent de la **Workspace Trust** : en
  mode restreint, ces serveurs ne démarrent pas ; dans un espace de confiance
  ils démarrent **sans invite MCP séparée, y compris après une modification
  de la configuration**. N'accordez la confiance qu'à un dépôt dont vous avez
  relu ces fichiers.
- Approbations : laissez les outils mutants exiger une confirmation
  (`chat.tools.eligibleForAutoApproval` à `false` pour eux) et n'utilisez
  pas `chat.tools.global.autoApprove` ni `/yolo` / `/autoApprove` avec
  Striart connecté. Avec le bac à sable activé, VS Code approuve
  automatiquement les confirmations d'outils : tenez-en compte.

## Cursor

### Configuration

- Projet : `.cursor/mcp.json` ; global : `~/.cursor/mcp.json`. Les deux sont
  fusionnés, le projet l'emporte à nom égal.
- Clé `mcpServers` :

```json
{
  "mcpServers": {
    "striart": {
      "type": "stdio",
      "command": "striart",
      "args": ["mcp"]
    }
  }
}
```

**Répertoire de travail — non vérifié.** Cursor ne documente ni `cwd` ni
répertoire de lancement. Il interpole en revanche `${workspaceFolder}` (le
dossier qui contient `.cursor/mcp.json`) dans `args` ; sous macOS/Linux, le
`--root` (voir la [page commune](README.md#choisir-le-dépôt-piloté---root))
fixe le dépôt sans chemin en dur, sur toutes les plateformes :

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

### Ce qui est couvert

Les outils Striart dans l'agent de Cursor (Cursor prend aussi en charge
prompts, ressources, roots et elicitation ; Striart n'utilise que ses outils
côté Cursor). Aucune
limite du nombre d'outils n'est documentée actuellement.

### Sécurité

- Cursor demande une approbation avant chaque outil MCP par défaut.
- En mode **Auto-review** (défaut depuis Cursor 3.6), les outils de
  l'allowlist s'exécutent immédiatement : n'y mettez que les outils en
  lecture, dans `~/.cursor/permissions.json` ou
  `<workspace>/.cursor/permissions.json` :

  ```json
  { "mcpAllowlist": ["striart:striart_status", "striart:striart_queue"] }
  ```

  Jamais `striart:*`. Le mode **Run Everything** exécute tout appel sans
  confirmation : à proscrire avec Striart connecté.
- Sous Windows, quand l'administrateur active les « MCP Network Controls »,
  les serveurs stdio en bac à sable ne démarrent pas : une entrée « No
  sandbox » est nécessaire (documentation Cursor).

## Sources (vérifiées le 2026-10-24)

- VS Code, « MCP configuration reference » —
  <https://code.visualstudio.com/docs/agents/reference/mcp-configuration>
  (DateApproved 2026-10-21).
- VS Code, « MCP servers » —
  <https://code.visualstudio.com/docs/agent-customization/mcp-servers> ;
  « Manage MCP servers » — <https://code.visualstudio.com/docs/agents/run/manage-mcp-servers> ;
  outils et approbations — <https://code.visualstudio.com/docs/agents/run/tools>,
  <https://code.visualstudio.com/docs/agents/run/approvals>.
- Cursor, « MCP » — <https://cursor.com/docs/mcp> ; aide —
  <https://cursor.com/help/customization/mcp> ; modes d'exécution —
  <https://cursor.com/docs/agent/security/run-modes> ; permissions —
  <https://cursor.com/docs/reference/permissions> (aucune date affichée).
