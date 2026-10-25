# Neovim — CodeCompanion.nvim

> [Documentation](../README.md) · [Intégrations](README.md) · Neovim
> 🇬🇧 [English](../../en/integrations/neovim.md)

[CodeCompanion.nvim](https://codecompanion.olimorris.dev/) est client MCP
natif (MCP 2025-11-25, transport stdio) et client ACP. Striart s'y branche
comme serveur MCP.

## Configuration MCP

```lua
require("codecompanion").setup({
  mcp = {
    servers = {
      ["striart"] = {
        cmd = { "striart", "mcp" },
      },
    },
    opts = {
      -- démarre Striart avec chaque chat ; sinon `/mcp` le démarre à la demande
      default_servers = { "striart" },
    },
  },
})
```

Le format `mcp.servers` (clé = nom, `cmd` = commande et arguments) et
`opts.default_servers` sont documentés ; l'entrée `striart` est l'adaptation
de l'exemple officiel.

**Répertoire de travail.** CodeCompanion ne documente pas d'option `cwd`.
D'après son code source (`lua/codecompanion/mcp/client.lua`, lancement par
`vim.system` sans `cwd`), le serveur hérite du **répertoire courant de
Neovim** — information tirée du source, **non documentée**. Lancez Neovim à
la racine du dépôt (ou `:cd` dessus avant le premier chat).

## Agents ACP

CodeCompanion fournit des adaptateurs ACP (`claude_code`, `codex`,
`gemini_cli`, `goose`, `opencode`…). Pour leur transmettre Striart, la
documentation indique de régler, dans les `defaults` de l'adaptateur,
`mcpServers = "inherit_from_config"` : « seuls les serveurs de
`mcp.opts.default_servers` sont transmis », et `mcp.opts.acp_enabled = false`
coupe toute transmission. La manière de surcharger un adaptateur intégré se
reprend de la page « ACP adapters » (non recopiée ici). Le `cwd` de session
ACP est `vim.fn.getcwd()` (d'après le source, non documenté).

Pour utiliser **Striart lui-même comme agent ACP** (`striart acp`), déclarez un
adaptateur personnalisé dont la commande est `{ "striart", "acp" }` — la
manière exacte de déclarer un adaptateur ACP personnalisé se reprend de la page
« ACP adapters » de CodeCompanion (non recopiée ici, **non vérifiée**). Une
session de Neovim = un clone isolé + l'agent amont choisi + un merge sous Test
Gate. **Recette réelle : à faire.**

## Ce qui est couvert

- Outils Striart (contenu texte), dans le chat et pour les agents ACP qui
  héritent des serveurs. Ressources MCP non prises en charge par
  CodeCompanion (Striart en expose, `striart://…`, mais seuls ses outils
  servent ici).

## Sécurité

- **« Les outils MCP s'exécutent sans demander, sauf si vous définissez
  `require_approval_before` »** (documentation CodeCompanion). Configurez
  l'approbation au moins pour `striart_run`, `striart_merge`,
  `striart_promote`, `striart_resolve_prepare`, `striart_resolve_apply` et
  `striart_collab_post`, via `tool_overrides` du serveur. **Non
  vérifié** : la structure exacte de `tool_overrides` — reprenez-la de la
  page « MCP ».
- Les roots MCP sont un indice que CodeCompanion ne peut pas imposer
  (Striart ne s'en sert pas).

## Sources (vérifiées le 2026-10-24)

- CodeCompanion, configuration MCP —
  <https://codecompanion.olimorris.dev/configuration/mcp> ; support MCP —
  <https://codecompanion.olimorris.dev/model-context-protocol> ; adaptateurs
  ACP — <https://codecompanion.olimorris.dev/configuration/adapters-acp>
  (sources : `doc/` du dépôt olimorris/codecompanion.nvim, commits du 2026-10-10
  au 2026-10-16 ; version v20.0.1 du 2026-10-17).
