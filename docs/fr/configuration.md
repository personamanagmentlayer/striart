# Configuration

> [Documentation](README.md) · Configuration

La config est chargée par cosmiconfig : `striart.config.mjs` (généré par
`striart init`, recommandé — ESM explicite, fonctionne même si le repo cible
est en CommonJS), mais aussi `striart.config.js`, `.striartrc.json`,
`.striartrc.yaml`… Elle est validée au chargement : une valeur invalide est
refusée avec son motif (`CONFIG_INVALID` — seule la **clé** fautive est citée,
jamais sa valeur, qui peut porter un secret), jamais dégradée en silence. Les
réglages imbriqués (`tokens`, `orchestration`, `acpAgent`, `pty`, `terminal`,
`mcp`…) **refusent une clé inconnue** : une faute de frappe sur un réglage de
sécurité ne doit pas laisser croire qu'un relâchement ou un plafond est actif.

> **Une config `.mjs`/`.js` est du code exécuté** (voir
> [SECURITY.md](../../SECURITY.md)) : ne chargez jamais celle d'un tiers sans
> l'avoir lue. Les réglages qui élargissent une confiance vivent donc, pour
> certains, hors du dépôt — voir [Configuration utilisateur](#configuration-utilisateur-hors-du-dépôt).

Tout a un défaut raisonnable — la config minimale tient en trois lignes :

```js
export default {
  unknownConfigKeys: 'error',     // clé de premier niveau inconnue : 'error' (défaut) = CONFIG_INVALID | 'warn' (relâchement)
  testCommand: 'npm test',   // la commande du Test Gate — le seul réglage vraiment portant
  targetBranch: 'main',      // branche où merger — 'master', 'dev'… fonctionnent aussi
};
```

**Principe directeur** : tout comportement à choix défendables est une clé
validée, avec un **défaut sûr** ; relâcher une protection est explicite,
journalisé, et affiché par `striart doctor` (ligne dédiée et synthèse
« protections relâchées »).

## Référence complète commentée

Les valeurs ci-dessous sont les **défauts réels** (`src/config.js`,
`DEFAULT_CONFIG`) ; les bornes sont celles des validateurs.

```js
export default {
  testCommand: 'npm test',        // Test Gate : 'yarn test', 'make test', 'pytest'...
  targetBranch: 'main',           // branche où merger/pousser — voir docs/fr/branches.md
  // Pipeline staging → main (optionnel) : les agents mergent dans targetBranch
  // (ex: 'striart/staging') et `striart promote` fait avancer mainBranch en
  // fast-forward après un Test Gate global — main n'est jamais dans un état
  // intermédiaire, même une milliseconde.
  mainBranch: null,               // ex: 'main' (null = promotion désactivée)
  promoteTestCommand: null,       // gate global d'intégration (null → testCommand)
  autoPush: false,                // true → push origin après chaque merge vert
  autoRebase: true,               // rebase des agents sur la branche cible avant merge
  autoStash: true,                // stash auto pendant le rebase si le travail en cours
                                  // est disjoint des commits entrants (vérifié)
  semanticMerge: true,            // fusion des conflits par LLM
  semanticGateRetries: 1,         // retentatives du Merger avec le log du gate en feedback (0 à 5)
  secretPatterns: ['.env', '.env.*', '*.pem', '*.key', 'credentials.json'],
                                  // secrets TRACKÉS retirés du worktree des clones ([] = off)
  memoryLayer: false,             // mémoire sémantique partagée entre agents (résumé LLM par merge)
  memoryMaxEntries: 30,           // taille max de .striart/memory.md (1 à 500 entrées récentes)
  presenceMinutes: 10,            // un clone dont le disque a bougé depuis moins de N minutes
                                  // est réputé occupé : striart clean le saute (1 à 1440)
  agentCommand: null,             // outil affiché après start/run — null → 'claude' en exemple
                                  // (surchargeable par agent via --command)
  testTimeoutMs: 600000,          // délai max du Test Gate (kill de l'arbre au-delà), 1000 à 2147483647
  gateOrphanGraceMs: 2000,        // délai laissé aux descendants du test pour finir seuls (0 à 600000)
  gateMaxOutputBytes: 104857600,  // plafond du journal du gate conservé (1 Kio à 1 Gio) : la fin est gardée
  gateContainer: 'native',        // 'native' (conteneur de process, fail closed) | 'process' (relâchement)
  fetchIntervalMs: 20000,         // fetch silencieux du watch (0 = désactivé, sinon ≥ 1000)
  cloneFilter: null,              // 'blob:none' : clone partiel pour les très gros historiques
  pruneDays: 14,                  // rétention de striart prune (entier ≥ 0)
  logMaxBytes: 10485760,          // rotation des journaux longs : taille max (64 Kio à 1 Gio)…
  logGenerations: 5,              // …et nombre de générations conservées (1 à 100)

  // Mode autonome : comment lancer chaque outil SANS interaction humaine.
  // Par défaut : les 20 presets PRÊTS du catalogue (`striart profiles --catalog`).
  agentProfiles: { /* voir « Profils d'agents » */ },
  autonomousTimeoutMs: 1800000,   // délai max d'une session autonome (kill de l'arbre au-delà), 1000 à 2147483647

  // Contrat de commit et consignes remises aux agents :
  commitPolicy: 'agent',          // 'agent' | 'agent-then-striart' | 'striart' | 'human'
  commitMessage: 'striart({{agent}}): {{task}}',
  agentInstructions: { /* voir « agentInstructions » */ },
  protectedAgentPaths: { extend: [], allow: [], matchCase: 'insensitive' },
  acpRegistry: { url: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
                 allowBinaryDownload: false, allowEnv: [] },
  acpAgent: { /* le proxy `striart acp` — voir « acpAgent » */ },

  // Notifications (best-effort) :
  webhookUrl: null,               // canal unique historique (type deviné par l'URL)
  notifiers: [],                  // ex: [{ type: 'slack', urlEnv: 'SLACK_WEBHOOK_URL' }]

  // Dashboard et Control Protocol :
  dashboardPort: 3456,            // port par défaut de striart dashboard (--port le remplace)
  dashboardHostname: 'instance',  // 'instance' (<id-aléatoire>.localhost) | 'localhost' (relâchement)
  dashboardAllowedHosts: [],      // hôtes Host admis EN PLUS de l'adresse locale (relâchement)
  dashboardLinkTtlMs: 300000,     // durée de vie d'un lien de connexion (10 s à 24 h)
  dashboardSessionTtlMs: 43200000,// durée d'une session navigateur (1 min à 30 j)
  controlSseMaxBufferedBytes: 4194304, // octets en attente au-delà desquels un client lent est coupé
  controlStateMaxDelayMs: 2000,   // délai max entre un changement et sa notification (300 à 60 000)

  // LLM du Router/Merger — Ollama local par défaut :
  ollamaModel: 'llama3.1:8b',
  ollamaHost: 'http://localhost:11434',
  prompts: { router: null, merger: null },
  llm: null,                      // ou { provider, model, … } — voir plus bas
  llmRoles: { router: null, merger: null, memory: null, judge: null },
  llmResilience: {},              // backoff + disjoncteur — voir plus bas
  tokens: {},                     // comptabilité, plafonds, optimisations — voir plus bas

  // Verrou, terminal, hooks, MCP :
  lock: { breakFrozenHolderAfterMs: null },
  pty: { replayBytes: 65536, clientQueueBytes: 4194304, killGraceMs: 1000,
         shell: 'auto', shellArgs: [] },
  terminal: { /* le lanceur de --open — voir « terminal » */ },
  hooks: { collisions: true, notifySessionEnd: true },
  mcp: { /* le serveur MCP — voir « mcp » */ },

  // Modes d'orchestration et collaboration entre agents :
  orchestration: { /* voir « orchestration et collab » */ },
  collab: { /* voir « orchestration et collab » */ },
};
```

## Clés inconnues : `unknownConfigKeys`

Une clé de premier niveau que Striart ne connaît pas (`testComand`,
`commitPolcy`…) est **refusée** au chargement : `CONFIG_INVALID`, sous-code
`UNKNOWN_KEY`, avec la clé et la suggestion la plus proche (« voulais-tu
`testCommand` ? »). Raison : une faute de frappe sur un réglage de sécurité
laisserait la protection visée à son défaut sans que personne le voie. Seule
`$schema` est admise sans validateur. `unknownConfigKeys: 'warn'` est le
relâchement explicite : la clé est ignorée, journalisée à chaque chargement,
et `striart doctor` l'affiche parmi les protections relâchées. Le validateur
ne contrôle pas la valeur de `unknownConfigKeys` lui-même : tout ce qui n'est
pas `'warn'` se comporte comme `'error'`.

## `secretPatterns` — les secrets des clones

Syntaxe **gitignore** : un motif sans `/` désigne le nom à toute profondeur ;
un `/` initial ou intermédiaire l'ancre à la racine ; un `/` final ne désigne
qu'un dossier ; `**`, `*`, `?` et `[...]` comme dans `.gitignore`. Les fichiers
**suivis** sont retirés du worktree d'un clone par le sparse-checkout, selon
l'ensemble que **git lui-même** calcule (`ls-files --exclude`) — jamais une
réimplémentation approximative ; l'historique est scanné avant tout clonage
(noms non ASCII et renommages compris) : un chemin qui a un jour existé sous
un de ces motifs refuse le clonage (`HISTORICAL_SECRETS_FOUND`). Sont
**refusés** (`SECRET_PATTERN_INVALID`) : la négation `!`, le commentaire `#`,
le motif vide et le saut de ligne. `secretPatterns: []` est un **relâchement**
explicite (plus d'exclusion ni de scan), affiché par `striart doctor`.

## Le LLM du Router/Merger

Le Router (prédiction de fichiers) et le Merger (fusion sémantique) passent
exclusivement par la couche provider `src/llm.js`. **Ollama local est le
défaut** (zéro coût, zéro réseau), mais n'importe quel LLM est utilisable :

```js
llm: { provider: 'ollama' | 'openai' | 'anthropic' | 'azure', model, baseUrl?, apiKeyEnv?, apiVersion? }
// llm: { provider: 'openai', model: 'gpt-4o-mini' },                       // clé via OPENAI_API_KEY
// llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },      // clé via ANTHROPIC_API_KEY
// llm: { provider: 'azure', model: '<deployment>', baseUrl: 'https://<ressource>.openai.azure.com' },
// llm: { provider: 'openai', model: 'x', baseUrl: 'http://localhost:1234/v1' }, // LM Studio, vLLM, llama.cpp...
```

**Tous les providers du marché sont supportés** — nativement (`ollama`,
`openai`, `anthropic`, `azure`) ou via leur endpoint compatible OpenAI :
Gemini, Mistral, Groq, DeepSeek, xAI, Together, Fireworks, OpenRouter,
Perplexity, Cohere, et en on-premise LM Studio, vLLM, llama.cpp, TGI.
AWS Bedrock et Google Vertex (auth SigV4/OAuth) passent par un proxy LiteLLM.
Le **[.env.example](../../.env.example)** documente la config exacte de
chacun.

Les clés API ne sont **jamais** dans la config : uniquement le nom d'une
variable d'environnement (`apiKeyEnv`), chargée depuis le shell ou un `.env`
à la **racine du dépôt** (une variable déjà définie dans le shell l'emporte).
`striart init` et `striart doctor` vérifient que la clé est présente (ou
qu'Ollama répond) — avertissement, jamais bloquant.

Le `.env` de la racine est une donnée **non fiable** (un dépôt cloné peut en
fournir un) : seules sont appliquées les variables d'une **liste blanche**
— les noms `*_API_KEY`, `STRIART_LANG`/`THEME`/`ASCII`/`NO_ANIMATION`,
`SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`, `INTERNAL_WEBHOOK_URL`,
`AZURE_OPENAI_ENDPOINT` —, et une liste noire (`NODE_*`, `LD_*`, `DYLD_*`,
`PATH*`, `HOME`, `GIT_*`, `*_PROXY`, `STRIART_NATIVE_BIN`,
`STRIART_CONFIG_HOME`…) l'emporte toujours. Les variables écartées sont
nommées sur stderr. Pour en admettre d'autres, la liste `env.allow` de la
[configuration utilisateur](#configuration-utilisateur-hors-du-dépôt) — la
liste noire reste non relâchable.

Deux gardes protègent la clé d'API d'un dépôt hostile, qui fournirait
`apiKeyEnv: 'GITHUB_TOKEN'` et un `baseUrl` à lui : `apiKeyEnv` doit avoir la
forme d'une clé (MAJUSCULES terminées par `_API_KEY`, `_KEY` ou `_TOKEN`) et
ne pas désigner un secret d'infrastructure (`GITHUB_*`, `NPM_*`, `AWS_*`,
`SSH_*`, `DOCKER_*`, `STRIART_*`…) ; la clé ne part qu'en HTTPS (la boucle
locale est exemptée). Refus : `LLM_CONFIG_INVALID`. Deux relâchements
explicites, affichés par `doctor` : `llm.allowAnyApiKeyEnv: true` et
`llm.allowInsecureTransport: true`. Un hôte qui n'est pas celui du
fournisseur est journalisé une fois (proxy légitime ou détournement).

### `llmRoles` — un LLM par rôle

`llmRoles: { router, merger, memory, judge }` donne à chaque rôle son propre
modèle ; chaque entrée est une spécification `llm` (mêmes champs) ou `null`
(= le bloc `llm` global, ou Ollama). Un modèle local peu coûteux pour le
Router et un modèle fort pour le Merger, par exemple. `judge` est le LLM qui
départage une course `race` (`pick: judge`). Seuls ces quatre rôles existent
(clé inconnue refusée) ; les relecteurs `review` sont des agents, pas des
rôles LLM de Striart.

### `llmResilience` — retries, backoff et disjoncteur

Tout appel LLM de Striart est retenté avec une **attente exponentielle à
gigue complète** et respecte `Retry-After` ; un **disjoncteur** par
fournisseur évite d'insister sur un service en panne. Seules les erreurs
transitoires sont retentées (réseau, délai, 408, 409, 425, 429, 5xx sauf
501/505) ; une erreur de configuration ou de requête (400, 401, 403, 404,
422) ne l'est jamais — la rejouer brûlerait du temps et des jetons pour le
même refus.

```js
llmResilience: {
  backoff: {
    baseMs: 500,            // 1 à 60 000 — attente de départ (tirée dans [0, min(maxMs, baseMs·2^n)])
    maxMs: 20000,           // 1 à 600 000 — plafond de l'attente
    maxRetryAfterMs: 60000, // 0 à 3 600 000 — au-delà, pas d'attente : échec franc
  },
  breaker: {
    enabled: true,          // false = relâchement (affiché par doctor, ligne « tokens »)
    failureThreshold: 5,    // 1 à 1000 — échecs retentables consécutifs avant ouverture
    cooldownMs: 30000,      // 100 à 3 600 000 — durée d'ouverture, puis UN appel sonde
  },
}
```

Le disjoncteur vit en mémoire du process (un `watch` ou un dashboard de longue
durée en profite, une CLI ponctuelle repart propre).

### Prompts surchargeables

`prompts.router` et `prompts.merger` remplacent **intégralement** les prompts
par défaut (`null` → défaut) — utile, par exemple, pour les réécrire en
anglais quand le modèle local est plus fiable en anglais. Les placeholders
sont **obligatoires et validés au chargement** :

- router : `{{task}}` + `{{files}}` ;
- merger : `{{file}}` + `{{base}}` + `{{ours}}` + `{{theirs}}` +
  `{{feedback}}` (le retry post-gate y injecte le log d'échec).

## Tokens : comptabilité, plafonds et économie (`tokens`)

Striart relève **chaque appel LLM** (Router, Merger, Memory, juge, relecture)
et chaque session d'agent dans un registre append-only `.striart/usage/`
(`striart usage`), sans jamais y écrire de prompt, de réponse ni de clé. Le
bloc `tokens` règle ce registre, les **plafonds** et les optimisations. C'est
un objet partiel fusionné en profondeur avec ces défauts ; une clé inconnue
est refusée.

```js
tokens: {
  accounting: true,            // false = relâchement : plus aucun relevé, budgets aveugles
  onAccountingError: 'warn',   // 'warn' | 'fail' — si le relevé ou la relecture des cumuls échoue (voir ci-dessous)
  retentionDays: 90,           // 1 à 3650 — rétention du registre (appliquée par striart prune)
  pricing: {},                 // AUCUN prix en dur — voir ci-dessous
  pricingStaleAfterDays: 90,   // 1 à 3650 — âge au-delà duquel doctor signale un prix périmé
  estimator: { safetyFactor: 1.15, charsPerToken: 3 },  // marge ≥ 1 (≤ 5) ; 1 à 8 car./jeton

  budgets: {                   // plafonds OPT-IN : null = aucun plafond
    enforcement: 'hard',       // 'hard' : refuse ; 'alert-only' : relâchement, n'alerte que
    warnAtRatio: 0.8,          // fraction d'un plafond qui déclenche l'alerte
    perCall:  { maxInputTokens: null, maxOutputTokens: null, maxTokens: null, maxCostUsd: null },
    perTask:  { maxTokens: null, maxCostUsd: null },
    perAgent: { maxTokens: null, maxCostUsd: null },
    perDay:   { maxTokens: null, maxCostUsd: null },   // jour UTC
    global:   { maxTokens: null, maxCostUsd: null },   // sur la rétention du registre
  },
  alerts: {                    // seuils absolus (alerte seule) tant qu'aucun plafond n'est posé
    callInputTokens: 150000, taskTokens: 20000000, dayTokens: 100000000,   // null = désactivé
  },

  router: {
    onBudgetExceeded: 'serialize',  // plafond atteint : 'serialize' (prudent) | 'fail'
    onTreeTruncated: 'serialize',   // plus de maxFiles fichiers : 'serialize' | 'predict' (relâchement)
    tree: { maxFiles: 50000, mode: 'auto',        // 'auto' | 'full' | 'compact'
            maxTreeTokens: 6000, importExpansion: true,
            exclude: [ /* node_modules, dist, build, coverage, vendor, *.min.js, *.map, images, archives… */ ] },
  },
  merger: { mode: 'auto',          // 'auto' (par régions au-delà du seuil) | 'full' | 'hunk'
            hunkThresholdChars: 16000, contextLines: 5, maxWindowTokens: 30000 },
  memory: { maxEntryChars: 1200, maxTotalChars: 12000, diffMaxChars: 8000, dedupe: true },
  promptCache: { enabled: true, ttl: '5m', minPrefixTokens: 1024 },   // Anthropic : cache_control
  cache: { enabled: true, roles: ['router', 'memory'], ttlMs: 600000, maxEntries: 200 },
  instructions: { mode: 'full' },  // 'full' | 'compact' : gabarit des consignes injectées
}
```

- **Les prix sont déclarés, jamais livrés** : un prix change sans prévenir et
  dépend du contrat. `pricing` mappe `provider:model` (ou `model`) vers
  `{ inputPerMTok, outputPerMTok, cacheReadPerMTok?, cacheWritePerMTok?, asOf }` ;
  `asOf` (AAAA-MM-JJ) est **obligatoire** — un prix non daté ne vaut rien — et
  `doctor` signale les prix plus vieux que `pricingStaleAfterDays`. Seule
  exception : un modèle Ollama local est compté à 0 USD.
- **Un plafond posé est tenu, fail closed.** Dépassé, l'appel LLM est refusé
  *avant* tout envoi (`TOKEN_BUDGET_EXCEEDED`, sortie 3) et une session
  d'agent est arrêtée proprement (`BUDGET_EXCEEDED`, clone conservé). Un
  plafond de **coût** sans prix déclaré pour le modèle ne peut pas être
  tenu : l'appel est refusé (`TOKEN_PRICE_MISSING`). Un refus de budget n'est
  pas un échec du LLM : il ne compte pas dans le mode manuel. `perCall`
  borne l'entrée estimée d'un appel et la sortie transmise au fournisseur ;
  une sortie coupée par `maxOutputTokens` est une **erreur franche**, jamais
  un texte tronqué silencieusement pris pour une fusion complète.
- **Une comptabilité qui échoue n'est jamais silencieuse.** Si l'écriture du
  registre d'usage ou la relecture des cumuls de budget échoue (disque,
  droits, antivirus), le journal reçoit un avertissement au code stable
  `TOKEN_ACCOUNTING_FAILED` (les budgets sont alors aveugles pour cet appel).
  `onAccountingError: 'warn'` (défaut) ne perd jamais la réponse d'un appel
  déjà payé ; `'fail'` refuse à la place d'avancer à l'aveugle : l'appel LLM
  dont le relevé échoue est rejeté et une session dont les cumuls sont
  illisibles ne démarre pas (`TOKEN_ACCOUNTING_FAILED`, échec — sortie 1).
  Les flux de session asynchrones (alertes, vidage final) ne font que
  journaliser.
- **Les relâchements** — `accounting: false`, `enforcement: 'alert-only'`
  avec un plafond posé, `'merger'` dans `cache.roles`, `router.onTreeTruncated:
  'predict'`, `llmResilience.breaker.enabled: false` — sont affichés par
  `doctor`. Resserrer (poser un plafond, `compact`) n'est pas un relâchement.
- **Optimisations** : le Merger ne soumet que les **régions en conflit** avec
  leur contexte quand un fichier dépasse `hunkThresholdChars`, et refuse
  (`MERGE_WINDOW_EXCEEDED`, ticket humain) un conflit plus grand que
  `maxWindowTokens` plutôt que de tronquer ; l'arbre du Router est classé par
  pertinence et résumé par dossier s'il déborde `maxTreeTokens` (une
  troncature à `maxFiles` est *déclarée*, jamais silencieuse) ; la Memory Layer
  dédoublonne ses puces. Le **cache de résultats** (`.striart/usage/cache/`)
  ne vaut que pour des sorties validées en aval (Router → collisions,
  Memory → advisory) ; le juge et la relecture, qui arbitrent, n'y entrent
  **jamais**.
- Un agent ne doit pas pouvoir désactiver ce garde-fou depuis la config du
  dépôt qu'il modifie : `tokens` vit dans la config du dépôt, qui est
  protégée par la garde des chemins protégés (un merge qui la change est
  refusé). Poser le plafond dans la *config utilisateur* n'est pas encore
  possible (voir la roadmap).

## Profils d'agents (`agentProfiles`)

Comment lancer chaque outil SANS interaction humaine (mode autonome). Par
défaut, la table contient les **20 presets prêts** du catalogue
(`striart profiles --catalog`), chacun configuré pour que l'outil puisse
réussir (éditer, commiter selon le contrat de commit) et neutralisant la
configuration d'agent apportée par le dépôt quand l'outil le permet :
`claude`, `claude-subscription`, `codex`, `gemini` (ACP), `copilot`,
`copilot-acp`, `cursor`, `opencode`, `opencode-acp`, `goose`, `goose-acp`,
`amp`, `kilo`, `kilo-acp`, `qwen`, `qwen-acp`, `cline`, `cline-acp`, `aider`
et `ollama`. Déclarer un profil **ajoute** un fournisseur sans effacer ceux
d'origine ; `{ preset: '<id>', … }` dérive un profil d'un preset (y compris
d'un preset **expérimental** : Gemini en argv, Junie, Junie ACP, Continue,
Warp Oz — qui n'entrent jamais dans les défauts et s'affichent comme
relâchement dans `doctor`). `{{prompt}}` est substitué comme **élément
d'argv** — jamais de shell, donc aucune injection possible depuis le texte
du prompt.

```js
agentProfiles: {
  // Preset dérivé : les champs donnés l'emportent sur ceux du preset.
  claude: { preset: 'claude-code', commitPolicy: 'human' },
  // Profil à la main (argv) : {{prompt}} OBLIGATOIRE dans args.
  mytool: { command: 'mytool', args: ['--yes', '--message', '{{prompt}}'] },
  // Profil ACP : {{prompt}} INTERDIT (le prompt passe par le protocole).
  'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
}
```

Champs d'un profil (tous validés, un champ inconnu ou invalide est refusé
avec son nom, `PROFILE_INVALID`) :

| Champ | Rôle |
|---|---|
| `command`, `args` | L'outil et son argv. `{{prompt}}` obligatoire en argv, interdit en ACP. Emplacements optionnels : `{{striartInstructions}}` (texte des consignes), `{{striartInstructionsFile}}` (chemin du fichier de consignes, hors du clone), `{{striartTestCommand}}` (commande du Test Gate). |
| `env` | Variables propres au profil, fusionnées par-dessus l'environnement (cloisonner une clé par outil). Depuis un `.mjs`, `env: { KEY: process.env.SOURCE }` — jamais un secret en clair. |
| `timeout` | Délai max de session (ms, 1000 à 2147483647). Précédence : `--timeout` > `profile.timeout` > `autonomousTimeoutMs`. |
| `preset`, `experimental` | Preset dont dérive le profil ; drapeau « non vérifié en documentation officielle ». |
| `writeMode` | `workspace` \| `read-only` \| `unrestricted` : ce que l'invocation permet d'écrire (déclaratif, affiché). |
| `commitPolicy`, `commitAuthor`, `commitMessage` | Contrat de commit **propre au profil** (voir ci-dessous). `commitAuthor` : `{ name?, email? }` ; défaut `<clé> (Striart agent) <<clé>.agent@striart.invalid>`. |
| `structuredOutput` | `none` \| `claude-stream-json` \| `codex-jsonl` \| `gemini-stream-json` \| `ndjson` : la sortie structurée de l'outil est transcrite lisiblement dans le log de session et alimente le relevé de tokens. Sans objet en ACP. |
| `instructions` | `{ channel, template, append, flag, encoding }` : canal de remise des consignes (`auto`, `acp-prompt`, `system-prompt-file`, `prompt`, `none`) et gabarit propres au profil. |
| `settingsFile` | `{ flag, json, claudeMdExcludes? }` : fichier de réglages de session écrit par Striart **hors du clone** (`.striart/logs/`) et passé à l'outil par `flag` (≤ 64 Kio). |
| `acp` | Transport ACP : `true` ou un objet (voir ci-dessous). |

Sans `env`, la session hérite de tout l'environnement du process — voir
[SECURITY.md](../../SECURITY.md). `striart profiles` liste les profils
configurés (noms d'`env`, jamais les valeurs), `--catalog` les presets,
`--detect` les outils installés.

### `agentProfiles.<nom>.acp` — le transport ACP

```js
acp: {
  permissions: 'allow',       // 'allow' | 'reject' | 'ask' — défaut 'allow' (voir ci-dessous)
  askTimeoutMs: 120000,       // 1 000 à 86 400 000 — délai d'arbitrage humain ('ask'), fail closed au-delà
  auth: { methodId: '…' },    // décision EXPLICITE d'authentifier ; jamais automatique (relâchement)
  persistentHost: true,       // session portée par un hôte détaché (Phase E, proxy IDE)
  bus: true,                  // l'hôte accepte les messages humains `@agent`
  terminal: true,             // ou { timeoutMs: 600000, outputByteLimit: 1000000, maxTerminals: 8 } ; false = désactivé
  fsReadMaxBytes: 4194304,    // 1 024 à 268 435 456 — plafond d'un fichier servi à fs/read_text_file (4 Mio)
  mcp: 'striart',             // 'striart' (MCP en lecture seule borné au clone) | 'none'
  elicitation: { form: true, url: false },   // seulement avec permissions: 'ask'
}
```

`allow` est le niveau de confiance des profils headless historiques :
l'isolation vient du clone et l'autorité du Test Gate, pas de la politique de
permission. `ask` est le mode **semi-autonome** : chaque permission, et
chaque question structurée de l'agent (élicitation), est arbitrée par
l'humain — dashboard, `striart api` ou éditeur — et refusée au délai. Une
élicitation demandée sans `ask` est refusée au chargement
(`ACP_ELICITATION_NEEDS_ASK`) : une capacité annoncée puis sans humain pour
répondre serait morte. Sont des relâchements (listés par `doctor`) :
`auth.methodId`, `elicitation.url`, et un `terminal` plus permissif que les
valeurs ci-dessus. Le client ACP de Striart gère `auth_required` (il s'arrête
sur `ACP_AUTH_REQUIRED` — il ne s'authentifie jamais de lui-même, sauf
`auth.methodId` posé), l'élicitation, les terminaux bornés au clone et les
fichiers bornés au clone (liens symboliques compris).

## `commitPolicy`, `commitMessage` — qui commite

`commitPolicy` décide qui commite le travail laissé par une session autonome
sortie `COMPLETED`, globalement et par profil :

| Valeur | Effet |
|---|---|
| `agent` (défaut) | L'agent seul ; il n'a rien commité → clone conservé (`NO_COMMIT`). |
| `agent-then-striart` | L'agent ; s'il n'a rien commité, Striart commite ce qu'il a laissé. |
| `striart` | Striart commite toujours le reste non commité. |
| `human` | Personne ne commite **ni ne merge** : clone conservé pour revue humaine. Si l'agent a commité malgré tout, le cycle rend `KEPT` / `HUMAN_REVIEW_REQUIRED` et ne merge **jamais** — dans tous les modes (cycle simple, modes orchestrés, proxy ACP) ; sortie 3 (rupture annoncée au CHANGELOG). |

Le commit Striart n'embarque jamais un fichier exclu (`secretPatterns`,
fichiers injectés par Striart, même suivis ou déjà indexés — revérifié sur le
commit produit), a pour **auteur** le profil d'agent et pour **committer**
l'identité git de l'utilisateur lue dans le dépôt principal
(`COMMITTER_IDENTITY_MISSING` sinon), et ne s'applique jamais à un clone dans
un état ambigu. `commitMessage` est le gabarit du message
(`striart({{agent}}): {{task}}` par défaut ; placeholders `{{agent}}`,
`{{profile}}`, `{{task}}`, `{{taskId}}`, `{{branch}}`, 4 000 caractères au
plus, sujet non vide) ; des *trailers* `Striart-*` sont toujours ajoutés et
le sujet n'est jamais confondu avec un merge Striart. Le preset `codex` a
`striart` pour défaut : le bac à sable de Codex rend `.git` en lecture seule,
l'agent ne peut pas commiter.

## `agentInstructions` — les consignes remises aux agents

Un agent lancé dans un clone ne sait rien de Striart. Striart lui remet donc
ses règles (clone isolé, seul le travail *commité* est intégré, Test Gate,
pas de push, pas de modification des fichiers d'agent, conventions de commit,
règles MCP, chemins protégés, canal de collaboration quand l'agent est dans
un groupe) par le canal adapté à l'outil. Fusion par clé avec ces défauts :

```js
agentInstructions: {
  enabled: true,              // false = relâchement : les agents ne reçoivent aucune règle
  template: null,             // gabarit complet de remplacement (≤ 32 Kio, placeholders connus seulement)
  append: null,               // texte ajouté à la fin du gabarit
  commitConvention: 'Conventional Commits — "<type>(<scope>): <summary>" …',
  agentsMd: 'override',       // 'override' | 'non-file' : que faire quand AGENTS.md existe
  attendedFiles: {},          // fichiers d'instructions par outil, en mode supervisé (chemins relatifs au clone)
  genericFiles: ['AGENTS.md'],// fichiers pour un outil non reconnu
  neutralizeParentInstructions: true,  // exclut les CLAUDE.md du dépôt principal hérités par le clone
}
```

Canaux : bloc en tête du prompt ACP ; fichier de consignes système hors du
clone (`--append-system-prompt-file`, `--read`…) ; enveloppe du prompt ; ou,
en supervisé, un **fichier non suivi** dans le clone, exclu par
`.git/info/exclude` *du clone*. Quand un `AGENTS.md` suivi existe,
`agentsMd: 'override'` dépose un `AGENTS.override.md` composite (pour les
outils qui le lisent, comme Codex) ; `'non-file'` ne touche à rien à côté
d'`AGENTS.md` et préfère un canal sans fichier. Placeholders du gabarit :
`{{agent}}`, `{{mode}}`, `{{tool}}`, `{{profile}}`, `{{branch}}`,
`{{targetBranch}}`, `{{testCommand}}`, `{{commitRules}}`,
`{{commitConvention}}`, `{{mcpRules}}`, `{{protectedPaths}}`, `{{extra}}`.
`tokens.instructions.mode: 'compact'` divise à peu près par trois le coût en
jetons du gabarit par défaut. Les consignes sont *advisory* : les
garde-fous (Test Gate, chemins protégés, garde MCP) décident, et un échec
d'injection est un avertissement, pas un refus.

## `protectedAgentPaths` — les chemins qu'un agent ne change jamais

Un agent qui modifie un fichier qui **instruit ou configure** les agents de
coding — `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude`, `.codex/`,
`.cursor/`, `.mcp.json`, `.vscode/settings.json` (auto-approbation, cf.
CVE-2025-53773), `.github/hooks/`, `opencode.json`… 81 motifs
vérifiés contre la documentation des outils — ou la **config de Striart**
(`striart.config.*`, `.striartrc*`, `.striart/`, y compris la clé `striart`
de `package.json`) voit son **merge refusé** : ticket `PROTECTED_PATHS_CHANGED`,
avant toute fusion LLM et avant le Test Gate. Ces fichiers sont relus par les
sessions *suivantes* avec la confiance qu'on accorde au dépôt : les laisser
passer transformerait une injection de prompt ponctuelle en compromission
persistante, ou désarmerait le Test Gate (un agent qui réécrit
`testCommand`). Le refus tombe sur un changement *effectif* (le contenu
apporté diffère de celui de la branche cible).

```js
protectedAgentPaths: {
  extend: [],               // motifs ajoutés (globs ancrés à la racine, séparateur /)
  allow: [],                // motifs RETIRÉS des défauts — relâchement journalisé à chaque merge
  matchCase: 'insensitive', // 'insensitive' (défaut) | 'platform' (sensible à la casse hors Windows/macOS : relâchement)
}
```

Motifs : `*` (tout sauf `/`), `?`, `**` en segment entier ; pas de classes
`[…]`, d'accolades ni de négation. `x/**` couvre `x` lui-même (même remplacé
par un fichier ou un sous-module) et tout son contenu. Un motif absolu, avec
`..` ou `\` est refusé au chargement.

Les défauts couvrent aussi les points d'**auto-exécution** : `.vscode/tasks.json`
(tâche `folderOpen`), `.devcontainer/` et `.devcontainer.json`, `.husky/`,
`.githooks/`, `.envrc`, `.pre-commit-config.yaml`, `lefthook.*`. La
comparaison est faite sur un chemin **normalisé** (NFKC, minuscules : `AGENTſ.md`
est `AGENTS.md`) et tout segment au format de nom court Windows (`CLAUDE~1.MD`)
est traité comme protégé. `package.json` ne peut pas l'être en entier : seule
la clé `striart` l'est — périmètre partiel assumé (un agent peut changer vos
scripts npm ; le Test Gate reste l'autorité).

## `acpRegistry` — l'import d'agents ACP

```js
acpRegistry: {
  url: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',  // https obligatoire
  allowBinaryDownload: false,   // true : `--import-acp` peut TÉLÉCHARGER un binaire (relâchement)
  allowEnv: [],                 // noms de variables d'environnement qu'un agent du registre peut poser
}
```

Par défaut **métadonnées seules**. Le téléchargement exige une version
épinglée, une empreinte sha256 publiée et vérifiée, une extraction sans lien
symbolique ni chemin sortant ; il est journalisé et affiché par `doctor`.

Un agent du registre peut demander des variables d'environnement (`env`).
Elles sont **refusées** (`ACP_IMPORT_ENV_FORBIDDEN`) sauf si leur nom figure
dans `allowEnv` — et **jamais** pour une variable d'interpréteur ou de
chargeur (`NODE_OPTIONS`, `PATH`, `LD_*`…), même listée : un registre ne
pose pas de code dans l'environnement d'une session.

## `acpAgent` — le proxy ACP (`striart acp`)

Réglages de `striart acp` ; objet partiel, ses clés remplacent celles des
défauts. Une clé inconnue est refusée (`CONFIG_INVALID`, champ
`acpAgent.<clé>`).

```js
acpAgent: {
  defaultProfile: null,          // profil amont proposé par défaut (null : le premier profil ACP par ordre alphabétique)
  profiles: null,                // liste blanche de profils proposés à l'IDE (null : tous les profils `acp: true`)
  permissions: 'ask',            // 'ask' | 'reject' | 'allow' | 'profile' — politique par défaut d'une session
  permissionChoices: ['ask', 'reject'],  // politiques que l'humain peut choisir depuis l'IDE
  askTimeoutMs: null,            // 1 000 à 86 400 000 ; null : celui du profil
  merge: 'auto',                 // 'auto' (merge sous Test Gate à la fin) | 'manual' (clone conservé)
  mergeChoice: true,             // l'humain peut basculer auto/manuel depuis l'IDE
  onDisconnect: 'keep',          // IDE fermé sans fin explicite : 'keep' (clone conservé) | 'finish' (relâchement)
  agentName: null,               // nom FIXE du clone (null : dérivé du premier prompt)
  reuse: false,                  // réhabilite une archive du même nom (exige agentName)
  collisionPolicy: 'fail',       // collision du Router au premier prompt : 'fail' | 'wait'
  collisionWaitMs: 600000,       // 1 000 à 86 400 000
  collisionPollMs: 2000,         // 100 à 600 000
  sessionTimeoutMs: 14400000,    // 60 000 à 7 jours — durée max d'une session (clone conservé au-delà)
  relayThoughts: true,           // relaie le raisonnement de l'agent (agent_thought_chunk)
}
```

Sont des relâchements : `permissions: 'allow'` (ou `'allow'` dans
`permissionChoices`), `'profile'` (la politique du profil amont s'applique,
`allow` par défaut), `onDisconnect: 'finish'`. La politique par défaut doit
figurer dans `permissionChoices` ; `reuse: true` exige `agentName`.

## `hooks` — les hooks advisory

```js
hooks: {
  collisions: true,        // signaler un fichier prédit/verrouillé par un autre agent
  notifySessionEnd: true,  // webhooks à la fin d'une session supervisée
}
```

Informatifs par construction : aucun réglage ne permet à un hook de Striart
de bloquer une action. Installation : `striart hook install`. La confiance
d'un hook dans la config d'un dépôt se règle dans la
[configuration utilisateur](#configuration-utilisateur-hors-du-dépôt).

## `terminal` — le lanceur de `--open`

```js
terminal: {
  launcher: 'auto',      // 'auto' | 'wt' | 'warp' | 'terminal-app' | 'iterm' | 'gnome-terminal'
                         // | 'konsole' | 'kitty' | 'wezterm' | 'alacritty' | 'custom'
  detectWarp: true,      // en 'auto' : TERM_PROGRAM=WarpTerminal → onglet Warp
  holdShell: 'bash',     // shell qui garde l'onglet ouvert (Linux, kitty…) — [A-Za-z0-9._/-], 200 car. max
  warp: {
    channel: 'auto',     // 'auto' (déduit de TERM_PROGRAM_VERSION) | 'stable' | 'preview'
    shell: null,         // 'pwsh' | 'bash' | 'zsh' | 'fish' (null : défaut de l'OS)
    newWindow: false,    // warp://tab_config/<nom>?new_window=true
    tabConfigDir: null,  // dossier tab_configs de Warp (chemin absolu ; null : emplacement documenté par OS)
  },
  custom: null,          // { command, args } — argv, JAMAIS un shell
}
```

`auto` garde le comportement historique (Windows Terminal si `WT_SESSION`,
sinon console PowerShell ; Terminal.app ; gnome-terminal) et reconnaît une
session Warp. Le lanceur `custom` reçoit son argv avec des placeholders
substitués *dans l'élément*, en un seul passage : `{{argv}}` (élément entier
uniquement — l'argv d'attache en plusieurs éléments), `{{posixCommand}}` /
`{{powershellCommand}}` (la même commande citée pour un shell POSIX /
PowerShell, à passer à un `-c`/`-Command`), `{{cwd}}`, `{{title}}`,
`{{agent}}`. L'un des trois premiers est obligatoire : sans lui l'onglet
s'ouvrirait sans jamais s'attacher à l'agent. Chaque lanceur est refusé
explicitement hors de sa plateforme (`TERMINAL_LAUNCHER_UNSUPPORTED`).
**Warp** n'exécute aucune commande par son schéma d'URI : Striart écrit une
*Tab Config* (`striart-<agent>-<empreinte>.toml`, mode 0600, volet unique
dans le clone, commande d'attache citée pour le shell choisi) et l'ouvre par
`warp://tab_config/<nom>`. Ce fichier est retiré par `striart stop` et
`striart clean` (`removeWarpTabConfig`, via la libération des artefacts de
l'agent) ; un échec de suppression est rapporté (avertissement
`AGENT_ARTIFACT_FAILED`), le fichier se retire alors à la main.

