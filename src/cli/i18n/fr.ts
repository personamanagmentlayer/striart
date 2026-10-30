/**
 * Catalogue français de la CLI — langue de référence : le type `Messages`
 * est DÉRIVÉ de cet objet, et `en.ts` doit le satisfaire exactement (tsc
 * signale toute clé manquante ou en trop).
 *
 * Ton : tutoiement, verbes d'action, aucune majuscule de majesté. Les
 * valeurs venues de l'extérieur (noms de fichiers, messages de commit)
 * arrivent DÉJÀ neutralisées par l'appelant.
 */

const plural = (n: number, one: string, many: string) => (n <= 1 ? one : many);

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `${Math.floor(h / 24)} j`;
}

function formatBytes(n: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0).replace('.', ',');
  return `${text} ${units[unit]}`;
}

const frStr = (value: unknown): string =>
  value === null || value === undefined ? '?' : String(value);

/**
 * Erreurs du domaine rédigées en ANGLAIS à la source (messages du noyau
 * natif, de l'hôte de pty, des canaux d'instructions) : sans entrée ici, la
 * locale française les afficherait telles quelles. Une entrée qui rend `null`
 * laisse le message du domaine. Les codes dont le message est déjà en
 * français n'ont pas d'entrée.
 */
const FR_ERRORS: Record<string, (d: Record<string, unknown>) => string | null> = {
  STATE_LOCK_TIMEOUT: (d) =>
    d.reason === 'BREAK_FAILED'
      ? `le verrou d'état (${frStr(d.lockFile)}) est périmé (son porteur a disparu) mais ne peut pas être retiré (${frStr(d.cause)}) : l'écriture d'état a été abandonnée. Vérifie les droits sur .striart/ et qu'aucun antivirus ou indexeur ne garde le fichier ouvert.`
      : d.reason === 'LOCK_UNREADABLE'
        ? `le verrou d'état (${frStr(d.lockFile)}) est illisible (${frStr(d.cause)}) et n'est jamais cassé à l'aveugle : l'écriture d'état a été abandonnée. Vérifie les droits sur .striart/.`
        : `le verrou d'état (${frStr(d.lockFile)}) est toujours tenu par le PID ${frStr(d.pid)}${typeof d.heldForMs === 'number' ? ` depuis ${formatDuration(d.heldForMs)}` : ''} : l'écriture d'état a été abandonnée. Un porteur vivant n'est jamais cassé ; si ce process est bloqué, arrête-le.`,
  STATE_LOCK_LOST: (d) =>
    `le verrou d'état (${frStr(d.lockFile)}) a été perdu avant l'écriture : rien n'a été écrit, l'état précédent est intact. Relance la commande.`,
  STATE_LOCK_FAILED: (d) =>
    `le verrou d'état (${frStr(d.lockFile)}) n'a pas pu être ${typeof d.operation === 'string' ? `manipulé (${d.operation}, ${frStr(d.cause)})` : `créé (${frStr(d.cause)})`} : vérifie les droits sur .striart/.`,
  PTY_HOST_ALREADY_RUNNING: (d) =>
    `un hôte de terminal tient déjà l'agent "${frStr(d.agent)}" : attache-toi à lui au lieu d'en lancer un second.`,
  PTY_STATE_PATH_TOO_LONG: (d) =>
    `impossible de construire un chemin de socket d'attache assez court pour "${frStr(d.agent)}" : le dossier temporaire lui-même ("${frStr(d.tmpDirBytes)}" octets) est trop long. Fixe TMPDIR (POSIX) sur un chemin plus court avant de relancer.`,
  ACP_STATE_PATH_TOO_LONG: (d) =>
    `impossible de construire un chemin de socket ACP assez court pour "${frStr(d.agent)}" : le dossier temporaire lui-même ("${frStr(d.tmpDirBytes)}" octets) est trop long. Fixe TMPDIR (POSIX) sur un chemin plus court avant de relancer.`,
  PTY_HOST_SPAWN_FAILED: (d) => {
    const log = d.logFile ? ` (journal : ${frStr(d.logFile)})` : '';
    if (d.reason === 'TIMEOUT')
      return `l'hôte de terminal de "${frStr(d.agent)}" n'a pas été prêt à temps${log}.`;
    if (d.reason === 'EXITED') {
      const cause = [
        d.nativeCode ? frStr(d.nativeCode) : null,
        d.exitCode !== undefined && d.exitCode !== null
          ? `code de sortie ${frStr(d.exitCode)}`
          : null,
        d.signal ? `signal ${frStr(d.signal)}` : null,
      ].filter(Boolean);
      return `l'hôte de terminal de "${frStr(d.agent)}" s'est arrêté avant d'être prêt${cause.length > 0 ? ` (${cause.join(', ')})` : ''}${log}.`;
    }
    return null;
  },
  REVIEW_VERDICT_INVALID: (d) =>
    d.reason === 'ID_REQUIRED'
      ? "un verdict a besoin de l'identifiant d'une demande de relecture."
      : d.reason === 'COMMENT_REQUIRED'
        ? "--request-changes a besoin de --comment : l'auteur doit savoir quoi corriger."
        : null,
  PROFILE_INVALID: (d) =>
    d.reason === 'INSTRUCTIONS_CHANNEL_TRANSPORT'
      ? 'le canal d\'instructions "acp-prompt" exige un profil ACP (acp: true).'
      : d.reason === 'INSTRUCTIONS_FLAG_MISSING'
        ? 'le canal d\'instructions "system-prompt-file" exige instructions.flag ou un argument {{striartInstructionsFile}}.'
        : null,
};

