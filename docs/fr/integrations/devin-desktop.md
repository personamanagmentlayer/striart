# Devin Desktop (ex-Windsurf)

> [Documentation](../README.md) · [Intégrations](README.md) · Devin Desktop
> 🇬🇧 [English](../../en/integrations/devin-desktop.md)

Windsurf est devenu **Devin Desktop** le 2 juin 2026. Deux agents y
cohabitent, avec deux configurations MCP distinctes : **Devin Local** (agent
par défaut des nouveaux onglets) et **Cascade** (agent historique, annoncé
disponible « jusqu'en juillet » par la FAQ officielle — vérifiez s'il l'est
encore dans votre version).

## Devin Local (agent par défaut)

### Configuration

| Portée | Fichier |
|---|---|
| Utilisateur | `~/.config/devin/mcp_config.json` (Windows : `%APPDATA%\devin\mcp_config.json`) |
| Projet (versionné) | `.devin/mcp_config.json` |
| Local (ignoré par git, portée par défaut de `devin mcp add`) | `.devin/mcp_config.local.json` |

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

Ou en ligne de commande, depuis la racine du dépôt :

```bash
devin mcp add striart -- striart mcp              # portée locale
devin mcp add -s project striart -- striart mcp   # portée projet
```

Le fichier MCP a changé d'emplacement en v3000.3 (Local 3.6) ; les versions
antérieures gardaient `mcpServers` dans `config.json` et migrent seules.

### Permissions

Devin Local **demande une approbation avant tout outil MCP** par défaut.
Les règles `allow` / `deny` / `ask` de la configuration de Devin (format de
la page MCP de Devin Local) désignent un outil par `mcp__<serveur>__<outil>` ;
n'ajoutez en `allow` que les outils en lecture :

```json
{
  "permissions": {
    "allow": ["mcp__striart__striart_status", "mcp__striart__striart_queue"]
  }
}
```

Jamais `mcp__striart__*` ni `mcp__*` en `allow`.

## Cascade (agent historique)

### Configuration

Fichier **utilisateur uniquement** : `~/.config/devin/mcp_config.json` (ou
`$XDG_CONFIG_HOME/devin/mcp_config.json`) ; Windows :
`%APPDATA%\devin\mcp_config.json`. **Non vérifié** : la lecture de l'ancien
`~/.codeium/windsurf/mcp_config.json`.

Faute de configuration par projet, fixez le dépôt avec `--root` (voir la
[page commune](README.md#choisir-le-dépôt-piloté---root)), et
masquez les outils mutants avec `disabledTools` — **Cascade ne demande pas
d'approbation avant un outil MCP par défaut** (hors d'un clone, le serveur est
de toute façon en lecture seule tant que `mcp.scope` reste `agent`) :

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "/chemin/absolu/vers/mon-projet"],
      "disabledTools": [
        "striart_run",
        "striart_merge",
        "striart_promote",
        "striart_resolve_prepare",
        "striart_resolve_apply",
        "striart_collab_post"
      ]
    }
  }
}
```

### Limite de 100 outils

« Cascade a une limite de 100 outils au total à un instant donné. » Striart
en consomme peu (liste dans [Serveur MCP](../mcp.md)) ; si la limite est
atteinte, désactivez des outils d'autres serveurs plutôt que de Striart en
lecture.

## Ce qui est couvert

- Les outils Striart pour Devin Local et Cascade (Cascade prend aussi en
  charge ressources et prompts, que Striart n'utilise pas).

## Limites

- **Répertoire de travail — non vérifié** pour les deux agents : aucun champ
  `cwd` documenté. Préférez la configuration projet de Devin Local, et
  vérifiez la racine dans le journal du serveur.
- L'extension VS Code de Striart est livrée dans le dépôt mais **pas publiée**
  (ni Open VSX ni Marketplace, sans date annoncée) : Devin Desktop ne pourra
  l'installer depuis Open VSX qu'une fois publiée ; d'ici là, un `.vsix` construit
  depuis les sources s'installe à la main (voir
  [VS Code et Cursor](vscode-cursor.md#extension-vs-code)).

## Sécurité

- Administration d'équipe : dès qu'un seul serveur MCP est mis en allowlist,
  tous les autres sont bloqués ; la correspondance se fait sur l'identifiant
  du serveur (la clé de `mcp_config.json`, sensible à la casse), avec regex
  ancrée optionnelle sur `command`/`args`.
- Les agents sont désactivés dans un espace de travail en mode restreint.
- `.devin/mcp_config.json` est versionné : relisez-le dans tout dépôt cloné.

## Sources (vérifiées le 2026-10-24)

- FAQ Devin Desktop — <https://docs.devin.ai/desktop/devin-desktop-faq> ;
  changelog — <https://docs.devin.ai/desktop/changelog> (2 juin 2026).
- Devin Local — <https://docs.devin.ai/desktop/devin-local>
- MCP de Devin Local / CLI — <https://docs.devin.ai/cli/extensibility/mcp/configuration>
- MCP de Cascade — <https://docs.devin.ai/desktop/cascade/mcp> (ancienne URL
  `docs.windsurf.com/windsurf/cascade/mcp` redirigée).

(Aucune date de mise à jour affichée sur ces pages.)
