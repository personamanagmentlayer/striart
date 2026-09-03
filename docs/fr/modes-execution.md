# Les deux modes d'exécution

> [Documentation](README.md) · Modes d'exécution

À chaque tâche, tu choisis qui pilote l'agent. La frontière n'est pas le
lancement, c'est la **surveillance** : session regardée par un humain, ou
boucle non surveillée — les deux sont assumées, tâche par tâche.

## Mode supervisé (défaut)

Striart prépare le clone isolé et te donne la commande ; tu lances ton outil
et tu regardes travailler. C'est le mode à utiliser pour une tâche ouverte,
exploratoire, ou sur du code sensible.

```bash
striart run "Refactor le module d'authentification" --command claude --open
```

## Mode autonome

Striart lance l'outil lui-même en mode non interactif, supervise le process,
merge, passe le Test Gate, et supprime le clone si tout est vert. C'est le
mode des tâches bien cadrées qu'on ne veut pas surveiller.

```bash
striart run "Ajoute des tests unitaires à src/parser.js" --autonomous --profile claude
striart run "Traduis les messages d'erreur en anglais" --autonomous --profile codex --timeout 600000
```

Deux prérequis, faciles à oublier : l'outil doit être **installé et déjà
authentifié** dans le shell d'où tu lances Striart — la session hérite de son
environnement, elle n'ouvre aucune fenêtre de login et ne peut répondre à
aucune invite. Et son profil doit être **réellement non interactif** : une
commande qui attend une confirmation restera bloquée jusqu'au `--timeout`.
Quand la session échoue, le clone est conservé et le log complet reste dans
`.striart/logs/session-<agent>-<taskId>.log`.

### Les profils : agnostique du fournisseur

Les profils rendent le mode **agnostique du fournisseur** : chaque outil a sa
syntaxe headless, `agentProfiles` la décrit une fois. Claude, Codex, Aider et
Ollama sont fournis ; ajouter Kimi ou un autre outil est une entrée de config,
et n'efface pas les profils existants. Plusieurs fournisseurs peuvent donc
travailler en parallèle sur le même projet, chacun dans son clone.