export const fr = {
  levels: { ok: 'ok', info: 'info', warn: 'attention', error: 'erreur', skip: 'ignoré' },
  /** Entre le mot de niveau et le message (typographie française : espace avant les deux-points). */
  levelSeparator: ' : ',

  units: { duration: formatDuration, bytes: formatBytes },

  common: {
    log: (p: string) => `journal : ${p}`,
    ticket: (id: string, dir: string) => `ticket ${id} (${dir})`,
    mode: (mode: string, profile?: string | null) =>
      mode === 'autonomous' ? `autonome${profile ? ` (${profile})` : ''}` : 'supervisé',
  },

  main: {
    unexpected: (message: string) => `erreur inattendue : ${message}`,
    debugHint: 'STRIART_LOG_LEVEL=debug striart … (relance avec la pile complète sur stderr)',
    jsonUnsupported: (command: string) =>
      `« striart ${command} » n'a pas de sortie --json (protocole ou terminal interactif).`,
    deprecatedForce: (command: string) =>
      `« striart ${command} --force » sans --reuse est déprécié : utilise --allow-historical-secrets (même effet). L'alias disparaîtra en 0.12.`,
    uiNeedsTty:
      '« watch --ui » exige un terminal interactif (entrée standard redirigée ou absente).',
    uiNeedsTtyHint: 'striart watch',
    pidNeedsStart: '--pid ne s’emploie qu’avec --start.',
  },

  parse: {
    integer: (value: string, min: number, max: number) =>
      `« ${value} » n'est pas un entier entre ${min} et ${max}.`,
    agentName: (value: string) =>
      `nom d'agent invalide « ${value} » : lettres, chiffres, tirets et underscores, commençant par une lettre ou un chiffre (64 caractères au plus).`,
    nonEmpty: 'la valeur ne peut pas être vide.',
    ticketId: (value: string) => `identifiant de ticket invalide « ${value} ».`,
    projectPath: (value: string) =>
      `chemin de projet invalide « ${value} » : un chemin relatif à la racine, en « / », sans « .. », sans lecteur ni caractère de contrôle.`,
    runId: (value: string) =>
      `identifiant de run invalide « ${value} » : de la forme run-xxxxxxxxxxxx (« striart status --json », section orchestration).`,
  },

  usageErrors: {
    unknownCommand: (name: string) => `commande inconnue « ${name} ».`,
    unknownOption: (name: string) => `option inconnue « ${name} ».`,
    didYouMean: (suggestion: string) => `Voulais-tu dire « ${suggestion} » ?`,
    missingArgument: (name: string) => `argument manquant : <${name}>.`,
    optionMissingArgument: (name: string) => `l'option ${name} attend une valeur.`,
    excessArguments: (expected: number, received: number) =>
      `trop d'arguments : ${received} reçu(s), ${expected} attendu(s).`,
    conflictingOption: (a: string, b: string) => `les options ${a} et ${b} sont incompatibles.`,
    invalidArgument: (detail: string) => `valeur invalide : ${detail}`,
    missingCommand: 'aucune commande indiquée.',
    generic: (message: string) => message,
    seeHelp: (command: string) => `striart ${command} --help`,
  },

  help: {
    description:
      'Orchestrateur Git multi-agents : clones isolés, routage préventif, fusion sémantique, Test Gate bloquant.',
    usage: 'Utilisation :',
    arguments: 'Arguments :',
    options: 'Options :',
    commands: 'Commandes :',
    globalOptions: 'Options globales :',
    rootUsage: '[options] <commande>',
    versionOption: 'affiche la version',
    helpOption: "affiche l'aide de la commande",
    helpCommand: "affiche l'aide d'une commande",
    examples: 'Exemples :',
    groups: {
      setup: 'Initialisation et diagnostic :',
      launch: 'Lancer des agents :',
      orchestrate: 'Orchestrer :',
      observe: 'Observer :',
      repair: 'Réparer et nettoyer :',
      integrate: 'Intégration :',
    },
    global: {
      json: 'sortie machine : un document JSON sur stdout (flux ndjson pour watch et dashboard)',
      plain: 'texte nu, sans couleur, glyphe ni lien (logs, lecteurs d’écran, consoles anciennes)',
      noColor: 'désactive la couleur (comme NO_COLOR)',
      quiet: 'supprime les messages de progression (jamais les erreurs ni les données)',
    },
    rootEpilog: [
      'Codes de sortie :',
      '  0    succès, ou ajournement voulu (tâche mise en file, déjà à jour)',
      '  1    échec d’exécution ou d’environnement (relancer peut suffire)',
      '  2    usage invalide (option inconnue, valeur hors bornes, options incompatibles)',
      '  3    refus : une garde a protégé du travail (conflit, Test Gate rouge, session vivante…)',
      '  130  interrompu (Ctrl+C)',
      '  143  terminé par SIGTERM (arrêt demandé par le système ou un superviseur)',
      '',
      'Environnement :',
      '  STRIART_LANG=fr|en     langue de la CLI (défaut : la locale du système)',
      '  STRIART_THEME=default|colorblind|mono   couleurs',
      '  NO_COLOR, FORCE_COLOR  couleur ; STRIART_ASCII=1 : glyphes ASCII',
      '  STRIART_LOG_LEVEL=debug  journaux détaillés sur stderr',
      '',
      'Documentation : docs/fr/commandes.md — complétion : striart completion <shell>',
    ].join('\n'),
  },

  commands: {
    init: {
      summary: 'Initialise Striart dans le dépôt courant',
      description:
        'Crée .striart/ (registre, file, tickets), ajoute .striart/ au .gitignore, génère striart.config.mjs si absent, puis signale ce qui empêcherait la première commande de réussir.',
      examples: ['striart init'],
    },
    doctor: {
      summary: 'Diagnostic complet : git, dépôt, config, LLM, verrous, tickets',
      description:
        "Répond à « pourquoi ça ne marche pas ? ». Sortie 1 si un prérequis manque ; les points d'attention ne changent pas le code de sortie.",
      examples: ['striart doctor', 'striart doctor --json | jq ".data.summary"'],
    },
    completion: {
      summary: 'Script de complétion shell (bash, zsh, fish, PowerShell)',
      description:
        'Écrit sur stdout le script de complétion du shell demandé, à charger dans son profil.',
      examples: [
        'striart completion bash >> ~/.bashrc',
        'striart completion zsh > "${fpath[1]}/_striart"',
        'striart completion powershell >> $PROFILE',
      ],
      shell: 'bash, zsh, fish ou powershell',
    },
    start: {
      summary: 'Clone le dépôt pour un nouvel agent supervisé',
      description:
        'Crée un clone isolé (.striart/agents/<agent>) sur une branche de tâche dédiée. Tu lances ensuite ton outil de coding dedans, ou --open le fait dans un nouvel onglet.',
      examples: [
        'striart start agent-a',
        'striart start agent-b --command "aider --model gpt-4o" --open',
        'striart start agent-a --reuse',
      ],
      agent: "nom de l'agent (lettres, chiffres, - et _)",
      command: 'outil de coding de cet agent (défaut : agentCommand de la config, sinon claude)',
      open: "ouvre un onglet de terminal dans le clone et y lance l'outil",
      reuse: "réhabilite le clone conservé d'un agent arrêté (resynchronisé, nouvelle branche)",
      force: 'avec --reuse : abandonne le travail non commité ou non mergé du clone (PERDU)',
      allowHistoricalSecrets:
        "clone malgré des secrets présents dans l'historique du dépôt (décision consciente)",
    },
    run: {
      summary: 'Router préventif : prédit les fichiers touchés, puis lance ou met en file',
      description:
        "Le LLM prédit les fichiers que la tâche va modifier. Sans collision avec un agent actif, l'agent démarre ; sinon la tâche attend en file. --autonomous : Striart pilote l'agent de bout en bout. --on-main : l'agent travaille directement dans le dépôt principal.",
      examples: [
        'striart run "ajoute un test sur le parseur"',
        'striart run --agent api "expose /health" --open',
        'striart run --autonomous --profile codex "corrige le lint"',
        'striart run --after api --agent docs "documente /health"',
      ],
      prompt: 'tâche à confier (ou --prompt)',
      promptOption: 'tâche à confier (équivalent au positionnel)',
      agent: "nom de l'agent (défaut : dérivé du prompt)",
      command: 'outil de coding de cet agent',
      open: "ouvre un onglet de terminal dans le clone et y lance l'outil",
      autonomous: "Striart lance et supervise l'agent, merge derrière le Test Gate puis nettoie",
      onMain:
        "lance l'agent DIRECTEMENT dans le dépôt principal (session protégée, pas de merge de fin de cycle)",
      profile: 'avec --autonomous ou --on-main : profil d’invocation (striart profiles)',
      timeout: 'avec --autonomous ou --on-main : délai maximal de la session, en millisecondes',
      after: "ne démarre qu'une fois ce travail terminé (id de tâche en file ou agent actif)",
      reuse: 'réhabilite le clone conservé de --agent au lieu de cloner',
      force: 'avec --reuse : abandonne le travail non commité ou non mergé du clone (PERDU)',
      allowHistoricalSecrets:
        "clone malgré des secrets présents dans l'historique du dépôt (décision consciente)",
    },
    attach: {
      summary: "Attache ce terminal au pty d'un agent (session --open)",
      description:
        "Rejoint la session de terminal possédée d'un agent supervisé (lancée par --open). À exécuter depuis le clone de l'agent.",
      examples: ['striart attach agent-a'],
      agent: "nom de l'agent",
    },
    plan: {
      summary: 'Applique un plan de tâches YAML (tâches-as-code)',
      description:
        'Lance un graphe de tâches déclaré dans un fichier YAML versionné : agents, prompts, dépendances (after), mode autonome par tâche.',
      examples: [
        'striart plan plan.yaml --dry-run',
        'striart plan plan.yaml',
        'striart plan plan.yaml --mode parallel --concurrency 3',
        'striart plan plan.yaml --resume run-0123456789ab',
      ],
      file: 'fichier YAML du plan',
      dryRun: 'valide et affiche le plan sans rien lancer',
      mode: 'plan v2 : impose l’enchaînement (sequential ou parallel)',
      concurrency: 'plan v2 : tâches simultanées en mode parallel',
      onFailure: 'plan v2 : après un échec, stop (rien ne démarre plus) ou skip-dependents',
      resume:
        'plan v2 : reprend un run interrompu (id affiché par « status --json ») — même fichier de plan, tâches déjà terminées non relancées',
    },
    orchestrate: {
      summary: 'Lance une tâche orchestrée : review, race, team ou pipeline',
      description:
        'Construit un plan v2 d’une seule tâche et l’applique (même validation que striart plan). review : un auteur, des relecteurs, merge seulement après approbation puis Test Gate. race : plusieurs agents sur la même tâche, un gagnant. team : plusieurs rôles dans le même clone. pipeline : étapes enchaînées, chacune nourrit la suivante.',
      examples: [
        'striart orchestrate review "Passe l’auth en JWT" --author claude --reviewer codex',
        'striart orchestrate race "Accélère le parseur" --candidate claude --candidate codex --pick smallest-diff',
        'striart orchestrate team "API de somme testée" --role backend=claude:src/** --role tests=codex:tests/**',
        'striart orchestrate pipeline "Conçois le schéma" "Implémente l’API" --step-profile claude --step-profile codex',
      ],
      mode: 'review, race, team ou pipeline',
      prompts: 'la tâche (une étape par argument pour pipeline)',
      agent: 'nom de l’agent (ou base des noms dérivés)',
      author: 'review : profil de l’auteur',
      reviewer: 'review : profil d’un relecteur (répétable)',
      humanReviewer: 'review : ajoute un relecteur humain (verdict par striart review)',
      quorum: 'review : all, any ou majority',
      maxRounds: 'review : tours de correction au plus',
      candidate: 'race : profil d’un candidat (répétable, 2 au moins)',
      pick: 'race : first-green, smallest-diff ou judge',
      losers: 'race : keep, archive ou clean',
      role: 'team : rôle nom=profil[:glob,glob] (répétable ; « : » seul = lecture seule)',
      cadence: 'team : turns (un écrivain à la fois) ou parallel (partition statique)',
      rounds: 'team : nombre de tours',
      stepProfile: 'pipeline : profil de chaque étape, dans l’ordre (répétable)',
      handoff: 'pipeline : merge (chaque étape mergée) ou clone (un seul merge)',
      timeout: 'délai max par session (ms)',
      dryRun: 'valide et affiche la tâche sans rien lancer',
    },
    review: {
      summary: 'Relectures humaines : lister, approuver, demander des corrections, rejeter',
      description:
        'Sans argument : liste les relectures (les demandes en attente d’abord). Avec un id : rend le verdict d’un relecteur humain d’une tâche review ; le merge reste soumis au Test Gate.',
      examples: [
        'striart review',
        'striart review rev-1a2b3c4d5e6f --approve',
        'striart review rev-1a2b3c4d5e6f --request-changes --comment "Ajoute un test du cas nul"',
      ],
      id: 'identifiant de la demande (rev-…)',
      approve: 'approuve (le Test Gate décide ensuite)',
      requestChanges: 'demande des corrections à l’auteur (--comment obligatoire)',
      reject: 'rejette : rien n’est mergé, le clone est conservé',
      comment: 'remarque transmise à l’auteur',
    },
    profiles: {
      summary: "Profils d'agents configurés (mode autonome)",
      description:
        "Liste les profils d'invocation de config.agentProfiles. Les valeurs d'environnement ne sont jamais affichées, seulement leurs noms. --catalog liste les presets vérifiés, --detect sonde les outils installés (PATH + version, sans exécuter la config du dépôt), --import-acp dérive un profil épinglé du registre ACP.",
      examples: [
        'striart profiles',
        'striart profiles --catalog',
        'striart profiles --detect',
        'striart profiles --import-acp codex-acp',
        'striart profiles --json',
      ],
      detect: 'sonde les outils de coding installés (PATH + version, argv, dossier vide)',
      catalog: 'liste le catalogue des presets (prêts et expérimentaux)',
      importAcp:
        "dérive un profil ACP épinglé d'un agent du registre ACP (métadonnées seules par défaut)",
    },
    watch: {
      summary: 'Surveille les commits des agents et les merge derrière le Test Gate',
      description:
        "Chaque commit d'un agent supervisé déclenche un merge (Test Gate bloquant), puis le rebase des autres agents. --ui ajoute une interface interactive ; --daemon tourne en arrière-plan.",
      examples: [
        'striart watch',
        'striart watch --daemon',
        'striart watch --ui',
        'striart watch --json | jq -c .',
      ],
      noMerge: 'signale les commits sans déclencher de merge',
      daemon: 'lance le watcher en arrière-plan (PID et journal dans .striart/)',
      stop: 'arrête le watcher en arrière-plan',
      status: 'état du watcher en arrière-plan',
      ui: "interface interactive : panneau d'agents, commandes, messages « @agent » aux sessions supervisées",
    },
    merge: {
      summary: "Merge le dernier commit d'un agent derrière le Test Gate",
      description:
        "Fusionne la branche de l'agent dans la branche cible. Conflit textuel : fusion sémantique par le LLM. Le commit n'a lieu que si le Test Gate est vert ; sinon ticket et sortie 3.",
      examples: ['striart merge agent-a', 'striart merge agent-a && npm run deploy'],
      agent: "nom de l'agent",
    },
    sync: {
      summary: 'Rebase un agent (ou tous) sur la branche cible',
      description:
        'Ne touche jamais un travail en cours qui recoupe les commits entrants : le rebase est alors reporté (sortie 0), le merge le rattrapera.',
      examples: ['striart sync', 'striart sync agent-a'],
      agent: "nom de l'agent (défaut : tous)",
    },
    stop: {
      summary: 'Marque un agent comme terminé (le clone reste sur disque)',
      description:
        "Retire l'agent du registre et débloque la file. Refuse s'il reste des commits non mergés, sauf --force.",
      examples: ['striart stop agent-a', 'striart stop agent-a --force'],
      agent: "nom de l'agent",
      force: 'abandonne les commits non mergés',
    },
    status: {
      summary: 'Agents actifs, sessions, travail en attente et points à traiter',
      description:
        "Vue d'ensemble : un tableau des agents, puis tout ce qui attend un humain (tickets, mode manuel, dépôt réservé, tâches débloquables).",
      examples: ['striart status', 'striart status --json | jq ".data.agents[].name"'],
    },
    queue: {
      summary: "File d'attente : tâches en cours, en attente, et pourquoi",
      description:
        'Tâches démarrées et tâches en attente, avec ce qui les bloque. --retry démarre celles qui ne sont plus bloquées.',
      examples: ['striart queue', 'striart queue --retry'],
      retry: 'démarre les tâches dont plus rien ne bloque le départ',
    },
    history: {
      summary: 'Historique des merges et rollbacks (depuis le graphe git)',
      description:
        'Reconstruit depuis les commits « merge(striart) » : aucune base parallèle qui pourrait diverger.',
      examples: ['striart history', 'striart history --limit 5 --json'],
      limit: "nombre d'entrées (défaut 30)",
    },
    usage: {
      summary: 'Consommation de tokens et coûts (par période, rôle, agent, tâche)',
      description:
        "Lit le registre .striart/usage/ : appels LLM de Striart (router, merger, memory) et sessions d'agents. Jamais de prompt ni de contenu. Le coût exige un prix déclaré (tokens.pricing).",
      examples: [
        'striart usage',
        'striart usage --since 7d --role merger',
        'striart usage --agent agent-a --json',
      ],
      since: 'début de période : 7d, 24h, 30m, today ou AAAA-MM-JJ (UTC)',
      until: 'fin de période (date AAAA-MM-JJ UTC incluse, ou durée)',
      role: 'filtre par rôle : router, merger, memory, judge, review, agent',
      agent: 'filtre par agent',
      task: 'filtre par identifiant de tâche',
    },
    dashboard: {
      summary: 'Tableau de bord web local, temps réel (127.0.0.1)',
      description:
        'Agents, file, tickets, journaux du Test Gate, avec pilotage. Écoute uniquement en local.',
      examples: [
        'striart dashboard',
        'striart dashboard --daemon',
        'striart dashboard --link',
        'striart dashboard --status',
      ],
      port: "port d'écoute (défaut : dashboardPort de la config, 3456)",
      daemon: 'lance le tableau de bord en arrière-plan',
      stop: 'arrête le tableau de bord en arrière-plan',
      status: 'état (et adresse) du tableau de bord en arrière-plan',
      link: 'émet un nouveau lien de connexion à usage unique pour le tableau de bord en cours (celui du daemon, ou celui de --port)',
    },
    rollback: {
      summary: 'Défait le dernier merge Striart de la branche cible',
      description:
        "Merge non poussé : reset (récupérable par le reflog). Merge déjà poussé : revert, l'historique publié est conservé.",
      examples: ['striart rollback'],
    },
    resolve: {
      summary: 'Tickets de conflit : lister, préparer, appliquer sous le Test Gate',
      description:
        'Sans option : liste les tickets ouverts. --prepare amorce un fichier .resolved par fichier en conflit ; --apply rejoue le merge avec ces résolutions, derrière le Test Gate.',
      examples: [
        'striart resolve',
        'striart resolve --prepare agent-a-f72c4ba9',
        'striart resolve --apply agent-a-f72c4ba9',
        'striart resolve --unlock',
      ],
      unlock: 'réactive la fusion sémantique après le passage en mode manuel',
      close: 'marque un ticket comme résolu (corrigé à la main)',
      prepare: 'amorce <fichier>.resolved pour chaque fichier en conflit du ticket',
      acceptTheirs:
        "avec --prepare : amorce aussi ce chemin PROTÉGÉ depuis la version de l'agent (décision explicite, répétable)",
      apply: 'rejoue le merge du ticket avec les résolutions préparées, sous le Test Gate',
      all: 'inclut les tickets déjà résolus',
    },
    lock: {
      summary: 'Réserve ou libère le dépôt principal pour une intervention directe',
      description:
        "Tant que la réservation vit (PID surveillé), toute opération mutante de Striart (merge, sync, promote, resolve --apply, merge auto de watch) est refusée. Sans option : affiche l'état.",
      examples: [
        'striart lock --start "résolution à la main de app.js"',
        'striart lock --start "édition" --pid $PID',
        'striart lock --stop',
      ],
      start: 'réserve le dépôt pour cette raison (PID du shell courant, sauf --pid)',
      stop: 'libère le dépôt (toujours permis : sortie de secours)',
      pid: 'avec --start : PID du process à surveiller',
    },
    clean: {
      summary: 'Supprime des clones pour libérer le disque',
      description:
        "Par défaut : uniquement les clones d'agents arrêtés. --all inclut les agents actifs sans travail en attente. Une session vivante n'est jamais supprimée.",
      examples: ['striart clean', 'striart clean agent-a', 'striart clean --all'],
      agent: "nom de l'agent (défaut : tous les clones éligibles)",
      stopped: 'uniquement les agents arrêtés (comportement par défaut, explicite)',
      all: 'inclut les agents actifs sans travail en attente (arrêtés puis supprimés)',
      force:
        "passe outre l'activité récente du clone et, avec --all, abandonne le travail non mergé (PERDU)",
    },
    reconcile: {
      summary: "Converge l'état sur le réel : sessions mortes, file, verrous",
      description:
        'Neutralise les sessions mortes, démarre les tâches débloquées, nettoie les verrous orphelins.',
      examples: ['striart reconcile'],
    },
    prune: {
      summary: 'Rétention : clones arrêtés inactifs et tickets résolus anciens',
      description:
        'Supprime les clones arrêtés inactifs et les tickets résolus depuis plus de N jours. Jamais un agent actif ni un ticket ouvert.',
      examples: ['striart prune --dry-run', 'striart prune --days 30'],
      days: 'période de rétention en jours (défaut : pruneDays de la config, 14)',
      dryRun: 'affiche ce qui serait supprimé, sans rien supprimer',
    },
    gc: {
      summary: 'GC : détecte les agents inactifs et ferme proprement leurs sessions oubliées',
      description:
        "Détecte les agents sans aucune activité (worktree, commits, sortie, messages) et, selon idle.action, les signale, les avertit puis ferme leur SESSION après un délai de grâce. Le clone et le travail non commité sont toujours conservés ; aucun merge, aucune suppression. Une demande humaine en attente, un ticket ouvert, un plan d'orchestration ou la session du principal protègent un agent.",
      examples: ['striart gc', 'striart gc --dry-run', 'striart gc agent-a --close'],
      agent: 'limiter le balayage à cet agent',
      close:
        "demande de fermer les sessions inactives (remplace idle.action et l'autorisation ; l'avertissement et la grâce restent obligatoires)",
      dryRun: 'affiche ce qui serait fait, sans rien écrire ni fermer',
    },
    promote: {
      summary: 'Promotion staging → main derrière un Test Gate global',
      description:
        'Rejoue le Test Gate sur la branche cible puis avance mainBranch en fast-forward.',
      examples: ['striart promote', 'striart promote --rollback'],
      rollback: 'si le Test Gate échoue : remet le staging au niveau de main (destructif)',
    },
    acp: {
      summary:
        "Agent ACP sur stdio pour un éditeur (Zed, JetBrains, Neovim, Emacs…) : un clone isolé + l'agent amont + un merge sous Test Gate",
      description:
        "Expose Striart comme agent ACP v1 (JSON-RPC sur stdin/stdout). Chaque session ouverte par l'éditeur devient un clone Striart isolé où travaille l'agent amont choisi (option de session « Agent »), servi par le client ACP de Striart (fichiers et terminal bornés au clone : ceux de l'éditeur ne sont jamais utilisés). L'éditeur voit le déroulé, arbitre les permissions (politique « ask ») et reçoit le résultat : fin de session (/striart-finish ou fermeture) = contrat de commit, merge sous Test Gate, ticket si rouge. Refusé dans une session d'agent.",
      examples: [
        'striart acp',
        'striart acp --profile claude-acp',
        'striart acp --root /chemin/du/depot',
      ],
      root: "racine du dépôt principal : toute session doit s'y trouver (défaut : déduite du répertoire de la session)",
      profile: 'profil amont proposé par défaut (prioritaire sur acpAgent.defaultProfile)',
    },
    api: {
      summary: 'Striart Control Protocol v1 sur stdio, pour les extensions IDE (plan humain)',
      description:
        "Sert le protocole de pilotage humain (JSON-RPC 2.0 : état, abonnement aux changements, actions, arbitrage des permissions, tickets 3-way) sur stdin/stdout — zéro surface réseau, fonctionne en Remote SSH, devcontainer et Codespaces. --schema imprime le schéma publié. Refusé dans une session d'agent.",
      examples: [
        'striart api --stdio',
        'striart api --stdio --framing content-length',
        'striart api --schema openrpc',
      ],
      stdio: 'sert le protocole sur stdin/stdout (stdout réservé au protocole)',
      framing:
        'cadrage des messages : ndjson (un message par ligne, défaut) ou content-length (style LSP)',
      schema: 'imprime le schéma publié : openrpc (méthodes) ou json-schema (document --json)',
    },
    mcp: {
      summary: 'Serveur MCP sur stdio pour un hôte MCP (Claude Code, Cursor…)',
      description:
        "Expose l'état, les tickets et les journaux (ressources), et — selon le niveau — merge et résolution comme outils MCP (ères 2026-07-28 et legacy). Lancé depuis le clone d'un agent, il n'agit que sur cet agent ; hors clone, il est en lecture seule sauf mcp.scope: 'orchestrator'. stdout est réservé au protocole.",
      examples: [
        'striart mcp',
        'striart mcp --root /chemin/du/depot --agent agent-a',
        'striart mcp --read-only',
      ],
      root: 'racine du dépôt principal (prioritaire sur le répertoire courant)',
      agent: 'borne les outils à cet agent (son merge, ses tickets)',
      readOnly: "n'expose aucun outil mutant",
      collab:
        "avec --read-only et un agent borné, autorise aussi à poster dans le canal de collaboration (striart_collab_post) — rien d'autre",
    },
    hook: {
      summary: 'Hooks advisory des outils de coding (collisions, fin de session)',
      description:
        "Lancé PAR l'outil (Claude Code, Codex, Copilot CLI, Gemini CLI, Cline) à chaque événement : signale un fichier prédit ou verrouillé par un autre agent et notifie la fin d'une session supervisée. N'est jamais bloquant (sortie 0, réponse neutre sur toute anomalie). install/uninstall écrit ou retire la configuration du hook, pour l'utilisateur (--user) ou dans le clone d'un agent (--agent, fichier non suivi et exclu de git).",
      examples: [
        'striart hook install claude --user',
        'striart hook install codex --agent agent-a',
        'striart hook install gemini --user --dry-run',
        'striart hook uninstall claude --user',
      ],
      words:
        "install|uninstall <outil>, ou <outil> <événement> (appel par l'outil) — outils : claude, codex, copilot, gemini, cline",
      user: "configuration UTILISATEUR de l'outil (sert dans tout projet, neutre hors d'un clone)",
      agent: 'dans le clone de cet agent (fichier non suivi, exclu localement de git)',
      dryRun: 'affiche les fichiers qui seraient modifiés, sans rien écrire',
      root: 'racine de confiance (écrite par install --agent) : sa config complète est chargée',
    },
    __complete: {
      summary: 'Interne : valeurs de complétion',
      description: 'Appelé par les scripts de complétion.',
      examples: [] as string[],
    },
  },

  init: {
    working: 'Initialisation de .striart/',
    checking: 'Vérification des prérequis',
    ready: (dir: string) => `Striart prêt (${dir}).`,
    alreadyInitialized: (dir: string) => `déjà initialisé (${dir}) : rien à créer.`,
    created: (item: string) => (item === '.gitignore' ? '.gitignore (.striart/ ajouté)' : item),
    config: (configPath: string | null) =>
      `configuration : ${configPath ?? 'aucun fichier, valeurs par défaut'}`,
    nextStep: 'Prochaine étape :',
  },

  doctor: {
    running: 'Diagnostic en cours',
    colLevel: 'NIVEAU',
    colCheck: 'CONTRÔLE',
    colDetail: 'CONSTAT',
    actions: 'À faire :',
    verdictOk: 'environnement opérationnel.',
    verdictWarn: (warn: number) =>
      `utilisable, ${warn} ${plural(warn, "point d'attention", "points d'attention")}.`,
    verdictFail: (fail: number, warn: number) =>
      `${fail} ${plural(fail, 'prérequis manque', 'prérequis manquent')}${warn ? `, ${warn} ${plural(warn, "point d'attention", "points d'attention")}` : ''} : corrige les erreurs ci-dessus.`,
  },

  start: {
    creating: (agent: string) => `Création du clone de ${agent}`,
    reusing: (agent: string) => `Réhabilitation du clone de ${agent}`,
    ready: (agent: string, dir: string) => `agent ${agent} prêt dans ${dir}.`,
    branch: (branch: string) => `branche : ${branch}`,
    terminalOpened: (agent: string, command: string) => `onglet ouvert pour ${agent} (${command}).`,
    terminalFailed: (error: string) => `ouverture du terminal impossible : ${error}`,
    attachManually: "l'hôte du terminal tourne : rejoins-le à la main.",
    launchManually: 'lance ton outil de coding dans le clone :',
  },

  run: {
    twoPrompts:
      'le prompt est donné deux fois (positionnel et --prompt), avec des valeurs différentes.',
    emptyPrompt: 'le prompt de la tâche est vide.',
    needsUnattended: (option: string) => `${option} n'a de sens qu'avec --autonomous ou --on-main.`,
    reuseNeedsAgent: '--reuse exige un nom d’agent explicite (--agent).',
    routing: 'Router : prédiction des fichiers touchés',
    sessionRunning: 'Session de l’agent en cours',
    onMainIntro: (profile: string | null) =>
      `session sur le dépôt principal (profil ${profile ?? 'par défaut'}) : merge, sync, promote et resolve --apply sont bloqués jusqu'à la fin.`,
    autonomousIntro: (profile: string | null) =>
      `mode autonome (profil ${profile ?? 'par défaut'}) : le Test Gate est le seul juge, personne ne relira avant le merge.`,
    sessionEnded: (status: string, duration: string, exitCode: number | null) =>
      `session terminée en ${duration} : ${status}${exitCode !== null ? `, code de sortie ${exitCode}` : ''}.`,
    autonomousQueued: (taskId: string) =>
      `collision détectée : aucune session lancée, tâche ${taskId} mise en file (elle repartira en mode supervisé).`,
    autonomousCleaned: 'cycle complet : merge réussi, Test Gate vert, clone supprimé.',
    autonomousKept: (reason: string) => `merge réussi ; clone conservé : ${reason}`,
    alreadyIntegratedWarning: (agent: string) =>
      `${agent} : son commit était déjà dans la branche cible — rien n'a été mergé par ce cycle et le Test Gate n'a pas été rejoué ; clone nettoyé.`,
    serializationRelaxedWarning: (agent: string, blockers: string) =>
      `${agent} : tâche vague ou globale, mais elle n'a pas attendu ${blockers} — session terminée en échec, clone conservé sans commit à merger. Une collision sur fichier précis reste bloquante.`,
    autonomousStatus: (status: string, reason: string) => `${status} : ${reason}`,
    cloneKept: (dir: string) => `clone conservé : ${dir}`,
    striartCommitted: (sha: string, n: number, author: string) =>
      `commit Striart ${sha} : ${n} ${plural(n, 'fichier laissé', 'fichiers laissés')} par l'agent, auteur ${author}.`,
    commitExcluded: (kind: 'secrets' | 'injected', files: string) =>
      kind === 'secrets'
        ? `exclus du commit (secretPatterns) : ${files}`
        : `exclus du commit (fichiers injectés par Striart) : ${files}`,
    commitSkippedAgent:
      "l'agent a committé lui-même : aucun commit Striart (commitPolicy agent-then-striart).",
    kept: (code: string, detail: string | null): string | null =>
      (
        ({
          SESSION_FAILED:
            detail === 'BUDGET_EXCEEDED'
              ? 'plafond de tokens franchi : session arrêtée, rien n’a été mergé, clone conservé. Consulte `striart usage`, relève tokens.budgets si c’est voulu, ou relis le travail du clone.'
              : `session ${detail ?? ''} — clone conservé pour diagnostic.`,
          NO_COMMIT:
            detail === 'human'
              ? "commitPolicy 'human' : personne ne committe, le travail reste dans le clone pour ta revue."
              : "l'agent est sorti sans produire de commit — rien à merger, clone conservé.",
          NO_CHANGES: "l'agent est sorti sans aucune modification — rien à committer ni à merger.",
          ONLY_EXCLUDED_CHANGES:
            "seuls des fichiers exclus restaient (secrets, fichiers injectés) — rien n'a été committé.",
          COMMIT_REFUSED: `commit Striart refusé (${detail ?? '?'}) : état du clone ambigu, à vérifier à la main.`,
          COMMIT_FAILED: `commit Striart impossible (${detail ?? '?'}) — rien n'a été mergé.`,
          MERGE_BLOCKED: `merge ${detail ?? ''} — le travail de l'agent n'est pas perdu.`,
          CLEANUP_SKIPPED: `nettoyage sauté (${detail ?? '?'}).`,
          HUMAN_REVIEW_REQUIRED:
            "commitPolicy 'human' : l'agent a committé mais rien n'est mergé automatiquement — le clone est conservé pour ta revue.",
        }) as Record<string, string>
      )[code] ?? null,
    collision: (blocker: string, agent: string, files: string) =>
      `${agent} et ${blocker} toucheraient ${files} : départ séquentiel.`,
    waitsFor: (after: string) => `attend la fin de ${after}.`,
    queued: (agent: string, taskId: string) => `tâche ${taskId} (${agent}) mise en file d'attente.`,
    predicted: (files: string) => `fichiers prédits : ${files}`,
    serialized: (reason: string) => `le Router a sérialisé la tâche (tout le dépôt) : ${reason}.`,
    sharedIgnored: (files: string) =>
      `tenue de livre écartée de la détection de collisions : ${files}.`,
    importLink: (by: string, file: string) => `${by} importe ${file}`,
    dependsOn: (a: string, b: string) => `${a} dépend de ${b}`,
    semanticLink: (agent: string, links: string) =>
      `lien sémantique avec ${agent} (${links}) : pas de conflit git attendu, le Test Gate tranchera.`,
    workspaceLink: (agent: string, links: string) => `packages liés avec ${agent} : ${links}.`,
  },

  plan: {
    validating: 'Validation du plan',
    applying: 'Application du plan',
    sessionFailed: (agent: string, code: string, detail: string) =>
      `session supervisée de ${agent} impossible à ouvrir (${code}) : ${detail} Le plan est interrompu plutôt que d'attendre un agent que personne n'a lancé.`,
    notFound: (file: string) => `plan introuvable : ${file}`,
    valid: (n: number) => `plan valide : ${n} ${plural(n, 'tâche', 'tâches')}, rien n'a été lancé.`,
    colTask: 'TÂCHE',
    colMode: 'MODE',
    colAfter: 'APRÈS',
    derivedName: '(nom dérivé du prompt)',
    applied: (n: number) => `plan appliqué : ${n} ${plural(n, 'tâche', 'tâches')}.`,
    autonomousTask: (name: string, status: string) => `${name} (autonome) : ${status}`,
    queuedTask: (name: string) => `${name} : en file d'attente`,
    notApplied: (name: string) =>
      `${name} : non appliquée (arrêt demandé) — relance le plan sans les tâches déjà faites.`,
    colKind: 'TYPE',
    kind: (kind: string) =>
      ({
        task: 'tâche',
        review: 'relecture',
        pipeline: 'pipeline',
        race: 'course',
        team: 'équipe',
      })[kind] ?? kind,
    run: (id: string, mode: string, concurrency: number) =>
      `plan ${id} : ${mode === 'parallel' ? `parallèle (${concurrency} à la fois)` : 'séquentiel'}.`,
    node: (name: string, kind: string, status: string) => `${name} (${kind}) : ${status}`,
    nodeDetail: (detail: string) => `détail : ${detail}`,
    nodeAgents: (agents: string) => `clones : ${agents}`,
    nodeKept: 'clone(s) conservé(s) pour décision humaine.',
    verdicts: (list: string) => `verdicts : ${list}`,
    progress: {
      started: (name: string, kind: string) => `${name} (${kind}) démarré`,
      finished: (name: string, kind: string, status: string) => `${name} (${kind}) : ${status}`,
      turn: (agent: string, role: string, round: number) =>
        `${agent} : tour de ${role} (tour ${round})`,
      turnDone: (agent: string, role: string, status: string) => `${agent} : ${role} → ${status}`,
      serializationRelaxed: (name: string, blockers: string) =>
        `${name} n'attend pas ${blockers} (session en échec, clone sans commit à merger)`,
      waiting: (name: string, reason: string, ref: string) =>
        `${name} attend ${
          (
            {
              dependency: 'la fin de',
              collision: 'le départ des agents en collision',
              attended: 'la fin de la session supervisée de',
              'human-review': 'le verdict humain',
            } as Record<string, string>
          )[reason] ?? reason
        } ${ref}`,
      verdict: (reviewer: string, round: number, verdict: string) =>
        `relecture : ${reviewer} (tour ${round}) → ${verdict}`,
    },
  },

  completion: {
    /** Première ligne (commentaire) de chaque script de complétion. */
    header: (shell: string, install: string) =>
      `# striart — complétion ${shell}. Installation : ${install}`,
  },

  api: {
    needsTransport:
      'Choisis un transport : striart api --stdio (ou --schema pour imprimer le schéma).',
  },

  review: {
    idRequired: "Un verdict a besoin de l'identifiant d'une demande de relecture.",
    commentRequired:
      "--request-changes a besoin de --comment : l'auteur doit savoir quoi corriger.",
    empty: 'aucune relecture humaine.',
    colId: 'ID',
    colAgent: 'AGENT',
    colReviewer: 'RELECTEUR',
    colRound: 'TOUR',
    colState: 'ÉTAT',
    colSince: 'DEPUIS',
    state: (status: string, alive: boolean): string =>
      status === 'PENDING'
        ? alive
          ? 'en attente'
          : 'orpheline (plus personne n’attend)'
        : status === 'ANSWERED'
          ? 'tranchée'
          : 'expirée',
    answered: (id: string, verdict: string) => `relecture ${id} : ${verdict} enregistré.`,
    gateStillDecides: 'le Test Gate décide du merge.',
    pendingHint: 'striart review <id> --approve | --request-changes --comment "…" | --reject',
  },

  profiles: {
    acpBinaryDownloaded: (id: string, version: string) =>
      `acpRegistry.allowBinaryDownload : ${id} ${version} téléchargé (sha256 vérifié).`,
    empty: 'aucun profil configuré (agentProfiles est vide).',
    emptyHint: 'docs/fr/configuration.md (agentProfiles)',
    colName: 'PROFIL',
    colTransport: 'TRANSPORT',
    colTimeout: 'DÉLAI',
    colEnv: 'VARIABLES',
    colInvocation: 'INVOCATION',
    usage: 'Utilisables avec --profile (run --autonomous / --on-main) ou dans un plan.',
    colPreset: 'PRESET',
    colWrite: 'ÉCRITURE',
    colCommit: 'COMMIT',
    colInstructions: 'CONSIGNES',
    colStatus: 'STATUT',
    colTool: 'OUTIL',
    colVersion: 'VERSION',
    colPath: 'CHEMIN',
    colProfiles: 'PROFILS',
    experimental: 'expérimental',
    ready: 'prêt',
    detectFound: 'installé',
    detectOutdated: 'trop ancien',
    detectMissing: 'absent',
    detectUnknownVersion: 'version illisible',
    detectSummary: (found: number, total: number) =>
      `${found} outil(s) détecté(s) sur ${total} — sonde : PATH puis « --version » dans un dossier vide, jamais la config du dépôt.`,
    catalogUsage:
      "Un preset expérimental se déclare explicitement : agentProfiles: { <clé>: { preset: '<id>' } }.",
    importTitle: (name: string, version: string) => `Agent ACP ${name} ${version}`,
    importPaste: 'Profil à ajouter dans agentProfiles (striart.config) :',
    importResolvedAtLaunch: (tool: string) =>
      `${tool} résoudra le paquet épinglé au premier lancement (Striart ne télécharge rien).`,
    importInstallBinary: (archive: string, sha256: string | null) =>
      `Distribution binaire : installe ${archive}${sha256 ? ` (sha256 ${sha256})` : ' (aucune empreinte publiée)'} et place le binaire dans le PATH — ou acpRegistry.allowBinaryDownload: true.`,
    importDownloaded: (dir: string) => `Téléchargé, empreinte vérifiée, extrait dans ${dir}.`,
  },

  status: {
    empty: 'aucun agent actif.',
    colAgent: 'AGENT',
    colState: 'ÉTAT',
    colMode: 'MODE',
    colSession: 'SESSION',
    colPending: 'EN ATTENTE',
    colBranch: 'BRANCHE',
    colTool: 'OUTIL',
    colSize: 'TAILLE',
    colLastCommit: 'DERNIER COMMIT',
    session: (s: { state: string; via: string | null; pid: number | null } | null) => {
      if (!s || s.state === 'idle') return '—';
      if (s.state === 'running')
        return `PID ${s.pid} (${s.via === 'pty' ? 'terminal' : 'autonome'})`;
      return 'activité récente';
    },
    brokenDetail: (status: string): string =>
      status === 'MISSING'
        ? 'clone absent du disque'
        : status === 'REMOVING'
          ? 'suppression du clone en cours'
          : 'clone illisible par git',
    stateTicket: 'TICKET',
    attention: 'À traiter',
    missing: (agent: string) => `le clone de ${agent} a disparu du disque.`,
    tickets: (n: number) =>
      `${n} ${plural(n, 'ticket de conflit ouvert', 'tickets de conflit ouverts')}.`,
    manualMode:
      'mode manuel actif : la fusion sémantique est coupée, chaque conflit devient un ticket.',
    mainSession: (reason: string, pid: number, since: string) =>
      `dépôt principal réservé : « ${reason} » (PID ${pid}, depuis ${since}).`,
    ready: (n: number) => `${n} ${plural(n, 'tâche débloquable', 'tâches débloquables')} en file.`,
    waiting: (n: number) => `${n} ${plural(n, 'tâche bloquée', 'tâches bloquées')} en file.`,
    noWatcher:
      'aucun watcher actif : les commits des agents supervisés ne seront pas mergés automatiquement.',
    humanReviews: (n: number) =>
      `${n} ${plural(n, 'relecture humaine attend', 'relectures humaines attendent')} un verdict.`,
    orchestrations: (n: number) =>
      `${n} ${plural(n, 'orchestration en cours', 'orchestrations en cours')} (plan v2 / orchestrate).`,
    idleSessions: (n: number, names: string) =>
      `${n} ${plural(n, 'session vivante inactive', 'sessions vivantes inactives')} : ${names} (aucune activité, aucun signal frais).`,
    orphanRuns: (n: number) =>
      `${n} ${plural(n, 'orchestration interrompue', 'orchestrations interrompues')} : son process s’est arrêté avant la fin.`,
    overlapAgents: (a: string, b: string, files: string, n: number) =>
      `${a} et ${b} ont tous deux modifié ${files}${n > 0 ? ` (+${n})` : ''} (non prévu par le Router) : conflit probable au merge.`,
    overlapTarget: (agent: string, files: string, n: number, branch: string) =>
      `${agent} a modifié ${files}${n > 0 ? ` (+${n})` : ''} que ${branch} a aussi fait avancer : conflit probable à son merge.`,
    overlapDeferred: (agents: string) =>
      `chevauchements non observés pour ${agents} (budget d’appels git du cycle atteint : overlap.maxGitCalls).`,
    overlapUnavailable: (reason: string) => `chevauchements non observables (${reason}).`,
    overlapScope:
      'les chevauchements ne couvrent que le travail COMMITÉ des agents (pas les modifications en cours).',
  },

  queue: {
    retrying: 'Relance de la file',
    unblocked: (taskId: string, agent: string) => `tâche ${taskId} démarrée (${agent}).`,
    nothingUnblocked: 'aucune tâche débloquée.',
    blockedReason: (code: string) => `démarrage refusé (${code})`,
    stillBlocked: 'toujours bloquée',
    empty: 'aucune tâche.',
    colTask: 'TÂCHE',
    colAgent: 'AGENT',
    colState: 'ÉTAT',
    colWhy: 'RAISON',
    colFiles: 'FICHIERS PRÉDITS',
    running: 'en cours',
    blockedBy: (agent: string, files: string) => `bloquée par ${agent} (${files})`,
    after: (ref: string) => `attend la fin de ${ref}`,
    ready: 'plus rien ne la bloque',
    readyHint: 'des tâches ne sont plus bloquées :',
  },

  reconcile: {
    running: 'Réconciliation',
    cleared: (agents: string) => `sessions mortes neutralisées : ${agents}.`,
    stillWaiting: (n: number) =>
      `${n} ${plural(n, 'tâche toujours en attente', 'tâches toujours en attente')}.`,
    nothing: "rien à réconcilier : l'état est déjà cohérent.",
  },

  usage: {
    empty: 'aucun usage enregistré sur la période.',
    unknownRole: (role: string, roles: string) => `Rôle inconnu « ${role} ». Rôles : ${roles}.`,
    colKey: 'CLÉ',
    colCalls: 'APPELS',
    colInput: 'ENTRÉE',
    colOutput: 'SORTIE',
    colCache: 'CACHE LU',
    colTokens: 'TOTAL',
    colCost: 'COÛT USD',
    byRole: 'Par rôle',
    byAgent: 'Par agent',
    byTask: 'Par tâche',
    byModel: 'Par modèle',
    byDay: 'Par jour',
    unpriced: (n: number) =>
      `${n} ${plural(n, 'appel sans prix déclaré', 'appels sans prix déclaré')} (coût incomplet — voir tokens.pricing).`,
    estimated: (n: number) =>
      `${n} ${plural(n, 'appel estimé localement', 'appels estimés localement')} (le fournisseur n'a pas rapporté d'usage).`,
    unmetered: (n: number) =>
      `${n} ${plural(n, 'session sans relevé', 'sessions sans relevé')} (pas de flux structuré : seul le délai les borne).`,
    promptCache: (pct: string) =>
      `cache de prompt : ${pct} de l'entrée servie par le cache du fournisseur.`,
    resultCache: (hits: number, eligible: number) =>
      `cache de résultats : ${hits}/${eligible} appels éligibles servis localement.`,
    instructions: (tokens: number) => `consignes injectées : ~${tokens} tokens par session.`,
    skipped: (n: number) =>
      `${n} ${plural(n, 'ligne illisible ignorée', 'lignes illisibles ignorées')} dans le registre.`,
    none: '—',
  },

  history: {
    empty: "aucun merge Striart dans l'historique.",
    colDate: 'DATE',
    colType: 'TYPE',
    colAgent: 'AGENT',
    colMerge: 'MERGE',
    colAgentCommit: 'COMMIT AGENT',
    colResolution: 'RÉSOLUTION',
    type: (type: string) => (type === 'rollback' ? 'rollback' : 'merge'),
    resolution: (resolution: string, ticketId: string | null, files: string[]) => {
      if (resolution === 'manual') return `manuelle (${ticketId})`;
      if (resolution === 'semantic') return `sémantique : ${files.join(', ')}`;
      return 'automatique';
    },
  },

  merge: {
    running: (agent: string) => `Merge de ${agent} (Test Gate)`,
    upToDate: (agent: string) => `${agent} : rien à merger, déjà à jour.`,
    alreadyIntegrated: (agent: string) =>
      `${agent} : son commit est déjà dans la branche cible (intégré par un autre chemin) : rien à merger.`,
    merged: (agent: string, mergeSha: string, agentSha: string) =>
      `${agent} mergé : commit ${mergeSha} (agent ${agentSha}), Test Gate vert.`,
    semanticFiles: (files: string) => `conflits résolus par fusion sémantique : ${files}`,
    gateRetries: (n: number) =>
      `fusion corrigée après ${n} ${plural(n, 'retour', 'retours')} du Test Gate.`,
    renameHazard: (source: string, ours: string, theirs: string) =>
      `${source} supprimé des deux côtés, contenu retrouvé sous deux noms (main : ${ours}, agent : ${theirs}) : probable double renommage, vérifie le doublon.`,
    pushFailed: (error: string) => `push échoué (le merge local reste valide) : ${error}`,
    deliveredBranch: (ref: string, sha: string) =>
      `livré sur origin/${ref} (${sha}) : à approuver depuis la forge (PR/MR), la branche cible n'a pas été poussée.`,
    memoryFailed: (error: string) => `mémoire partagée non mise à jour : ${error}`,
    conflict: (agent: string, files: string) =>
      `conflit de merge avec ${agent} sur ${files} : merge annulé.`,
    semanticFailed: (error: string) => `la fusion sémantique a échoué : ${error}`,
    unmergeableTitle: 'hors de portée de la fusion sémantique :',
    deletedBy: (side: string) => ` (supprimé côté ${side})`,
    conflictKind: (kind: string) =>
      (
        ({
          delete: 'suppression contre modification',
          path: 'conflit de chemin (renommage)',
          binary: 'fichier binaire',
          lockfile: 'lockfile généré (à régénérer)',
          oversized: 'trop volumineux pour le LLM',
          submodule: 'sous-module git',
          symlink: 'lien symbolique',
          mode: 'bit exécutable divergent',
          opaque: 'non lisible',
        }) as Record<string, string>
      )[kind] ?? kind,
    gateFailed: (agent: string, exitCode: number | null) =>
      `Test Gate rouge pour ${agent}${exitCode !== null ? ` (code ${exitCode})` : ''} : merge annulé.`,
    gateFailedSemantic: 'le code fusionné par le LLM ne passait pas les tests.',
    manualMode:
      'mode manuel actif (3 échecs sémantiques de suite) : chaque conflit devient un ticket.',
    protectedRefused: (agent: string, files: string) =>
      `merge de ${agent} refusé : l'agent change des chemins protégés (${files}).`,
    protectedChange: (file: string, status: string, pattern: string, kind: string) =>
      `${file} : ${
        ({ A: 'ajouté', M: 'modifié', D: 'supprimé', T: 'type changé' } as Record<string, string>)[
          status
        ] ?? status
      } — ${
        (
          {
            instructions: "instructions d'agent",
            'agent-config': "configuration d'agent",
            'striart-config': 'configuration de Striart',
          } as Record<string, string>
        )[kind] ?? kind
      } (${pattern})`,
    protectedHelp: (ticketId: string) =>
      `décide du contenu final de chaque chemin (.resolved, ou .delete pour le retirer), puis « striart resolve --apply ${ticketId} » (sous Test Gate) ; ou « striart resolve --close ${ticketId} » pour écarter ce travail.`,
  },

  sync: {
    running: (agent: string) => `Rebase de ${agent}`,
    runningAll: 'Rebase des agents',
    noAgents: 'aucun agent actif.',
    rebased: (agent: string, head: string, n: number) =>
      `${agent} rebasé sur ${head} (${n} ${plural(n, 'commit rattrapé', 'commits rattrapés')}).`,
    stashed: 'travail en cours mis de côté puis restauré (fichiers disjoints vérifiés).',
    upToDate: (agent: string) => `${agent} déjà à jour.`,
    skippedOverlap: (agent: string, files: string) =>
      `${agent} : travail en cours sur ${files}, aussi touché par les commits entrants — rebase reporté.`,
    skippedDirty: (agent: string, n: number) =>
      `${agent} : travail en cours (${n} ${plural(n, 'fichier modifié', 'fichiers modifiés')}), rebase reporté.`,
    skippedSession: (agent: string, pid: number | null) =>
      `${agent} : session autonome en cours (PID ${pid ?? '?'}), rebase à sa fin de cycle.`,
    rebaseConflict: (agent: string) =>
      `${agent} : rebase en conflit, annulé ; le conflit sera traité au merge.`,
    stashKept: 'travail en cours conservé dans le stash du clone.',
    stashConflict: (agent: string) =>
      `${agent} : restauration du travail en cours en conflit après rebase — il est en sécurité dans le stash du clone, à résoudre à la main.`,
  },

  stop: {
    running: (agent: string) => `Arrêt de ${agent}`,
    stopped: (agent: string, dir: string) =>
      `${agent} retiré du registre ; clone conservé : ${dir}.`,
    stoppedMissing: (agent: string) =>
      `${agent} retiré du registre (son clone avait déjà disparu).`,
    artifactFailed: (agent: string, what: string, message: string) =>
      `${agent} est arrêté, mais son ${what} n'a pas pu être nettoyé : ${message}`,
    queueFailed: (agent: string, code: string) =>
      `${agent} est arrêté, mais la file n'a pas pu être débloquée (${code}) : les tâches en attente restent en file.`,
    hostStopping: (agent: string) =>
      `le terminal de ${agent} s'arrête encore : son clone reste protégé jusqu'à sa sortie.`,
    hostUntouched: (agent: string, why: string) =>
      `le terminal de ${agent} est laissé en place (${why}) : ferme-le à la main avant « striart clean ${agent} ».`,
    hostWhy: (reason: string): string =>
      reason === 'unverified'
        ? 'process non identifiable'
        : reason === 'denied'
          ? 'appartient à un autre utilisateur'
          : 'arrêt en échec, voir le journal',
  },

  rollback: {
    running: 'Annulation du dernier merge',
    reset: (agent: string, undone: string, head: string) =>
      `merge de ${agent} défait (${undone}) : branche revenue sur ${head}.`,
    resynced: (agent: string) =>
      `les commits de ${agent} redeviennent en attente et pourront être re-mergés.`,
    notResynced: (agent: string) =>
      `${agent} non recalé (arrêté ou clone absent) : re-merge manuel si besoin.`,
    reflog: 'récupérable par le reflog (git reflog).',
    revert: (agent: string, head: string) =>
      `merge de ${agent} annulé par revert (${head}) : l'historique publié est conservé.`,
    doNotRemerge: (agent: string) =>
      `ne re-merge pas ${agent} tel quel : le même commit reproduirait l'état annulé.`,
  },

  promote: {
    running: 'Promotion : Test Gate global',
    upToDate: 'rien à promouvoir : main est déjà au niveau du staging.',
    promoted: (n: number, sha: string) =>
      `${n} ${plural(n, 'commit promu', 'commits promus')} : main avancé en fast-forward sur ${sha}.`,
    gateFailed: (exitCode: number | null) =>
      `Test Gate global rouge${exitCode !== null ? ` (code ${exitCode})` : ''} : promotion refusée, main intact.`,
    rolledBack: 'staging remis au niveau de main (--rollback).',
    stagingKept: 'staging conservé pour analyse.',
  },

  clean: {
    running: 'Nettoyage des clones',
    artifactFailed: (agent: string, what: string, message: string) =>
      `${agent} : son ${what} n'a pas pu être nettoyé : ${message}`,
    removed: (agent: string, size: string, wasActive: boolean) =>
      `${agent} supprimé${wasActive ? ' (agent actif arrêté)' : ''} : ${size} libérés.`,
    skipped: (agent: string, reason: string) =>
      `${agent} conservé : ${
        (
          {
            SESSION_LIVE: 'une session vit dans ce clone (jamais supprimé, même avec --force)',
            ACTIVE: 'agent actif',
            PENDING: 'travail non mergé',
            IN_USE: 'activité disque récente, une session y travaille peut-être',
            BUSY: 'dossier verrouillé par un process',
          } as Record<string, string>
        )[reason] ?? reason
      }.`,
    nothing: 'aucun clone à nettoyer.',
    total: (size: string) => `total libéré : ${size}.`,
  },

  gc: {
    running: 'Balayage des sessions inactives',
    disabled: "GC d'inactivité désactivé (idle.enabled: false) : rien n'est détecté.",
    nothing: 'aucun agent enregistré.',
    stage: {
      active: 'actif',
      protected: 'protégé',
      idle: 'inactif',
      warned: 'averti',
      closable: 'fermable',
    } as Record<string, string>,
    session: {
      live: 'session vivante',
      ended: 'session terminée',
      none: 'jamais lancé',
    } as Record<string, string>,
    agentLine: (agent: string, stage: string, idle: string | null, session: string, host: string) =>
      `${agent} : ${stage}${idle ? ` depuis ${idle}` : ''} — ${session}${host === 'none' ? '' : ` (${host})`}.`,
    blockedBy: (codes: string) => `protégé par : ${codes}.`,
    reasons: (codes: string) => `actif : ${codes}.`,
    closeBlocked: (codes: string) => `fermeture impossible pour l'instant : ${codes}.`,
    closeNotBefore: (date: string) => `fermable à partir de ${date} sans nouvelle activité.`,
    wouldWarn: (agent: string) => `${agent} serait averti.`,
    wouldClose: (agent: string) => `la session de ${agent} serait fermée.`,
    warned: (agent: string) =>
      `${agent} averti : sa session sera fermable après le délai de grâce.`,
    closed: (agent: string, host: string, code: string) =>
      code === 'CLOSING'
        ? `session de ${agent} (${host}) : arrêt demandé, sortie en cours — clone et travail conservés.`
        : `session de ${agent} (${host}) fermée proprement — clone et travail conservés.`,
    refused: (agent: string, code: string, detail: string | null) =>
      `session de ${agent} NON fermée (${code}${detail ? ` : ${detail}` : ''}) — laissée intacte.`,
    notAuthorized:
      'fermeture non autorisée : ajoute ce dépôt à idle.closeRoots dans la config utilisateur (striart doctor).',
    authorizationError: (code: string) =>
      `config utilisateur illisible (${code}) : aucune fermeture automatique.`,
    holds: (codes: string) => `balayage prudent, aucune fermeture : ${codes}.`,
    summary: (idle: number, warned: number, closed: number, dryRun: boolean) =>
      `${idle} ${idle > 1 ? 'agents inactifs' : 'agent inactif'}, ${warned} ${dryRun ? 'à avertir' : warned > 1 ? 'avertis' : 'averti'}, ${closed} ${dryRun ? 'à fermer' : closed > 1 ? 'sessions fermées' : 'session fermée'}.`,
  },

  prune: {
    running: 'Rétention',
    cloneRemoved: (agent: string, date: string, size: string, dryRun: boolean) =>
      `clone ${agent} ${dryRun ? 'serait supprimé' : 'supprimé'} (inactif depuis ${date}, ${size}).`,
    cloneKept: (agent: string, date: string) => `clone ${agent} conservé (activité le ${date}).`,
    keptReason: (reason: string) =>
      reason === 'PTY_HOST_LIVE'
        ? 'Un terminal est encore ouvert dessus : ferme-le avant de réessayer.'
        : reason,
    failed: (kind: string, name: string, cause: string) =>
      `${kind === 'clone' ? 'clone' : kind === 'ticket' ? 'ticket' : 'journal'} ${name} : suppression impossible (${cause}).`,
    ticketRemoved: (id: string, date: string, dryRun: boolean) =>
      `ticket ${id} ${dryRun ? 'serait supprimé' : 'supprimé'} (résolu le ${date}).`,
    nothing: (days: number) =>
      `rien à élaguer (rétention : ${days} ${plural(days, 'jour', 'jours')}).`,
    total: (size: string, days: number, dryRun: boolean) =>
      `${dryRun ? 'espace récupérable' : 'espace libéré'} : ${size} (rétention : ${days} ${plural(days, 'jour', 'jours')}).`,
  },

  resolve: {
    applying: (id: string) => `Application de la résolution ${id} (Test Gate)`,
    unlocked: "fusion sémantique réactivée (compteur d'échecs remis à zéro).",
    closed: (id: string, dir: string) => `ticket ${id} marqué résolu (${dir}).`,
    prepared: (file: string, source: string) =>
      `${file}.resolved amorcé depuis .${source} : à éditer.`,
    alreadyPrepared: (file: string) => `${file} : déjà préparé, inchangé.`,
    acceptNeedsPrepare: "--accept-theirs ne fonctionne qu'avec --prepare.",
    held: (file: string) =>
      `${file} : chemin protégé, NON amorcé depuis la version de l'agent — écris ${file}.resolved toi-même, ou accepte explicitement sa version :`,
    editThenApply:
      'Édite les fichiers .resolved (ou crée un fichier .delete pour supprimer), puis :',
    applied: (id: string, sha: string) =>
      `ticket ${id} résolu et mergé (commit ${sha}), Test Gate vert.`,
    files: (files: string) => `fichiers : ${files}`,
    duplicatesClosed: (ids: string) => `doublons du même conflit fermés : ${ids}`,
    alreadyClean: (id: string) => `ticket ${id} : plus aucun conflit, rien à appliquer.`,
    gateFailed: (id: string, exitCode: number | null) =>
      `Test Gate rouge après la résolution du ticket ${id}${exitCode !== null ? ` (code ${exitCode})` : ''} : le ticket reste ouvert, ajuste les fichiers .resolved.`,
    streak: (n: number) =>
      `${n} ${plural(n, 'échec sémantique consécutif', 'échecs sémantiques consécutifs')}.`,
    none: 'aucun ticket ouvert.',
    colTicket: 'TICKET',
    colState: 'ÉTAT',
    colReason: 'RAISON',
    colAgent: 'AGENT',
    colAttempts: 'ESSAIS',
    colDate: 'DATE',
    colFiles: 'FICHIERS',
    stateOpen: 'ouvert',
    stateResolved: 'résolu',
    stateCorrupt: (cause: string) => `illisible (${cause})`,
    unknownField: '—',
    corrupt: (id: string, cause: string) =>
      `ticket ${id} illisible (${cause}) : son contenu ne peut être ni lu, ni préparé, ni appliqué — inspecte son dossier, puis ferme-le.`,
    howTo: (n: number) =>
      `${n} ${plural(n, 'ticket ouvert', 'tickets ouverts')} : prépare puis applique la résolution sous le Test Gate, ou --close si c'est déjà corrigé à la main.`,
  },

  hook: {
    collision: (entries: { file: string; agents: string[] }[]) =>
      `Striart : ${entries
        .map((e) => `${e.file} est prédit ou verrouillé par ${e.agents.join(', ')}`)
        .join(
          ' ; ',
        )}. Un autre agent travaille sur ce fichier : le modifier ici risque un conflit au merge — coordonne-toi ou restreins ta modification (avis seulement, rien n'est bloqué).`,
    sessionEnded: (agent: string, tool: string, reason: string | null) =>
      `Session supervisée terminée : ${agent} (${tool}${reason ? `, ${reason}` : ''}). Ses commits seront mergés par striart watch ou striart merge ${agent}.`,
    warnings: {
      unknownTool: (tool: string) =>
        `hook ignoré : outil inconnu « ${tool} » (claude, codex, copilot, gemini, cline).`,
      unknownEvent: (tool: string, event: string) =>
        `hook ignoré : événement « ${event} » inconnu pour ${tool}.`,
      noEvent: (reason: string): string =>
        reason === 'TOO_LARGE'
          ? 'hook ignoré : événement trop long sur stdin (lecture bornée).'
          : reason === 'TIMEOUT'
            ? 'hook ignoré : aucun événement complet reçu sur stdin dans le délai.'
            : reason === 'TTY'
              ? "hook ignoré : aucun événement sur stdin (commande lancée par l'outil de coding, pas à la main)."
              : 'hook ignoré : stdin illisible.',
      invalidPayload: "hook ignoré : l'événement reçu n'est pas un objet JSON.",
      eventMismatch: (expected: string, actual: string) =>
        `hook ignoré : l'événement reçu (${actual}) ne correspond pas à celui déclaré (${expected}).`,
      contextFailed: (message: string) => `hook ignoré : ${message}`,
      codeConfigUntrusted:
        "config Striart exécutable (striart.config.mjs) non chargée par un hook installé pour l'utilisateur : réglages hooks par défaut, notifications de fin de session sautées. Installe le hook dans le clone (striart hook install <outil> --agent <nom>) ou utilise une config données (.striartrc.json).",
      configFailed: (message: string) => `config Striart illisible pour le hook : ${message}`,
      userConfigFailed: (message: string) =>
        `config utilisateur de Striart ignorée (aucune racine de confiance) : ${message}`,
    },
    scopeRequired:
      'précise où installer le hook : --user (configuration utilisateur) ou --agent <nom> (clone).',
    installed: (tool: string, scope: string, agent: string | null, dryRun: boolean) =>
      `${dryRun ? '(simulation) ' : ''}hook ${tool} installé ${scope === 'user' ? "pour l'utilisateur" : `dans le clone de ${agent}`}.`,
    uninstalled: (tool: string, scope: string, agent: string | null, dryRun: boolean) =>
      `${dryRun ? '(simulation) ' : ''}hook ${tool} retiré ${scope === 'user' ? 'de la configuration utilisateur' : `du clone de ${agent}`}.`,
    change: (action: string, file: string) =>
      `${{ create: 'créé', update: 'modifié', remove: 'supprimé', unchanged: 'inchangé' }[action] ?? action} : ${file}`,
    reloadHint: (tool: string) =>
      tool === 'codex'
        ? 'Codex : approuve le hook avec /hooks (les hooks non gérés doivent être approuvés avant de tourner).'
        : tool === 'cline'
          ? 'Cline : active Settings → Features → Enable Hooks.'
          : `relance ${tool} pour charger le hook.`,
  },

  lock: {
    released: (reason: string) => `dépôt principal libéré (« ${reason} »).`,
    alreadyFree: 'dépôt principal déjà libre.',
    reserved: (reason: string, pid: number) =>
      `dépôt principal réservé pour « ${reason} » (PID ${pid} surveillé).`,
    reservedDetail:
      'merge, sync, promote, resolve --apply et le merge auto de watch sont refusés tant que ce process vit.',
    free: 'dépôt principal libre.',
    busy: (reason: string, pid: number, date: string, since: string) =>
      `dépôt principal réservé : « ${reason} » (PID ${pid}, depuis le ${date}, ${since}).`,
    deadPid: (reason: string, pid: number) =>
      `réservation « ${reason} » inopérante : le PID ${pid} est mort (libérée à la prochaine opération).`,
  },

  watch: {
    started: (dir: string) => `watcher actif sur ${dir} (Ctrl+C pour quitter).`,
    autoMerge: 'merge automatique : chaque commit passe par le Test Gate.',
    noMerge: 'merge automatique désactivé (--no-merge) : les commits sont seulement signalés.',
    commit: (agent: string, branch: string, sha: string) =>
      `nouveau commit de ${agent} sur ${branch} (${sha}).`,
    mergeSkipped: (agent: string) => `${agent} est autonome : son merge a lieu en fin de session.`,
    mergeError: (agent: string, error: string) => `merge de ${agent} impossible : ${error}`,
    reconcileError: (error: string) => `réconciliation périodique échouée : ${error}`,
    behind: (agent: string, n: number, branch: string) =>
      `${agent} en retard de ${n} ${plural(n, 'commit', 'commits')} sur ${branch} : rebase au prochain merge.`,
    caughtUp: (agent: string, branch: string) => `${agent} de nouveau à jour sur ${branch}.`,
    draining: 'arrêt : fin de l’opération en cours (Ctrl+C à nouveau pour forcer)',
    mergeDeferred: (agent: string) =>
      `merge de ${agent} non lancé (arrêt demandé) : le prochain watch ne le reprendra pas.`,
    fetchError: (agent: string | null, error: string) =>
      `fetch silencieux échoué${agent ? ` pour ${agent}` : ''} : ${error}`,
    overlapAgents: (a: string, b: string, files: string, n: number) =>
      `chevauchement observé : ${a} et ${b} ont tous deux modifié ${files}${n > 0 ? ` (+${n})` : ''} (non prévu par le Router).`,
    overlapTarget: (agent: string, files: string, n: number, branch: string) =>
      `chevauchement observé : ${agent} a modifié ${files}${n > 0 ? ` (+${n})` : ''} que ${branch} a aussi fait avancer.`,
    overlapCatchup: (agent: string, status: string) =>
      status === 'REBASED'
        ? `${agent} rebasé par anticipation (chevauchement observé).`
        : status === 'SKIPPED_SESSION'
          ? `${agent} : session vivante, rebase anticipé ajourné (clone intouchable).`
          : `${agent} : rebase anticipé non effectué (${status}) — traité à son merge.`,
    overlapError: (error: string) => `observation des chevauchements échouée : ${error}`,
    idleWarned: (agent: string, idle: string, willClose: boolean) =>
      willClose
        ? `${agent} inactif depuis ${idle} : sa session sera fermée après le délai de grâce sans nouvelle activité (clone et travail conservés).`
        : `${agent} inactif depuis ${idle} (fermeture automatique non activée).`,
    idleError: (error: string) => `balayage des sessions inactives échoué : ${error}`,
  },

  daemon: {
    label: (name: string): string => (name === 'watch' ? 'watcher' : 'tableau de bord'),
    started: (label: string, pid: number) => `${label} lancé en arrière-plan (PID ${pid}).`,
    boot: "reprise au démarrage de la machine : enregistre « striart watch --daemon » dans le planificateur de l'OS.",
    stopped: (label: string, pid: number | null) => `${label} arrêté (PID ${pid}).`,
    staleCleaned: (pid: number | null) =>
      `fichier PID orphelin nettoyé (PID ${pid} : le daemon n'existe plus).`,
    stopping: (label: string, pid: number | null) =>
      `arrêt demandé : le ${label} (PID ${pid}) termine l'opération en cours, puis sort de lui-même.`,
    notRunning: (label: string) => `aucun ${label} en arrière-plan.`,
    running: (label: string, pid: number | null, since: string) =>
      `${label} actif (PID ${pid}, depuis ${since}).`,
    dead: (label: string, pid: number | null) =>
      `${label} arrêté (fichier PID orphelin, PID ${pid} : le daemon n'existe plus).`,
  },

  dashboard: {
    listening: (url: string) => `tableau de bord : ${url}`,
    quit: 'Ctrl+C pour arrêter.',
    url: (url: string) => `adresse : ${url}`,
    signIn: (url: string) => `connexion (lien à usage unique) : ${url}`,
    signInDetail: (expiresAt: string) =>
      `le lien expire à ${expiresAt} et ne sert qu'une fois ; nouveau lien : striart dashboard --link. Ne le partage pas.`,
    linkPending:
      "le tableau de bord démarre encore : son lien de connexion n'est pas prêt. Lance « striart dashboard --link » dans un instant.",
    noInstance:
      'aucun tableau de bord en cours pour ce dépôt : lance « striart dashboard » ou « striart dashboard --daemon ».',
  },

  control: {
    autonomousMerged: (agent: string, kept: string | null) =>
      `✅ session autonome ${agent} : travail mergé` + (kept ? ` — ${kept}` : ', clone nettoyé.'),
    autonomousQueued: (agent: string) =>
      `⏳ tâche autonome de ${agent} mise en file (collision Router).`,
    autonomousBlocked: (agent: string, why: string) => `⛔ session autonome ${agent} : ${why}`,
    autonomousFailed: (message: string) => `⛔ session autonome : ${message}`,
  },

  attach: {
    wrongCwd: (cwd: string) =>
      `« striart attach » se lance depuis le clone de l'agent (répertoire courant : ${cwd}).`,
    failed: (agent: string, error: string) =>
      `impossible de rejoindre ${agent} : ${error}. L'hôte du terminal tourne-t-il encore ?`,
    ended: 'session terminée côté agent.',
  },

  /**
   * Constats de `doctor`, par contrôle (`id`) et par constat (`key` +
   * `params` bruts). `null` : le texte de référence du domaine (français)
   * est affiché tel quel. Le catalogue anglais, lui, reformule chacun.
   */
  watchUi: {
    loading: 'Chargement des agents…',
    terminalEmpty: 'Aucune commande lancée pour l’instant — tape /status ou !ls pour commencer.',
    idleTool: 'outil hébergé terminé ? — « /relaunch » pour le relancer',
    refreshFailed: (error: string) => `Rafraîchissement impossible : ${error}`,
    sending: (agent: string) => `Envoi à « ${agent} »`,
    relaunching: (agent: string) => `Relance de « ${agent} »`,
    relaunchNoAgent: 'aucun agent — « /relaunch agent-a » ou sélectionne son onglet',
    unknownAgent: (agent: string) => `Agent inconnu : « ${agent} ».`,
    autonomousRefused: (agent: string) =>
      `« ${agent} » est en mode autonome sans session ACP vivante — une session argv est one-shot (plus de process à qui parler), une session ACP n'est adressable que pendant qu'elle tourne dans son hôte persistant (acp.persistentHost). Utilise le dashboard ou striart resolve.`,
    acpRefused: (agent: string, reason: string) =>
      `Session ACP de « ${agent} » : message refusé — ${reason}`,
    relaunchAutonomous: (agent: string) =>
      `« ${agent} » est en mode autonome : /relaunch ne relance que l'outil d'un agent supervisé (pty).`,
    hostUnavailable: (agent: string, error: string) =>
      `Hôte de pty indisponible pour « ${agent} » : ${error}`,
    injectFailed: (agent: string, error: string) =>
      `Injection impossible vers « ${agent} » : ${error}`,
    dashboardForeground:
      '« dashboard » démarre un serveur HTTP qui tourne indéfiniment — utilise « dashboard --daemon » pour le lancer en arrière-plan depuis ce champ (« dashboard --stop »/« --status » pour le piloter), ou lance-le dans un terminal séparé.',
    foregroundRefused: (cmd: string, reason: string) =>
      `« ${cmd} » ne peut pas se lancer depuis ce champ : ${reason}.`,
    foreground: {
      watch:
        'lancerait un second watcher en plus de celui qui héberge déjà ce panneau — doublons de merge, contention sur main.lock',
      protocol:
        "sert un protocole sur stdin/stdout — ce champ ne peut pas lui fournir un client, il resterait bloqué jusqu'au délai",
      terminal:
        'doit posséder le terminal réel (mode raw) — incompatible avec ce panneau qui le possède déjà',
      internal: 'commande interne, jamais destinée à un humain (lancée par --open)',
    },
    unavailableHere: (reason: string) => `non disponible ici (${reason})`,
    dashboardSuggestion: 'tourne au premier plan — utilise « --daemon » depuis ce champ',
    initSuggestion: '.striart/ est déjà là si tu es dans ce panneau — rarement utile ici',
    clearSuggestion:
      "Efface le panneau Commandes — dans le détail d'un agent, envoie la vraie commande d'effacement à son shell",
    relaunchSuggestion:
      '[agent] — retape la commande de lancement (utile si l’outil hébergé s’est arrêté)',
    exitSuggestion: 'Quitte ce panneau (comme Ctrl+C)',
    // Cockpit `watch --ui` : écran persistant à positions stables (en-tête,
    // chiffres clés, agents, détail, panneau du bas, saisie, barre de touches).
    cockpit: {
      appName: 'striart watch',
      starting: 'Démarrage du cockpit (chargement des modules, quelques secondes)',
      watcherOn: 'watcher actif',
      watcherMerge: 'merge auto',
      watcherNoMerge: 'merge désactivé',
      stale: (since: string) => `données obsolètes depuis ${since}`,
      loading: 'chargement…',
      kpiAgents: 'agents',
      kpiCommits: 'commits en attente',
      kpiConflicts: 'conflits',
      kpiQueue: 'file',
      kpiAgentsShort: 'ag.',
      kpiCommitsShort: 'commits',
      kpiConflictsShort: 'conflits',
      kpiQueueShort: 'file',
      colAgent: 'AGENT',
      colState: 'ÉTAT',
      colCommits: 'COMMITS',
      colLast: 'DERNIER COMMIT',
      colAge: 'ÂGE',
      colBranch: 'BRANCHE',
      colMode: 'MODE',
      colSession: 'SESSION',
      groupAttention: 'À traiter',
      groupRunning: 'En cours',
      groupIdle: 'Inactifs',
      sectionAgents: 'Agents',
      sectionDetail: (agent: string) => `Détail · ${agent}`,
      sectionJournal: 'Journal',
      sectionCommands: 'Commandes',
      sectionOutput: (agent: string) => `Sortie · ${agent}`,
      emptyTitle: 'Aucun agent pour l’instant.',
      emptyHint: 'Crée le premier : striart start agent-a',
      noSelection: 'Aucun agent sélectionné.',
      detailSession: 'Session',
      /** Indicateur d'inactivité (GC) : « inactif 3 h », + l'étage quand il demande attention. */
      idleState: (stage: 'idle' | 'warned' | 'closable', duration: string) =>
        stage === 'closable'
          ? `inactif ${duration}, fermable`
          : stage === 'warned'
            ? `inactif ${duration}, averti`
            : `inactif ${duration}`,
      detailBranch: 'Branche',
      detailCommits: 'Commits',
      detailFiles: 'Fichiers',
      detailTicket: 'Ticket',
      detailLoading: 'lecture du clone…',
      detailUnreadable: (error: string) => `clone illisible : ${error}`,
      pendingNone: 'aucun commit en attente de merge',
      pendingCount: (n: number) =>
        `${n} ${plural(n, 'commit en attente', 'commits en attente')} de merge`,
      filesNone: 'aucun fichier modifié',
      filesMore: (n: number) => `+${n} ${plural(n, 'autre', 'autres')}`,
      uncommitted: (n: number) =>
        `${n} ${plural(n, 'modification non commitée', 'modifications non commitées')}`,
      ticketLine: (id: string, reason: string) => `${id} · ${reason}`,
      journalEmpty: 'Aucun événement. Commits, merges et rebases du watcher apparaîtront ici.',
      outputEmpty: 'Pas de sortie : cet agent n’a pas de terminal hébergé (mode autonome).',
      outputDisconnected:
        'terminal hébergé injoignable pour l’instant — nouvelle tentative en cours',
      terminalSmall: (cols: number, rows: number) =>
        `Terminal trop petit (${cols}×${rows}) : agrandis-le pour voir tout l’écran (80×24 conseillé).`,
      promptIdle: 'Appuie sur / pour une commande, @ pour écrire à un agent, ? pour l’aide.',
      modeCommand: 'commande',
      modeMessage: 'message',
      modeShell: 'shell',
      merging: (agent: string) => `Merge de « ${agent} »`,
      syncing: (agent: string) => `Sync de « ${agent} »`,
      done: (label: string, elapsed: string) => `${label} (${elapsed})`,
      seeCommands: 'détails dans le panneau Commandes (Tab)',
      confirmMergeTitle: (agent: string, target: string) =>
        `Fusionner « ${agent} » dans ${target} ?`,
      confirmMergePending: (n: number) =>
        `${n} ${plural(n, 'commit en attente sera intégré', 'commits en attente seront intégrés')}.`,
      confirmMergeNone: 'Aucun commit en attente : le merge ne changera rien.',
      confirmMergeGate:
        'Le Test Gate s’exécute avant tout commit : en cas d’échec, le merge est annulé et un ticket est créé.',
      confirmMergeTicket:
        'Un ticket de conflit est ouvert pour cet agent (« striart resolve ») : ce merge peut échouer de nouveau.',
      plainConfirm: 'Réponds « y » pour confirmer ; toute autre réponse annule.',
      confirmMergeLive:
        'Une session autonome est en cours sur ce clone : le merge sera refusé tant qu’elle tourne.',
      cancelled: 'Annulé.',
      plainKeys:
        '  m <agent> merge (confirmation y), s <agent> sync, /commande, !shell, @agent texte, ? aide, q quitter',
      keys: {
        select: 'sélectionner',
        details: 'détails',
        merge: 'merge',
        sync: 'sync',
        command: 'commande',
        message: 'message @agent',
        shell: 'shell',
        pane: 'journal/commandes',
        help: 'aide',
        quit: 'quitter',
        send: 'envoyer',
        cancel: 'annuler',
        complete: 'compléter',
        history: 'suggestions/historique',
        confirm: 'confirmer',
        back: 'retour',
        scroll: 'défiler',
        close: 'fermer',
      },
      helpTitle: 'Aide — raccourcis',
      helpSections: [
        {
          title: 'Navigation',
          rows: [
            ['↑ ↓  j k', 'sélectionner un agent'],
            ['Entrée', 'détails et sortie de l’agent (Échap pour revenir)'],
            ['Tab', 'basculer le panneau du bas (journal, commandes)'],
            ['PgUp PgDn', 'remonter / redescendre dans le panneau du bas'],
          ],
        },
        {
          title: 'Actions sur l’agent sélectionné',
          rows: [
            ['m', 'merge dans la branche cible, sous Test Gate (confirmation)'],
            ['s', 'sync : rebase de l’agent sur la branche cible'],
          ],
        },
        {
          title: 'Saisie (le focus passe au champ ; Échap l’abandonne)',
          rows: [
            ['/', 'commande striart (/status, /resolve, /clear, /relaunch, /exit)'],
            ['@', 'message à un agent (@agent texte) ; texte seul → agent sélectionné'],
            ['!', 'commande shell réelle'],
            ['Tab', 'compléter la suggestion'],
          ],
        },
        {
          title: 'Général',
          rows: [
            ['?', 'cette aide'],
            ['Échap', 'revenir en arrière (confirmation, aide, détails, saisie)'],
            ['q  Ctrl+C', 'quitter (le watcher s’arrête)'],
          ],
        },
      ],
    },
    agentAutonomous: 'autonome — message transmis à sa session ACP vivante',
    agentSupervised: 'supervisé actif',
    agentInactive: 'inactif',
  },

  /** Messages du proxy ACP `striart acp` (lot I10), affichés DANS l'éditeur. */
  acpProxy: {
    optionProfile: 'Agent',
    optionProfileHelp:
      'Agent de coding amont qui travaille dans le clone Striart (figé au premier prompt)',
    optionPermissions: 'Permissions',
    optionPermissionsHelp: "Qui tranche les demandes de l'agent (figé au premier prompt)",
    permissionLabels: {
      ask: "Me demander (dans l'éditeur)",
      reject: 'Tout refuser',
      allow: 'Tout accorder',
      profile: 'Politique du profil',
    },
    optionMerge: 'Fin de session',
    optionMergeHelp: 'Ce que Striart fait du travail quand la session se termine',
    mergeLabels: { auto: 'Merger sous Test Gate', manual: 'Garder le clone (merge manuel)' },
    commandFinish: 'Termine la session : contrat de commit, merge sous Test Gate, nettoyage',
    commandStatus: "Affiche le clone, l'agent amont et les réglages de cette session",
    started: (agent: string, profile: string, clonePath: string) =>
      `🧬 [striart] clone « ${agent} » créé (${clonePath}) — agent amont : ${profile}. Tout le travail se fait dans ce clone ; ton dépôt principal n'est touché qu'au merge final, sous Test Gate.\n`,
    ideMcpIgnored: (n: number) =>
      `ℹ️ [striart] ${n} serveur(s) MCP de l'éditeur non transmis à l'agent amont : ils agiraient sur ton dépôt principal, pas sur le clone.\n`,
    replacedControls: (n: number) =>
      `ℹ️ [striart] ${n} caractère(s) de contrôle du prompt remplacé(s) par « � ».\n`,
    foreignTurn:
      "\n↪ [striart] un message venu d'une autre surface Striart (watch --ui) est en cours de traitement.\n",
    turnCancelled:
      "\n⏹ [striart] tour annulé. Fermer la session maintenant garde le clone sans merge ; envoie un autre prompt pour terminer le travail d'abord.\n",
    elicitationElsewhere:
      "\n❓ [striart] l'agent pose une question que cet éditeur ne sait pas afficher : réponds-y dans le tableau de bord (striart dashboard) — sans réponse, elle sera annulée (fail closed).\n",
    permissionLost: (title: string) =>
      `\nℹ️ [striart] demande « ${title} » déjà tranchée ailleurs ou expirée.\n`,
    collisionWaiting: (agents: string) =>
      `⏳ [striart] le Router prédit une collision avec ${agents} : j'attends leur fin avant de créer le clone.\n`,
    finishing:
      '\n🏁 [striart] fin de session : fermeture de l’agent amont, contrat de commit, merge sous Test Gate…\n',
    cancelIgnoredWhileFinishing:
      '\n⏳ [striart] le merge est en cours : il ne s’interrompt pas (le dépôt ne reste jamais en état « merging »).\n',
    outcomeMerged: (agent: string, sha: string) =>
      `✅ [striart] travail de « ${agent} » mergé (commit ${sha.slice(0, 8)}), Test Gate vert, clone nettoyé.\n`,
    outcomeAlreadyIntegrated: (agent: string, sha: string) =>
      `✅ [striart] travail de « ${agent} » déjà dans la branche cible (commit ${sha.slice(0, 8)}) : rien mergé, Test Gate non rejoué, clone nettoyé.
`,
    outcomeKept: (agent: string, reason: string, clonePath: string | null) =>
      `⛔ [striart] « ${agent} » : ${reason}${clonePath ? ` Clone conservé : ${clonePath}` : ''}\n`,
    outcomeNothing: "ℹ️ [striart] aucune tâche n'a démarré : rien à merger.\n",
    keptReasons: {
      SESSION_FAILED: (detail: string | null) =>
        detail === 'BUDGET_EXCEEDED'
          ? "plafond de tokens franchi : session arrêtée, rien n'a été mergé, clone conservé (consulte `striart usage`)."
          : `session amont terminée en ${detail ?? 'échec'}, rien n'a été mergé.`,
      NO_COMMIT: "l'agent n'a rien committé : rien à merger.",
      NO_CHANGES: "l'agent n'a rien modifié : rien à merger.",
      ONLY_EXCLUDED_CHANGES:
        'seuls des fichiers exclus des commits restaient (secrets, fichiers injectés).',
      COMMIT_REFUSED: (detail: string | null) =>
        `commit Striart refusé (${detail ?? '?'}), état du clone ambigu.`,
      COMMIT_FAILED: (detail: string | null) => `commit Striart impossible (${detail ?? '?'}).`,
      MERGE_BLOCKED: (detail: string | null) =>
        `merge bloqué (${detail ?? '?'}) : Test Gate rouge ou conflit — un ticket t'attend (striart status).`,
      CLEANUP_SKIPPED: (detail: string | null) =>
        `mergé, mais le clone n'a pas pu être nettoyé (${detail ?? '?'}).`,
      HUMAN_REVIEW_REQUIRED: (agent: string) =>
        `commitPolicy 'human' : rien n'est mergé automatiquement — relis le clone, puis lance "striart merge ${agent}".`,
      MERGE_DEFERRED: (agent: string, detail: string | null) =>
        detail === 'DISCONNECTED'
          ? `éditeur déconnecté sans fin de session : merge laissé à toi (striart merge ${agent}).`
          : `merge laissé à toi (striart merge ${agent}).`,
    },
    logAt: (logPath: string) => `📄 [striart] journal de session : ${logPath}\n`,
    status: (p: {
      agent: string | null;
      profile: string;
      permissions: string;
      merge: string;
      turns: number;
      clonePath: string | null;
    }) =>
      `[striart] agent : ${p.agent ?? '(clone créé au premier prompt)'} · amont : ${p.profile} · permissions : ${p.permissions} · fin : ${p.merge} · tours : ${p.turns}${p.clonePath ? ` · clone : ${p.clonePath}` : ''}\n`,
  },

  doctorChecks: {
    label: (_id: string): string | null => null,
    detail: (_key: string, _params: Record<string, unknown>): string | null => null,
    hint: (_key: string, _params: Record<string, unknown>): string | null => null,
  },

  /**
   * Messages des erreurs du domaine, par code. `null` : le message du
   * domaine (déjà en français) est affiché tel quel ; seules les erreurs
   * rédigées en anglais à la source ont une entrée (FR_ERRORS). Le catalogue
   * anglais, lui, traduit chaque code.
   */
  errors: (code: string, details: Record<string, unknown>): string | null =>
    FR_ERRORS[code]?.(details) ?? null,
};

export type Messages = typeof fr;
