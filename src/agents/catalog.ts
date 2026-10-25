/**
 * Catalogue des presets d'outils de coding (lot I4) — données pures, sans
 * dépendance : importé par config.js au chargement de toute commande.
 *
 * Chaque preset décrit comment lancer UN outil en mode non interactif dans un
 * clone Striart pour qu'il puisse RÉUSSIR (éditer, et commiter si le contrat
 * le prévoit), en neutralisant la configuration d'agent apportée par le dépôt
 * quand l'outil le permet (hooks, serveurs MCP, réglages de projet), et
 * comment lui remettre les consignes Striart (src/agents/instructions.ts).
 *
 * Sources : documentation officielle de chaque outil, vérifiée le 2026-10-24
 * (URL dans `docs`). Un preset dont l'invocation non interactive, le mode
 * d'écriture ou la neutralisation n'ont pas pu être vérifiés en doc officielle
 * est marqué `status: 'experimental'` : il n'entre PAS dans les profils par
 * défaut, et l'utilisateur doit le déclarer lui-même (`{ preset: '<id>' }`).
 */
import type {
  CommitPolicy,
  AgentInstructionsSpec,
  AgentProfile,
  AgentWriteMode,
  StructuredOutputFormat,
} from '../types.js';
import { PROMPT_PLACEHOLDER } from './profile-schema.ts';

export type PresetStatus = 'ready' | 'experimental';

export interface PresetBuildOptions {
  commitPolicy: CommitPolicy;
}

export interface AgentPreset {
  /** Identifiant stable du catalogue (`{ preset: '<id>' }` en config). */
  id: string;
  /** Clé de profil par défaut (DEFAULT_CONFIG.agentProfiles) pour un preset prêt. */
  profileKey: string;
  label: string;
  status: PresetStatus;
  /** Pages de documentation officielle qui fondent l'invocation. */
  docs: readonly string[];
  /** Binaires candidats (le premier est la commande du profil). */
  binaries: readonly string[];
  versionArgs?: readonly string[];
  minVersion?: string | null;
  transport: 'argv' | 'acp';
  writeMode: AgentWriteMode;
  /** Contrat de commit par défaut, cohérent avec ce que l'invocation permet. */
  commitPolicy: CommitPolicy;
  structuredOutput: StructuredOutputFormat;
  instructions: AgentInstructionsSpec;
  /** Arguments selon le contrat de commit (marqueur {{prompt}} en argv). */
  args: (options: PresetBuildOptions) => string[];
  env?: Readonly<Record<string, string>>;
  /** Fichier de réglages de session écrit par Striart hors du clone. */
  settingsFile?: AgentProfile['settingsFile'];
  /**
   * Mode supervisé : fichiers d'instructions que l'outil lit, par ordre de
   * préférence, relatifs au clone. Vide = l'outil n'en charge aucun
   * automatiquement (un avertissement le dit).
   */
  attendedFiles: readonly string[];
  /** L'outil lit AGENTS.override.md à la place d'AGENTS.md (Codex). */
  readsAgentsOverride?: boolean;
  /** L'outil concatène les CLAUDE.md des dossiers parents (Claude Code). */
  claudeMdExcludes?: boolean;
  /** Réserves vérifiées ou points non vérifiables, en clair. */
  notes: readonly string[];
}

/** Commit autorisé à l'agent par le contrat ? */
const agentMayCommit = (policy: CommitPolicy) =>
  policy === 'agent' || policy === 'agent-then-striart';

const CLAUDE_DOCS = [
  'https://code.claude.com/docs/en/headless',
  'https://code.claude.com/docs/en/cli-reference',
  'https://code.claude.com/docs/en/permissions',
  'https://code.claude.com/docs/en/permission-modes',
  'https://code.claude.com/docs/en/memory',
];

