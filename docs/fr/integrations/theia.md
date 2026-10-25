# Eclipse Theia (Theia IDE et applications Theia AI)

> [Documentation](../README.md) · [Intégrations](README.md) · Eclipse Theia
> 🇬🇧 [English](../../en/integrations/theia.md)

Theia AI consomme des serveurs MCP déclarés dans ses préférences ; Striart
s'y branche comme serveur MCP stdio.

## Configuration

Préférence `ai-features.mcp.mcpServers` (fichier de préférences
`settings.json`, ou l'éditeur de préférences de Theia) :

```json
{
  "ai-features.mcp.mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp"],
      "autostart": true
    }
  }
}
```

Champs documentés pour un serveur local : `command`, `args`, `env`,
`autostart` (défaut `true`). Les commandes « MCP: Start MCP Server » et
« MCP: Stop MCP Server » pilotent le serveur ; une modification s'applique au
redémarrage suivant.

**Répertoire de travail — non vérifié.** Theia ne documente pas de champ
`cwd` ; son propre exemple de serveur Git passe le dépôt **en argument**
(`--directory`). Faites de même avec `striart mcp --root` (voir la
[page commune](README.md#choisir-le-dépôt-piloté---root)), avec le chemin
absolu du dépôt :

```json
{
  "ai-features.mcp.mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "/chemin/absolu/vers/mon-projet"]
    }
  }
}
```

## Ce qui est couvert

- Les outils Striart, visibles dès que le serveur démarre, utilisables par
  les agents de Theia AI.
- Theia peut aussi exposer ses propres outils comme serveur MCP (Streamable
  HTTP, `POST /mcp`) ; c'est l'autre direction, sans lien avec Striart.

## Limites

- Pas de `cwd` documenté : une entrée par dépôt, avec `--root`.
- Pas de support ACP documenté côté Theia (**non vérifié**) : `striart acp`
  ne s'y applique pas tant que Theia n'est pas client ACP.

## Sécurité

- Chaque outil a un mode : Disabled, Confirm (défaut global) ou Always Allow
  (préférences `ai-features.chat.defaultToolConfirmation` et
  `ai-features.chat.toolConfirmation`). Gardez **Confirm** pour les outils
  mutants de Striart ; « Always allow » seulement pour `striart_status` et
  `striart_queue`.
- Le serveur MCP de Theia lui-même (s'il est activé) n'est à ouvrir que dans
  un environnement de confiance (avertissement de sa documentation).

## Sources (vérifiées le 2026-10-24)

- Theia, « Using AI features » — <https://theia-ide.org/docs/user_ai/>
  (aucune date affichée).
- README du paquet `@theia/ai-mcp` —
  <https://github.com/eclipse-theia/theia/tree/master/packages/ai-mcp>
- README du paquet `@theia/ai-mcp-server` —
  <https://github.com/eclipse-theia/theia/tree/master/packages/ai-mcp-server>
