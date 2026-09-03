# Projets volumineux

> [Documentation](README.md) · Projets volumineux

L'isolation par vrais clones se paie en disque — voici comment la maîtriser :

- **L'historique est déjà quasi gratuit** : le clone se fait par chemin local,
  git hardlinke `.git/objects` (objets immuables → sûr même si le principal
  fait un `gc` : ses `unlink` ne touchent pas les inodes des clones). Seul le
  worktree est une vraie copie — c'est le prix de l'isolation, incompressible
  sans risque.
- **Très gros historiques** : `cloneFilter: 'blob:none'` en config — les blobs
  anciens sont récupérés à la demande depuis le repo principal (conservé en
  remote promisor fetch-only, `pushurl` neutralisé — la règle « les clones
  n'ont pas de remote qui pousse » tient toujours).
- **`node_modules`** : utilisez **pnpm** dans le projet cible (store global
  partagé par hardlinks, géré par un outil conçu pour). Ne partagez jamais
  `node_modules` par symlink entre agents : les caches d'outillage
  (`node_modules/.cache`, Vite, webpack) y écrivent en permanence.
- **Suivi et nettoyage** : `striart status` et le dashboard affichent la
  taille additionnelle de chaque clone (les hardlinks comptent 0) ;
  `striart clean` supprime les clones des agents arrêtés, et
  `striart prune` applique une rétention (clones arrêtés inactifs et tickets
  résolus depuis `pruneDays` jours — `--dry-run` pour prévisualiser).
  Un `striart prune` périodique (cron/tâche planifiée) garde `.striart/` sain.
- **Repartir chaud** : `striart start <agent> --reuse` réhabilite le clone
  conservé d'un agent arrêté — untracked préservés (`node_modules`), pas de
  réinstallation. Voir [Commandes](commandes.md#striart-start-agent---reuse---force).
