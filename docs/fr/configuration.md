# Configuration

> [Documentation](README.md) · Configuration

La config est chargée par cosmiconfig : `striart.config.mjs` (généré par
`striart init`, recommandé — ESM explicite, fonctionne même si le repo cible
est en CommonJS), mais aussi `striart.config.js`, `.striartrc.json`,
`.striartrc.yaml`… Elle est validée au chargement : une valeur invalide est
refusée avec son motif, jamais dégradée en silence.

Tout a un défaut raisonnable — la config minimale tient en trois lignes :

```js
export default {
  testCommand: 'npm test',   // la commande du Test Gate — le seul réglage vraiment portant
  targetBranch: 'main',      // branche où merger — 'master', 'dev'… fonctionnent aussi
};
```

## Référence complète commentée

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
  semanticGateRetries: 1,         // retentatives du Merger avec le log du gate en feedback
  secretPatterns: ['.env', '.env.*', '*.pem', '*.key', 'credentials.json'],
                                  // secrets TRACKÉS retirés du worktree des clones ([] = off)
  memoryLayer: false,             // mémoire sémantique partagée entre agents (résumé LLM par merge)
  memoryMaxEntries: 30,           // taille max de .striart/memory.md (entrées les plus récentes)
  presenceMinutes: 10,            // un clone dont le disque a bougé depuis moins de N minutes
                                  // est réputé occupé : striart clean le saute (règle d'or n°3)
  agentCommand: null,             // outil affiché après start/run — null → 'claude' en exemple
                                  // (surchargeable par agent via --command)

  // Mode autonome : comment lancer chaque outil SANS interaction humaine.
  // {{prompt}} est substitué comme élément d'argv (jamais via un shell).
  // Déclarer un profil AJOUTE un fournisseur, sans effacer ceux d'origine.
  // `striart profiles` liste les profils configurés (outil, env, timeout).
  agentProfiles: {
    claude: { command: 'claude', args: ['-p', '{{prompt}}'] },
    codex:  { command: 'codex',  args: ['exec', '{{prompt}}'] },
    aider:  { command: 'aider',  args: ['--yes', '--message', '{{prompt}}'] },
    ollama: { command: 'ollama', args: ['run', 'qwen2.5-coder', '{{prompt}}'] },
    // Champs optionnels par profil — pour un vrai multi-IA :
    //   env     : variables PROPRES à ce profil, fusionnées par-dessus
    //             l'environnement (cloisonner une clé par outil, fixer MODEL…).
    //             Depuis un .mjs, référence un secret sans l'inliner :
    //             env: { OPENAI_API_KEY: process.env.MON_OPENAI }
    //   timeout : délai max de session (ms) — précédence :
    //             --timeout > profile.timeout > autonomousTimeoutMs
    //   acp     : transport ACP (Agent Client Protocol) — Striart dialogue
    //             avec l'outil en JSON-RPC stdio au lieu de l'argv. `true` ou
    //             { permissions: 'allow' | 'reject' | 'ask', askTimeoutMs? }.
    //             'ask' = SEMI-AUTONOME : chaque permission est arbitrée par
    //             l'humain au dashboard, fail closed au délai (défaut 120 s).
    //             Avec acp, args ne contient PAS {{prompt}} (le prompt passe
    //             par le protocole).
    // codex: { command: 'codex', args: ['exec', '{{prompt}}'],
    //          env: { OPENAI_API_KEY: process.env.MON_OPENAI }, timeout: 1800000 },
    // 'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  },
  autonomousTimeoutMs: 1800000,   // délai max d'une session autonome (kill de l'arbre au-delà)
  webhookUrl: null,               // canal unique historique (type deviné par l'URL)
  // Table multi-canaux — s'ajoute à webhookUrl. Le type est explicite
  // (slack → {text}, discord → {content}, generic → {message}) ; l'URL vient
  // de `url` ou de `urlEnv` (nom d'une variable d'env — préférable, une URL
  // de webhook est un secret), jamais des deux.
  notifiers: [],                  // ex: [{ type: 'slack', urlEnv: 'SLACK_WEBHOOK_URL' }]
  dashboardPort: 3456,
  testTimeoutMs: 600000,          // délai max du Test Gate (kill de l'arbre de process au-delà)
  fetchIntervalMs: 20000,         // fetch silencieux du watch (0 = désactivé)
  cloneFilter: null,              // 'blob:none' : clone partiel pour les très gros historiques
  pruneDays: 14,                  // rétention de striart prune (clones arrêtés, tickets résolus)

  // LLM du Router/Merger — Ollama local par défaut :
  ollamaModel: 'llama3.1:8b',
  ollamaHost: 'http://localhost:11434',
  // Prompts du Router/Merger surchargeables intégralement (null → défaut) —
  // ex: les réécrire en anglais pour un modèle local plus fiable en anglais.
  // Placeholders OBLIGATOIRES (validés au chargement) : router {{task}}+{{files}} ;
  // merger {{file}}+{{base}}+{{ours}}+{{theirs}}+{{feedback}} (retry post-gate).
  prompts: { router: null, merger: null },
  // ...ou n'importe quel provider :
  // llm: { provider: 'openai', model: 'gpt-4o-mini' },                       // clé via OPENAI_API_KEY
  // llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },      // clé via ANTHROPIC_API_KEY
  // llm: { provider: 'azure', model: '<deployment>', baseUrl: 'https://<ressource>.openai.azure.com' },
  // llm: { provider: 'openai', model: 'x', baseUrl: 'http://localhost:1234/v1' }, // LM Studio, vLLM, llama.cpp...
};
```

## Le LLM du Router/Merger

Le Router (prédiction de fichiers) et le Merger (fusion sémantique) passent
exclusivement par la couche provider `src/llm.js`. **Ollama local est le
défaut** (zéro coût, zéro réseau), mais n'importe quel LLM est utilisable :

```js
llm: { provider: 'ollama' | 'openai' | 'anthropic' | 'azure', model, baseUrl?, apiKeyEnv?, apiVersion? }
```

**Tous les providers du marché sont supportés** — nativement (`ollama`,
`openai`, `anthropic`, `azure`) ou via leur endpoint compatible OpenAI :
Gemini, Mistral, Groq, DeepSeek, xAI, Together, Fireworks, OpenRouter,
Perplexity, Cohere, et en on-premise LM Studio, vLLM, llama.cpp, TGI.
AWS Bedrock et Google Vertex (auth SigV4/OAuth) passent par un proxy LiteLLM.
Le **[.env.example](../../.env.example)** documente la config exacte de
chacun.

Les clés API ne sont **jamais** dans la config : uniquement le nom d'une
variable d'environnement (`apiKeyEnv`), chargée depuis le shell ou un `.env`.
`striart init` et `striart doctor` vérifient que la clé est présente (ou
qu'Ollama répond) — avertissement, jamais bloquant.

### Prompts surchargeables

`prompts.router` et `prompts.merger` remplacent **intégralement** les prompts
par défaut (`null` → défaut) — utile, par exemple, pour les réécrire en
anglais quand le modèle local est plus fiable en anglais. Les placeholders
sont **obligatoires et validés au chargement** :

- router : `{{task}}` + `{{files}}` ;
- merger : `{{file}}` + `{{base}}` + `{{ours}}` + `{{theirs}}` +
  `{{feedback}}` (le retry post-gate y injecte le log d'échec).

## Notifications

Deux mécanismes cumulables, best-effort (un webhook en panne ne bloque
jamais l'orchestration) :

- `webhookUrl` — canal unique historique, le type (Slack/Discord) est deviné
  par l'URL ;
- `notifiers` — table multi-canaux au type explicite (`slack` → `{text}`,
  `discord` → `{content}`, `generic` → `{message}`). L'URL vient de `url` ou
  de `urlEnv` (nom d'une variable d'env — préférable : une URL de webhook est
  un secret), jamais des deux.

## Voir aussi

- [Branches et pipeline](branches.md) — `targetBranch`, `mainBranch`,
  `autoPush` en détail, avec des exemples `dev`/`master`.
- [Modes d'exécution](modes-execution.md) — `agentProfiles`, ACP,
  `autonomousTimeoutMs`.
- [Projets volumineux](projets-volumineux.md) — `cloneFilter`, `pruneDays`.