Champs par profil (voir la [référence de configuration](configuration.md)) :
`command` + `args` (avec `{{prompt}}` substitué **comme élément d'argv,
jamais via un shell** — le prompt est de la donnée, l'interpréter serait une
injection de commande), `env` (variables propres au profil, fusionnées
par-dessus l'environnement — cloisonner une clé par outil), `timeout`
(précédence : `--timeout` > `profile.timeout` > `autonomousTimeoutMs`),
`acp` (voir ci-dessous). `striart profiles` liste ce qui est configuré.

## Transport ACP — la session qui se laisse regarder

Un profil peut déclarer `acp: true` : Striart dialogue alors avec l'outil en
**ACP (Agent Client Protocol)** — JSON-RPC sur stdio, le standard
« client ↔ agent de coding » v1 (Gemini CLI et Copilot CLI nativement, Claude
Code via l'adaptateur officiel, 25+ agents) — au lieu de lui passer le prompt
en argv et d'attendre le code de sortie. Position symétrique du
[serveur MCP](mcp.md) : **MCP = l'agent pilote Striart, ACP = Striart pilote
l'agent.**

```js
agentProfiles: {
  'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  'gemini-acp': { command: 'gemini', args: ['--experimental-acp'], acp: true },
  // Lecture seule de fait : toute permission demandée est refusée.
  audit: { command: 'claude-agent-acp', args: [], acp: { permissions: 'reject' } },
  // SEMI-AUTONOME : chaque permission est arbitrée par l'humain au dashboard.
  prudent: { command: 'claude-agent-acp', args: [], acp: { permissions: 'ask', askTimeoutMs: 300000 } },
}
```

Même contrat de bout en bout (Router, merge, Test Gate, politique de
suppression du clone : l'orchestrateur ne voit pas la différence de
transport), mais plusieurs choses changent :

- **La session cesse d'être opaque** : messages, plan et appels d'outils sont
  transcrits en continu dans le log de session — il raconte le déroulé, pas
  seulement la fin.
- **Les invites deviennent des messages** : une demande de permission est
  répondue par la politique du profil (`allow` par défaut — le niveau de
  confiance des profils headless, tous en `--yes` ; ou `reject`), et tracée
  au log. Plus de session bloquée sur une confirmation jusqu'au timeout.
- **Ou arbitrée par toi** (`permissions: 'ask'`) — le mode **semi-autonome** :
  chaque demande apparaît en tête du dashboard avec un bouton par option
  proposée par l'agent ; sans réponse sous `askTimeoutMs` (défaut 120 s),
  **fail closed** — le refus s'applique, jamais un accord par défaut. La
  décision et son origine (humain ou délai) sont tracées au log de session.
- **Le filesystem passe par un point de contrôle** : les lectures/écritures
  que l'agent délègue à Striart sont **bornées au clone** — chemin hors du
  clone, refus.
- **L'arrêt est propre** : au timeout, `session/cancel` d'abord (l'agent peut
  finaliser), kill d'arbre en filet.

Avec `acp: true`, `args` ne contient **pas** `{{prompt}}` : le prompt passe
par le protocole (un placeholder y est refusé au chargement de la config —
un seul canal). Les profils argv restent le chemin des outils sans ACP, les
deux cohabitent librement.

## Ce que le mode autonome garantit

Le clone n'est supprimé que sur le **chemin entièrement vert** : sortie 0, au
moins un commit, merge réussi, Test Gate vert. Tout autre chemin le conserve
et dit pourquoi (`keptReason`) — session échouée, délai dépassé, sortie sans
le moindre commit, conflit, ou gate rouge. Le nettoyage n'utilise **jamais**
`--force` : si l'agent a laissé du travail non commité, le clone survit. Les
logs de session vivent sous `.striart/logs/`, hors du clone, donc ils lui
survivent toujours.

Trois contraintes de conception, non négociables :

1. **Le verrou principal n'est jamais tenu pendant la session** — elle dure
   des minutes ou des heures ; le cycle autonome compose des primitives qui
   prennent le verrou brièvement, chacune de leur côté.
2. **Le prompt n'est jamais passé à un shell** — substitué dans un élément
   d'argv (`shell: false`), ou transmis par le protocole ACP.
3. **Un clone dont la session vit est intouchable** (voir ci-dessous).

## Les deux modes cohabitent sur le même repo

Rien n'oblige à choisir globalement : un agent autonome et un agent supervisé
peuvent travailler côte à côte. C'est le **PID de session**, publié au registre
le temps qu'elle vit, qui rend l'état vérifiable plutôt que supposé :

- **`striart watch` ne merge pas les agents autonomes.** Leur merge appartient à
  leur fin de cycle. Sans ce filtre, le watcher mergeait leurs commits
  *intermédiaires* et entrait en course avec le merge final — repo principal
  bloqué en état « merging » quand la course était perdue.
- **`striart sync` saute leur clone** (`SKIPPED_SESSION`) : on ne se dispute pas
  l'index avec une session qui lance ses propres commandes git. Le rebase est
  ajourné, pas annulé.
- **`striart clean` refuse de le supprimer, même avec `--force`**
  (`SESSION_LIVE`) : `--force` sert à passer outre une heuristique, pas un fait.

Un PID resté au registre après un crash est neutralisé par le contrôle de
vitalité : rien ne reste gelé.

## Ce qu'il faut assumer

Sans humain qui relit, **le Test Gate devient la seule autorité** : la qualité
de `testCommand` sur ton repo devient portante. Un projet dont les tests sont
faibles obtiendra du code mergé que personne n'a lu.

Et `--timeout` borne le temps, **pas la dépense** : un agent autonome consomme
des tokens sans surveillance.

## Voir aussi

- [Plans — tâches-as-code](plans.md) — enchaîner des tâches (autonomes ou
  non) dans un graphe YAML versionné.
- [SECURITY.md](../../SECURITY.md) — l'environnement hérité par les sessions
  et les frontières de confiance.
