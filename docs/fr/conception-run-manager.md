# Conception — Run Manager (proposition)

> [Documentation](README.md) · Conception — Run Manager
>
> **Statut : proposition, non implémentée.** Ce document décrit une cible
> d'architecture et un ordre de réalisation ; rien ici n'est livré. Il sert
> de point de départ à la discussion et à la planification, pas de
> spécification figée. 🇬🇧 [English version](../en/run-manager-design.md).

## Pourquoi

Striart orchestre déjà la boucle *agent → commit → fusion sémantique → Test
Gate → livraison* de façon fiable (voir [Architecture](architecture.md)).
Ce qui manque pour en faire un véritable orchestrateur de bout en bout —
objectif → planification → exécution → vérification → approbation →
intégration → reprise après incident — est une **couche durable** qui relie
ces étapes et survit à un crash. Aujourd'hui :

- Un plan v2 interrompu **ne se reprend pas** : `src/orchestration/store.ts`
  documente lui-même que l'état persisté sous `.striart/orchestration/{runs,groups}/`
  **« informe, ne décide de rien »** — il n'est jamais relu pour piloter
  l'exécution. Relancer un plan relance tout, y compris les tâches déjà
  appliquées.
- Rien n'arbitre les ressources **non-Git** (port réseau, base de données
  partagée, service externe) : `src/lock.ts`/`locks.ts` ne couvrent que le
  verrou principal et les chemins de fichiers (`locks.json`).
- Une tâche se termine sur un `GateResult` (un `testCommand`, vert ou rouge)
  et un `OrchestrationNodeResult` — rien n'oblige à produire ou conserver les
  preuves (critères d'acceptation, diff exact, sorties de commandes, verdicts
  de relecture, coût) qui ont justifié le merge.
- La session d'un agent hérite de **l'environnement complet** de
  l'orchestrateur (`src/session-env.ts`, décision documentée : « l'outil
  d'agent a besoin de ses clés », voir SECURITY.md) : c'est une défense en
  profondeur, explicitement **pas une sandbox**.

Ce document propose de combler ces manques, dans un ordre qui livre de la
valeur vérifiable à chaque étape plutôt qu'une réécriture d'un seul tenant.

## Vue d'ensemble

