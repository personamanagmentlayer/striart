# Visual Studio 2022 (17.14+) / Visual Studio 2026

> [Documentation](../README.md) · [Intégrations](README.md) · Visual Studio
> 🇬🇧 [English](../../en/integrations/visual-studio.md)

Visual Studio consomme des serveurs MCP depuis le mode agent de GitHub
Copilot. Striart s'y branche comme serveur MCP stdio.

## Configuration

Visual Studio lit les configurations MCP dans cet ordre (documentation
officielle) :

1. `%USERPROFILE%\.mcp.json` — global à l'utilisateur, pour toutes les solutions ;
2. `<SOLUTIONDIR>\.vs\mcp.json` — propre à Visual Studio, à l'utilisateur et à la solution ;
3. `<SOLUTIONDIR>\.mcp.json` — versionnable avec le dépôt ;
4. `<SOLUTIONDIR>\.vscode\mcp.json` ;
5. `<SOLUTIONDIR>\.cursor\mcp.json`.

Recommandé : `<SOLUTIONDIR>\.vs\mcp.json` (non versionné, propre au poste) ou
`<SOLUTIONDIR>\.mcp.json` si l'équipe veut partager l'entrée. La clé de
premier niveau est `servers` :

```json
{
  "servers": {
    "striart": {
      "type": "stdio",
      "command": "striart",
      "args": ["mcp"]
    }
  }
}
```

La page officielle ne montre qu'un exemple de serveur distant (`url`) ; les
champs stdio `type: "stdio"`, `command` et `args` sont confirmés par son
lien d'installation en un clic et par sa description des fichiers (« nom,
type de transport (stdio ou SSE), commande, arguments, variables
d'environnement optionnelles »).

**Répertoire de travail — non vérifié.** La documentation ne décrit ni champ
`cwd` ni répertoire de lancement. La solution doit se trouver dans le dépôt
cible initialisé par `striart init` ; si le journal du serveur montre une
autre racine, passez `--root <dépôt>` dans `args` (voir
[la page commune](README.md#choisir-le-dépôt-piloté---root)).
Si `striart` n'est pas trouvé, visez `node` avec le chemin absolu de
`src/cli.js` ([Windows](README.md#windows--la-commande-striart)).

## Ce qui est couvert

- Les outils Striart (lecture et mutation), utilisables par le mode agent de
  Copilot. Striart n'expose aucun prompt : rien n'apparaît sous
  « Add Reference > Prompts » ni via `#`. Ses ressources (`striart://…`) ne
  sont pas utilisées par ce client (**non vérifié**).
- **Les outils sont désactivés par défaut** : il faut les activer à la main
  dans la liste des outils de la fenêtre de chat.

## Limites

- Pas de répertoire de travail configurable documenté (voir plus haut).
- Une intégration native (extension) n'est pas prévue pour Visual Studio à
  ce stade ; l'extension VS Code (livrée, non publiée) vise VS Code et, une fois
  publiée, Open VSX.

## Sécurité

- Visual Studio 2026 (18.7+) affiche une boîte de confiance quand la
  commande, les arguments ou la liste d'outils d'un serveur changent (pas à
  la première rencontre, qui sert de référence) : refusez tout changement que
  vous n'avez pas fait.
- Sur `notifications/tools/list_changed`, Visual Studio réinitialise les
  approbations d'outils (protection « rug-pull »).
- L'approbation d'un outil peut être mémorisée pour la session, la solution
  ou toujours : réservez « toujours » à `striart_status` et `striart_queue`.
  Réinitialisation : Tools > Options > GitHub > Copilot > Tools.
- Un `.mcp.json` versionné peut lancer n'importe quelle commande : relisez-le
  dans tout dépôt cloné.

## Sources (vérifiées le 2026-10-24)

- Microsoft Learn, « Use MCP servers in Visual Studio » —
  <https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers>
  (`ms.date` 2026-05-26, mise à jour 2026-10-14).
