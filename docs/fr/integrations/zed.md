# Zed

> [Documentation](../README.md) · [Intégrations](README.md) · Zed
> 🇬🇧 [English](../../en/integrations/zed.md)

Zed consomme des serveurs MCP (`context_servers`) et des agents externes ACP
(`agent_servers`). Striart s'y branche des deux façons : comme serveur MCP, et
comme agent ACP par le proxy `striart acp`.

## Configuration MCP

Dans `settings.json` — utilisateur (`~/.config/zed/settings.json`) ou projet
(`.zed/settings.json` à la racine, fusionné par-dessus) :

```json
{
  "context_servers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "/chemin/absolu/vers/mon-projet"],
      "env": {}
    }
  }
}
```

Préférez le fichier **projet** : il lie le serveur au dépôt ouvert.

**Répertoire de travail — non vérifié.** Zed ne documente ni `cwd` ni
répertoire de lancement pour un serveur de contexte : `--root` (voir la
[page commune](README.md#choisir-le-dépôt-piloté---root)) fixe le dépôt sans
en dépendre. Vérifiez la racine dans le journal du serveur.

## Striart comme agent ACP : `striart acp`

Zed est un client ACP : déclarez Striart comme agent externe, dans le même
`settings.json` (le **projet** `.zed/settings.json` lie l'entrée au dépôt
ouvert) :

```json
{
  "agent_servers": {
    "Striart": {
      "type": "custom",
      "command": "striart",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Une session de Zed = un clone isolé + l'agent amont que vous choisissez dans
les options de session + un merge sous Test Gate ; les fichiers et le
terminal de Zed ne sont **jamais** utilisés par l'agent amont (voir
[Striart comme agent ACP](README.md#striart-comme-agent-acp--striart-acp)).
Prérequis : au moins un profil ACP configuré (`striart profiles --detect`).
`/striart-finish` termine la session. **Recette sur Zed réel : à faire** (non
vérifiée ici).

## Agents externes ACP et serveurs MCP transmis

Les serveurs MCP configurés dans Zed « peuvent être transmis aux agents
externes via ACP » : un agent ACP (Claude Agent, Codex, Gemini…) déclaré dans
`agent_servers` reçoit alors les outils Striart. Forme documentée d'un agent
personnalisé :

```json
{
  "agent_servers": {
    "mon-agent": {
      "type": "custom",
      "command": "node",
      "args": ["~/projects/agent/index.js", "--acp"],
      "env": {}
    }
  }
}
```

Le protocole ACP exige un `command` absolu pour un serveur MCP transmis ;
si un agent refuse `striart`, déclarez le serveur avec son chemin absolu.

## Ce qui est couvert

- Les outils Striart dans l'agent de Zed et, par transmission, dans les
  agents ACP. (Zed prend en charge outils et prompts MCP, pas les
  ressources ; Striart expose des outils et des ressources `striart://…`,
  seuls les outils servent donc ici.)
- Striart lui-même comme agent ACP (`striart acp`, ci-dessus).
- Les profils d'agent peuvent activer ou désactiver chaque outil MCP.

## Sécurité

- Depuis Zed v0.224.0, `agent.tool_permissions.default` vaut `"confirm"` par
  défaut : chaque action d'outil, MCP compris, demande une approbation.
  Gardez ce défaut. Les outils MCP se désignent `mcp:<serveur>:<outil>`
  (par exemple `mcp:striart:striart_run`) et n'acceptent qu'un réglage
  `default` ; n'en passez à `"allow"` que `mcp:striart:striart_status` et
  `mcp:striart:striart_queue`. La structure exacte de ces entrées se reprend
  de la page « Tool permissions » (exemples non recopiés ici à
  l'identique — **à vérifier** sur la page).
- **Confiance de l'espace de travail** : une fois un dossier approuvé, ses
  réglages de projet et ses serveurs MCP démarrent automatiquement. Relisez
  `.zed/settings.json` avant d'approuver un dépôt cloné.

## Sources (vérifiées le 2026-10-24)

- Zed, MCP — <https://zed.dev/docs/ai/mcp>
- Zed, agents externes — <https://zed.dev/docs/ai/external-agents>
- Zed, permissions des outils — <https://zed.dev/docs/ai/tool-permissions>
- Zed, configuration — <https://zed.dev/docs/configuring-zed>
- ACP, schéma `McpServer` — <https://agentclientprotocol.com/protocol/session-setup>

(Aucune date de mise à jour affichée sur ces pages.)