Les trois plans de sécurité actuels (humain → Striart, agent → Striart,
Striart → agent, voir [Architecture — trois plans](architecture.md#trois-plans-jamais-mélangés))
et la chaîne sérialisée restent inchangés. On ajoute une couche au-dessus :

```text
CLI / Dashboard / API
          │
          ▼
     Run Manager
  état durable + journal
          │
     ┌────┴─────┐
     ▼          ▼
  Planner    Policy Engine
  objectif   budgets, droits,
  → DAG      approbations
     │          │
     └────┬─────┘
          ▼
      Scheduler
 dépendances, priorités,
 collisions, ressources
          │
          ▼
    Agent Runtime
 profils, ACP, sandbox,
 checkpoints, annulation
          │
          ▼
   Evidence Collector
 diff, tests, revues, coûts,
 artefacts, logs, verdict
          │
          ▼
 Merge Queue → Test Gates → Delivery
```

Le Run Manager devient la **source de vérité fonctionnelle** (l'état d'une
exécution en cours). Git reste la source de vérité du **code** ;
`.striart/` continue de porter les preuves et les transitions — mais
désormais **relues**, pas seulement journalisées.

**Nommage** : le type `RunResult` existe déjà (`src/types.d.ts`, résultat du
lancement d'une tâche) et désigne autre chose que ce que ce document appelle
« Run ». Utiliser `PlanRunState`/`PlanRunRecord` (ou équivalent) pour éviter
la collision — à trancher à l'implémentation.

## 1. Exécutions durables et reprenables (priorité 1)

Deux objets explicites, persistés sous le verrou d'état existant
(`src/state-lock.ts`, écriture atomique `src/json-file.js`) :

```text
Run
├── objectif initial
├── plan validé et sa version
├── budget global
├── état courant
├── tâches
├── événements
└── résultat final

TaskRun
├── état
├── agent et workspace
├── tentative
├── dépendances
├── artefacts
├── preuves
└── erreur ou décision humaine
```

Machine à états bornée :

```text
PENDING → READY → RUNNING → VERIFYING → MERGING → SUCCEEDED
                 │          │
                 │          └→ REVIEW_REQUIRED
                 ├→ BLOCKED
                 ├→ FAILED
                 └→ CANCELLED
```

Chaque transition est persistée, idempotente et rejouable. Ajouter :

- `striart plan resume <run-id>` — reprend un run sans relancer les
  `TaskRun` déjà `SUCCEEDED` ;
- des checkpoints avant lancement d'agent, avant merge, avant livraison ;
- des clés d'idempotence (tâche + tentative) pour éviter les doublons de
  clone ou de merge ;
- des tentatives (`attempt`) distinctes au lieu d'écraser l'historique d'une
  tâche ;
- une reprise automatique via `reconcile` (déjà le nom d'un mécanisme
  existant côté verrou/état — réutiliser le vocabulaire, pas forcément le
  code) après un crash du process orchestrateur.

**Critère de clôture** : tuer le process après chaque transition ; la
reprise ne duplique ni agent, ni merge, ni livraison, et aboutit au même
état final que sans interruption.

**Relation avec l'existant** : `src/orchestration/store.ts` est le
candidat naturel à absorber dans cette couche plutôt qu'à dupliquer — son
format `runs/`/`groups/` devient la base du nouveau `Run`, relu au lieu de
seulement écrit.

## 2. Dossier de preuves (priorité 2)

Le Test Gate reste obligatoire et bloquant, mais une tâche ne doit pas
pouvoir se déclarer « terminée » sans preuves. Chaque `TaskRun` produit un
`EvidenceBundle` :

```text
- critères d'acceptation initiaux ;
- diff et commit précis ;
- commandes exécutées et résultats ;
- tests ajoutés ou modifiés ;
- verdicts des relecteurs (déjà modélisés pour `review` — orchestration/verdict.ts) ;
- limites déclarées ;
- consommation et coût (déjà mesurés, src/tokens/ — à joindre, pas à recalculer) ;
- artefacts nécessaires à la reproduction.
```

Pipeline de vérification à plusieurs portes, dépendant du risque :

```text
Formatage → types → tests ciblés → tests d'intégration
→ sécurité → revue → Test Gate global → merge
```

Une preuve manquante est un échec de la porte concernée, jamais un succès
silencieux — même philosophie fail-closed que le reste du projet
(voir [Architecture — règles d'or](architecture.md#règles-dor)).

## 3. Planner (priorité 3)

Le Planner transforme un objectif en plan **v2 existant** — ne pas créer de
format v3 tout de suite ; faire produire au Planner un plan v2 valide, puis
le faire passer par le validateur actuel (`src/orchestration/plan-schema.ts`).

```text
Objectif utilisateur
      → analyse du dépôt
      → proposition de DAG
      → estimation des risques et coûts
      → validation du schéma
      → approbation humaine
      → exécution
```

Le Planner doit : décomposer l'objectif en tâches testables, associer des
critères d'acceptation à chaque tâche, déclarer les dépendances explicites
(`after`, déjà borné aux références arrière par le schéma actuel), proposer
des profils d'agents (`agentProfiles`, catalogue existant), estimer tokens/
durée/risque, marquer les zones incertaines, et **s'arrêter** si l'objectif
est trop ambigu plutôt que de deviner.

L'humain approuve le plan et tout dépassement de pouvoir. **Garde
structurelle** : le Planner ne doit jamais pouvoir modifier ses propres
permissions ni valider sa propre production — même principe que les trois
plans jamais mélangés.

## 4. Scheduler déterministe (priorité 4)

Le Router LLM (`src/router.ts` et modules associés) reste un **signal**, pas
l'autorité de coordination — la documentation le dit déjà elle-même : filtre
grossier, environ la moitié des fichiers touchés non prédits avec le
préréglage par défaut (voir [Architecture — ce que valent le Router et la fusion](architecture.md#ce-que-valent-le-router-et-la-fusion-sémantique--mesures-du-2026-10-26)).

Le Scheduler arbitre à partir de règles déterministes :

- dépendances du graphe (plan v2) ;
- verrous et chemins protégés (`protected-paths.ts`, déjà strict) ;
- collisions prédites (sortie du Router, inchangée) ;
- chevauchements réellement observés (`src/overlap.ts`, déjà livré) ;
- priorités et plafonds de concurrence (le plan v2 a déjà `concurrency`) ;
- budget restant (`src/tokens/budget.ts`, déjà livré) ;
- disponibilité et santé des agents (`ptyHostStatus`, `checkProcessInstance`) ;
- **ressources partagées non-Git** : base de données, ports, fichiers
  verrouillés, services externes — **n'existe pas aujourd'hui**, à
  introduire comme un nouveau type de verrou nommé (distinct des verrous de
  chemin), déclaré par le profil de tâche ou le plan.

**Critère de clôture** : quelle que soit la réponse du LLM (y compris
fausse ou absente), les dépendances, limites de concurrence, budgets et
chemins protégés restent respectés — le Scheduler ne fait jamais confiance
au Router pour une garantie de sûreté, seulement pour une optimisation.

## 5. Policies et sandbox d'exécution (priorité 5 — décision SECURITY.md requise)

**Ce point contredit une décision actuelle documentée**, pas seulement un
manque : `session-env.ts` hérite délibérément l'environnement complet de
l'orchestrateur, et SECURITY.md qualifie le modèle de « défense en
profondeur, pas une sandbox ». L'étendre ne doit pas se faire en passant —
cela relève d'un changement d'invariant, donc d'une relecture SECURITY.md
avant toute implémentation, par [la procédure déjà en place](architecture.md)
pour ce type de changement.

Si retenu, profils d'exécution proposés :

- système de fichiers limité au workspace (le clone l'est déjà pour le
  code ; pas pour le process lui-même) ;
- réseau refusé par défaut ou limité à une liste blanche **pour le process
  de l'agent** (`net.ts` gouverne déjà les appels sortants de Striart
  lui-même — pas ceux de l'outil hébergé) ;
- secrets fournis temporairement par un courtier, jamais copiés dans le
  clone ;
- capacités explicites : lecture, écriture, terminal, navigateur, accès API ;
- limites de CPU, mémoire, processus et durée (le conteneur de process
  natif, `job run`, sait déjà borner et tuer un arbre de process — à
  étendre, pas à réinventer) ;
- journalisation des actions sensibles ;
- approbation humaine avant toute élévation.

**Contrôles indispensables** si implémenté : une tâche hostile ne doit
pouvoir ni lire hors de son périmètre, ni récupérer les secrets de
l'orchestrateur, ni pousser, ni approuver son propre résultat.

## 6. Observabilité de bout en bout (priorité 6)

Identifiant commun à travers dashboard et registres existants :

```text
run_id → task_id → attempt_id → session_id → commit_sha
```

Chaque run doit permettre de répondre à : pourquoi cette tâche a-t-elle été
créée ? pourquoi cet agent a-t-il été choisi ? pourquoi a-t-elle attendu ?
quelles données ont été envoyées au LLM ? quelles preuves ont permis le
merge ? combien a coûté le résultat ? peut-on le rejouer ?

Puis mesurer la valeur réelle : taux de tâches intégrées, interventions
humaines, reprises après incident, rollbacks, coût par tâche mergée,
défauts ayant traversé les gates.

## 7. Workers distants et multi-dépôts (priorité 7)

Hors scope de ce document pour l'instant — dépend entièrement des
priorités 1 à 6 (un Run Manager non durable ne peut pas distribuer sans
double exécution).

## Ordre de réalisation

| Priorité | Incrément | Résultat vérifiable |
|---|---|---|
| 1 | Run Manager durable | Crash et reprise sans doublon |
| 2 | Dossier de preuves | Aucun succès sans critères et artefacts |
| 3 | Planner produisant des plans v2 | Objectif transformé en DAG validé |
| 4 | Scheduler déterministe | Contraintes respectées même si le Router se trompe |
| 5 | Policies et sandbox | Une tâche hostile reste confinée (décision SECURITY.md d'abord) |
| 6 | Observabilité et benchmarks | Décisions mesurées sur des runs réels |
| 7 | Workers distants et multi-dépôts | Distribution sans double exécution |

Ne pas commencer par Kubernetes, des microservices ou une réécriture
distribuée. La première version réellement « complète » serait simplement :
donner un objectif, approuver un plan, laisser Striart l'exécuter, le
reprendre après un crash, et obtenir un dossier de preuves expliquant
chaque merge. C'est le Run Manager durable, pas un LLM plus puissant, qui
est la fondation prioritaire.

## Portée de cette branche

Ce document seul. Aucun code n'est livré ici : il sert à valider la cible
et l'ordre avant d'entamer la priorité 1 dans une branche séparée.
