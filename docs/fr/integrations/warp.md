# Warp

> [Documentation](../README.md) · [Intégrations](README.md) · Warp
> 🇬🇧 [English](../../en/integrations/warp.md)

Warp touche Striart par trois mécanismes : le **serveur MCP** de son agent,
ses **règles** (AGENTS.md / WARP.md) et ses **Tab Configs** pour ouvrir un
onglet dans le clone d'un agent.

## Serveur MCP

| Portée | Fichier | Démarrage automatique |
|---|---|---|
| Global | `~/.warp/.mcp.json` | oui par défaut |
| Projet | `.warp/.mcp.json` à la racine du projet | **jamais** — démarrage manuel |

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp"],
      "working_directory": "/chemin/absolu/vers/mon-projet"
    }
  }
}
```

`working_directory` (« répertoire où la commande est lancée ») est documenté
pour les serveurs CLI ; **non vérifié** : qu'il soit honoré dans les
fichiers `.mcp.json` (il est décrit pour l'interface de réglages) et qu'un
chemin relatif y soit accepté. Une entrée **globale** doit fixer le dépôt,
sans quoi elle pilote le dépôt du répertoire de lancement.

Warp lit aussi, sur bascule explicite, les fichiers MCP d'autres agents
(`.mcp.json` de Claude Code, `.codex/config.toml`, `.agents/.mcp.json`).
Le CLI Warp Agent garde sa propre configuration (macOS : `~/.warp_cli/.mcp.json`).

## Règles : AGENTS.md et WARP.md

- Warp utilise `AGENTS.md` comme fichier de règles de projet par défaut ;
  si `WARP.md` et `AGENTS.md` coexistent dans un dossier, **`WARP.md`
  l'emporte**. Le nom doit être en majuscules.
- Priorité : fichier du sous-dossier courant > fichier racine > règles
  globales (`~/.agents/AGENTS.md` pour le CLI).
- Un clone Striart (`.striart/agents/<nom>/`) est un clone complet : il porte
  l'`AGENTS.md` / `WARP.md` du dépôt, que Warp applique à l'agent qui y
  travaille.

## Tab Configs : ouvrir un onglet dans le clone d'un agent

`striart start --open` ouvre un onglet dans le terminal choisi par
`terminal.launcher` ([Configuration](../configuration.md#terminal--le-lanceur-de---open)) ;
**Warp est un lanceur à part entière** : `terminal: { launcher: 'warp' }`, ou
automatiquement quand Striart est lancé depuis une session Warp
(`TERM_PROGRAM=WarpTerminal`, désactivable par `terminal.detectWarp: false`).
Le schéma d'URI de Warp (`warp://action/new_tab?path=…`) n'exécute aucune
commande : Striart écrit donc lui-même une Tab Config (TOML,
`striart-<agent>-<empreinte>.toml`, mode 0600, un seul volet dans le clone,
commande d'attache `striart attach` citée pour le shell choisi) dans le
dossier ci-dessous, puis l'ouvre par `warp://tab_config/<nom>`. L'empreinte
distingue deux dépôts qui ont chacun un `agent-a`. Ce fichier est retiré par
`striart stop` et `striart clean` (échec rapporté : avertissement
`AGENT_ARTIFACT_FAILED`, le supprimer alors à la main). À la
main, une Tab Config fait l'équivalent. Dossiers :

- macOS : `~/.warp/tab_configs/`
- Windows : `%APPDATA%\warp\Warp\data\tab_configs\`
- Linux : `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/`

```toml
name = "Striart agent-a"

[[panes]]
id = "main"
type = "terminal"
directory = "/chemin/absolu/vers/mon-projet/.striart/agents/agent-a"
commands = ["claude"]
```

Ouverture par `warp://tab_config/<nom>`. Les anciennes « Launch
Configurations » YAML sont remplacées par les Tab Configs (toujours lues).

## Ce qui est couvert

- Les outils Striart dans l'agent de Warp (Warp liste outils et ressources
  par serveur ; Striart expose les deux).
- Règles AGENTS.md des clones ; ouverture d'un onglet par agent.

## Sécurité

- Les modifications de configuration demandent une approbation ; les
  serveurs de **projet** ne démarrent jamais seuls et leur activation vaut
  pour la session (« si vous faites toujours confiance au dépôt »).
- Gardez la confirmation sur les outils mutants de Striart dans les
  permissions de l'agent Warp.
- Le partage d'une configuration retire les secrets de `env`.

## Sources (vérifiées le 2026-10-24)

- Warp, MCP — <https://docs.warp.dev/agents/capabilities/mcp> (mise à jour
  20 octobre 2026).
- Warp, règles — <https://docs.warp.dev/agents/capabilities/rules> (20 octobre 2026).
- Warp, Tab Configs — <https://docs.warp.dev/terminal/windows/tab-configs>
  (20 octobre 2026).
- AGENTS.md — <https://agents.md/>
