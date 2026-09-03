# Branches et pipeline

> [Documentation](README.md) · Branches et pipeline

## `targetBranch` : n'importe quelle branche

`main` n'est qu'un **défaut de configuration**, pas une contrainte. La
branche cible se règle via `targetBranch`, et toute la mécanique en dérive :

- les clones agents sont créés **depuis** elle (leur branche de tâche
  `striart/<agent>/task-<uuid>` part de son HEAD) ;
- les rebases (`autoRebase`, `striart sync`) se font **sur** elle ;
- les merges atterrissent **dedans** ;
- `autoPush` pousse **elle** vers `origin` ;
- `striart doctor` vérifie qu'elle est bien la branche courante.

Exemples — un repo dont le travail se fait sur `dev` :

```js
// striart.config.mjs
export default {
  targetBranch: 'dev',       // les agents partent de dev, mergent dans dev
  testCommand: 'npm test',
};
```

Un repo historique en `master` :

```js
export default {
  targetBranch: 'master',
  testCommand: 'npm test',
};
```

Pour un projet vierge, autant aligner le nom dès la création du repo :

```bash
git init -b dev            # ou -b master, -b main…
git add -A && git commit -m "chore: état initial"
striart init               # puis ajuster targetBranch dans striart.config.mjs
```

## La contrainte : le repo principal doit être sur `targetBranch`

Avant tout merge, rollback ou promotion, Striart vérifie l'état du repo
principal (**fail closed** — refuser plutôt que merger au mauvais endroit) :

- **Branche courante ≠ `targetBranch`** → refus `TARGET_BRANCH_MISMATCH` :

  > Le repo principal est sur "master" mais la branche attendue est "main".
  > Checkout la branche ou ajuste striart.config.

  Deux issues, au choix : `git checkout <targetBranch>` dans le repo
  principal, ou aligner `targetBranch` dans la config sur la branche réelle.

- **Modifications non commitées** dans le repo principal → refus
  `MAIN_DIRTY` : commit ou stash d'abord. L'orchestrateur ne merge jamais
  par-dessus du travail humain en cours.

`striart doctor` signale l'écart de branche avant même que vous tentiez un
merge (« sur "X" mais targetBranch = "Y" — merge/watch refuseront »).

Pendant que `striart watch` tourne, la branche cible appartient à
l'orchestrateur : les commits directs restent possibles (les agents seront
rebasés dessus au merge suivant), mais changer de branche ou laisser le
worktree sale suspendra les merges jusqu'au retour à un état propre.

## Le pipeline staging → main

Pour ne **jamais** exposer la branche stable à un état intermédiaire, Striart
propose un étage au-dessus : les agents mergent en continu dans
`targetBranch` (le staging), et `mainBranch` n'avance que par promotion
explicite.

```js
export default {
  targetBranch: 'striart/staging',                // les agents mergent ici en continu
  mainBranch: 'main',                             // promue uniquement via `striart promote`
  promoteTestCommand: 'npm run test:integration', // gate global (null → testCommand)
};
```

Le scénario `dev` → `main` s'écrit naturellement :

```js
export default {
  targetBranch: 'dev',
  mainBranch: 'main',
  promoteTestCommand: 'npm run test:e2e',
};
```

### `striart promote`

1. Exige `mainBranch` en config, **différent** de `targetBranch` ;
2. vérifie l'état du repo (`MAIN_DIRTY`, `TARGET_BRANCH_MISMATCH` — mêmes
   gardes que le merge) ;
3. refuse si `mainBranch` a des commits hors pipeline (fast-forward
   impossible) : « Réconcilie manuellement (merge mainBranch dans
   targetBranch) » — Striart n'invente jamais un merge sur la branche
   stable ;
4. joue le **Test Gate global** (`promoteTestCommand`) sur le staging ;
   rouge → promotion refusée, ticket créé, rollback du staging proposé ;
5. vert → `mainBranch` avance en **fast-forward** sur le staging :
   atomique, `main` n'est jamais dans un état intermédiaire, même une
   milliseconde.

`striart promote --rollback` défait la dernière promotion.

## `autoPush` et le remote

Les clones agents n'ont **pas de remote** : seul l'orchestrateur pousse
(règle d'or n°1). Par défaut `autoPush: false` — l'humain valide le push.
Avec `autoPush: true`, chaque merge vert est suivi d'un
`git push origin <targetBranch>` ; un échec de push est journalisé mais ne
défait pas le merge local.

`striart rollback` tient compte du push : merge non poussé → reset local
(récupérable via reflog) ; merge déjà poussé → revert (l'historique publié
est conservé).

## Voir aussi

- [Configuration](configuration.md) — la référence complète.
- [Commandes](commandes.md#striart-promote---rollback) — `promote`,
  `rollback`, `history`.
- [Dépannage](depannage.md) — les codes `TARGET_BRANCH_MISMATCH` et
  `MAIN_DIRTY` en situation.