## `pty` — l'hôte de terminal natif

```js
pty: {
  replayBytes: 65536,        // sortie récente rejouée à un client qui s'attache (1 Kio à 16 Mio)
  clientQueueBytes: 4194304, // file d'un client au-delà de laquelle il est évincé (16 Kio à 256 Mio, ≥ replayBytes)
  killGraceMs: 1000,         // délai laissé au shell et à ses descendants à la fermeture (0 à 60 000)
  shell: 'auto',             // 'auto' | nom nu (PATH absolu seulement) | chemin absolu
  shellArgs: [],             // ≤ 64 arguments, chacun ≤ 4096 octets, sans saut de ligne ni NUL
}
```

`shell: 'auto'` = PowerShell sous Windows, `$SHELL` ou bash ailleurs. Un nom
nu est résolu dans les dossiers **absolus** du `PATH` seulement (jamais le
dossier courant), un chemin doit être absolu ; rien n'est passé à un shell
(argv). Priorité : commande explicite de l'agent > `pty.shell` > `auto` ;
aucun repli en cas d'échec (`PTY_SHELL_INVALID`). Choisir un exécutable dans
la config d'un dépôt est un relâchement (config-as-code) : `striart doctor`
l'affiche. Sous Windows PowerShell 5.1 charge vos profils à chaque
démarrage (lent, et refusé par une politique d'exécution stricte) : poser
`shellArgs: ['-NoLogo', '-NoProfile']`, ou `shell: 'pwsh'` (PowerShell 7 —
Striart ne le préfère pas automatiquement : le gain n'est pas démontré).

## `lock` — le verrou principal

```js
lock: { breakFrozenHolderAfterMs: null }   // null (défaut sûr) | entier ≥ 60 000
```

Un détenteur du verrou principal **vivant** dont le battement est figé
(process gelé : débogueur, `SIGSTOP`, boucle synchrone) n'est **jamais**
cassé par défaut : le casser laisserait deux process dans la section critique
à son dégel. L'attente se termine en `LOCK_TIMEOUT` (`HOLDER_FROZEN`) avec le
PID à arrêter. Un entier ≥ 60 000 ms autorise la cassure au-delà de ce délai
sans battement (après une observation active de 15 s, qu'une veille de la
machine ne fausse pas) : protection relâchée, **journalisée à chaque
cassure** et affichée par `striart doctor`.

## `mcp` — le serveur MCP

```js
mcp: {
  scope: 'agent',            // 'agent' (défaut) | 'orchestrator' (relâchement)
  apps: true,                // vue MCP Apps (lecture seule) du ticket 3-way
  tasks: true,               // extension Tasks pour les opérations longues (merge, apply, promote)
  taskTtlMs: 3600000,        // 60 000 à 7 jours — rétention d'une tâche terminée
  taskPollIntervalMs: 2000,  // 100 à 60 000 — cadence suggérée au client
  maxLineBytes: 1048576,     // 4 096 à 64 Mio — borne d'une requête JSON-RPC
  maxConcurrentRequests: 4,  // 1 à 64 — outils/lectures exécutés en parallèle
  maxQueuedRequests: 64,     // 0 à 4096 — en attente (refus « overloaded » au-delà)
}
```

`scope: 'agent'` : un serveur lancé depuis un clone (ou `--agent`) n'agit
que sur **son** agent ; hors clone il est en lecture seule. `'orchestrator'`
accorde, hors clone, `run`/`merge`/résolution sur tout le dépôt — jamais la
fermeture d'un ticket sans Test Gate ni l'arbitrage d'une permission, à aucun
niveau. Voir [Serveur MCP](mcp.md).

## `orchestration` et `collab` — modes d'orchestration, collaboration

Objets partiels, fusionnés en profondeur avec ces défauts (clé inconnue
refusée). Ils règlent `striart plan` (version 2) et `striart orchestrate`.

```js
orchestration: {
  concurrency: 2,            // tâches simultanées d'un plan `parallel` (≤ maxConcurrency)
  maxConcurrency: 8,         // plafond dur (1 à 64)
  onFailure: 'stop',         // 'stop' (rien ne démarre plus) | 'skip-dependents'
  collisionPolicy: 'wait',   // collision du Router : 'wait' (attente bornée) | 'fail'
  pollIntervalMs: 2000,      // 100 à 60 000
  waitTimeoutMs: 86400000,   // 1 000 à 30 j — attente d'une dépendance ou d'une collision (fail closed)
  keepRuns: 50,              // 1 à 10 000 — états de plans/groupes terminés conservés
  review: { maxRounds: 3,            // 1 à 10 tours de correction
            verdictRetries: 1,       // 0 à 3 nouvelles demandes d'un verdict absent/invalide
            quorum: 'all',           // 'all' | 'any' | 'majority'
            reviewerWrites: 'fail',  // 'fail' | 'discard' (relâchement : écritures du relecteur annulées)
            humanTimeoutMs: 86400000 // 60 000 à 30 j — délai d'un relecteur humain (fail closed)
          },
  race: { pick: 'first-green',       // 'first-green' | 'smallest-diff' | 'judge'
          losers: 'keep',            // 'keep' | 'archive' | 'clean' (relâchement : supprimés avec leur travail)
          maxCandidates: 5,          // 2 à 10
          judgeFallback: 'fail' },   // 'fail' | 'first-green' si le juge échoue
  team: { cadence: 'turns',          // 'turns' (un écrivain à la fois) | 'parallel' (partition statique)
          rounds: 1, maxRounds: 10,  // 1 à 10
          onScopeViolation: 'fail' },// 'fail' | 'warn'
  pipeline: { handoff: 'merge' },    // 'merge' (chaque étape mergée) | 'clone' (un seul merge)
},
collab: {
  enabled: true,             // false : plus de messages libres (les modes restent)
  maxMessages: 200,          // 1 à 10 000 par groupe
  maxBodyBytes: 8192,        // 256 à 262 144 par message
  maxMessagesPerSender: 50,  // 1 à 10 000
  inboxFile: true,           // `.striart-inbox.md` livré dans le clone
  outboxFile: true,          // `.striart-outbox.json` lu à la fin du tour
  maxOutboxBytes: 65536,     // 1 024 à 4 Mio
  briefingMaxChars: 12000,   // 1 000 à 24 000 — briefing de relais/tour
  logMarkers: true,
},
```

Défauts sûrs : un échec arrête tout ce qui n'a pas démarré, les perdants
d'une course sont conservés, un relecteur qui écrit fait échouer la relecture.
Les relâchements (`race.losers: 'clean'`, `review.reviewerWrites: 'discard'`)
sont affichés par `doctor`. La partition **dynamique** (`team.cadence:
'dynamic'`) n'existe pas : elle est refusée à la validation
(`CADENCE_UNAVAILABLE`) tant que l'arbitrage des écritures n'est pas branché.
Détail des modes : [Modes d'exécution](modes-execution.md#les-modes-dorchestration).

## Dashboard et Control Protocol

`dashboardPort` (3456) est le port par défaut. Le dashboard n'écoute que sur
`127.0.0.1` et exige une session obtenue par un **lien à usage unique**
(`dashboardLinkTtlMs`, 10 s à 24 h) ; le cookie de session vit
`dashboardSessionTtlMs` (1 min à 30 jours). `controlSseMaxBufferedBytes`
(64 Kio à 256 Mio) est le volume en attente au-delà duquel un client SSE trop
lent est déconnecté (il se reconnecte et reçoit l'état complet) ;
`controlStateMaxDelayMs` (300 ms à 60 s) borne le délai entre un changement
et sa notification.

`dashboardHostname` (`'instance'` par défaut) : le dashboard est servi sous
`http://<id-aléatoire>.localhost:<port>`, un nom tiré à chaque démarrage et
résolu en boucle locale par les navigateurs. Pourquoi : un cookie n'est pas
isolé par port (RFC 6265 §8.5) — sous `localhost`, le navigateur renverrait le
cookie de session à tout serveur `localhost:*`, par exemple le serveur de
développement d'un agent qui pourrait le rejouer. Sous un nom propre à
l'instance, il n'est jamais envoyé ailleurs, et l'adresse `localhost`
« nue » n'est **plus servie** (403 `Host` non local, hors
`dashboardAllowedHosts`). Le lien de connexion affiché porte ce nom.
`'localhost'` est un relâchement (config-as-code) : journalisé à chaque
démarrage et affiché par `doctor` ; à réserver à un navigateur qui ne résout
pas `*.localhost`.

`dashboardAllowedHosts` (vide par défaut) admet des en-têtes `Host`
**supplémentaires** : derrière un tunnel web (Codespaces `*.app.github.dev`,
proxy inverse d'entreprise), le navigateur envoie le nom public. Motifs
stricts : nom exact (`striart.example.com`), joker en tête d'un seul niveau
sous un suffixe d'au moins deux étiquettes (`*.app.github.dev`), IPv4 privée
ou de bouclage exacte, port facultatif ; refusés : `*`, `*.com`, joker
ailleurs, plusieurs jokers, IP publique, IPv6, schéma, chemin, identifiants.
Ce réglage **ne relâche que** le contrôle `Host` : jeton, cookie
`SameSite=Strict`, `Sec-Fetch-Site`, `Origin` et anti-CSRF restent exigés. Il
est journalisé à chaque démarrage du dashboard et affiché par `doctor`.

## Test Gate : conteneur de process

Le Test Gate (`testCommand`, `promoteTestCommand`) s'exécute par défaut
dans le **conteneur de process natif** (`striart-native job run` : Job
Object sous Windows, groupe + subreaper sous Linux).

- `testTimeoutMs` (600 000, de 1 000 à 2 147 483 647) : au-delà, l'arbre est tué et le gate
  est rouge.
- `gateOrphanGraceMs` (2 000, de 0 à 600 000) : à la sortie de la commande,
  ses descendants ont ce délai pour finir seuls. Un descendant encore vivant
  est un **orphelin** : il est tué et le gate est **rouge**
  (`GATE_ORPHAN_PROCESS`) **même si la commande a rendu 0** — un test qui
  laisse un process derrière lui fuit, ce n'est pas un succès.
- `gateMaxOutputBytes` (100 Mio, de 1 Kio à 1 Gio) : plafond du journal
  conservé ; la **fin** de la sortie est gardée, le reste écarté (le
  résultat porte `truncated`).
- `gateContainer` : `'native'` (défaut) ou `'process'`. Sans binaire natif
  sain, le gate **n'est pas exécuté** et rend rouge
  `GATE_NATIVE_UNAVAILABLE` (fail closed). `'process'` est le relâchement
  explicite : exécution classique, arbre tué au délai seulement, **aucune
  détection d'orphelins**.

Le gate est rouge aussi si le nettoyage du conteneur est incomplet
(`JOB_TERMINATE_INCOMPLETE`).

## Journaux

`logMaxBytes` (10 Mio par défaut, 64 Kio à 1 Gio) et `logGenerations` (5, de
1 à 100) règlent la rotation par taille des journaux longs (`watch.log`,
`dashboard.log`, `watch-ui.log`) : au-delà, le journal devient `<nom>.log.1`,
puis `.log.2`… la plus ancienne génération étant supprimée.
`STRIART_LOG_LEVEL` règle la verbosité des journaux de la CLI (stderr).

## Notifications

Deux mécanismes cumulables, best-effort (un webhook en panne ne bloque
jamais l'orchestration) :

- `webhookUrl` — canal unique historique, le type (Slack/Discord) est deviné
  par l'URL ;
- `notifiers` — table multi-canaux au type explicite (`slack` → `{text}`,
  `discord` → `{content}`, `generic` → `{message}`). L'URL vient de `url` ou
  de `urlEnv` (nom d'une variable d'env — préférable : une URL de webhook est
  un secret), jamais des deux.

## Configuration utilisateur (hors du dépôt)

Certains réglages **élargissent l'exécution de code** ; ils ne peuvent pas
vivre dans la config d'un dépôt, qu'un dépôt hostile fournirait. Ils
tiennent dans un fichier JSON **utilisateur**, de données seules (jamais
exécuté), à l'emplacement :

- `$STRIART_CONFIG_HOME/config.json` s'il est défini (chemin absolu) ;
- sinon `%APPDATA%\striart\config.json` (Windows) ;
- sinon `${XDG_CONFIG_HOME:-~/.config}/striart/config.json` (Linux, macOS).

```json
{
  "hooks":  { "trustedRoots": ["/chemin/absolu/du/depot"] },
  "env":    { "allow": ["MON_FOURNISSEUR_*", "*_SECRET_ID"] },
  "native": { "trustedKeyIds": ["0123456789ABCDEF"] }
}
```

`hooks.trustedRoots` (256 racines au plus, chemins absolus, jamais la racine
du système de fichiers) liste les dépôts dont un hook installé pour
l'utilisateur peut charger la config **complète** — y compris un
`striart.config.mjs` exécutable ; ailleurs, le hook ne lit que les configs en
données. Toute anomalie (JSON invalide, clé inconnue, fichier modifiable par
le groupe ou les autres sous POSIX — `chmod 600`) donne **aucune confiance**
(fail closed) et un avertissement (`USER_CONFIG_INVALID`,
`USER_CONFIG_UNSAFE`). Chaque usage est journalisé et `doctor` affiche les
racines de confiance.

- `env.allow` (128 motifs au plus) : noms de variables que le `.env` de la
  racine d'un dépôt peut ajouter à l'environnement **en plus** de la liste
  blanche intégrée. Forme : un nom en MAJUSCULES, `PREFIXE_*` ou
  `*_SUFFIXE`. Un motif qui vise une variable de la liste noire (`NODE_*`,
  `LD_*`, `PATH`…) est refusé : la liste noire n'est jamais relâchable.
- `native.trustedKeyIds` (16 au plus) : identifiants de clés de signature
  (minisign, 16 chiffres hexadécimaux **majuscules** ; celui du binaire en
  usage est affiché par `doctor`) acceptés **en plus** de la clé épinglée dans le code pour
  vérifier le binaire natif — pour une organisation qui re-signe ses
  propres archives.

Les trois blocs élargissent l'exécution de code ou la confiance : c'est la
raison de leur place hors du dépôt. `doctor` affiche `env.allow` et
`hooks.trustedRoots` parmi les relâchements.

## Variables d'environnement

| Variable | Effet |
|---|---|
| `STRIART_LANG`, `STRIART_THEME`, `NO_COLOR`, `STRIART_ASCII`… | Affichage de la CLI — voir [Commandes](commandes.md#langue-couleurs-terminal). |
| `STRIART_LOG_LEVEL` | Verbosité des journaux (stderr). |
| `STRIART_CONFIG_HOME` | Dossier de la configuration utilisateur (chemin absolu). |
| `STRIART_NATIVE_BIN` | Chemin **absolu** d'un binaire natif construit à la main. Choix assumé : son intégrité n'est **pas** vérifiée, `doctor` le signale. |
| `STRIART_HOOK_BIN_DIR` | Dossier sans espace où `hook install` écrit le lanceur Windows `.cmd`. |
| `STRIART_SESSION=1` | Posé par Striart dans les sessions autonomes : garde de profondeur du MCP, refus du Control Protocol. Non surchargeable par un profil. |

## Voir aussi

- [Branches et pipeline](branches.md) — `targetBranch`, `mainBranch`,
  `autoPush` en détail, avec des exemples `dev`/`master`.
- [Modes d'exécution](modes-execution.md) — `agentProfiles`, ACP,
  `autonomousTimeoutMs`, modes d'orchestration.
- [Projets volumineux](projets-volumineux.md) — `cloneFilter`, `pruneDays`.
- [Dépannage](depannage.md) — chaque code d'erreur, dont ceux de la config.
