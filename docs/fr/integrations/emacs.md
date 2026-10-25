# Emacs — agent-shell

> [Documentation](../README.md) · [Intégrations](README.md) · Emacs
> 🇬🇧 [English](../../en/integrations/emacs.md)

[agent-shell](https://github.com/xenodium/agent-shell) est un client ACP pour
Emacs (Emacs 29.1+, dépend d'`acp.el` et de `shell-maker`, installés par
MELPA). Il ne consomme pas de serveur MCP lui-même : il **transmet** des
serveurs MCP aux agents ACP qu'il lance (Claude Agent, Codex, Gemini,
Goose…). C'est ainsi que Striart s'y branche.

## Configuration

```elisp
(setq agent-shell-mcp-servers
      '(((name . "striart")
         (command . "/chemin/absolu/vers/striart")
         (args . ("mcp"))
         (env . ()))))
```

La forme suit le schéma ACP `McpServer` (docstring d'`agent-shell-mcp-servers`) ;
le protocole exige un `command` **absolu** (`which striart`, ou sous Windows
le chemin de `node` + `src/cli.js`, voir [page commune](README.md#windows--la-commande-striart)).
Un agent peut avoir sa propre liste (mot-clé `:mcp-servers` de
`agent-shell-make-agent-config`), prioritaire sur la liste globale. Les
réglages peuvent se poser par projet via les variables locales de
répertoire.

**Répertoire de travail.** La session ACP démarre dans `agent-shell-cwd` :
`agent-shell-cwd-function` si défini, sinon la racine du projet, sinon
`default-directory`. Le répertoire dans lequel l'agent lance ensuite le
serveur MCP dépend de l'agent (**non vérifié**) ; vérifiez la racine dans le
journal du serveur, et au besoin passez `--root <dépôt>` (voir la
[page commune](README.md#choisir-le-dépôt-piloté---root)) à `striart mcp`.

## Ce qui est couvert

- Les outils Striart pour tout agent ACP lancé par agent-shell.

## Limites

- Pas de recette publique documentée pour déclarer une commande d'agent ACP
  entièrement personnalisée (les agents intégrés passent par une fonction
  interne) : `striart acp` (commande `striart`, argument `acp`) est à brancher
  par `agent-shell-agent-configs` — **non vérifié**, recette réelle à faire.

## Sécurité

- Les approbations d'outils sont celles de l'agent ACP lancé (et des
  permissions qu'agent-shell lui relaie) : gardez la confirmation sur les
  outils mutants de Striart dans la configuration de l'agent.

## Sources (vérifiées le 2026-10-24)

- README et `agent-shell.el` (version 0.89.1, `acp` 0.17.1) —
  <https://github.com/xenodium/agent-shell> (dernier commit du README :
  2026-10-23).
- ACP, schéma `McpServer` — <https://agentclientprotocol.com/protocol/session-setup>
