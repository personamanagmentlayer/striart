# Branches et releases de Striart

> [Documentation](README.md) · Branches et releases de Striart
>
> Cette page décrit comment **le dépôt de Striart lui-même** est géré : branches,
> versions, tags, releases. Elle ne concerne pas `targetBranch`, qui règle les
> dépôts *cibles* que Striart orchestre — voir [Branches et pipeline](branches.md).

## Branches

Striart suit un modèle **trunk-based** : une seule branche de développement,
courte, protégée, toujours verte.

| Branche | Rôle | Durée de vie |
|---|---|---|
| `main` | Branche par défaut. Reçoit tout le travail via pull request. | permanente |
| `feat/…`, `fix/…`, `chore/…`, `docs/…` | Branches de travail, une par sujet, créées depuis `main`. | quelques jours |
| `release/X.Y` | Maintenance d'une version **déjà publiée** (correctif de sécurité ou de régression). Créée **seulement à la demande**, depuis le tag `vX.Y.Z` concerné. | tant que la ligne X.Y est supportée |

Règles :

- Une pull request = un sujet, ouverte vers `main` (ou vers `release/X.Y` pour un
  rétro-portage). Un correctif de maintenance est d'abord fusionné dans `main`,
  puis rétro-porté par `git cherry-pick -x` : `main` ne perd jamais un correctif.
- **Fusion en squash uniquement.** Une pull request devient un commit sur `main` :
  historique linéaire, un commit = un sujet, annulation par un seul `git revert`.
  Le message du squash reprend le titre de la PR (un message de Conventional
  Commits) et conserve les lignes `Signed-off-by` et `Co-authored-by` des commits.
- Commits au format [Conventional Commits](https://www.conventionalcommits.org/) :
  `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `perf:`, `ci:` ; le
  **pourquoi** dans le corps. Un changement qui rompt la compatibilité porte
  `!` (`feat!:`) ou un pied `BREAKING CHANGE:`.
- Signer les commits d'un `Signed-off-by` (`git commit -s`) atteste que vous avez
  le droit de les soumettre sous la licence du projet (MIT).
- Aucun *force-push* ni suppression sur `main` et `release/*`.

### Protection attendue

Sur `main` et `release/*` (jeux de règles versionnés dans
[`.github/rulesets/`](../../.github/rulesets/default-branch.json)) : pull request
obligatoire, une approbation, conversations résolues, contrôle `ci-ok` vert et
branche à jour, historique linéaire, squash seul, ni *force-push* ni suppression.
Sur les tags `v*` : création réservée aux mainteneurs, ni déplacement ni suppression.

## Intégration continue

Le workflow `CI` tourne sur chaque pull request vers `main` ou `release/*` et sur
chaque push de ces branches (jamais sur un tag : un tag désigne un commit déjà
testé). Le job final **`ci-ok`** échoue si un job amont est rouge, annulé ou sauté :
c'est le seul contrôle à exiger. Une pull request obsolète est annulée par
nouvelle poussée ; un push n'est jamais annulé.

## Versions et tags

- **SemVer** (`MAJEUR.MINEUR.CORRECTIF`). Tant que la majeure est `0`, une montée de
  **mineure peut rompre la compatibilité** (annoncée dans « Ruptures » du
  `CHANGELOG.md`) ; une montée de **correctif** ne contient que des corrections.
  À partir de `1.0.0`, une rupture exige une nouvelle majeure.
- La source de vérité de la version est le champ `version` de `package.json`.
- Un tag est **annoté** et nommé `vX.Y.Z` (ou `vX.Y.Z-rc.N` pour une préversion ;
  `rc` est la seule préversion admise). Il est signé quand une clé est disponible
  (`git tag -s`). Un tag publié **ne se déplace jamais** : on corrige par la version
  suivante.
- Le `CHANGELOG.md` porte une entrée **datée** `## [X.Y.Z] — AAAA-MM-JJ` par version.

`node scripts/release-check.ts` refuse (sortie 1) un tag mal formé ou différent de la
version de `package.json`, une entrée de CHANGELOG absente, non datée ou à une date
future, un arbre sale, un tag léger ou qui ne désigne pas `HEAD`, une version qui ne
progresse pas, un commit hors branche de release, une CI qui n'est pas verte sur ce
commit (`--require-ci`) et, avec `--repro --native-dir <dossier>`, une archive qui n'est
pas reproductible.

## Faire une release (mainteneurs)

1. Sur `main`, à jour et vert : monter `version` dans `package.json`, dater l'entrée
   du `CHANGELOG.md`, fusionner par pull request.
2. `node scripts/release-check.ts` (mode préparation, sans tag) doit être conforme.
3. Créer et pousser le tag annoté :
   `git tag -s -a vX.Y.Z -m "Striart vX.Y.Z"` (`-a` seul sans clé de signature), puis
   `git push origin vX.Y.Z`.
4. Le workflow `Release` se déclenche sur le tag. Il **ne publie rien sur un registre
   de paquets**. Il : (a) rejoue `release-check --require-ci` — tag, version,
   CHANGELOG, CI verte sur ce commit ; (b) récupère les binaires natifs de l'exécution
   de CI verte de ce commit (ce qui est livré est ce qui a été testé) ; (c) vérifie que
   deux constructions de l'archive sont identiques ; (d) construit et signe les
   archives (`npm run pack:release`, manifeste minisign), le SBOM CycloneDX et
   `SHA256SUMS` ; (e) attache une attestation de provenance ; (f) crée une
   **release GitHub en brouillon** dont les notes sont extraites du CHANGELOG
   (préversion cochée pour un `-rc.N`).
5. Relire le brouillon, puis le publier à la main.

Vérifier une archive téléchargée : `sha256sum -c SHA256SUMS` et
`gh attestation verify <archive>.tgz --repo <propriétaire>/striart`.

Le secret `STRIART_NATIVE_SIGNING_KEY` n'est lu que par le job `archives`, dans
l'`environment` `release` (relecteurs requis, restreint aux tags `v*`) ; il n'est jamais
affiché. Les pull requests n'y ont aucun accès : elles signent avec une clé jetable, en
`--dry-run`.

## Correctif sur une version publiée

1. Corriger sur `main` (pull request, squash).
2. `git switch -c release/X.Y vX.Y.Z` puis `git push -u origin release/X.Y` — la branche
   n'existe que si le besoin se présente.
3. `git cherry-pick -x <commit du correctif>` via une pull request vers `release/X.Y`.
4. Version `X.Y.(Z+1)`, entrée de CHANGELOG, tag `vX.Y.(Z+1)` depuis `release/X.Y` :
   `release-check` exige que la version reste dans la ligne X.Y.
