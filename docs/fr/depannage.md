# Dépannage

> [Documentation](README.md) · Dépannage

## Premier réflexe : `striart doctor`

```bash
striart doctor          # git, repo, config, LLM joignable, verrous, tickets
striart doctor --json   # scriptable
```

Le doctor vérifie notamment : la version de git, que le répertoire est bien
dans un repo Git, que la config charge et valide, que le LLM répond (ping
Ollama, ou présence de la clé API du provider cloud), l'état des verrous, les
tickets ouverts, et **que la branche courante est `targetBranch`** — un écart
affiche « sur "X" mais targetBranch = "Y" — merge/watch refuseront ».

## Les codes d'erreur

Toutes les erreurs Striart portent un `code` machine-readable (affiché par le
CLI à côté du message humain). Les plus fréquents :

| Code | Signification | Issue |
|---|---|---|
| `TARGET_BRANCH_MISMATCH` | Le repo principal n'est pas sur `targetBranch`. | `git checkout <targetBranch>`, ou ajuster la config — voir [Branches](branches.md#la-contrainte--le-repo-principal-doit-être-sur-targetbranch). |
| `MAIN_DIRTY` | Le repo principal a des modifications non commitées. | Commit ou stash, puis relancer. |
| `ROUTER_FAILED` | Le LLM du Router n'a pas répondu ou a rendu une sortie inexploitable. | `striart doctor` (LLM joignable ? clé présente ?) ; relancer — le Router est un filtre, pas une garantie. |
| `MERGE_CONFLICT` | Conflit non résolu (fusion sémantique échouée ou désactivée). | Ticket dans `.striart/conflicts/` — résoudre puis `striart resolve --close <id>`. |
| `GATE_FAILED` | La suite de tests a rejeté le merge (statut de `mergeAgentCommit`, pas une `StriartError` levée). | Lire `test-output.log` du ticket ; corriger côté agent ou main. |
| `SESSION_LIVE` | Le clone héberge une session autonome vivante (PID vérifié). | Attendre la fin de session — ni `stop`, ni `clean`, ni `--force` ne passeront. |
| `IN_USE` | Le disque du clone a bougé il y a moins de `presenceMinutes` min. | Attendre, ou `--force` en connaissance de cause (heuristique). |
| `REUSE_DIRTY` / `REUSE_UNMERGED` / `REUSE_IN_USE` | L'archive à réutiliser a du travail non commité / non mergé / une activité récente. | Inspecter le clone ; `--force` assume la perte. |

## Tickets de conflit et mode manuel

Chaque échec de fusion produit un ticket complet dans
`.striart/conflicts/<ticket>/` : versions `base`/`ours`/`theirs`, tentative
LLM (`llm-attempt`), log du Test Gate (`test-output.log`).

```bash
striart resolve                 # liste les tickets ouverts
striart resolve --close <id>    # marque un ticket résolu
striart resolve --all           # clôt tout
```

**Mode manuel** : après 3 fusions sémantiques échouées d'affilée, Striart
désactive la fusion LLM (règle de sécurité — un LLM qui échoue en boucle ne
doit pas continuer à toucher au code). `striart resolve --unlock` la
réactive une fois la cause traitée.

## Défaire un merge : `striart rollback`

Défait le **dernier merge Striart** de la branche cible :

- merge non poussé → `reset` local (récupérable via reflog) ;
- merge déjà poussé → `revert` (l'historique publié est conservé).

Refuse si le dernier commit de la branche cible n'est pas un merge Striart —
il ne défait jamais un commit humain. `striart history` reconstitue la liste
des merges et rollbacks depuis le graphe Git.

## État incohérent : `striart reconcile`

Après un crash, un `kill -9`, un débranchage : `striart reconcile` remet
tout d'équerre — sessions mortes neutralisées au registre, file débloquée,
verrous orphelins cassés, merge abandonné (`MERGE_HEAD` orphelin) annulé
proprement. **Idempotent** : le lancer « pour rien » ne coûte rien. `striart
watch` le rejoue automatiquement.

## Verrou bloqué ?

Le verrou `.striart/main.lock` casse automatiquement les verrous orphelins
(processus détenteur mort, ou TTL de 30 min dépassé). Une attente de verrou
expire après 2 min avec un message explicite. Si un verrou semble coincé :
`striart reconcile`, puis `striart doctor`.

## Sessions autonomes

- **Session bloquée** : un profil non réellement non-interactif (commande qui
  attend une confirmation) reste bloqué jusqu'au timeout
  (`--timeout` > `profile.timeout` > `autonomousTimeoutMs`), puis l'arbre de
  process est tué (`session/cancel` d'abord en ACP).
- **Session échouée** : le clone est **conservé** avec un `keptReason` ; le
  log complet est dans `.striart/logs/session-<agent>-<taskId>.log` (hors du
  clone — il survit à sa suppression).
- **Outil non authentifié** : la session hérite de l'environnement du shell
  d'où Striart est lancé — authentifiez l'outil dans ce shell d'abord.

## Le watcher

- `striart watch --daemon --status` — le daemon tourne-t-il ? PID ? logs dans
  `.striart/logs/watch.log`.
- Un daemon orphelin (PID file sans process) est détecté et signalé.
- Le watcher ne surveille que `.git/refs/heads/` des clones — jamais les
  worktrees : une modification de fichier sans commit ne déclenche rien
  (c'est voulu : seuls les commits comptent).

## Où sont les logs ?

| Quoi | Où |
|---|---|
| Logs du watcher/daemon | `.striart/logs/watch.log` |
| Logs de session autonome | `.striart/logs/session-<agent>-<taskId>.log` |
| Tickets de conflit | `.striart/conflicts/<ticket>/` |
| Registre des agents | `.striart/agents.json` |
| File d'attente | `.striart/queue.json` |
| Historique des merges | `striart history` (reconstruit du graphe Git) |