/** Règles Bash de Claude Code : commit selon le contrat, Test Gate, jamais push. */
function claudeToolRules(commitPolicy: CommitPolicy): string[] {
  const allow = ['Bash({{striartTestCommand}})', 'Bash({{striartTestCommand}} *)'];
  if (agentMayCommit(commitPolicy)) allow.push('Bash(git add *)', 'Bash(git commit *)');
  return [
    '--allowedTools',
    allow.join(','),
    // Deny l'emporte toujours sur allow — mais n'est PAS une frontière de
    // sécurité (`git -C . push` y échappe, doc permissions) : la vraie
    // garantie reste le clone sans remote `origin` (décision n°2).
    '--disallowedTools',
    'Bash(git push *)',
  ];
}

export const PRESETS: readonly AgentPreset[] = Object.freeze([
  {
    id: 'claude-code',
    profileKey: 'claude',
    label: 'Claude Code',
    status: 'ready',
    docs: CLAUDE_DOCS,
    binaries: ['claude'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent',
    structuredOutput: 'claude-stream-json',
    instructions: { channel: 'system-prompt-file', flag: '--append-system-prompt-file' },
    // `-p` seul démarre en mode Manual depuis 2.1.302 : éditions et commit
    // refusés, la session ne peut pas réussir. acceptEdits + règles Bash.
    // `--bare` : ni hooks, ni .mcp.json, ni CLAUDE.md auto-découverts (dont
    // ceux du worktree PRINCIPAL, parents du clone) ; `--setting-sources
    // user` : le bloc `env` et les helpers (`apiKeyHelper`) des réglages du
    // DÉPÔT ne s'appliquent pas non plus (--bare ne les neutralise pas).
    args: ({ commitPolicy }) => [
      '--bare',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      ...claudeToolRules(commitPolicy),
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      PROMPT_PLACEHOLDER,
    ],
    attendedFiles: ['.claude/rules/striart.md'],
    claudeMdExcludes: true,
    notes: [
      '--bare never reads OAuth or the keychain: it needs ANTHROPIC_API_KEY (or Bedrock/Vertex credentials). Subscription users: preset "claude-code-subscription".',
      'With --bare the clone CLAUDE.md is not auto-loaded either; the Striart rules ask the agent to read the project instruction files.',
    ],
  },
  {
    id: 'claude-code-subscription',
    profileKey: 'claude-subscription',
    label: 'Claude Code (subscription login)',
    status: 'ready',
    docs: CLAUDE_DOCS,
    binaries: ['claude'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent',
    structuredOutput: 'claude-stream-json',
    instructions: { channel: 'system-prompt-file', flag: '--append-system-prompt-file' },
    // Sans --bare (OAuth utilisable) : réglages du dépôt ignorés
    // (--setting-sources user : ni settings projet ni .mcp.json), MCP strict,
    // hooks coupés et CLAUDE.md du worktree principal exclus par un fichier
    // --settings écrit par Striart hors du clone.
    args: ({ commitPolicy }) => [
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      ...claudeToolRules(commitPolicy),
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      PROMPT_PLACEHOLDER,
    ],
    settingsFile: {
      flag: '--settings',
      json: { disableAllHooks: true },
      claudeMdExcludes: true,
    },
    attendedFiles: ['.claude/rules/striart.md'],
    claudeMdExcludes: true,
    notes: [
      'disableAllHooks also disables your user-level hooks for these sessions (fail closed for unattended runs).',
    ],
  },
  {
    id: 'codex',
    profileKey: 'codex',
    label: 'OpenAI Codex CLI',
    status: 'ready',
    docs: [
      'https://learn.chatgpt.com/docs/non-interactive-mode',
      'https://learn.chatgpt.com/docs/cli/reference',
      'https://learn.chatgpt.com/docs/agent-approvals-security.md',
      'https://learn.chatgpt.com/docs/agent-configuration/agents-md.md',
      'https://learn.chatgpt.com/docs/config-file/config-reference.md',
    ],
    binaries: ['codex'],
    transport: 'argv',
    writeMode: 'workspace',
    // workspace-write protège `.git` en lecture seule : l'agent ne PEUT pas
    // commiter. Striart committe le worktree en fin de session.
    commitPolicy: 'striart',
    structuredOutput: 'codex-jsonl',
    instructions: { channel: 'prompt', encoding: 'toml-string' },
    // `codex exec` seul est en lecture seule ; --full-auto n'existe plus.
    // Codex ne lit l'AGENTS.md qu'à partir de la racine git (le clone) : le
    // worktree principal n'est pas atteint. `.codex/` du dépôt : chargé
    // seulement si le projet est approuvé (un clone neuf ne l'est pas).
    args: () => [
      'exec',
      '--sandbox',
      'workspace-write',
      '--ephemeral',
      '--json',
      '-c',
      'developer_instructions={{striartInstructions}}',
      PROMPT_PLACEHOLDER,
    ],
    attendedFiles: ['AGENTS.md'],
    readsAgentsOverride: true,
    notes: [
      'The sandbox makes .git read-only: commitPolicy "agent" cannot succeed with this preset (default "striart").',
      'Network is off in workspace-write: dependency installs inside the session fail unless you allow it in your Codex config.',
    ],
  },
  {
    id: 'gemini-acp',
    profileKey: 'gemini',
    label: 'Gemini CLI (ACP)',
    status: 'ready',
    docs: [
      'https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md',
      'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    ],
    binaries: ['gemini'],
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    // Les permissions passent par le protocole (politique du profil) et le
    // fs ACP est borné au clone par Striart. `-e none` : aucune extension.
    args: () => ['--acp', '-e', 'none'],
    attendedFiles: ['GEMINI.md'],
    notes: [
      'GEMINI.md discovery stops at the clone .git: the main worktree is not read.',
      'Gemini CLI was replaced by Antigravity CLI for unpaid tiers on 2026-06-18.',
    ],
  },
  {
    id: 'copilot',
    profileKey: 'copilot',
    label: 'GitHub Copilot CLI',
    status: 'ready',
    docs: [
      'https://docs.github.com/en/copilot/reference/cli-command-reference',
      'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference',
    ],
    binaries: ['copilot'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'ndjson',
    instructions: { channel: 'prompt' },
    // Deny prime sur allow même avec --allow-all-tools (doc). Les hooks du
    // dépôt, le MCP de l'espace de travail et les extensions de projet sont
    // désactivés en mode prompt par défaut — ne JAMAIS poser
    // COPILOT_ALLOW_ALL (qui approuverait le dossier).
    args: () => [
      '--allow-all-tools',
      '--deny-tool',
      'shell(git push)',
      '--no-ask-user',
      '--disable-builtin-mcps',
      '--no-auto-update',
      '--output-format',
      'json',
      '-p',
      PROMPT_PLACEHOLDER,
    ],
    attendedFiles: ['.github/instructions/striart.instructions.md'],
    notes: ['The JSONL record shape of -p is not documented: transcribed generically.'],
  },
  {
    id: 'cursor',
    profileKey: 'cursor',
    label: 'Cursor CLI',
    status: 'ready',
    docs: [
      'https://cursor.com/docs/cli/headless',
      'https://cursor.com/docs/cli/reference/parameters',
      'https://cursor.com/docs/cli/reference/output-format',
      'https://cursor.com/docs/cli/reference/permissions',
    ],
    binaries: ['agent', 'cursor-agent'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'claude-stream-json',
    instructions: { channel: 'prompt' },
    // Sans --force les changements sont seulement proposés.
    args: () => [
      '-p',
      '--force',
      '--sandbox',
      'enabled',
      '--output-format',
      'stream-json',
      PROMPT_PLACEHOLDER,
    ],
    attendedFiles: ['.cursor/rules/striart.mdc', 'AGENTS.md'],
    notes: [
      'Not neutralizable: a repository .cursor/cli.json can widen permissions, and MCP configs are discovered from parent directories.',
      'No documented per-run rule forbids git push.',
    ],
  },
  {
    id: 'opencode',
    profileKey: 'opencode',
    label: 'OpenCode',
    status: 'ready',
    docs: [
      'https://opencode.ai/docs/cli/',
      'https://opencode.ai/docs/permissions/',
      'https://opencode.ai/docs/config/',
      'https://opencode.ai/docs/rules/',
    ],
    binaries: ['opencode'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'ndjson',
    instructions: { channel: 'prompt' },
    args: () => ['run', '--format', 'json', '--auto', PROMPT_PLACEHOLDER],
    // Config ET instructions du projet désactivées (elles remontent les
    // dossiers parents jusqu'au worktree principal) ; push refusé.
    env: {
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_PERMISSION: '{"bash":{"git push *":"deny"}}',
    },
    attendedFiles: ['AGENTS.md'],
    notes: [
      'OPENCODE_DISABLE_PROJECT_CONFIG also skips the clone AGENTS.md; the Striart rules ask the agent to read it.',
      'Supervised: OpenCode walks parent directories for AGENTS.md and also reads the main worktree one.',
    ],
  },
  {
    id: 'opencode-acp',
    profileKey: 'opencode-acp',
    label: 'OpenCode (ACP)',
    status: 'ready',
    docs: ['https://opencode.ai/docs/acp/', 'https://opencode.ai/docs/cli/'],
    binaries: ['opencode'],
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    args: () => ['acp'],
    env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
    attendedFiles: ['AGENTS.md'],
    notes: [],
  },
  {
    id: 'goose',
    profileKey: 'goose',
    label: 'Goose',
    status: 'ready',
    docs: [
      'https://goose-docs.ai/docs/guides/goose-cli-commands',
      'https://goose-docs.ai/docs/tutorials/headless-goose',
      'https://goose-docs.ai/docs/guides/context-engineering/using-goosehints',
    ],
    binaries: ['goose'],
    transport: 'argv',
    writeMode: 'unrestricted',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'ndjson',
    // `--system <TEXT>` : instructions système additionnelles.
    instructions: { channel: 'prompt' },
    args: () => [
      'run',
      '--no-session',
      '--with-builtin',
      'developer',
      '--output-format',
      'stream-json',
      '--system',
      '{{striartInstructions}}',
      '-t',
      PROMPT_PLACEHOLDER,
    ],
    env: { GOOSE_MODE: 'auto' },
    attendedFiles: ['AGENTS.md', '.goosehints'],
    notes: ['No documented rule forbids git push.'],
  },
  {
    id: 'goose-acp',
    profileKey: 'goose-acp',
    label: 'Goose (ACP)',
    status: 'ready',
    docs: ['https://goose-docs.ai/docs/guides/goose-cli-commands'],
    binaries: ['goose'],
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    args: () => ['acp'],
    attendedFiles: ['AGENTS.md', '.goosehints'],
    notes: [],
  },
  {
    id: 'amp',
    profileKey: 'amp',
    label: 'Amp',
    status: 'ready',
    docs: [
      'https://ampcode.com/docs/cli/execute-mode',
      'https://ampcode.com/docs/cli/streaming-json',
      'https://ampcode.com/docs/customize/agents-md',
    ],
    binaries: ['amp'],
    transport: 'argv',
    writeMode: 'unrestricted',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'claude-stream-json',
    instructions: { channel: 'prompt' },
    args: () => ['-x', PROMPT_PLACEHOLDER, '--stream-json'],
    // Amp remonte les AGENTS.md jusqu'à $HOME, donc jusqu'au worktree
    // principal : tous ignorés en session autonome.
    env: { AMP_IGNORE_GUIDANCE_FILES: '*' },
    attendedFiles: ['AGENTS.md'],
    notes: [
      'Non-interactive auth: AMP_API_KEY.',
      'Supervised: Amp reads parent AGENTS.md files up to $HOME, including the main worktree one.',
    ],
  },
  {
    id: 'kilo',
    profileKey: 'kilo',
    label: 'Kilo Code CLI',
    status: 'ready',
    docs: ['https://kilo.ai/docs/cli', 'https://kilo.ai/docs/code-with-ai/platforms/cli-reference'],
    binaries: ['kilo'],
    minVersion: '1.0.0',
    transport: 'argv',
    writeMode: 'unrestricted',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'ndjson',
    instructions: { channel: 'prompt' },
    // Sans --auto, une exécution non interactive rejette toute demande de
    // permission et sort en 1.
    args: () => ['run', '--auto', '--format', 'json', PROMPT_PLACEHOLDER],
    attendedFiles: ['AGENTS.md', '.kilocode/rules/striart.md'],
    notes: ['No documented switch disables the project configuration.'],
  },
  {
    id: 'kilo-acp',
    profileKey: 'kilo-acp',
    label: 'Kilo Code CLI (ACP)',
    status: 'ready',
    docs: ['https://kilo.ai/docs/code-with-ai/platforms/cli-reference'],
    binaries: ['kilo'],
    minVersion: '1.0.0',
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    args: () => ['acp'],
    attendedFiles: ['AGENTS.md', '.kilocode/rules/striart.md'],
    notes: [],
  },
  {
    id: 'qwen-code',
    profileKey: 'qwen',
    label: 'Qwen Code',
    status: 'ready',
    docs: [
      'https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/',
      'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/',
    ],
    binaries: ['qwen'],
    transport: 'argv',
    writeMode: 'unrestricted',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'claude-stream-json',
    instructions: { channel: 'prompt' },
    // yolo n'active pas de sandbox : l'isolation vient du clone.
    args: () => [
      '--approval-mode',
      'yolo',
      '--output-format',
      'stream-json',
      '--append-system-prompt',
      '{{striartInstructions}}',
      '-p',
      PROMPT_PLACEHOLDER,
    ],
    attendedFiles: ['QWEN.md'],
    notes: ['QWEN.md discovery stops at the clone .git.'],
  },
  {
    id: 'qwen-code-acp',
    profileKey: 'qwen-acp',
    label: 'Qwen Code (ACP)',
    status: 'ready',
    docs: ['https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/'],
    binaries: ['qwen'],
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    args: () => ['--acp'],
    attendedFiles: ['QWEN.md'],
    notes: [],
  },
  {
    id: 'cline',
    profileKey: 'cline',
    label: 'Cline CLI',
    status: 'ready',
    docs: [
      'https://docs.cline.bot/cli/cli-reference.md',
      'https://docs.cline.bot/cline-cli/three-core-flows.md',
      'https://docs.cline.bot/customization/cline-rules',
    ],
    binaries: ['cline'],
    transport: 'argv',
    writeMode: 'unrestricted',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'ndjson',
    // `-s/--system` REMPLACE le prompt système de Cline : enveloppe du prompt.
    instructions: { channel: 'prompt' },
    args: () => ['--json', '--auto-approve', 'true', PROMPT_PLACEHOLDER],
    attendedFiles: ['.clinerules/striart.md'],
    notes: ['No documented rule forbids git push.'],
  },
  {
    id: 'cline-acp',
    profileKey: 'cline-acp',
    label: 'Cline CLI (ACP)',
    status: 'ready',
    docs: ['https://docs.cline.bot/usage/acp.md'],
    binaries: ['cline'],
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    args: () => ['--acp'],
    attendedFiles: ['.clinerules/striart.md'],
    notes: [],
  },
  {
    id: 'copilot-acp',
    profileKey: 'copilot-acp',
    label: 'GitHub Copilot CLI (ACP)',
    status: 'ready',
    docs: ['https://docs.github.com/en/copilot/reference/cli-command-reference'],
    binaries: ['copilot'],
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    args: () => ['--acp'],
    attendedFiles: ['.github/instructions/striart.instructions.md'],
    notes: [],
  },
  {
    id: 'aider',
    profileKey: 'aider',
    label: 'Aider',
    status: 'ready',
    docs: [
      'https://aider.chat/docs/scripting.html',
      'https://aider.chat/docs/config/options.html',
      'https://aider.chat/docs/config/aider_conf.html',
      'https://aider.chat/docs/git.html',
    ],
    binaries: ['aider'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent',
    structuredOutput: 'none',
    // `--read <fichier>` : fichier de conventions en lecture seule.
    instructions: { channel: 'system-prompt-file', flag: '--read' },
    args: ({ commitPolicy }) => [
      '--message',
      PROMPT_PLACEHOLDER,
      '--yes-always',
      '--no-check-update',
      '--no-gitignore',
      '--no-pretty',
      '--no-stream',
      agentMayCommit(commitPolicy) ? '--auto-commits' : '--no-auto-commits',
      ...(agentMayCommit(commitPolicy) ? [] : ['--no-dirty-commits']),
    ],
    // `--config <fichier>` : SEUL ce fichier est chargé (pas le
    // .aider.conf.yml du dépôt). `{}` est un YAML valide et vide.
    settingsFile: { flag: '--config', json: {} },
    attendedFiles: [],
    notes: [
      'Aider loads no instruction file by itself: in supervised mode start it with --read <file>.',
      'Aider commits each edit with --no-verify (pre-commit hooks are skipped).',
    ],
  },
  {
    id: 'aider-ollama',
    profileKey: 'ollama',
    label: 'Aider + local Ollama model',
    status: 'ready',
    docs: ['https://aider.chat/docs/llms/ollama.html', 'https://aider.chat/docs/scripting.html'],
    binaries: ['aider'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent',
    structuredOutput: 'none',
    instructions: { channel: 'system-prompt-file', flag: '--read' },
    // `ollama run` n'est qu'un chat : il n'édite aucun fichier, une session
    // ne pouvait pas réussir. Requalifié : Aider pilote le modèle local.
    args: ({ commitPolicy }) => [
      '--model',
      'ollama_chat/qwen2.5-coder',
      '--message',
      PROMPT_PLACEHOLDER,
      '--yes-always',
      '--no-check-update',
      '--no-gitignore',
      '--no-pretty',
      '--no-stream',
      agentMayCommit(commitPolicy) ? '--auto-commits' : '--no-auto-commits',
      ...(agentMayCommit(commitPolicy) ? [] : ['--no-dirty-commits']),
    ],
    env: { OLLAMA_API_BASE: 'http://127.0.0.1:11434' },
    settingsFile: { flag: '--config', json: {} },
    attendedFiles: [],
    notes: [
      'Ollama defaults to a 2k context window; start it with a larger OLLAMA_CONTEXT_LENGTH.',
    ],
  },
  // --- Expérimentaux : invocation ou sécurité non vérifiables en doc officielle.
  {
    id: 'gemini',
    profileKey: 'gemini-argv',
    label: 'Gemini CLI (argv)',
    status: 'experimental',
    docs: [
      'https://geminicli.com/docs/cli/cli-reference',
      'https://geminicli.com/docs/cli/headless',
    ],
    binaries: ['gemini'],
    transport: 'argv',
    writeMode: 'workspace',
    // auto_edit n'approuve que les éditions : aucune commande shell (ni git,
    // ni tests) en non interactif.
    commitPolicy: 'striart',
    structuredOutput: 'gemini-stream-json',
    instructions: { channel: 'prompt' },
    args: () => [
      '--approval-mode',
      'auto_edit',
      '--output-format',
      'stream-json',
      '-e',
      'none',
      '-p',
      PROMPT_PLACEHOLDER,
    ],
    attendedFiles: ['GEMINI.md'],
    notes: [
      'Folder trust defaults conflict in the docs: an untrusted clone may abort with FatalUntrustedWorkspaceError.',
    ],
  },
  {
    id: 'junie',
    profileKey: 'junie',
    label: 'JetBrains Junie CLI',
    status: 'experimental',
    docs: [
      'https://junie.jetbrains.com/docs/junie-cli.html',
      'https://junie.jetbrains.com/docs/parameters.html',
      'https://junie.jetbrains.com/docs/junie-headless.html',
    ],
    binaries: ['junie'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'ndjson',
    instructions: { channel: 'prompt' },
    args: () => [
      '--output-format',
      'json-stream',
      '--skip-update-check',
      '--system-prompt',
      '{{striartInstructions}}',
      '--task',
      PROMPT_PLACEHOLDER,
    ],
    attendedFiles: ['.junie/rules/striart.md'],
    notes: [
      'Headless runs are trusted by design and load the repository Junie configuration (MCP, hooks) without prompting.',
      'Approval behaviour in headless mode is not documented.',
    ],
  },
  {
    id: 'junie-acp',
    profileKey: 'junie-acp',
    label: 'JetBrains Junie CLI (ACP)',
    status: 'experimental',
    docs: ['https://junie.jetbrains.com/docs/parameters.html'],
    binaries: ['junie'],
    transport: 'acp',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'acp-prompt' },
    args: () => ['--acp'],
    attendedFiles: ['.junie/rules/striart.md'],
    notes: ['Loads the repository Junie configuration without prompting.'],
  },
  {
    id: 'continue',
    profileKey: 'continue',
    label: 'Continue CLI',
    status: 'experimental',
    docs: [
      'https://docs.continue.dev/cli/headless-mode',
      'https://docs.continue.dev/cli/tool-permissions',
    ],
    binaries: ['cn'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'ndjson',
    instructions: { channel: 'prompt' },
    // --auto passerait au-dessus de --exclude : allow explicites + exclude.
    args: () => [
      '-p',
      PROMPT_PLACEHOLDER,
      '--allow',
      'Write',
      '--allow',
      'Edit',
      '--allow',
      'Bash',
      '--exclude',
      'Bash(git push*)',
      '--rule',
      '{{striartInstructions}}',
      '--format',
      'json',
    ],
    attendedFiles: ['.continue/rules/striart.md'],
    notes: ['JSON output schema and CLI rule loading are not documented.'],
  },
  {
    id: 'warp-oz',
    profileKey: 'oz',
    label: 'Warp Oz CLI',
    status: 'experimental',
    docs: ['https://docs.warp.dev/reference/cli/', 'https://docs.warp.dev/agents/cli/oz-cli/'],
    binaries: ['oz'],
    transport: 'argv',
    writeMode: 'workspace',
    commitPolicy: 'agent-then-striart',
    structuredOutput: 'none',
    instructions: { channel: 'prompt' },
    args: () => ['agent', 'run', '--prompt', PROMPT_PLACEHOLDER],
    attendedFiles: ['AGENTS.md'],
    notes: [
      '"oz" is a legacy interface; an agent profile (--profile <ID>) and WARP_API_KEY are required.',
    ],
  },
]);

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): AgentPreset | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Commande de l'outil d'un agent SUPERVISÉ : par agent (registre) > config
 * globale (`agentCommand`) > 'claude'. Source unique (pty-host.ts, consignes).
 */
export function attendedCommandOf(
  command: string | null | undefined,
  agentCommand: string | null | undefined,
): string {
  return command ?? agentCommand ?? 'claude';
}

/** Nom de base d'une commande (`C:\…\claude.exe --x` → `claude`), en minuscules. */
export function commandBaseName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

/**
 * Preset d'un outil d'après sa commande (mode supervisé : `agentCommand`).
 * Préfère un preset prêt et argv (le fichier d'instructions dépend de
 * l'outil, pas du transport).
 */
export function findPresetForCommand(command: string | null | undefined): AgentPreset | null {
  if (!command) return null;
  const base = commandBaseName(command);
  const matches = PRESETS.filter((p) => p.binaries.includes(base));
  return (
    matches.find((p) => p.status === 'ready' && p.transport === 'argv') ??
    matches.find((p) => p.status === 'ready') ??
    matches[0] ??
    null
  );
}

/** Profil matérialisé depuis un preset. */
export function materializePreset(
  preset: AgentPreset,
  overrides: Partial<AgentProfile> = {},
): AgentProfile {
  const commitPolicy = overrides.commitPolicy ?? preset.commitPolicy;
  const profile: AgentProfile = {
    command: preset.binaries[0],
    args: preset.args({ commitPolicy }),
    preset: preset.id,
    writeMode: preset.writeMode,
    commitPolicy,
    structuredOutput: preset.structuredOutput,
    instructions: { ...preset.instructions },
  };
  if (preset.transport === 'acp') profile.acp = true;
  if (preset.status === 'experimental') profile.experimental = true;
  if (preset.env) profile.env = { ...preset.env };
  if (preset.settingsFile) {
    profile.settingsFile = { ...preset.settingsFile, json: { ...preset.settingsFile.json } };
  }
  // Les champs donnés l'emportent ; env et instructions fusionnent par clé
  // (ajouter une clé d'API ne doit pas effacer les neutralisations du preset).
  const { env, instructions, ...rest } = overrides;
  Object.assign(profile, rest);
  if (env) profile.env = { ...(profile.env ?? {}), ...env };
  if (instructions) profile.instructions = { ...(profile.instructions ?? {}), ...instructions };
  return profile;
}

/** Profils par défaut : presets PRÊTS uniquement, sous leur clé de profil. */
export function defaultAgentProfiles(): Record<string, AgentProfile> {
  const profiles: Record<string, AgentProfile> = {};
  for (const preset of PRESETS) {
    if (preset.status !== 'ready') continue;
    profiles[preset.profileKey] = materializePreset(preset);
  }
  return profiles;
}

/** Profils par défaut sous forme de RÉFÉRENCES (`{ preset }`), matérialisables avec un contrat global. */
export function defaultAgentProfileRefs(): Record<string, Partial<AgentProfile>> {
  const refs: Record<string, Partial<AgentProfile>> = {};
  for (const preset of PRESETS) {
    if (preset.status === 'ready') refs[preset.profileKey] = { preset: preset.id };
  }
  return refs;
}

/**
 * Matérialise les entrées `{ preset: '<id>', … }` d'une table de profils.
 * Une entrée sans `command` qui nomme un preset est complétée ; une entrée
 * complète (command + args) reste telle quelle (elle peut nommer un preset
 * pour l'affichage). Un preset inconnu est laissé tel quel : la validation
 * le refuse.
 *
 * Contrat de commit, par priorité : celui de l'entrée > `commitPolicy`
 * global QUAND l'utilisateur l'a déclaré > défaut du preset (ce que
 * l'invocation de l'outil permet).
 */
export function expandAgentProfiles(
  profiles: Record<string, Partial<AgentProfile>>,
  { commitPolicy }: { commitPolicy?: CommitPolicy | null } = {},
): Record<string, AgentProfile> {
  const out: Record<string, AgentProfile> = {};
  for (const [key, entry] of Object.entries(profiles)) {
    const preset = typeof entry?.preset === 'string' ? getPreset(entry.preset) : null;
    if (preset && entry.command === undefined) {
      const policy = entry.commitPolicy ?? commitPolicy ?? undefined;
      out[key] = materializePreset(preset, policy ? { ...entry, commitPolicy: policy } : entry);
    } else {
      out[key] = entry as AgentProfile;
    }
  }
  return out;
}
