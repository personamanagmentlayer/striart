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
| `timeout` | Avec `autonomous` : délai max de session en ms (précédence sur `autonomousTimeoutMs`). |

## Deux garde-fous de conception

- **Un plan est de la donnée, jamais du code** — pas de fichier exécutable :
  un plan circule (commit, PR, partage), l'exécuter serait la faille de la
  config-as-code. Le prompt reste de la donnée, une tâche autonome référence
  un **profil** (défini par l'admin en config), pas une commande shell brute.
- **`after` ne peut désigner qu'une tâche définie plus haut** dans le fichier —
  règle simple qui rend le graphe acyclique par construction. La validation
  complète tombe **avant** toute application : un plan invalide n'applique
  aucune tâche.

Exemple complet et commenté :
[`examples/plan.example.yaml`](../../examples/plan.example.yaml).
