# Plans — tâches-as-code

> [Documentation](README.md) · Plans

Au lieu de retaper une séquence de `striart run`, décris un **graphe de
tâches** dans un fichier YAML committé avec le code — inspiré de Bruno (les
collections d'API en fichiers texte co-localisés au repo) : on le diffe, on le
revoit en PR, on le rejoue.

```yaml
# refonte-auth.yaml
version: 1
tasks:
  - id: schema
    prompt: |
      Ajoute une colonne jwt_version à la table users.
  - id: auth
    prompt: Fais passer l'authentification aux JWT.
    after: schema          # dépendance SÉMANTIQUE (aucune collision ne la déduirait)
  - id: tests
    prompt: Ajoute des tests pour le flux JWT.
    after: auth
    autonomous: true       # Striart pilote l'outil
    profile: claude
```

```bash
striart plan refonte-auth.yaml --dry-run   # valide et affiche, ne lance rien
striart plan refonte-auth.yaml             # applique
```

## Sémantique

`apply` **équivaut exactement** à la séquence de `striart run` décrite, les
`id` de plan résolus en noms d'agents pour les `after` : aucune sémantique
nouvelle, ça compose la file, `--after` et `reconcile`.

Champs d'une tâche :

| Champ | Rôle |
|---|---|
| `id` | Alias **local au plan**, cible d'un `after` — résolu en nom d'agent réel à l'application, jamais utilisé tel quel comme nom. |
| `agent` | Nom de l'agent (optionnel, dérivé du prompt si absent). |
| `prompt` | Le prompt de la tâche (scalaire ou bloc littéral YAML). De la **donnée**, jamais interprétée. |
| `after` | Référence à une tâche **définie plus haut** dans le fichier. La tâche attend en file la fin (merge + stop) du travail référencé. |
| `autonomous` | `true` → Striart pilote l'outil ([mode autonome](modes-execution.md)). |
| `profile` | Le profil d'`agentProfiles` à utiliser pour une tâche autonome. |
| `command` | Outil de coding pour une tâche supervisée (équivalent à `--command`). |
| `timeout` | Avec `autonomous` : délai max de session en ms, de 1000 à 2147483647 (précédence sur `autonomousTimeoutMs`). |

## Plans `version: 2` — modes d'orchestration

`version: 2` est un **format distinct**, pas une extension silencieuse du v1 :
un Striart antérieur le refuse (`UNSUPPORTED_VERSION`, fail closed) au lieu
d'appliquer une tâche `mode: review` sans relecture, et le v1 garde
exactement sa sémantique (file, `--after`, non bloquant). Le v2 est en
**validation positive** : toute clé inconnue est refusée (`PLAN_INVALID`,
`details.reason` stable), toute valeur hors liste aussi, et tout est validé
**avant** le moindre effet de bord, `--dry-run` compris — les profils cités
doivent exister en config.

```yaml
# revue-auth.yaml
version: 2
mode: sequential          # sequential (défaut) | parallel
onFailure: stop           # stop (défaut) | skip-dependents
tasks:
  - id: schema
    prompt: Ajoute une colonne jwt_version à la table users.
    autonomous: true
    profile: claude
  - id: auth
    mode: review          # un auteur, des relecteurs, merge après approbation PUIS Test Gate
    prompt: Fais passer l'authentification aux JWT.
    after: schema
    author: { profile: claude }
    reviewers:
      - { name: secu, profile: codex }
      - { name: humain, human: true }     # verdict par `striart review`
    quorum: all           # all | any | majority
    maxRounds: 3
  - id: perf
    mode: race            # best-of-n
    prompt: Accélère le parseur.
    candidates: [{ profile: claude }, { profile: codex }]
    pick: smallest-diff   # first-green | smallest-diff | judge
    losers: archive       # keep | archive | clean
  - id: api
    mode: team            # plusieurs rôles dans le même clone
    prompt: API de somme testée.
    cadence: parallel     # turns | parallel (partition statique)
    roles:
      - { name: backend, profile: claude, files: ['src/**'] }
      - { name: tests,   profile: codex,  files: ['tests/**'] }
  - id: livraison
    mode: pipeline        # étapes ordonnées, chacune nourrit la suivante
    after: [auth, api]    # `after` accepte une liste (fan-in)
    handoff: merge        # merge | clone
    steps:
      - { id: schema, prompt: Conçois le schéma, profile: claude }
      - { id: impl,   prompt: Implémente l'API,  profile: codex }
```

**Niveau plan** : `mode` — `sequential` (défaut : chaque tâche dépend
implicitement de la précédente ; une tâche *supervisée* est **attendue**
jusqu'à la sortie de son agent du registre) ou `parallel` (graphe de
dépendances, `concurrency` bornée par `orchestration.maxConcurrency`) ;
`concurrency` ; `onFailure`. `striart plan --mode`, `--concurrency` et
`--on-failure` les surchargent à l'application. **Niveau tâche** : `id`,
`mode` (`task` par défaut, `review`, `race`, `team`, `pipeline`), `agent`,
`after` (un id ou une liste ; un id défini plus haut, ou une référence
d'exécution — agent ou tâche vivant, attendu avec délai borné).

| Mode | Champs propres | Bornes |
|---|---|---|
| `task` | `prompt`, `autonomous`, `profile`, `command`, `timeout` | comme en v1 |
| `review` | `prompt`, `author` (`profile`, `timeout`), `reviewers` (`name`, `profile`, `timeout`, `prompt`, `human`), `quorum`, `maxRounds` | 1 à 5 relecteurs ; un relecteur humain n'a ni `profile` ni `timeout` |
| `race` | `prompt`, `candidates` (`profile`, `timeout`), `pick`, `losers` | 2 à 10 candidats |
| `team` | `prompt`, `cadence`, `rounds`, `roles` (`name`, `profile`, `timeout`, `prompt`, `files`) | 2 à 8 rôles ; en `parallel`, `files` est obligatoire par rôle ; `cadence: dynamic` refusée (`CADENCE_UNAVAILABLE`) |
| `pipeline` | `handoff`, `steps` (`id`, `prompt`, `profile`, `timeout`) | 2 à 10 étapes ; pas de `prompt` au niveau tâche |

Les noms de rôles et de relecteurs sont en minuscules, chiffres et tirets
(`author` et `striart` sont réservés). Un nom d'agent dérivé (`<agent>-<étape>`,
`<agent>-<n>`) doit rester un nom valide : `agent` est limité à 30 caractères
pour `pipeline` et `race`.

**Collision du Router** sur une tâche orchestrée : `orchestration.collisionPolicy`
vaut `wait` (défaut — la tâche attend, bornée par `waitTimeoutMs`, le départ
des agents en collision puis repasse le Router ; fail closed `WAIT_TIMEOUT`)
ou `fail`. Le mode autonome ne se perd donc plus dans la file comme en v1.
Même chemin en ligne de commande : [`striart orchestrate`](commandes.md#striart-orchestrate-mode-prompts).
Les comportements de chaque mode, le canal de collaboration et les
invariants de session sont décrits dans
[Modes d'exécution](modes-execution.md#les-modes-dorchestration) ; les
réglages dans [Configuration](configuration.md#orchestration-et-collab--modes-dorchestration-collaboration).

## Deux garde-fous de conception

- **Un plan est de la donnée, jamais du code** — pas de fichier exécutable :
  un plan circule (commit, PR, partage), l'exécuter serait la faille de la
  config-as-code. Le prompt reste de la donnée, une tâche autonome référence
  un **profil** (défini par l'admin en config), pas une commande shell brute.
- **`after` ne peut désigner qu'une tâche définie plus haut** dans le fichier —
  règle simple qui rend le graphe acyclique par construction. La validation
  complète tombe **avant** toute application : un plan invalide n'applique
  aucune tâche. Le refus `PLAN_INVALID` nomme la tâche (position, `id`) et
  le champ fautifs ; en `--json`, `error.details.reason` en donne la cause
  par un sous-code stable (`PROMPT_MISSING`, `AFTER_FORWARD`,
  `DUPLICATE_ID`… — liste dans [Commandes](commandes.md#sortie-machine----json)).
  Un plan sans ligne `version:` donne `VERSION_MISSING` (attendu :
  `version: 1` ou `version: 2`), un plan d'une autre version
  `UNSUPPORTED_VERSION`.

Exemple complet et commenté :
[`examples/plan.example.yaml`](../../examples/plan.example.yaml).

## Interrompre un plan

Un plan n'est pas une transaction : chaque tâche passe par son propre
`runTask`/`runAutonomousTask`. Ctrl+C (ou SIGTERM) pendant l'application
arrête donc **proprement** : la session autonome en cours reçoit le signal et
s'arrête comme `run --autonomous` (arbre de l'agent tué, PID dépublié,
clone conservé), et **aucune tâche suivante ne démarre**. Les tâches déjà
appliquées restent appliquées ; celles qui n'ont pas été lancées sont
listées (`notApplied` en `--json`, « non appliquée (arrêt demandé) » à
l'écran) — rien n'est perdu en silence. Pour reprendre, relancer le plan
sans les tâches déjà faites. La CLI sort en 130 (143 pour SIGTERM) et le
document `--json` rend `ok: false` : un plan interrompu n'a pas atteint son
intention, même si les tâches lancées ont réussi.
