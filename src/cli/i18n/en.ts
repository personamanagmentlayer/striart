/**
 * English catalogue of the CLI. Must satisfy `Messages` (derived from the
 * French reference catalogue) exactly: tsc reports any missing or extra key.
 *
 * Values coming from outside (file names, commit messages) arrive ALREADY
 * sanitized by the caller.
 */
import type { Messages } from './fr.ts';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h${min % 60 ? ` ${min % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${text} ${units[unit]}`;
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '?' : String(value);
const list = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : str(value));
/** `: <cause>` when the domain recorded one (git, YAML, JSON parser output). */
const because = (value: unknown): string => (value ? `: ${str(value)}` : '.');
/** Same, when another sentence follows. */
const becauseThen = (value: unknown): string => (value ? `: ${str(value)}.` : '.');
/**
 * Causes d'un échec LLM : la couche `llm.js` les rédige en français (référence) et ne
 * porte pas de code de cause stable. Les formes connues sont rendues en anglais ; une
 * cause inconnue reste affichée telle quelle (aucune information perdue).
 */
const LLM_CAUSES: Array<[RegExp, (...groups: string[]) => string]> = [
  [/^délai dépassé$/, () => 'timed out'],
  [/^panne de transport \((.*)\)$/, (detail) => `transport failure (${detail})`],
  [/^(.+) a répondu HTTP (\d+)$/, (label, status) => `${label} answered HTTP ${status}`],
  [
    /^(.+) : réponse coupée par la limite de longueur de sortie \((.*)\)$/,
    (label) =>
      `${label}: response cut by the output length limit (tokens.budgets.perCall.maxOutputTokens or the model limit)`,
  ],
  [
    /^(.+) : réponse filtrée par le fournisseur \(content_filter\)$/,
    (label) => `${label}: response filtered by the provider (content_filter)`,
  ],
  [
    /^L'API Anthropic a refusé la requête \(stop_reason: refusal\)$/,
    () => 'the Anthropic API refused the request (stop_reason: refusal)',
  ],
];
const llmCauseText = (value: unknown): string => {
  const text = str(value);
  for (const [pattern, render] of LLM_CAUSES) {
    const match = pattern.exec(text);
    if (match) return render(...match.slice(1));
  }
  return text;
};
/**
 * Stable `details.causeCode` of an LLM failure (src/llm-resilience.ts `LLM_CAUSE_CODES`) rendered
 * in English. An unknown code (a newer core than this catalogue) falls back to the free text, so
 * no information is lost.
 */
const LLM_CAUSE_CODES: Record<string, (d: Record<string, unknown>) => string> = {
  TRANSPORT: (d) => `transport failure${d.causeDetail ? ` (${str(d.causeDetail)})` : ''}`,
  TIMEOUT: () => 'timed out',
  HTTP_4XX: (d) => `the provider answered HTTP ${str(d.status)}`,
  HTTP_5XX: (d) => `the provider answered HTTP ${str(d.status)}`,
  TRUNCATED: () =>
    'response cut by the output length limit (tokens.budgets.perCall.maxOutputTokens or the model limit)',
  FILTERED: () => 'response filtered by the provider (content_filter)',
  REFUSED: () => 'the provider refused the request (stop_reason: refusal)',
  INVALID_JSON: () => 'the response is not valid JSON',
  INVALID_RESPONSE: () => 'the response is malformed (missing field or unexpected content)',
};
const llmCause = (d: Record<string, unknown>): string => {
  const render = typeof d.causeCode === 'string' ? LLM_CAUSE_CODES[d.causeCode] : undefined;
  return render ? render(d) : llmCauseText(d.cause);
};
/** `: <cause>` of an LLM failure (stable code first, free text as the fallback), or a bare full stop. */
const llmBecause = (d: Record<string, unknown>): string =>
  d.causeCode || d.cause ? `: ${llmCause(d)}` : '.';
/** ` (provider:model)` of an LLM failure, when known. */
const llmTarget = (d: Record<string, unknown>): string =>
  d.provider ? ` (${str(d.provider)}${d.model ? `:${str(d.model)}` : ''})` : '';
const planTask = (d: Record<string, unknown>): string =>
  d.task ? `task #${str(d.task)}${d.taskId ? ` (${str(d.taskId)})` : ''}: ` : '';

/** Plan validation reasons (details.reason of PLAN_INVALID). */
const PLAN_REASONS: Record<string, (d: Record<string, unknown>) => string> = {
  YAML: (d) => `the file is not valid YAML${because(d.cause)}`,
  NOT_AN_OBJECT: () => 'the plan must be a YAML object (version + tasks).',
  VERSION_MISSING: () => '"version" is missing (expected: "version: 1" or "version: 2").',
  UNSUPPORTED_VERSION: (d) => `unsupported plan version ${str(d.version)} (expected: 1 or 2).`,
  // Plan version 2 (orchestration modes).
  UNKNOWN_KEY: (d) =>
    `${planTask(d)}unknown key "${str(d.field)}" (version 2 plans accept documented keys only).`,
  MODE_INVALID: () => '"mode" must be sequential or parallel.',
  OVERRIDES_NEED_V2: () =>
    '--mode, --concurrency and --on-failure need a "version: 2" plan (a version 1 plan chains through the queue and --after).',
  CONCURRENCY_INVALID: (d) => `"concurrency" must be a whole number from 1 to ${str(d.max)}.`,
  ON_FAILURE_INVALID: () => '"onFailure" must be stop or skip-dependents.',
  KIND_UNKNOWN: (d) =>
    `${planTask(d)}unknown task mode ${str(d.kind)} (expected: task, review, pipeline, race, team).`,
  AFTER_INVALID: (d) => `${planTask(d)}"after" must be an id or a non-empty list of distinct ids.`,
  AGENT_INVALID: (d) =>
    `${planTask(d)}"agent" is not a valid agent name (letters, digits, - and _, at most ${str(d.max)} characters).`,
  COMMAND_AUTONOMOUS_CONFLICT: (d) =>
    `${planTask(d)}"command" (supervised tool) cannot be combined with autonomous: true — use "profile".`,
  COMMAND_NOT_AN_EXECUTABLE_NAME: (d) =>
    `${planTask(d)}"command" must be an executable name (no path, space, operator or option): it is typed into the agent's shell. Put tool options in the agentCommand config or use a profile.`,
  PROFILE_NEEDS_AUTONOMOUS: (d) =>
    `${planTask(d)}"${str(d.field ?? 'profile')}" only applies with autonomous: true.`,
  SPEC_NOT_AN_OBJECT: (d) => `${planTask(d)}each ${str(d.field)} must be an object.`,
  FIELD_NOT_BOOLEAN: (d) => `${planTask(d)}"${str(d.field)}" must be a boolean.`,
  REVIEWERS_MISSING: (d) => `${planTask(d)}"reviewers" must list at least one reviewer.`,
  REVIEWERS_TOO_MANY: (d) => `${planTask(d)}at most ${str(d.max)} reviewers.`,
  HUMAN_REVIEWER_PROFILE: (d) => `${planTask(d)}a human reviewer has no "profile" nor "timeout".`,
  QUORUM_INVALID: (d) => `${planTask(d)}"quorum" must be all, any or majority.`,
  ROUNDS_INVALID: (d) =>
    `${planTask(d)}"${str(d.field)}" must be a whole number from 1 to ${str(d.max)}.`,
  NAME_INVALID: (d) =>
    `${planTask(d)}invalid role or reviewer name (lowercase letters, digits and dashes, starting with a letter).`,
  NAME_RESERVED: (d) => `${planTask(d)}the name "${str(d.name)}" is reserved.`,
  NAME_DUPLICATE: (d) => `${planTask(d)}duplicate name "${str(d.name)}".`,
  STEPS_MISSING: (d) => `${planTask(d)}a pipeline needs at least 2 steps ("steps").`,
  STEPS_TOO_MANY: (d) => `${planTask(d)}at most ${str(d.max)} steps.`,
  STEP_ID_INVALID: (d) =>
    `${planTask(d)}every step needs an "id" (lowercase letters, digits and dashes).`,
  STEP_ID_DUPLICATE: (d) => `${planTask(d)}duplicate step id "${str(d.id)}".`,
  HANDOFF_INVALID: (d) => `${planTask(d)}"handoff" must be merge or clone.`,
  PROMPT_FORBIDDEN: (d) => `${planTask(d)}a pipeline has no "prompt": each step carries its own.`,
  CANDIDATES_TOO_FEW: (d) => `${planTask(d)}a race needs at least 2 candidates ("candidates").`,
  CANDIDATES_TOO_MANY: (d) => `${planTask(d)}at most ${str(d.max)} candidates.`,
  PICK_INVALID: (d) => `${planTask(d)}"pick" must be first-green, smallest-diff or judge.`,
  LOSERS_INVALID: (d) => `${planTask(d)}"losers" must be keep, archive or clean.`,
  ROLES_TOO_FEW: (d) => `${planTask(d)}a team needs at least 2 roles ("roles").`,
  ROLES_TOO_MANY: (d) => `${planTask(d)}at most ${str(d.max)} roles.`,
  CADENCE_INVALID: (d) => `${planTask(d)}"cadence" must be turns or parallel.`,
  CADENCE_UNAVAILABLE: (d) =>
    `${planTask(d)}cadence "${str(d.cadence)}" is not available: dynamic file arbitration needs write mediation in the ACP client, which is not wired yet.`,
  PARALLEL_SCOPE_MISSING: (d) =>
    `${planTask(d)}in parallel cadence, role "${str(d.role)}" must declare "files" (static partition).`,
  SCOPE_INVALID: (d) =>
    `${planTask(d)}"files" of role "${str(d.role)}" must list valid relative globs (no "..", no leading "/", no negation).`,
  TASKS_EMPTY: () => '"tasks" must be a non-empty list.',
  TASK_NOT_AN_OBJECT: (d) => `${planTask(d)}each entry of "tasks" must be an object.`,
  PROMPT_MISSING: (d) => `${planTask(d)}"prompt" is required and cannot be empty.`,
  FIELD_NOT_STRING: (d) =>
    `${planTask(d)}"${str(d.field)}" must be a non-empty string when present.`,
  AUTONOMOUS_NOT_BOOLEAN: (d) => `${planTask(d)}"autonomous" must be a boolean.`,
  TIMEOUT_INVALID: (d) => `${planTask(d)}"timeout" must be a whole number of milliseconds >= 1000.`,
  DUPLICATE_ID: (d) => `${planTask(d)}duplicate id "${str(d.id)}".`,
  AFTER_FORWARD: (d) =>
    `task${d.taskId ? ` (${str(d.taskId)})` : ''}: "after: ${str(d.after)}" refers to a task defined later. A dependency must come before the task that depends on it (this keeps the graph acyclic).`,
};

/** Agent profile rules (details.reason of PROFILE_INVALID). */
const PROFILE_REASONS: Record<string, (d: Record<string, unknown>) => string> = {
  COMMAND_EMPTY: () => '"command" must be a non-empty string.',
  ARGS_NOT_STRINGS: () => '"args" must be an array of strings.',
  PLACEHOLDER_MISSING: (d) =>
    `no argument contains ${str(d.placeholder)}: the prompt would never reach the agent.`,
  PLACEHOLDER_FORBIDDEN: () =>
    'ACP profile: {{prompt}} is forbidden in "args" — the prompt goes through the protocol.',
  ACP_TRANSPORT: () => 'ACP profile: the prompt goes through the protocol, not through argv.',
  ACP_OPTION_INVALID: (d) =>
    `ACP profile: option "${str(d.field)}" is invalid (see the agentProfiles.<name>.acp reference).`,
  INSTRUCTIONS_CHANNEL_TRANSPORT: () =>
    'instructions channel "acp-prompt" needs an ACP profile (acp: true).',
  INSTRUCTIONS_FLAG_MISSING: () =>
    'instructions channel "system-prompt-file" needs instructions.flag or a {{striartInstructionsFile}} argument.',
  ACP_ELICITATION_NEEDS_ASK: () =>
    'ACP profile: elicitation needs acp.permissions "ask" — without a human to answer, the capability would be dead.',
};

/** LLM configuration problems (details.reason of LLM_CONFIG_INVALID). */
const LLM_CONFIG_REASONS: Record<string, (d: Record<string, unknown>) => string> = {
  UNKNOWN_PROVIDER: (d) =>
    `unknown LLM provider "${str(d.provider)}" (supported: ${list(d.supported)}).`,
  NO_MODEL: (d) =>
    `no model configured for provider "${str(d.provider)}": set llm.model in striart.config.`,
  NO_BASE_URL: (d) =>
    `provider "${str(d.provider)}" needs llm.baseUrl (e.g. https://my-resource.openai.azure.com).`,
  NO_API_KEY: (d) =>
    `missing API key for provider "${str(d.provider)}": set the environment variable ${str(d.apiKeyEnv)} (for example in a .env file).`,
};

/** Renders `details.reason` from its table; unknown reason → the generic sentence. */
const byReason = (
  table: Record<string, (d: Record<string, unknown>) => string>,
  d: Record<string, unknown>,
  prefix: string,
  fallback: string,
): string => {
  const render = typeof d.reason === 'string' ? table[d.reason] : undefined;
  return render ? `${prefix}: ${render(d)}` : fallback;
};

/** Domain error messages, by code. Unknown code → null (the domain message is shown). */
const ERRORS: Record<string, (d: Record<string, unknown>) => string> = {
  AFTER_CYCLE: (d) =>
    `--after "${str(d.after)}" would create a dependency cycle: those tasks would wait for each other forever.`,
  AFTER_UNKNOWN: (d) => `--after "${str(d.after)}" matches no queued task and no active agent.`,
  ACP_AUTH_REQUIRED: () =>
    'the ACP agent requires authentication: sign in with its own CLI, or set agentProfiles.<profile>.acp.auth.methodId to an advertised method (explicit decision — Striart never signs in on its own).',
  ACP_AUTH_METHOD_UNAVAILABLE: () =>
    'the configured acp.auth.methodId is not a protocol authentication method advertised by this agent (terminal methods are never passed to "authenticate").',
  ACP_BUS_DISABLED: (d) =>
    `bus messages are disabled for the ACP session of "${str(d.agent)}" (acp.bus: false).`,
  ACP_HOST_AUTH_FAILED: () => 'the ACP session host refused the client: invalid token.',
  ACP_HOST_BUSY: (d) =>
    `an ACP session is already live for "${str(d.agent)}" (host PID ${str(d.pid)}): one session per agent. Wait for it or stop the agent first.`,
  ACP_HOST_FAILED: (d) =>
    `the ACP session host of "${str(d.agent)}" failed unexpectedly (see its log).`,
  ACP_HOST_LOST: (d) =>
    `the ACP session host of "${str(d.agent)}" disappeared without reporting a result (see .striart/logs/acp-host-${str(d.agent)}.log).`,
  ACP_HOST_PROTOCOL: () => 'unexpected frame on the ACP session host channel.',
  ACP_HOST_SPAWN_FAILED: (d) => `could not start the ACP session host for "${str(d.agent)}".`,
  ACP_HOST_UNREACHABLE: (d) => `the ACP session host of "${str(d.agent)}" is not reachable.`,
  ACP_PROMPT_INVALID: () =>
    'the message is not a valid prompt (empty, too long, or with control characters).',
  ACP_PROXY_AUTH_METHOD_UNKNOWN: () =>
    'unknown authentication method: Striart only advertises "striart-local" (no account needed).',
  ACP_PROXY_COLLISION: (d) =>
    `the Router predicts a collision with ${Array.isArray(d.agents) ? d.agents.map(str).join(', ') : 'another agent'}: no clone was created. Retry once they are done, or set acpAgent.collisionPolicy: "wait".`,
  ACP_PROXY_CWD_OUTSIDE_ROOT: () =>
    'the session directory is outside the repository this "striart acp" serves (--root).',
  ACP_PROXY_METHOD_UNSUPPORTED: () =>
    'method not supported by Striart (it never serves nor relays file or terminal capabilities).',
  ACP_PROXY_NO_PROFILE: () =>
    'no ACP agent profile is configured: declare one with acp: true (see "striart profiles --detect").',
  ACP_PROXY_NOT_INITIALIZED: () => 'the ACP client must call "initialize" first.',
  ACP_PROXY_OPTION_INVALID: () => 'invalid value for this session option.',
  ACP_PROXY_OPTION_LOCKED: () =>
    'this session option is locked once the first prompt started: open a new session to change it.',
  ACP_PROXY_OPTION_UNKNOWN: () => 'unknown session option.',
  ACP_PROXY_PROFILE_UNAVAILABLE: (d) =>
    `profile "${str(d.profile)}" is not an available ACP agent profile (acp: true, and listed in acpAgent.profiles if set).`,
  ACP_PROXY_PROMPT_BUSY: () => 'a prompt is already running in this session: cancel it first.',
  ACP_PROXY_QUEUE_TOOK_OVER: (d) =>
    `the queue relaunched the task of "${str(d.agent)}" before Striart could take it back: see "striart queue".`,
  ACP_PROXY_SESSION_ENDED: () => 'this Striart session has ended: open a new session.',
  ACP_PROXY_SESSION_UNKNOWN: () => 'unknown session id.',
  ACP_PROXY_UPSTREAM_ENDED: () =>
    'the upstream agent session ended before the turn finished; the outcome was reported in the session.',
  ACP_SESSION_CLOSING: (d) =>
    `the ACP session of "${str(d.agent)}" is closing: the message was not delivered.`,
  ACP_SESSION_NOT_FOUND: (d) =>
    `no live ACP session for "${str(d.agent)}": an argv session is one-shot, and an ACP session is addressable only while it runs in its persistent host.`,
  ELICITATION_CONTENT_INVALID: (d) =>
    `the answer does not match the requested form${d.field ? ` (field "${str(d.field)}"` : ' ('}${d.reason ? `${d.field ? ', ' : ''}${str(d.reason)}` : ''}).`,
  ELICITATION_INVALID: (d) => `the agent's question was refused: ${str(d.reason)}.`,
  ELICITATION_NOT_PENDING: () => 'this question is no longer pending.',
  AGENT_EXISTS: (d) => `agent "${str(d.agent ?? d.name)}" already exists.`,
  AGENT_HAS_PENDING: (d) =>
    d.head
      ? `agent "${str(d.agent)}" has unmerged commits (${str(d.head).slice(0, 8)}): merge first, or --force to discard that work.`
      : `the clone of "${str(d.agent)}" is unreadable by git: cannot check that no work would be lost.`,
  AGENT_QUEUED: (d) => `agent "${str(d.agent)}" already has a queued task.`,
  AGENT_UNKNOWN: (d) => `unknown agent: "${str(d.agent)}".`,
  ATTACH_WRONG_CWD: (d) =>
    `"striart attach" must run from the agent's clone (current directory: ${str(d.cwd)}).`,
  CLONE_FAILED: (d) => `cloning agent "${str(d.name)}" failed: ${str(d.cause)}`,
  CLONE_NOT_FOUND: (d) => `no clone found for "${str(d.agent)}".`,
  CONFIG_INVALID: (d) => {
    if (d.reason === 'UNREADABLE') return `cannot read the Striart config${because(d.cause)}`;
    if (d.reason === 'HOST_PATTERN')
      return `invalid host pattern at "${str(d.field)}" (${str(d.problem)}): expected an exact host name or a leading "*." wildcard under a 2-label suffix, optional port, never "*" nor a public IP.`;
    if (d.reason === 'SAME_BRANCH')
      return `mainBranch and targetBranch must differ for promotion (both are "${str(d.mainBranch)}").`;
    // The faulty field is named in full: `agentProfiles.<name>.acp.<field>` for a
    // profile option, the `acpAgent.<field>` path the validator already built.
    if (d.reason === 'INVALID_VALUE' && d.field)
      return `invalid value for "${d.profile ? `${str(d.key)}.${str(d.profile)}.` : ''}${str(d.field)}" in the Striart config.`;
    return d.key
      ? `invalid value for "${str(d.key)}" in the Striart config.`
      : 'invalid configuration (see striart doctor for the detail).';
  },
  CONTROL_CSRF_REFUSED: () =>
    'request refused by the dashboard: X-Striart: 1 and Content-Type: application/json are required.',
  // Without a port the command already supplied the localized sentence
  // (`dashboard.noInstance`): null keeps it.
  CONTROL_INSTANCE_NOT_FOUND: (d) =>
    d.port === undefined || d.port === null
      ? null
      : `no running dashboard on port ${str(d.port)} for this repository (or its token file is unreadable).`,
  CONTROL_INVALID_REQUEST: (d) => `invalid Striart Control Protocol message (${str(d.reason)}).`,
  CONTROL_MESSAGE_TOO_LARGE: (d) =>
    `message too large${d.bytes !== undefined ? ` (${str(d.bytes)} bytes)` : ''}: the limit is ${str(d.limit)} bytes.`,
  CONTROL_LINK_PENDING: () =>
    'the dashboard sign-in link is not ready yet: run "striart dashboard --link" in a moment.',
  CONTROL_METHOD_UNAVAILABLE: (d) =>
    `this method is not served over ${str(d.transport)}${d.transport === 'http' ? ' (subscribe with GET /events)' : ''}.`,
  CONTROL_METHOD_UNKNOWN: (d) => `unknown Striart Control Protocol method "${str(d.method)}".`,
  CONTROL_NESTED_SESSION: (d) =>
    `"${str(d.surface)}" is the human control plane: refused inside a Striart agent session (STRIART_SESSION=1).`,
  CONTROL_ORIGIN_REFUSED: (d) =>
    `request refused by the dashboard: it does not come from the dashboard page (${str(d.reason)}).`,
  CONTROL_PARSE_ERROR: () => 'the message is not valid JSON.',
  CONTROL_SUBSCRIPTION_UNKNOWN: (d) =>
    `unknown subscription "${str(d.subscriptionId)}" on this connection.`,
  CONTROL_TOKEN_UNPROTECTED: (d) =>
    `cannot restrict the dashboard token file to the current user (${str(d.reason)}): refused, no token is left readable by others.`,
  STATE_UNPROTECTED: (d) =>
    `cannot restrict ${str(d.path)} to the current user (${str(d.reason)}): refused, local data (code, logs, tickets) would stay readable by other accounts. Fix the permissions, or on a file system without permissions set privateStateDir: false (explicit, shown by "striart doctor").`,
  CONTROL_UNAUTHENTICATED: () => 'dashboard session missing or expired: sign in again.',
  CONTROL_VERSION_UNSUPPORTED: (d) =>
    `unsupported Striart Control Protocol version ${str(d.requested)} (supported: ${list(d.supported)}).`,
  DAEMON_RUNNING: (d) => `a ${str(d.name)} daemon is already running (PID ${str(d.pid)}).`,
  DAEMON_BUSY: (d) => `the PID file of the ${str(d.name)} daemon is locked by another command.`,
  DAEMON_IDENTITY_UNVERIFIED: (d) =>
    `PID ${str(d.pid)} of the ${str(d.name)} daemon is alive but its identity cannot be read: nothing is killed blindly. Check the process, then stop it by hand.`,
  DAEMON_PIDFILE_CORRUPT: (d) =>
    `the PID file of the ${str(d.name)} daemon is corrupt${becauseThen(d.cause)} Inspect it, delete it once you know no daemon is running, then retry.`,
  DAEMON_SPAWN_FAILED: (d) => `the ${str(d.name)} daemon could not be launched${because(d.cause)}`,
  MERGE_COMMIT_FAILED: (d) =>
    `git refused the merge commit for "${str(d.agent)}"${becauseThen(d.cause)} The merge was cancelled and the main repository is clean: fix the cause (pre-commit / commit-msg hook, git identity) and run the merge again.`,
  COMMIT_HOOK_REJECTED: (d) =>
    `a hook of the target repository (pre-commit, commit-msg…) or the commit signature ${d.timedOut ? 'blocked until the commitTimeoutMs deadline (its process tree was killed)' : 'rejected the merge commit'} for "${str(d.agent)}"${d.ticketId ? ` (ticket ${str(d.ticketId)} keeps the hook output)` : ''}. The merge was cancelled and nothing was committed: fix what the hook reports and run the merge again. Hooks are never bypassed (no --no-verify).`,
  DELIVERY_REF_INVALID: () =>
    'no delivery branch name can be derived (invalid agent name): nothing was pushed. Use a valid agent name (letters, digits, dashes, underscores).',
  IDLE_CLOSE_BLOCKED: (d) =>
    `the idle session was NOT closed: a guard forbids it (${str(d.detail)}). The session is left untouched, with its clone and work.`,
  IDLE_CLOSE_UNVERIFIED: (d) =>
    `the idle session was NOT closed: its process cannot be identified (${str(d.detail)}). Nothing is killed blindly; check the process and stop it by hand if it is really forgotten.`,
  IDLE_CLOSE_NOT_ACKNOWLEDGED: () =>
    'the idle session was NOT closed: the process that supervises it did not acknowledge the stop request. The session is left untouched.',
  IDLE_CLOSE_FAILED: (d) =>
    `closing the idle session failed (${str(d.detail)}): the session may still be running; its clone and work are intact.`,
  IDLE_STATE_CORRUPT: (d) =>
    `the idle GC state file is corrupt${because(d.cause)} Delete .striart/idle/state.json: warnings will restart from zero.`,
  TICKETS_UNREADABLE: (d) =>
    `the conflict tickets folder (${str(d.path)}) cannot be read${because(d.cause)}`,
  TICKET_PATH_UNSAFE: (d) =>
    `ticket "${str(d.ticketId)}" names a path that is not a safe project path (${str(d.path)}): absolute, parent-relative or inside .git. Nothing was written; the ticket file was probably altered, close it and rerun the merge.`,
  DAEMON_STOP_DENIED: (d) =>
    `the ${str(d.name)} daemon (PID ${str(d.pid)}) belongs to another user: it cannot be stopped from this account.`,
  GATE_ORPHAN_PROCESS: (d) =>
    `the Test Gate left ${str(d.count ?? 'some')} descendant process(es) alive after the test command exited: they were killed and the gate is red (a test that leaks a process is a failing test).`,
  GATE_NATIVE_UNAVAILABLE: () =>
    'the Test Gate needs the native process container (striart-native), which is unavailable: the gate is red (fail closed). Build it with "npm run native:build", or set gateContainer: "process" to relax this explicitly.',
  ACP_SOCKET_DIR_UNSAFE: (d) =>
    `the private socket folder ${str(d.dir ?? d.path)} is not safe (it must be a real directory owned by you, mode 0700): refused. Remove it and retry.`,
  MCP_PROTECTED_TICKET: (d) =>
    `ticket "${str(d.ticketId)}" changes protected paths: approving it is a human decision, refused over MCP. Use "striart resolve" in a terminal.`,
  JOB_TERMINATE_INCOMPLETE: (d) =>
    `the process container cleanup did not complete${Array.isArray(d.survivorPids) ? ` (${d.survivorPids.length} process(es) still alive)` : ''}: stop the remaining processes by hand.`,
  TOKEN_ACCOUNTING_FAILED: (d) =>
    `token accounting failed${d.what ? ` (${str(d.what)})` : ''} and tokens.onAccountingError is "fail": the operation is refused. Check the usage ledger (.striart/usage/), then retry.`,
  SECRET_PATTERN_INVALID: (d) =>
    `secretPatterns: unsupported pattern ${str(d.pattern)} (no negation "!", no comment "#", not empty, no line break).`,
  EMPTY_PROMPT: () => 'the task prompt is empty.',
  EMPTY_REPO: () => 'the main repository has no commit yet: create one before starting an agent.',
  HISTORICAL_SECRETS_FOUND: (d) =>
    `secrets found in the repository history (${list(d.historical)}): an agent could read them through git history even if sparse-checkout hides them. Revoke them, then rerun with --allow-historical-secrets (a conscious decision), or set secretPatterns: [] to disable this check.`,
  INVALID_AGENT_NAME: (d) =>
    `invalid agent name "${str(d.name)}": letters, digits, dashes and underscores, starting with a letter or digit (64 characters max).`,
  // Several producers share this code with different identifiers (CLI option,
  // MCP tool argument, Control Protocol method/param). Unusable details: null,
  // so the producer's own detailed message survives (never "invalid value for ?").
  INVALID_ARGUMENT: (d) => {
    if (d.method && d.param)
      return `invalid parameter "${str(d.param)}" for "${str(d.method)}"${d.keyword ? ` (${str(d.keyword)})` : ''}.`;
    if (d.argument) return `invalid or missing argument "${str(d.argument)}".`;
    if (d.option) {
      const value = d.value ?? d.port;
      const allowed = Array.isArray(d.allowed) ? ` (expected one of: ${list(d.allowed)})` : '';
      return value === undefined || value === null
        ? `invalid value for ${str(d.option)}.`
        : `invalid value for ${str(d.option)}: ${str(value)}${allowed}.`;
    }
    return null;
  },
  INVALID_PID: (d) => `invalid PID: ${str(d.pid)} (a positive integer is expected).`,
  INVALID_RETENTION_DAYS: (d) =>
    `invalid retention: ${str(d.days)} (a whole number of days >= 0 is expected).`,
  LLM_CONFIG_INVALID: (d) =>
    byReason(
      LLM_CONFIG_REASONS,
      d,
      'invalid LLM configuration',
      'invalid LLM configuration (see striart doctor).',
    ),
  LLM_FAILED: (d) => `the LLM did not answer correctly${llmTarget(d)}${llmBecause(d)}`,
  LOCK_PID_DEAD: (d) =>
    `PID ${str(d.pid)} is not a live process: the reservation would protect nothing.`,
  LOCK_PID_EPHEMERAL: (d) =>
    `cannot watch the calling process (PID ${str(d.pid)}, ${str(d.image ?? 'unknown')}): it would exit with this command and lift the reservation at once. Name the shell to watch with --pid.`,
  LOCK_REASON_EMPTY: () => 'the reservation reason is empty.',
  LOCK_LOST: (d) =>
    d.reason === 'NOT_HELD'
      ? 'an irreversible step ran outside the main repository lock: refused, nothing was written.'
      : `the main repository lock was lost during "${str(d.operation)}": another process${d.holderPid ? ` (PID ${str(d.holderPid)})` : ''} broke or took it over. Nothing was committed; the repository stays recoverable (the next Striart operation aborts a merge left open). Check who acted (striart doctor) before retrying.`,
  LOCK_WAIT_CANCELLED: (d) =>
    `waiting for the main repository lock was cancelled for "${str(d.operation)}": the operation never started, nothing was changed.`,
  LOCK_IO_FAILED: (d) =>
    `cannot ${str(d.operation)} ${str(d.path)} (${str(d.cause)}): the main repository lock (.striart/main.lock, .striart/lock-queue/) cannot be handled safely, nothing was done. Check the permissions of .striart/ and that no antivirus or indexer holds those files.`,
  LOCK_TIMEOUT: (d) => {
    const held = `could not get the main repository lock: held by "${str(d.holder)}" (PID ${str(d.pid)})${typeof d.heldForMs === 'number' ? ` for ${formatDuration(d.heldForMs)}` : ''}${typeof d.waitingAhead === 'number' && d.waitingAhead > 0 ? `, ${d.waitingAhead} ${plural(d.waitingAhead, 'operation', 'operations')} queued ahead` : ''}.`;
    if (d.reason === 'HOLDER_FROZEN')
      return `${held} Its holder is ALIVE but frozen (no heartbeat for ${formatDuration(Number(d.heartbeatAgeMs ?? 0))}): it is not broken, since breaking it would leave two processes in the critical section once it resumes. Stop PID ${str(d.pid)} if it is stuck, or allow breaking with lock.breakFrozenHolderAfterMs in striart.config.`;
    if (d.reason === 'LOCK_UNREADABLE')
      return `${held} The lock file is unreadable: it is never broken blindly — check the permissions of .striart/.`;
    if (d.reason === 'BREAK_IN_PROGRESS')
      return `${held} Another process is breaking a stale lock and has not finished.`;
    if (d.reason === 'BREAK_FAILED')
      return `${held} The lock is stale (its holder is gone) but cannot be deleted${d.cause ? ` (${str(d.cause)})` : ''}: check the permissions of .striart/ and that no antivirus or indexer holds the file.`;
    return held;
  },
  MAIN_DIRTY: (d) =>
    `the main repository has uncommitted changes (${list(d.files)}): commit or stash first.`,
  MAIN_DIVERGED: (d) =>
    `"${str(d.mainBranch)}" has ${str(d.behind)} commit(s) outside the pipeline: promotion only fast-forwards. Reconcile by hand (merge ${str(d.mainBranch)} into the target branch).`,
  MAIN_SESSION_LIVE: (d) => `main repository reserved: "${str(d.reason)}" (PID ${str(d.pid)}).`,
  MCP_DEPTH_LIMIT: () =>
    'refused: this process descends from a Striart autonomous session; orchestration depth is bounded to 1 (read-only).',
  MCP_OVERLOADED: () =>
    'the Striart MCP server is busy (too many concurrent requests): retry later, or raise mcp.maxConcurrentRequests.',
  MCP_READ_ONLY: () => 'this MCP server was started with --read-only: mutating tools are disabled.',
  MCP_RESOURCE_UNKNOWN: (d) => `unknown MCP resource: ${str(d.uri)}.`,
  MCP_ROOT_INVALID: (d) =>
    `--root does not designate an initialized Striart repository: ${str(d.root)} (run "striart init" there, or point --root to the main repository).`,
  MCP_SCOPE_CONFLICT: (d) =>
    `--agent ${str(d.agent)} contradicts the clone of agent "${str(d.cwdAgent)}" designated by the working directory.`,
  MCP_SCOPE_DENIED: (d) =>
    `outside the scope of this MCP server${d.boundAgent ? ` (bound to agent "${str(d.boundAgent)}")` : ''}: start it from the agent's clone or with --agent, or set mcp.scope: 'orchestrator' outside any clone.`,
  MEMORY_FAILED: (d) => `the shared memory update failed${llmTarget(d)}${llmBecause(d)}`,
  MERGE_ABORT_FAILED: () =>
    'git merge --abort failed: the main repository is stuck mid-merge. Manual action required ("git merge --abort", then check "git status").',
  MERGE_STATE_CHANGED: (d) =>
    `the main repository changed under ${d.agent ? `the merge of "${str(d.agent)}"` : `"${str(d.operation)}"`} (expected MERGE_HEAD ${d.expectedMergeHead ? str(d.expectedMergeHead).slice(0, 8) : 'none'}, found ${d.actualMergeHead ? str(d.actualMergeHead).slice(0, 8) : 'none'}; expected HEAD ${str(d.expectedHead).slice(0, 8)}, found ${d.actualHead ? str(d.actualHead).slice(0, 8) : 'none'}): nothing was committed. Someone acted on the main repository meanwhile — check "git status" and "git log -3" before retrying.${d.markerWritten === false ? ' The protection marker could not be recorded: the next Striart operation may abort the merge left open — finish or abort it yourself before retrying.' : ''}`,
  MERGE_RECOVERY_BLOCKED: (d) =>
    `a merge is open in the main repository that Striart will NOT abort: an earlier operation${d.operation ? ` (${str(d.operation)})` : ''} found it did not own it (MERGE_STATE_CHANGED). Finish it (git commit) or abort it yourself (git merge --abort); deleting ${str(d.marker)} lets Striart abort it.`,
  MERGE_FAILED: (d) => `merging "${str(d.agent)}" failed${because(d.cause)}`,
  NATIVE_COMMAND_FAILED: (d) => {
    if (d.reason === 'TIMEOUT')
      return `the native binary did not answer in time (${str(d.command)}).`;
    if (d.reason === 'SPAWN') return `the native binary could not be started (${str(d.path)}).`;
    if (d.reason === 'NO_REPORT')
      return `the native process container produced no report${d.nativeCode ? ` (${str(d.nativeCode)})` : ''}.`;
    return `the native binary failed (${str(d.command)}${d.nativeCode ? `: ${str(d.nativeCode)}` : ''}).`;
  },
  NATIVE_INTEGRITY_FAILED: (d) => {
    if (d.reason === 'DIGEST_MISMATCH')
      return `the native binary ${str(d.path)} does not match the SHA-256 recorded in the signed manifest: it was not run.`;
    if (d.reason === 'SIGNATURE_INVALID' || d.reason === 'SIGNATURE_UNREADABLE')
      return `the signature of the native binaries manifest is invalid${d.scheme ? ` (${str(d.scheme)})` : ''}: no native binary is run.`;
    if (d.reason === 'MANIFEST_MISSING')
      return 'the native binaries manifest is missing from the package: the expected digest is unknown, the binary is not run.';
    if (d.reason === 'PACKAGE_VERSION_MISMATCH' || d.reason === 'MANIFEST_VERSION_MISMATCH')
      return 'the native binary package and the main package have different versions: the binary is not run.';
    return 'the integrity of the native binary could not be established: it is not run.';
  },
  NATIVE_PROTOCOL_ERROR: (d) =>
    `the native binary answered outside its protocol${d.reason ? ` (${str(d.reason)})` : ''}: it may belong to another Striart version.`,
  NATIVE_UNAVAILABLE: (d) => {
    if (d.reason === 'DEV_BUILD_MISSING')
      return `the native binary is not built in this checkout (${str(d.path)}).`;
    if (d.reason === 'PACKAGE_MISSING')
      return `the native package ${str(d.package)} is not installed (optional dependencies skipped?).`;
    if (d.reason === 'PLATFORM_UNSUPPORTED' || d.reason === 'PLATFORM_NOT_PUBLISHED')
      return `no native binary is published for ${str(d.platform)}.`;
    if (d.reason === 'ENV_NOT_ABSOLUTE') return 'STRIART_NATIVE_BIN must be an absolute path.';
    if (d.reason === 'ENV_MISSING')
      return `STRIART_NATIVE_BIN points to a missing file: ${str(d.path)}.`;
    if (d.reason === 'BINARY_MISSING')
      return `the native binary is missing from its package (${str(d.path)}).`;
    return 'the native binary is unavailable.';
  },
  NOT_A_GIT_REPO: (d) => `no git repository found from ${str(d.cwd)}.`,
  NOT_A_STRIART_MERGE: () =>
    'the last commit of the target branch is not a Striart merge: rollback only undoes the merge at the tip.',
  NOT_INITIALIZED: (d) => `.striart/ not found in ${str(d.root)}.`,
  MISSING_OPTION: (d) => `missing option: one of ${list(d.options)} is required.`,
  OPTION_CONFLICT: (d) => {
    if (d.reason === 'NEEDS_UNATTENDED')
      return `${list(d.options)} only makes sense with --autonomous or --on-main.`;
    if (d.reason === 'NEEDS_START') return `${list(d.options)} only works with --start.`;
    if (d.reason === 'NEEDS_PREPARE') return `${list(d.options)} only works with --prepare.`;
    return `incompatible options: ${list(d.options)}.`;
  },
  PERMISSION_ID_INVALID: () => 'invalid permission request id.',
  PERMISSION_NOT_PENDING: () => 'this permission request is no longer pending.',
  PERMISSION_OPTION_UNKNOWN: (d) =>
    `unknown option "${str(d.optionId)}" for permission request "${str(d.id)}"${Array.isArray(d.known) ? ` (known: ${list(d.known)})` : ''}.`,
  PLAN_INVALID: (d) => byReason(PLAN_REASONS, d, 'invalid plan', 'invalid plan.'),
  PLAN_NOT_FOUND: (d) => `plan not found: ${str(d.file)}`,
  // Lot O — collaboration channel, human reviews, orchestration state.
  COLLAB_MESSAGE_INVALID: (d) => `invalid collaboration message (${str(d.reason)}).`,
  COLLAB_RECIPIENT_UNKNOWN: (d) =>
    `no role "${str(d.to)}" in collaboration group ${str(d.group)}: address a member role or "*".`,
  COLLAB_GROUP_AMBIGUOUS: (d) =>
    `agent "${str(d.agent)}" belongs to several collaboration groups (${list(d.groups)}): name the group.`,
  COLLAB_ROLE_AMBIGUOUS: (d) =>
    `agent "${str(d.agent)}" holds several roles in group ${str(d.group)} (${list(d.roles)}): name the sending role.`,
  COLLAB_NOT_MEMBER: (d) =>
    `agent "${str(d.agent)}" is not a member of an open collaboration group: messages are only exchanged inside an orchestrated collaboration.`,
  COLLAB_KIND_FORBIDDEN: (d) =>
    `message kind "${str(d.kind)}" refused: a verdict is accepted only from a reviewer role during its own review turn.`,
  COLLAB_LIMIT_REACHED: (d) =>
    `collaboration message refused: group ${str(d.group)} reached its ${d.limit === 'sender' ? 'per-sender' : 'total'} message limit (collab.${d.limit === 'sender' ? 'maxMessagesPerSender' : 'maxMessages'}).`,
  COLLAB_DISABLED: () => 'the collaboration channel is disabled (collab.enabled: false).',
  COLLAB_GROUP_UNKNOWN: (d) => `unknown collaboration group "${str(d.group)}".`,
  COLLAB_CORRUPT: (d) => `collaboration state file is corrupted: ${str(d.path)}${because(d.cause)}`,
  REVIEW_UNKNOWN: (d) => `unknown review request "${str(d.reviewId)}" (see striart review).`,
  REVIEW_NOT_PENDING: (d) =>
    `review ${str(d.reviewId)} is not pending (${str(d.reason)}): its verdict can no longer be given.`,
  REVIEW_VERDICT_INVALID: (d) =>
    d.reason === 'ID_REQUIRED'
      ? 'a verdict needs the id of a review request.'
      : d.reason === 'COMMENT_REQUIRED'
        ? '--request-changes needs --comment: the author must know what to fix.'
        : `invalid review verdict (${str(d.reason)}).`,
  REVIEW_CORRUPT: (d) => `review request file is corrupted: ${str(d.path)}${because(d.cause)}`,
  ORCHESTRATION_STATE_CORRUPT: (d) =>
    `orchestration state file is corrupted: ${str(d.path)}${because(d.cause)}`,
  RACE_JUDGE_FAILED: (d) =>
    `the race judge did not produce a valid ranking${llmTarget(d)}${llmBecause(d)}`,
  ORCHESTRATE_USAGE: (d) =>
    d.reason === 'OPTION_NOT_FOR_MODE'
      ? `option ${str(d.option)} does not apply to "orchestrate ${str(d.mode)}".`
      : d.reason === 'MISSING_OPTION'
        ? `"orchestrate ${str(d.mode)}" needs ${str(d.option)}.`
        : `invalid "orchestrate" usage (${str(d.reason)}).`,
  PORT_IN_USE: (d) => `port ${str(d.port)} is already in use on 127.0.0.1.`,
  ACP_BINARY_DOWNLOADED: (d) =>
    `acpRegistry.allowBinaryDownload: downloaded ${str(d.id)} ${str(d.version)} (sha256 verified).`,
  ACP_AGENT_UNKNOWN: (d) =>
    `unknown ACP registry agent "${str(d.id)}"${Array.isArray(d.known) && d.known.length > 0 ? ` (known: ${list(d.known)})` : ''}.`,
  ACP_REGISTRY_FETCH_FAILED: (d) =>
    `the ACP registry could not be fetched${d.status ? ` (HTTP ${str(d.status)})` : because(d.cause)}`,
  ACP_REGISTRY_INVALID: (d) => `the ACP registry document is invalid (${str(d.reason)}).`,
  ACP_IMPORT_UNPINNED: (d) =>
    `ACP agent "${str(d.id)}" does not pin an exact ${str(d.distribution)} version: import refused.`,
  ACP_IMPORT_PLATFORM_UNSUPPORTED: (d) =>
    `ACP agent "${str(d.id)}" publishes no distribution for this platform (${str(d.platform)})${Array.isArray(d.available) ? `; available: ${list(d.available)}` : ''}.`,
  ACP_IMPORT_NO_INTEGRITY: (d) =>
    `ACP agent "${str(d.id)}" publishes no sha256 checksum: download refused (integrity cannot be verified).`,
  ACP_DOWNLOAD_INTEGRITY_MISMATCH: (d) =>
    `the downloaded archive of "${str(d.id)}" does not match the registry checksum: rejected.`,
  ACP_EXTRACT_FAILED: (d) => `the archive of ACP agent "${str(d.id)}" could not be extracted.`,
  ACP_EXTRACT_UNSAFE: () =>
    'ACP archive refused: link, special entry or path outside the install directory.',
  ACP_IMPORT_ENV_FORBIDDEN: (d) =>
    `ACP agent "${str(d.id)}" asks for the environment variable ${str(d.variable)}: import refused (allow it in acpRegistry.allowEnv; interpreter and loader variables are never allowed).`,
  SAFE_WRITE_UNSAFE: (d) =>
    `write refused: ${str(d.reason)} (${str(d.path)}). Striart does not write through links inside an agent clone.`,
  PROFILE_INVALID: (d) =>
    byReason(
      PROFILE_REASONS,
      d,
      'invalid agent profile',
      'invalid agent profile (see striart profiles).',
    ),
  PROFILE_UNKNOWN: (d) =>
    `unknown profile${d.profile ? ` "${str(d.profile)}"` : ''}${Array.isArray(d.known) ? ` (known: ${d.known.join(', ')})` : ''}.`,
  PROTECTED_PATHS_CHANGED: (d) =>
    `the commit of "${str(d.agent)}" also changes protected paths (${list(d.files)}) with no human resolution prepared: rerun "striart merge ${str(d.agent)}" to refresh ticket ${str(d.ticketId)} with them, then decide each one.`,
  COMMITTER_IDENTITY_MISSING: () =>
    'no git identity for the user in the main repository: a Striart commit would have no legitimate committer. Set user.name and user.email.',
  STRIART_COMMIT_UNSAFE: (d) =>
    `Striart commit undone: it held paths that are not allowed (${list(d.files)}).`,
  PROMOTION_DISABLED: () =>
    'promotion is disabled: set mainBranch (different from targetBranch) in striart.config.',
  PTY_ATTACH_LISTEN_FAILED: (d) =>
    `the terminal host of "${str(d.agent)}" could not listen for attach clients${because(d.message)}`,
  TOKEN_BUDGET_EXCEEDED: (d) =>
    `token budget exceeded (${str(d.scope)}, ${str(d.metric)}: ${str(d.used)} > ${str(d.limit)})${d.role ? ` for the ${str(d.role)} call` : ''}: refused before any request was sent. Raise tokens.budgets.${str(d.scope)} in striart.config, or wait for the period to roll over.`,
  TOKEN_PRICE_MISSING: (d) =>
    `a cost ceiling is configured but no price is declared for ${str(d.provider)}:${str(d.model)}: the ceiling cannot be enforced, so the call was refused. Declare the model in tokens.pricing (with its "asOf" date) or remove the cost ceiling.`,
  MERGE_WINDOW_EXCEEDED: (d) =>
    `the conflict in ${str(d.file)} needs about ${str(d.estimatedTokens)} tokens, above the Merger window (tokens.merger.maxWindowTokens = ${str(d.maxWindowTokens)}): resolve it by hand instead of letting the model truncate it.`,
  USAGE_PERIOD_INVALID: (d) =>
    d.value
      ? `invalid period "${str(d.value)}": use a duration (7d, 24h, 30m), "today" or a UTC date (YYYY-MM-DD).`
      : 'invalid period: --since is after --until.',
  PTY_HOST_SPAWN_FAILED: (d) => {
    const log = d.logFile ? ` (log: ${str(d.logFile)})` : '';
    if (d.reason === 'TIMEOUT')
      return `the terminal host of "${str(d.agent)}" did not become ready in time${log}.`;
    if (d.reason === 'EXITED') {
      const cause = [
        d.nativeCode ? str(d.nativeCode) : null,
        d.exitCode !== undefined && d.exitCode !== null ? `exit code ${str(d.exitCode)}` : null,
        d.signal ? `signal ${str(d.signal)}` : null,
      ].filter(Boolean);
      return `the terminal host of "${str(d.agent)}" exited before being ready${cause.length > 0 ? ` (${cause.join(', ')})` : ''}${log}.`;
    }
    return 'the terminal host could not be started.';
  },
  PTY_HOST_ALREADY_RUNNING: (d) =>
    `a terminal host already runs for agent "${str(d.agent)}": attach to it instead of starting another.`,
  PTY_HOST_UNKNOWN_AGENT: (d) => `unknown agent "${str(d.agent)}": not in the registry.`,
  PTY_SHELL_INVALID: (d) => {
    if (d.reason === 'RELATIVE_PATH')
      return 'pty.shell is a relative path: use a bare name (looked up in PATH) or an absolute path.';
    if (d.reason === 'NOT_EXECUTABLE')
      return 'pty.shell points to something that is not an executable file.';
    return 'pty.shell was not found (bare names are looked up in the absolute PATH entries only).';
  },
  PTY_SESSION_NOT_FOUND: (d) => `no terminal session for "${str(d.agent)}".`,
  REGISTRY_CORRUPT: (d) =>
    `the agent registry (.striart/agents.json) is unreadable${because(d.cause)}`,
  QUEUE_CORRUPT: (d) => `the queue (.striart/queue.json) is unreadable${because(d.cause)}`,
  LOCKS_CORRUPT: (d) => `the locks file (.striart/locks.json) is unreadable${because(d.cause)}`,
  STATE_CORRUPT: (d) => `the state file (.striart/state.json) is unreadable${because(d.cause)}`,
  STATE_READ_FAILED: (d) =>
    `the state file ${str(d.path)} could not be read (${str(d.cause)}), even after retrying: check its permissions, or whether another program keeps it locked.`,
  STATE_WRITE_FAILED: (d) =>
    `the state file ${str(d.path)} could not be written (${str(d.cause)}), even after retrying: nothing was changed, the previous state is intact. Check free disk space and permissions, or whether another program keeps it locked.`,
  STATE_LOCK_TIMEOUT: (d) =>
    d.reason === 'BREAK_FAILED'
      ? `the state lock (${str(d.lockFile)}) is stale (its holder is gone) but cannot be removed (${str(d.cause)}): the state write was abandoned. Check permissions on .striart/ and that no antivirus or indexer keeps the file open.`
      : d.reason === 'LOCK_UNREADABLE'
        ? `the state lock (${str(d.lockFile)}) is unreadable (${str(d.cause)}) and is never broken blindly: the state write was abandoned. Check permissions on .striart/.`
        : `the state lock (${str(d.lockFile)}) is still held by PID ${str(d.pid)}${typeof d.heldForMs === 'number' ? ` after ${formatDuration(d.heldForMs)}` : ''}: the state write was abandoned. A live holder is never broken; if that process is stuck, stop it.`,
  STATE_LOCK_LOST: (d) =>
    `the state lock (${str(d.lockFile)}) was lost before writing: nothing was written, the previous state is intact. Retry the command.`,
  STATE_LOCK_FAILED: (d) =>
    `the state lock (${str(d.lockFile)}) could not be ${typeof d.operation === 'string' ? `handled (${d.operation}, ${str(d.cause)})` : `created (${str(d.cause)})`}: check permissions on .striart/.`,
  TICKET_CORRUPT: (d) =>
    `ticket "${str(d.ticketId)}" is unreadable (${str(d.cause)}): its content can be neither read, prepared nor applied. Inspect ${str(d.path)}, then close it.`,
  CLONE_REMOVAL_PENDING: (d) =>
    `the removal of the clone of "${str(d.name)}" was started and is not finished: the name cannot be reused until it completes (striart reconcile finishes it).`,
  MAIN_SESSION_CORRUPT: (d) =>
    `the main-session file (.striart/main-session.json) is unreadable${because(d.cause)}`,
  RESOLUTION_INCOMPLETE: (d) =>
    Array.isArray(d.stillConflicted)
      ? `file(s) still conflicted after applying the resolution: ${list(d.stillConflicted)}.`
      : `the resolution is incomplete: every conflicted file needs a .resolved or .delete file${Array.isArray(d.missing) ? ` (missing: ${list(d.missing)})` : ''}.`,
  REUSE_DIRTY: (d) =>
    `the clone of "${str(d.name)}" has uncommitted work: reusing it would destroy it.`,
  REUSE_FETCH_FAILED: (d) => `resynchronizing "${str(d.name)}" failed: ${str(d.cause)}`,
  REUSE_IN_USE: (d) =>
    `the clone of "${str(d.name)}" shows recent disk activity: check that nothing works in it, or --force.`,
  REUSE_NEEDS_AGENT: () => '--reuse needs an explicit agent name (--agent).',
  REUSE_NO_CLONE: (d) => `no clone to reuse for "${str(d.name)}".`,
  REUSE_UNMERGED: (d) =>
    `the clone of "${str(d.name)}" holds commits missing from main: rewriting them would lose them.`,
  ROUTER_FAILED: (d) =>
    `the Router could not predict the touched files${llmTarget(d)}${llmBecause(d)}`,
  SECRETS_EXCLUSION_FAILED: (d) =>
    `excluding secrets from the clone of "${str(d.name)}" failed (git 2.35+ is required for sparse-checkout --no-cone)${becauseThen(d.cause)} Update git, or disable explicitly with secretPatterns: [] in striart.config.`,
  SEMANTIC_MERGE_FAILED: (d) => `the semantic merge failed${llmTarget(d)}${llmBecause(d)}`,
  SESSION_LIVE: (d) =>
    `a session is running in the clone of "${str(d.agent)}" (PID ${str(d.pid)}).`,
  SESSION_LOG_UNAVAILABLE: (d) =>
    `no session log for "${str(d.agent)}" yet: the session may not have started.`,
  STALE_TICKET: (d) => {
    if (Array.isArray(d.expected))
      return `ticket ${str(d.ticketId)} is stale: it expected conflicts on ${list(d.expected)}, the replayed merge conflicts on ${list(d.actual)}. Rerun a normal merge to get a fresh ticket.`;
    if (d.sha)
      return `ticket ${str(d.ticketId)} is stale: commit ${str(d.sha).slice(0, 8)} is no longer in the main repository (the agent history may have been rewritten). Rerun a normal merge to get a fresh ticket.`;
    return 'the ticket no longer matches the current state of the repository.';
  },
  TARGET_BRANCH_MISMATCH: (d) =>
    `the main repository is on "${str(d.currentBranch)}" but the target branch is "${str(d.expectedBranch)}".`,
  TERMINAL_UNSAFE: () => 'opening a terminal was refused: an argument cannot be passed safely.',
  TERMINAL_LAUNCHER_UNSUPPORTED: (d) =>
    `terminal launcher "${str(d.launcher)}" is not available on this platform (${str(d.platform)}): pick another one in terminal.launcher.`,
  TERMINAL_CONTEXT_MISSING: () =>
    'cannot open Warp: the directory is not a Striart agent clone (root and agent unknown).',
  WARP_NOT_FOUND: (d) =>
    d.path
      ? `cannot open Warp: its data directory ${str(d.path)} is missing (is Warp installed for this user?).`
      : 'cannot open Warp: %APPDATA% is not set, the Tab Configs directory cannot be located.',
  // Avertissement de `striart hook` (jamais une erreur : un hook ne bloque pas).
  HOOK_ADVISORY_SKIPPED: () => 'hook skipped: neutral answer sent, nothing was blocked.',
  USER_CONFIG_INVALID: (d) =>
    `the Striart user config is invalid (${str(d.reason)}${d.key ? `, key ${str(d.key)}` : ''}): it is ignored, no root is trusted.`,
  USER_CONFIG_UNSAFE: (d) =>
    `the Striart user config ${str(d.path)} is writable by group or others, or not owned by you: it is ignored (chmod 600).`,
  NET_OFFLINE: (d) =>
    `offline mode: the outbound call to ${str(d.host)} (${str(d.purpose)}) is refused. Remove network.offline (user config) or STRIART_OFFLINE to allow the network.`,
  NET_HOST_NOT_ALLOWED: (d) =>
    `host ${str(d.host)} is not in the network allow-list (${str(d.purpose)}). Add it to network.allowedHosts (user config) or STRIART_ALLOWED_HOSTS if intended.`,
  NET_INSECURE_TRANSPORT: (d) =>
    d.reason === 'TLS_VERIFICATION_DISABLED'
      ? `NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification: the call to ${str(d.host)} is refused. Unset it and add the corporate CA instead (NODE_EXTRA_CA_CERTS).`
      : `HTTPS is required outside the loopback: ${str(d.host)} will not be reached in clear text (${str(d.purpose)}). Use https://, or list the host in network.allowInsecureHosts (user config) knowingly.`,
  NET_REDIRECT_REFUSED: (d) =>
    d.reason === 'TOO_MANY'
      ? `too many redirects (${str(d.purpose)}): refused.`
      : `${str(d.host)} answered with a redirect: refused (none is ever followed). Fix the URL to point at the right address directly.`,
  NET_URL_INVALID: (d) =>
    d.reason === 'SCHEME'
      ? `scheme ${str(d.protocol)} refused for an outbound call (http and https only).`
      : 'invalid outbound URL.',
  NET_PROXY_UNSUPPORTED: (d) =>
    `the proxy configured for ${str(d.host)} has an unsupported scheme: it must be an http:// or https:// URL (SOCKS proxies are not supported).`,
  NET_TLS_UNTRUSTED: (d) =>
    `untrusted certificate for ${str(d.host)} (${str(d.certCode)}). Add the corporate CA: NODE_EXTRA_CA_CERTS=<file.pem> (read at startup), node --use-system-ca / NODE_USE_SYSTEM_CA=1, or network.caFile (user config). Never NODE_TLS_REJECT_UNAUTHORIZED=0.`,
  NET_CA_INVALID: (d) =>
    `the corporate CA file is unusable (${str(d.reason)}): network.caFile must be a PEM file containing "BEGIN CERTIFICATE".`,
  HOOK_TOOL_UNKNOWN: (d) =>
    `unknown hook tool "${str(d.tool)}" (claude, codex, copilot, gemini, cline).`,
  HOOK_SCOPE_REQUIRED: () =>
    'say where to install the hook: --user (user configuration) or --agent <name> (clone).',
  HOOK_CONFIG_UNREADABLE: (d) =>
    `the tool configuration ${str(d.path)} is unreadable: it was left untouched — fix it, then retry.`,
  HOOK_TARGET_TRACKED: (d) =>
    `refused: ${str(d.path)} is versioned by the repository — the agent would commit it and the protected-paths guard would refuse the merge. Install the hook for the user (--user).`,
  HOOK_TARGET_FOREIGN: (d) => `refused: ${str(d.path)} exists and was not written by Striart.`,
  HOOK_PATH_UNSAFE: (d) =>
    d.path
      ? `refused: ${str(d.path)} contains a space or a special character that cmd and PowerShell would not read alike — set STRIART_HOOK_BIN_DIR to a directory without spaces.`
      : 'refused: a path cannot be written safely into the hook configuration (line break, NUL, "%" or a double quote).',
  TICKET_ALREADY_RESOLVED: (d) => `ticket ${str(d.ticketId)} is already resolved.`,
  TICKET_NOT_APPLICABLE: (d) =>
    `ticket ${str(d.ticketId)} (${str(d.reason)}) has no file-by-file conflict to resolve: fix the agent code and rerun a normal merge, or close the ticket.`,
  TICKET_UNKNOWN: (d) => `unknown ticket: "${str(d.ticketId)}".`,
  UI_REQUIRES_TTY: () =>
    '"watch --ui" needs an interactive terminal (standard input is redirected or missing).',
  UNKNOWN_BRANCH: (d) =>
    `branch "${str(d.branch)}" (${str(d.setting)}) does not exist in the main repository.`,
  UNSUPPORTED_OUTPUT_FORMAT: (d) =>
    `"striart ${str(d.command)}" has no --json output (protocol or interactive terminal).`,
  UNSUPPORTED_RESOLUTION_KIND: (d) =>
    `--apply cannot resolve these conflicts (${list(d.unsupported)}): resolve them with git directly in the main repository, then "striart resolve --close ${str(d.ticketId)}".`,
  UNTRACKED_COLLISION: (d) =>
    `merging "${str(d.agent)}" was refused: untracked files in the main repository would be overwritten${becauseThen(d.cause)} Commit, move or delete them, then rerun the merge.`,
};

/** `doctor` findings, by stable key. */
const DOCTOR_LABELS: Record<string, string> = {
  git: 'Git version',
  native: 'Native component',
  gate: 'Test Gate',
  pty: 'Terminal host (pty)',
  repo: 'Git repository',
  init: 'Striart setup',
  config: 'Configuration',
  branch: 'Target branch',
  llm: 'LLM (Router/Merger)',
  network: 'Network',
  secrets: 'Historical secrets',
  lock: 'Main lock',
  'state-lock': 'State lock',
  'main-session': 'Main repository',
  agents: 'Agents',
  tickets: 'Conflict tickets',
  manual: 'Semantic merge',
  protected: 'Protected paths',
  mcp: 'MCP server',
  profiles: 'Agent profiles',
  tokens: 'Tokens and cost',
  orchestration: 'Orchestration',
  idle: 'Idle GC',
  dashboard: 'Dashboard (hosts)',
  'state-privacy': 'Local data (.striart/)',
  'gate-env': 'Test Gate environment',
  delivery: 'Delivery',
  performance: 'Performance',
  relaxations: 'Relaxed protections',
};

/** `delivery` doctor line (policy information, not a relaxation). */
const deliveryDetail = (p: Record<string, unknown>): string => {
  const seconds = (ms: unknown) => `${Math.round(Number(ms) / 1000)} s`;
  let mode = 'autoPush is off: nothing is delivered to origin';
  if (p.autoPush) {
    mode =
      p.delivery === 'branch'
        ? 'BRANCH delivery: the tested commit goes to a review branch (PR/MR), never to the target branch'
        : 'delivery by pushing the target branch';
  }
  return `${mode}; push timeout ${seconds(p.pushTimeoutMs)} (pushTimeoutMs), merge commit timeout ${seconds(p.commitTimeoutMs)} (commitTimeoutMs)`;
};

/** Fragments of the main-lock doctor lines (src/lock.js readMainLockStatus). */
const lockBeat = (p: Record<string, unknown>): string =>
  typeof p.heartbeatAgeMs === 'number'
    ? `, last heartbeat ${formatDuration(p.heartbeatAgeMs)} ago`
    : '';
const lockQueue = (p: Record<string, unknown>): string =>
  typeof p.queued === 'number' && p.queued > 0 ? `, ${p.queued} queued` : '';
const lockRelaxed = (p: Record<string, unknown>): string =>
  typeof p.breakFrozenHolderAfterMs === 'number'
    ? ` — protection RELAXED: a frozen holder is broken after ${formatDuration(p.breakFrozenHolderAfterMs)} (lock.breakFrozenHolderAfterMs)`
    : '';

/** Trusted signing keys: the one pinned in the code and the user's own (native.trustedKeyIds). */
const nativeKeys = (p: Record<string, unknown>): string =>
  `trusted keys: pinned ${list(p.pinnedKeyIds)}; user (native.trustedKeyIds) ${
    p.trustedKeyIdsUnreadable === true
      ? 'unreadable'
      : Array.isArray(p.trustedKeyIds) && p.trustedKeyIds.length > 0
        ? list(p.trustedKeyIds)
        : 'none'
  }`;

const DOCTOR_DETAILS: Record<string, (p: Record<string, unknown>) => string> = {
  'git.tooOld': (p) => `${str(p.raw)}: at least ${str(p.min)} is required`,
  'git.old': (p) =>
    `${str(p.raw)}: ${str(p.recommended)}+ recommended (secret clean-up when cloning)`,
  'git.ok': (p) => str(p.raw),
  'git.missing': () => 'git not found in PATH',
  'native.ok': (p) =>
    `verified (${str(p.scheme)}, key ${str(p.keyId)}, SHA-256 matches) — v${str(p.version)} ${str(p.platform)} — ${str(p.path)} — ${nativeKeys(p)}`,
  'native.devBuild': (p) =>
    `unsigned development build — v${str(p.version)} ${str(p.platform)} — ${str(p.path)} — ${nativeKeys(p)}`,
  'native.explicit': (p) =>
    `set by STRIART_NATIVE_BIN, integrity NOT verified — v${str(p.version)} ${str(p.platform)} — ${str(p.path)} — ${nativeKeys(p)}`,
  'gate.native': (p) =>
    `native container (gateContainer) — orphan grace ${str(p.orphanGraceMs)} ms, log capped at ${str(p.maxOutputBytes)} bytes`,
  'gate.process': () =>
    'plain "process" container (gateContainer): tree killed on timeout only, NO orphan detection',
  'native.failed': (p) => {
    const why = ERRORS[str(p.code)]?.(p);
    return `${str(p.code)}: ${why ?? 'the native binary is unusable'}`;
  },
  'pty.ok': (p) =>
    `native host ${str(p.binary)} — shell ${str(p.shell)} (${p.source === 'config' ? 'pty.shell' : 'auto'})`,
  'pty.profileRisk': (p) =>
    `native host ${str(p.binary)} — shell ${str(p.shell)}: Windows PowerShell 5.1 loads your profiles at every start (slow, and failing under a restrictive execution policy)`,
  'pty.invalid': (p) => `pty.shell cannot be used: ${str(p.message)}`,
  'pty.native': (p) => `native host unavailable: ${str(p.code)}`,
  'repo.ok': (p) => str(p.root),
  'repo.noCommit': (p) => `${str(p.root)}: no commit, no agent can be cloned`,
  'repo.none': (p) => `no git repository from ${str(p.cwd)}`,
  'init.ok': (p) => str(p.dir),
  'init.missing': () => '.striart/ is missing',
  'config.unknownKeys': (p) => `unknown top-level key(s), ignored: ${list(p.keys)}`,
  'config.ok': (p) => (p.path ? str(p.path) : 'no file found, defaults in use'),
  'config.invalid': (p) => str(p.message),
  'branch.missing': (p) =>
    `targetBranch = "${str(p.target)}" does not exist: merge, sync, watch and rollback will fail`,
  'branch.mismatch': (p) =>
    `on "${str(p.branch)}" but targetBranch = "${str(p.target)}": merge and watch will refuse`,
  'branch.ok': (p) => str(p.branch),
  'branch.unreadable': () => 'HEAD is unreadable',
  'llm.ok': (p) => `${str(p.provider)}:${str(p.model)} @ ${str(p.url)}`,
  'llm.ollamaDown': (p) =>
    `ollama unreachable at ${str(p.url)}: striart run (Router) and the semantic merge are unavailable`,
  'llm.noKey': (p) => `${str(p.provider)}:${str(p.model)}: variable ${str(p.env)} is not set`,
  'llm.invalid': (p) => str(p.message),
  'llm.networkRefused': (p) => `ollama at ${str(p.url)}: ${str(p.code)} - ${str(p.message)}`,
  'network.userConfigUnreadable': (p) =>
    `user config unreadable (${str(p.code)}): network policy cannot be evaluated, non-local outbound calls are refused`,
  'network.envInvalid': (p) => str(p.message),
  'network.policy': (p) =>
    [
      p.offline ? 'offline (no non-local call: NET_OFFLINE)' : null,
      Array.isArray(p.allowedHosts) && p.allowedHosts.length > 0
        ? `allowed hosts: ${p.allowedHosts.map((l: unknown) => list(l)).join(' ∩ ')}`
        : null,
    ]
      .filter(Boolean)
      .join('; '),
  'network.direct': () => 'no proxy configured: direct connections',
  'network.proxyActive': (p) =>
    `proxy active (${str(p.source)}, per-request undici dispatcher): ${str(p.proxy)}${p.noProxy ? `; bypass: ${str(p.noProxy)}` : ''}`,
  'network.proxyInactive': (p) =>
    `proxy configured (${str(p.proxy)}) but INACTIVE (${str(p.problem)}): remote calls are refused (NET_PROXY_UNSUPPORTED)`,
  'network.tls': (p) =>
    [
      p.tlsMinVersion ? `minimum version ${str(p.tlsMinVersion)}` : null,
      p.caFile ? `corporate CA network.caFile ${str(p.caFile)}` : null,
      p.extraCaCerts ? `NODE_EXTRA_CA_CERTS ${str(p.extraCaCerts)}` : null,
      p.systemCa ? 'system CA (--use-system-ca)' : null,
    ]
      .filter(Boolean)
      .join('; '),
  'network.insecure': (p) =>
    `protection RELAXED: ${[
      Array.isArray(p.allowInsecureHosts) && p.allowInsecureHosts.length > 0
        ? `plain HTTP allowed to: ${list(p.allowInsecureHosts)} (network.allowInsecureHosts)`
        : null,
      p.tlsVerificationDisabled
        ? 'TLS verification disabled (NODE_TLS_REJECT_UNAUTHORIZED=0): remote calls are refused'
        : null,
    ]
      .filter(Boolean)
      .join('; ')}`,
  'secrets.ok': () => 'none',
  'secrets.disabled': () =>
    'secret exclusion from clones and the historical-secrets scan are disabled (secretPatterns: [])',
  'secrets.found': (p) =>
    `${list(p.files)} found in history: an agent could read them; start and run will refuse to clone`,
  'secrets.unreadable': (p) => `history is unreadable: ${str(p.message)}`,
  'lock.free': (p) => `free${lockQueue(p)}${lockRelaxed(p)}`,
  'lock.held': (p) =>
    `operation running: "${str(p.holder)}" (PID ${str(p.pid)}) since ${str(p.startedAt)}${lockBeat(p)}${lockQueue(p)}${lockRelaxed(p)}`,
  'lock.frozen': (p) =>
    `holder ALIVE but frozen: "${str(p.holder)}" (PID ${str(p.pid)})${lockBeat(p)}${lockQueue(p)} — never broken by default, every operation waits${lockRelaxed(p)}`,
  'lock.stale': (p) =>
    `orphan lock (${str(p.staleReason)}) of "${str(p.holder)}": broken by the next operation${lockRelaxed(p)}`,
  'lock.unreadable': (p) =>
    `main.lock is ${p.cause === 'invalid' ? 'invalid (interrupted creation?)' : 'unreadable'}: never broken blindly${lockRelaxed(p)}`,
  'lock.recoveryBlocked': (p) =>
    `third-party merge open in the main repository, reported by ${str(p.operation)} (MERGE_STATE_CHANGED): every operation refuses (MERGE_RECOVERY_BLOCKED) while it stays open${lockRelaxed(p)}`,
  'stateLock.free': () => 'free',
  'stateLock.held': (p) => `write in progress (PID ${str(p.pid)})`,
  'stateLock.orphan': (p) =>
    `orphaned (PID ${str(p.pid)}${p.alive ? ', unreadable content' : ' is dead'}): broken automatically by the next state write`,
  'stateLock.stuck': (p) =>
    `held by PID ${str(p.pid)} for ${formatDuration(Number(p.ageMs ?? 0))}: state writes wait, then fail (STATE_LOCK_TIMEOUT)`,
  'stateLock.unreadable': (p) => `unreadable state: ${str(p.cause)}`,
  'mainSession.free': () => 'free',
  'mainSession.busy': (p) =>
    `reserved by "${str(p.reason)}" (PID ${str(p.pid)}) since ${str(p.startedAt)}: merge, sync, promote and resolve --apply refuse while that process lives`,
  'mainSession.dead': (p) =>
    `declared session but PID ${str(p.pid)} is dead: released by the next operation`,
  'agents.ok': (p) =>
    `${str(p.active)} ACTIVE, ${str(p.queued)} queued, ${formatBytes(Number(p.sizeBytes ?? 0))} on disk`,
  'agents.broken': (p) =>
    `${str(p.active)} ACTIVE, ${str(p.queued)} queued, ${formatBytes(Number(p.sizeBytes ?? 0))} on disk; ${str(p.broken)} clone(s) in state ${list(p.states).replace(/, /g, '/')}`,
  'agents.unreadable': (p) => `unreadable state: ${str(p.message)}`,
  'tickets.open': (p) => `${str(p.count)} open, human resolution expected`,
  'tickets.none': () => 'no open ticket',
  'tickets.unreadable': (p) => `unreadable state: ${str(p.message)}`,
  'semantic.disabled': () => 'disabled (semanticMerge: false)',
  'semantic.manual': (p) =>
    `manual mode on (${str(p.streak)} consecutive failures): every conflict becomes a ticket`,
  'semantic.noLlm': () =>
    'unavailable while the LLM does not answer: every conflict becomes a ticket',
  'semantic.ok': (p) =>
    Number(p.streak) > 0 ? `operational (${str(p.streak)} consecutive failure(s))` : 'operational',
  'protected.ok': (p) =>
    `${str(p.defaults)} default patterns${Number(p.extend) > 0 ? ` + ${str(p.extend)} added (extend)` : ''}, case-insensitive: an agent changing them gets its merge refused (ticket)`,
  'protected.relaxed': (p) =>
    `protection RELAXED by the config:${Array.isArray(p.allow) && p.allow.length > 0 ? ` allow ${list(p.allow)}` : ''}${p.caseSensitive ? ' — case-sensitive matching (matchCase: platform)' : ''}. Logged at every merge.`,
  'protected.invalid': () => 'invalid protectedAgentPaths: every merge will fail',
  'mcp.relaxed': () =>
    "ORCHESTRATOR scope (mcp.scope: 'orchestrator'): outside any clone, an MCP server can run tasks, merge any agent and apply any resolution (never close a ticket without the Test Gate nor arbitrate a permission). Logged at startup.",
  'mcp.scoped': () =>
    'MCP tools bound to the calling agent (clone or --agent); read-only outside any clone',
  'orchestration.relaxed': (p) =>
    `protection RELAXED: ${list(p.keys)} — race losers deleted with their work (race.losers: clean) and/or reviewer changes reset instead of failing (review.reviewerWrites: discard).`,
  'dashboard.hostsRelaxed': (p) =>
    `Host check RELAXED: ${list(p.hosts)} served in addition to the loopback (dashboardAllowedHosts). The token, the SameSite=Strict session cookie, Sec-Fetch-Site, Origin and the anti-CSRF check are still required. Logged at every dashboard start.`,
  'dashboard.hostsStrict': () => 'Host limited to the loopback (127.0.0.1, localhost, [::1])',
  'dashboard.hostnameLocalhost': () =>
    'dashboardHostname is "localhost": the session cookie is sent by the browser to every localhost:* server (RFC 6265 section 8.5), e.g. an agent dev server that could replay it. Logged at every dashboard start.',
  'state-privacy.ok': (p) =>
    `${str(p.inspected)} item(s) of .striart/ restricted to the current user`,
  'state-privacy.open': (p) =>
    `${str(p.count)} item(s) of .striart/ readable by other accounts: ${
      Array.isArray(p.examples)
        ? p.examples.map((e: { path?: unknown }) => str(e?.path)).join(', ')
        : ''
    }`,
  'state-privacy.relaxed': () =>
    'protection RELAXED: .striart/ is not restricted to the current user (privateStateDir: false)',
  'state-privacy.unreadable': (p) =>
    `permissions of .striart/ could not be evaluated (${str(p.cause)})`,
  'gate-env.filtered': (p) =>
    `filtered environment: ${str(p.passed)} variable(s) passed, ${str(p.removedSecrets)} secret(s) removed, ${str(p.requested)} requested by the repository`,
  'gate-env.inherit': () =>
    'protection RELAXED: the Test Gate receives the WHOLE orchestrator environment, API keys included (gateEnv: "inherit")',
  'gate-env.refused': (p) =>
    `variables requested by the repository (gateEnv) but not allowed by the user config: ${list(p.names)}`,
  'network.allProxyIgnored': () =>
    'ALL_PROXY is not supported: the variable is ignored (Striart only reads HTTPS_PROXY, HTTP_PROXY and NO_PROXY), connections will NOT go through that proxy',
  'delivery.push': (p) => deliveryDetail(p),
  'delivery.branch': (p) => deliveryDetail(p),
  'performance.stateLock': (p) => {
    if (p.failed) return `state lock latency could not be measured: ${str(p.cause)}`;
    if (Number(p.samples) === 0)
      return 'state lock not obtained during the measurement: another process holds it or the disk does not answer';
    const base = `atomic write under the state lock: median ${str(p.medianMs)} ms, worst ${str(p.maxMs)} ms (${str(p.samples)} sample(s))`;
    if (p.level === 'alert')
      return `${base} — above ${Number(p.alertMs) / 1000} s: operations that write state queue up behind it`;
    if (p.level === 'slow') return `${base} — above the ${str(p.budgetMs)} ms budget`;
    return `${base} — within the ${str(p.budgetMs)} ms budget`;
  },
  'performance.gitStatus': (p) => {
    if (p.timedOut)
      return 'git status of the main repository did not answer within the measurement window';
    if (p.failed) return 'git status of the main repository failed';
    const slow = Number(p.ms) > Number(p.warnMs);
    return `git status of the main repository: ${str(p.ms)} ms${slow ? ` (above ${str(p.warnMs)} ms: status, the dashboard and merge guards suffer)` : ''}`;
  },
  'performance.stateDirSize': (p) =>
    `.striart/: ${formatBytes(Number(p.sizeBytes ?? 0))} on disk${p.complete ? '' : ' (walk stopped at the time limit: partial size)'}`,
  'performance.agentCount': (p) => `${str(p.count)} registered agent(s)`,
  'performance.oldestLock': (p) =>
    p.ageMs === null
      ? 'no lock held'
      : `${p.kind === 'main' ? 'main' : 'state'} lock held for ${Math.round(Number(p.ageMs) / 1000)} s${p.holder ? ` by "${str(p.holder)}"` : ''}${Number(p.ageMs) > 5 * 60_000 ? ': everything else waits (long Test Gate or LLM call, or a frozen holder)' : ''}`,
  'performance.unreadable': (p) => `performance measurements failed: ${str(p.message)}`,
  'relaxations.some': (p) =>
    [
      Number(p.count) > 0 ? `${str(p.count)} protection(s) relaxed: ${list(p.names)}` : null,
      Array.isArray(p.unreadable) && p.unreadable.length > 0
        ? `could not be evaluated: ${list(p.unreadable)}`
        : null,
    ]
      .filter(Boolean)
      .join('; '),
  'relaxations.none': () => 'no protection relaxed: safe defaults everywhere',
  'tokens.ok': (p) =>
    `accounting active (today ${str(p.tokens)} tokens), ${str(p.budgets)} ceiling(s) set, ${str(p.instructions)} instructions (~${str(p.instructionsTokens)} tokens)`,
  'tokens.relaxed': (p) =>
    `protection RELAXED: ${list(p.keys)} — accounting off and/or ceilings in alert-only mode and/or merger cache and/or LLM circuit breaker disabled.`,
  'tokens.exceeded': (p) =>
    `token ceiling reached: ${list(p.exceeded)} — the matching LLM calls and agent sessions are refused`,
  'tokens.warn': () => 'a token ceiling is close to being reached',
  'tokens.stalePrices': (p) =>
    `stale prices in tokens.pricing: ${list(p.stale)} — displayed costs may be wrong`,
  'tokens.unreadable': (p) => `usage ledger unreadable (${str(p.cause)})`,
  'idle.relaxed': (p) =>
    `protection RELAXED: ${list(p.keys)} — idle GC settings that lower a guard (see "striart gc").`,
  'idle.closeAuthorized': () =>
    'automatic closing of idle sessions is ON and authorized by the user config (warning, grace period; the clone and its work are always kept)',
  'idle.closeUnauthorized': (p) =>
    p.error
      ? `idle.action: 'close' requested but the user config is unreadable (${str(p.error)}): no session will be closed`
      : "idle.action: 'close' requested but this repository is not in idle.closeRoots of the user config: no session will be closed (warning only)",
  'idle.ok': (p) =>
    `idle agents are detected and reported (action: ${str(p.action)}); no session is closed automatically`,
  'orchestration.ok': () =>
    'orchestrated modes at safe defaults: race losers kept, reviewers verified read-only, nothing starts after a failure',
  'profiles.relaxed': (p) =>
    [
      p.download
        ? 'acpRegistry.allowBinaryDownload: --import-acp may DOWNLOAD a binary (pinned, sha256 verified, logged)'
        : null,
      p.noInstructions ? 'agentInstructions.enabled: false: agents receive no Striart rules' : null,
      Array.isArray(p.experimental) && p.experimental.length > 0
        ? `experimental presets declared (not verified in official docs): ${list(p.experimental)}`
        : null,
    ]
      .filter(Boolean)
      .join('; '),
  'profiles.ok': (p) =>
    `${str(p.count)} profiles (verified presets), Striart rules active, ACP import metadata-only`,
  'skip.noGit': () => 'git unavailable',
  'skip.noRepo': () => 'no repository',
  'skip.noConfig': () => 'configuration unavailable',
  'skip.noCommit': () => 'no commit',
};

const DOCTOR_HINTS: Record<string, (p: Record<string, unknown>) => string> = {
  'git.tooOld': () => 'upgrade git',
  'git.old': () => 'upgrade git',
  'git.missing': () => 'install git',
  'native.explicit': () => 'unset STRIART_NATIVE_BIN to use the signed binary of the package',
  'native.failed': (p) => {
    if (p.reason === 'DEV_BUILD_MISSING') return 'npm run native:build';
    if (p.code === 'NATIVE_INTEGRITY_FAILED')
      return 'reinstall Striart (npm install), then striart doctor';
    if (p.reason === 'PACKAGE_MISSING') return 'npm install (without --omit=optional)';
    return 'striart doctor --json (details), then reinstall Striart';
  },
  'pty.profileRisk': () =>
    'set pty.shellArgs to ["-NoLogo", "-NoProfile"], or pty.shell to "pwsh" (PowerShell 7)',
  'pty.invalid': () => 'fix pty.shell in striart.config, or set it back to "auto"',
  'config.invalid': () => 'fix striart.config (docs: configuration)',
  'config.unknownKeys': () =>
    'check the spelling (docs: configuration): a typo leaves a setting inactive',
  'branch.missing': () =>
    'fix targetBranch in striart.config (existing branches: git branch --list)',
  'llm.noKey': (p) => `set ${str(p.env)} (shell or .env file)`,
  'llm.invalid': () => 'fix llm in striart.config',
  'network.proxyInactive': (p) =>
    p.problem === 'SCHEME'
      ? 'use an http:// or https:// proxy URL'
      : 'start striart with NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24.5) or move to Node >= 24.14 / 25.4',
  'network.insecure': () =>
    'remove network.allowInsecureHosts / NODE_TLS_REJECT_UNAUTHORIZED if this is not intended',
  'secrets.found': () => 'revoke those secrets, then rerun with --allow-historical-secrets',
  'secrets.disabled': () =>
    'remove secretPatterns: [] (or list your own patterns) to restore the protection',
  'lock.frozen': (p) =>
    process.platform === 'win32' ? `taskkill /PID ${str(p.pid)} /F` : `kill ${str(p.pid)}`,
  'lock.recoveryBlocked': () => 'git merge --abort',
  'protected.relaxed': () =>
    'remove protectedAgentPaths.allow / matchCase from striart.config if this is not intended',
  'protected.invalid': () => 'fix protectedAgentPaths in striart.config',
  'mcp.relaxed': () => 'remove mcp.scope from striart.config if this is not intended',
  'tokens.relaxed': () =>
    'remove tokens.accounting / tokens.budgets.enforcement / llmResilience.breaker from striart.config if this is not intended',
  'idle.relaxed': () =>
    'remove idle.enabled / idle.closePty from striart.config if this is not intended',
  'idle.closeUnauthorized': () =>
    'add this repository root to idle.closeRoots in the user config (see docs), or set idle.action to warn',
  'orchestration.relaxed': () =>
    'remove orchestration.race.losers / orchestration.review.reviewerWrites from striart.config if this is not intended',
  'profiles.relaxed': () => 'remove those settings from striart.config if this is not intended',
  'dashboard.hostsRelaxed': () =>
    'remove dashboardAllowedHosts from striart.config if this is not intended',
  'dashboard.hostnameLocalhost': () =>
    'remove dashboardHostname (default "instance") unless your browser cannot resolve *.localhost',
  'state-privacy.open': () => 'striart init (tightens the existing data)',
  'state-privacy.relaxed': () =>
    'remove privateStateDir: false from striart.config, then run striart init',
  'state-privacy.unreadable': () => 'striart init',
  'gate-env.inherit': () => 'remove gateEnv: "inherit" from striart.config if this is not intended',
  'gate-env.refused': () =>
    'add them to gate.envAllow in the user config if they are intended, otherwise remove them from gateEnv',
  'relaxations.some': () =>
    'each dedicated line above details its relaxation; remove the matching setting if this is not intended',
  'network.allProxyIgnored': () =>
    'set HTTPS_PROXY / HTTP_PROXY (or network.proxy in the user config); SOCKS proxies are not supported',
  'performance.stateLock': (p) =>
    p.failed
      ? 'check the permissions of .striart/, then rerun striart doctor'
      : Number(p.samples) === 0
        ? 'striart status; rerun when the machine is idle'
        : 'loaded machine? exclude .striart/ from antivirus and indexing, then rerun when idle',
  'performance.gitStatus': () =>
    'git gc; check core.fsmonitor, the antivirus and the repository size',
  'performance.oldestLock': () => 'striart lock',
};

export const en: Messages = {
  levels: { ok: 'ok', info: 'info', warn: 'warning', error: 'error', skip: 'skipped' },
  levelSeparator: ': ',

  units: { duration: formatDuration, bytes: formatBytes },

  common: {
    log: (p) => `log: ${p}`,
    ticket: (id, dir) => `ticket ${id} (${dir})`,
    mode: (mode, profile) =>
      mode === 'autonomous' ? `autonomous${profile ? ` (${profile})` : ''}` : 'supervised',
  },

  main: {
    unexpected: (message) => `unexpected error: ${message}`,
    debugHint: 'STRIART_LOG_LEVEL=debug striart … (rerun with the full stack on stderr)',
    jsonUnsupported: (command) =>
      `"striart ${command}" has no --json output (protocol or interactive terminal).`,
    deprecatedForce: (command) =>
      `"striart ${command} --force" without --reuse is deprecated: use --allow-historical-secrets (same effect). The alias goes away in 0.12.`,
    uiNeedsTty:
      '"watch --ui" needs an interactive terminal (standard input is redirected or missing).',
    uiNeedsTtyHint: 'striart watch',
    pidNeedsStart: '--pid only works with --start.',
  },

  parse: {
    integer: (value, min, max) => `"${value}" is not an integer between ${min} and ${max}.`,
    agentName: (value) =>
      `invalid agent name "${value}": letters, digits, dashes and underscores, starting with a letter or digit (64 characters max).`,
    nonEmpty: 'the value cannot be empty.',
    ticketId: (value) => `invalid ticket id "${value}".`,
    projectPath: (value) =>
      `invalid project path "${value}": a path relative to the root, with "/" separators, no "..", no drive letter, no control character.`,
  },

  usageErrors: {
    unknownCommand: (name) => `unknown command "${name}".`,
    unknownOption: (name) => `unknown option "${name}".`,
    didYouMean: (suggestion) => `Did you mean "${suggestion}"?`,
    missingArgument: (name) => `missing argument: <${name}>.`,
    optionMissingArgument: (name) => `option ${name} needs a value.`,
    excessArguments: (expected, received) =>
      `too many arguments: ${received} given, ${expected} expected.`,
    conflictingOption: (a, b) => `options ${a} and ${b} cannot be combined.`,
    invalidArgument: (detail) => `invalid value: ${detail}`,
    missingCommand: 'no command given.',
    generic: (message) => message,
    seeHelp: (command) => `striart ${command} --help`,
  },

  help: {
    description:
      'Multi-agent Git orchestrator: isolated clones, preventive routing, semantic merge, blocking Test Gate.',
    usage: 'Usage:',
    arguments: 'Arguments:',
    options: 'Options:',
    commands: 'Commands:',
    globalOptions: 'Global options:',
    rootUsage: '[options] <command>',
    versionOption: 'print the version',
    helpOption: 'show help for the command',
    helpCommand: 'show help for a command',
    examples: 'Examples:',
    groups: {
      setup: 'Setup and diagnosis:',
      launch: 'Launching agents:',
      orchestrate: 'Orchestrating:',
      observe: 'Observing:',
      repair: 'Repairing and cleaning:',
      integrate: 'Integration:',
    },
    global: {
      json: 'machine output: one JSON document on stdout (ndjson stream for watch and dashboard)',
      plain: 'plain text, no color, glyph or link (logs, screen readers, legacy consoles)',
      noColor: 'disable color (like NO_COLOR)',
      quiet: 'suppress progress messages (never errors or data)',
    },
    rootEpilog: [
      'Exit codes:',
      '  0    success, or intended deferral (task queued, already up to date)',
      '  1    execution or environment failure (a retry may work)',
      '  2    invalid usage (unknown option, out-of-range value, incompatible options)',
      '  3    refused: a guard protected work (conflict, red Test Gate, live session…)',
      '  130  interrupted (Ctrl+C)',
      '  143  terminated by SIGTERM (stop requested by the system or a supervisor)',
      '',
      'Environment:',
      '  STRIART_LANG=fr|en     CLI language (default: the system locale)',
      '  STRIART_THEME=default|colorblind|mono   colors',
      '  NO_COLOR, FORCE_COLOR  color; STRIART_ASCII=1: ASCII glyphs',
      '  STRIART_LOG_LEVEL=debug  detailed logs on stderr',
      '',
      'Documentation: docs/en/commands.md — completion: striart completion <shell>',
    ].join('\n'),
  },

  commands: {
    init: {
      summary: 'Set Striart up in the current repository',
      description:
        'Creates .striart/ (registry, queue, tickets), adds .striart/ to .gitignore, generates striart.config.mjs when missing, then reports whatever would make the first command fail.',
      examples: ['striart init'],
    },
    doctor: {
      summary: 'Full diagnosis: git, repository, config, LLM, locks, tickets',
      description:
        'Answers "why does it not work?". Exit code 1 when a prerequisite is missing; warnings do not change the exit code.',
      examples: ['striart doctor', 'striart doctor --json | jq ".data.summary"'],
    },
    completion: {
      summary: 'Shell completion script (bash, zsh, fish, PowerShell)',
      description:
        'Writes the completion script of the given shell on stdout, to load from its profile.',
      examples: [
        'striart completion bash >> ~/.bashrc',
        'striart completion zsh > "${fpath[1]}/_striart"',
        'striart completion powershell >> $PROFILE',
      ],
      shell: 'bash, zsh, fish or powershell',
    },
    start: {
      summary: 'Clone the repository for a new supervised agent',
      description:
        'Creates an isolated clone (.striart/agents/<agent>) on a dedicated task branch. You then run your coding tool in it, or --open does it in a new tab.',
      examples: [
        'striart start agent-a',
        'striart start agent-b --command "aider --model gpt-4o" --open',
        'striart start agent-a --reuse',
      ],
      agent: 'agent name (letters, digits, - and _)',
      command: 'coding tool of this agent (default: agentCommand from the config, else claude)',
      open: 'open a terminal tab in the clone and start the tool there',
      reuse: 'rehabilitate the kept clone of a stopped agent (resynchronized, new branch)',
      force: 'with --reuse: discard the uncommitted or unmerged work of the clone (LOST)',
      allowHistoricalSecrets:
        'clone despite secrets present in the repository history (conscious decision)',
    },
    run: {
      summary: 'Preventive Router: predicts the touched files, then starts or queues',
      description:
        'The LLM predicts the files the task will change. Without a collision with an active agent, the agent starts; otherwise the task waits in the queue. --autonomous: Striart drives the agent end to end. --on-main: the agent works directly in the main repository.',
      examples: [
        'striart run "add a test for the parser"',
        'striart run --agent api "expose /health" --open',
        'striart run --autonomous --profile codex "fix the lint"',
        'striart run --after api --agent docs "document /health"',
      ],
      prompt: 'task to hand over (or --prompt)',
      promptOption: 'task to hand over (same as the positional)',
      agent: 'agent name (default: derived from the prompt)',
      command: 'coding tool of this agent',
      open: 'open a terminal tab in the clone and start the tool there',
      autonomous:
        'Striart starts and supervises the agent, merges behind the Test Gate, then cleans up',
      onMain:
        'start the agent DIRECTLY in the main repository (protected session, no end-of-cycle merge)',
      profile: 'with --autonomous or --on-main: invocation profile (striart profiles)',
      timeout: 'with --autonomous or --on-main: maximum session duration, in milliseconds',
      after: 'start only once that work is done (queued task id or active agent)',
      reuse: 'rehabilitate the kept clone of --agent instead of cloning',
      force: 'with --reuse: discard the uncommitted or unmerged work of the clone (LOST)',
      allowHistoricalSecrets:
        'clone despite secrets present in the repository history (conscious decision)',
    },
    attach: {
      summary: "Attach this terminal to an agent's pty (--open session)",
      description:
        "Joins the owned terminal session of a supervised agent (started by --open). Run it from the agent's clone.",
      examples: ['striart attach agent-a'],
      agent: 'agent name',
    },
    plan: {
      summary: 'Apply a YAML task plan (tasks-as-code)',
      description:
        'Starts a task graph declared in a versioned YAML file: agents, prompts, dependencies (after), autonomous mode per task.',
      examples: [
        'striart plan plan.yaml --dry-run',
        'striart plan plan.yaml',
        'striart plan plan.yaml --mode parallel --concurrency 3',
      ],
      file: 'YAML plan file',
      dryRun: 'validate and show the plan without starting anything',
      mode: 'version 2 plan: force the chaining (sequential or parallel)',
      concurrency: 'version 2 plan: simultaneous tasks in parallel mode',
      onFailure: 'version 2 plan: after a failure, stop (nothing else starts) or skip-dependents',
    },
    orchestrate: {
      summary: 'Run an orchestrated task: review, race, team or pipeline',
      description:
        'Builds a single-task version 2 plan and applies it (same validation as striart plan). review: an author and reviewers, merged only after approval then the Test Gate. race: several agents on the same task, one winner. team: several roles in the same clone. pipeline: chained steps, each feeding the next.',
      examples: [
        'striart orchestrate review "Move auth to JWT" --author claude --reviewer codex',
        'striart orchestrate race "Speed up the parser" --candidate claude --candidate codex --pick smallest-diff',
        'striart orchestrate team "Tested sum API" --role backend=claude:src/** --role tests=codex:tests/**',
        'striart orchestrate pipeline "Design the schema" "Implement the API" --step-profile claude --step-profile codex',
      ],
      mode: 'review, race, team or pipeline',
      prompts: 'the task (one step per argument for pipeline)',
      agent: 'agent name (or base of the derived names)',
      author: 'review: profile of the author',
      reviewer: 'review: profile of a reviewer (repeatable)',
      humanReviewer: 'review: add a human reviewer (verdict through striart review)',
      quorum: 'review: all, any or majority',
      maxRounds: 'review: maximum correction rounds',
      candidate: 'race: profile of a candidate (repeatable, at least 2)',
      pick: 'race: first-green, smallest-diff or judge',
      losers: 'race: keep, archive or clean',
      role: 'team: role name=profile[:glob,glob] (repeatable; a bare ":" = read-only)',
      cadence: 'team: turns (one writer at a time) or parallel (static partition)',
      rounds: 'team: number of rounds',
      stepProfile: 'pipeline: profile of each step, in order (repeatable)',
      handoff: 'pipeline: merge (each step merged) or clone (a single merge)',
      timeout: 'maximum duration of each session (ms)',
      dryRun: 'validate and show the task without starting anything',
    },
    review: {
      summary: 'Human reviews: list, approve, request changes, reject',
      description:
        'Without argument: lists the reviews (pending ones first). With an id: gives the verdict of a human reviewer of a review task; the merge still goes through the Test Gate.',
      examples: [
        'striart review',
        'striart review rev-1a2b3c4d5e6f --approve',
        'striart review rev-1a2b3c4d5e6f --request-changes --comment "Add a test for the null case"',
      ],
      id: 'request id (rev-…)',
      approve: 'approve (the Test Gate decides next)',
      requestChanges: 'request changes from the author (--comment required)',
      reject: 'reject: nothing is merged, the clone is kept',
      comment: 'remark passed to the author',
    },
    profiles: {
      summary: 'Configured agent profiles (autonomous mode)',
      description:
        'Lists the invocation profiles of config.agentProfiles. Environment values are never shown, only their names. --catalog lists the verified presets, --detect probes the installed tools (PATH + version, without running the repository configuration), --import-acp derives a pinned profile from the ACP registry.',
      examples: [
        'striart profiles',
        'striart profiles --catalog',
        'striart profiles --detect',
        'striart profiles --import-acp codex-acp',
        'striart profiles --json',
      ],
      detect: 'probe the installed coding tools (PATH + version, argv, empty directory)',
      catalog: 'list the preset catalog (ready and experimental)',
      importAcp:
        'derive a pinned ACP profile from an ACP registry agent (metadata only by default)',
    },
    watch: {
      summary: "Watch the agents' commits and merge them behind the Test Gate",
      description:
        'Every commit of a supervised agent triggers a merge (blocking Test Gate), then rebases the other agents. --ui adds an interactive interface; --daemon runs in the background.',
      examples: [
        'striart watch',
        'striart watch --daemon',
        'striart watch --ui',
        'striart watch --json | jq -c .',
      ],
      noMerge: 'report commits without merging them',
      daemon: 'run the watcher in the background (PID and log in .striart/)',
      stop: 'stop the background watcher',
      status: 'status of the background watcher',
      ui: 'interactive interface: agent panel, commands, "@agent" messages to supervised sessions',
    },
    merge: {
      summary: "Merge an agent's latest commit behind the Test Gate",
      description:
        "Merges the agent's branch into the target branch. Textual conflict: semantic merge by the LLM. The commit only happens when the Test Gate is green; otherwise a ticket and exit code 3.",
      examples: ['striart merge agent-a', 'striart merge agent-a && npm run deploy'],
      agent: 'agent name',
    },
    sync: {
      summary: 'Rebase an agent (or all of them) on the target branch',
      description:
        'Never touches work in progress that overlaps the incoming commits: the rebase is then deferred (exit 0), the merge will catch up.',
      examples: ['striart sync', 'striart sync agent-a'],
      agent: 'agent name (default: all)',
    },
    stop: {
      summary: 'Mark an agent as done (the clone stays on disk)',
      description:
        'Removes the agent from the registry and unblocks the queue. Refuses while unmerged commits remain, unless --force.',
      examples: ['striart stop agent-a', 'striart stop agent-a --force'],
      agent: 'agent name',
      force: 'discard the unmerged commits',
    },
    status: {
      summary: 'Active agents, sessions, pending work and things to handle',
      description:
        'Overview: a table of the agents, then everything waiting for a human (tickets, manual mode, reserved repository, startable tasks).',
      examples: ['striart status', 'striart status --json | jq ".data.agents[].name"'],
    },
    queue: {
      summary: 'Queue: running and waiting tasks, and why',
      description:
        'Started and waiting tasks, with what blocks them. --retry starts those no longer blocked.',
      examples: ['striart queue', 'striart queue --retry'],
      retry: 'start the tasks that nothing blocks anymore',
    },
    history: {
      summary: 'Merge and rollback history (from the git graph)',
      description:
        'Rebuilt from the "merge(striart)" commits: no parallel database that could diverge.',
      examples: ['striart history', 'striart history --limit 5 --json'],
      limit: 'number of entries (default 30)',
    },
    usage: {
      summary: 'Token usage and cost (by period, role, agent, task)',
      description:
        'Reads the .striart/usage/ ledger: Striart LLM calls (router, merger, memory) and agent sessions. Never any prompt or content. Cost needs a declared price (tokens.pricing).',
      examples: [
        'striart usage',
        'striart usage --since 7d --role merger',
        'striart usage --agent agent-a --json',
      ],
      since: 'period start: 7d, 24h, 30m, today or YYYY-MM-DD (UTC)',
      until: 'period end (YYYY-MM-DD UTC, whole day included, or a duration)',
      role: 'filter by role: router, merger, memory, judge, review, agent',
      agent: 'filter by agent',
      task: 'filter by task id',
    },
    dashboard: {
      summary: 'Local real-time web dashboard (127.0.0.1)',
      description: 'Agents, queue, tickets, Test Gate logs, with controls. Listens locally only.',
      examples: [
        'striart dashboard',
        'striart dashboard --daemon',
        'striart dashboard --link',
        'striart dashboard --status',
      ],
      port: 'listening port (default: dashboardPort from the config, 3456)',
      daemon: 'run the dashboard in the background',
      stop: 'stop the background dashboard',
      status: 'status (and address) of the background dashboard',
      link: 'issue a new one-time sign-in link for the running dashboard (the daemon, or the one on --port)',
    },
    rollback: {
      summary: 'Undo the last Striart merge of the target branch',
      description:
        'Unpushed merge: reset (recoverable from the reflog). Already pushed: revert, published history is kept.',
      examples: ['striart rollback'],
    },
    resolve: {
      summary: 'Conflict tickets: list, prepare, apply behind the Test Gate',
      description:
        'Without option: lists the open tickets. --prepare seeds a .resolved file per conflicted file; --apply replays the merge with those resolutions, behind the Test Gate.',
      examples: [
        'striart resolve',
        'striart resolve --prepare agent-a-f72c4ba9',
        'striart resolve --apply agent-a-f72c4ba9',
        'striart resolve --unlock',
      ],
      unlock: 'turn the semantic merge back on after manual mode',
      close: 'mark a ticket as resolved (fixed by hand)',
      prepare: 'seed <file>.resolved for every conflicted file of the ticket',
      acceptTheirs:
        "with --prepare: also seed this PROTECTED path from the agent's version (explicit decision, repeatable)",
      apply: "replay the ticket's merge with the prepared resolutions, behind the Test Gate",
      all: 'include tickets already resolved',
    },
    lock: {
      summary: 'Reserve or release the main repository for direct work',
      description:
        'While the reservation lives (watched PID), every mutating Striart operation (merge, sync, promote, resolve --apply, watch auto-merge) is refused. Without option: shows the status.',
      examples: [
        'striart lock --start "resolving app.js by hand"',
        'striart lock --start "editing" --pid $PID',
        'striart lock --stop',
      ],
      start: 'reserve the repository for this reason (PID of the current shell, unless --pid)',
      stop: 'release the repository (always allowed: emergency exit)',
      pid: 'with --start: PID of the process to watch',
    },
    clean: {
      summary: 'Delete clones to free disk space',
      description:
        'By default: only clones of stopped agents. --all includes active agents without pending work. A live session is never deleted.',
      examples: ['striart clean', 'striart clean agent-a', 'striart clean --all'],
      agent: 'agent name (default: every eligible clone)',
      stopped: 'stopped agents only (default behavior, explicit)',
      all: 'include active agents without pending work (stopped then deleted)',
      force: "override the clone's recent activity and, with --all, discard unmerged work (LOST)",
    },
    reconcile: {
      summary: 'Converge the state on reality: dead sessions, queue, locks',
      description: 'Clears dead sessions, starts unblocked tasks, cleans orphan locks.',
      examples: ['striart reconcile'],
    },
    prune: {
      summary: 'Retention: idle stopped clones and old resolved tickets',
      description:
        'Deletes idle stopped clones and tickets resolved more than N days ago. Never an active agent nor an open ticket.',
      examples: ['striart prune --dry-run', 'striart prune --days 30'],
      days: 'retention period in days (default: pruneDays from the config, 14)',
      dryRun: 'show what would be deleted, without deleting anything',
    },
    gc: {
      summary: 'GC: detect idle agents and cleanly close their forgotten sessions',
      description:
        'Detects agents with no activity at all (worktree, commits, output, messages) and, depending on idle.action, reports them, warns them, then closes their SESSION after a grace period. The clone and uncommitted work are always kept; no merge, no deletion. A pending human request, an open ticket, an orchestration plan or the main-repo session protects an agent.',
      examples: ['striart gc', 'striart gc --dry-run', 'striart gc agent-a --close'],
      agent: 'limit the sweep to this agent',
      close:
        'ask to close idle sessions (replaces idle.action and the authorization; the warning and the grace period remain mandatory)',
      dryRun: 'show what would be done, without writing or closing anything',
    },
    promote: {
      summary: 'Promote staging → main behind a global Test Gate',
      description: 'Replays the Test Gate on the target branch, then fast-forwards mainBranch.',
      examples: ['striart promote', 'striart promote --rollback'],
      rollback: 'if the Test Gate fails: reset staging to main (destructive)',
    },
    acp: {
      summary:
        'ACP agent on stdio for an editor (Zed, JetBrains, Neovim, Emacs…): an isolated clone + the upstream agent + a merge under the Test Gate',
      description:
        'Exposes Striart as an ACP v1 agent (JSON-RPC on stdin/stdout). Each session the editor opens becomes an isolated Striart clone where the chosen upstream agent works (session option "Agent"), served by Striart\'s own ACP client (files and terminals bounded to the clone: the editor\'s are never used). The editor sees the progress, arbitrates permissions ("ask" policy) and gets the outcome: ending the session (/striart-finish or closing it) = commit policy, merge under the Test Gate, a ticket if red. Refused inside an agent session.',
      examples: [
        'striart acp',
        'striart acp --profile claude-acp',
        'striart acp --root /path/to/repo',
      ],
      root: "root of the main repository: every session must be inside it (default: derived from the session's directory)",
      profile:
        'upstream profile offered by default (takes precedence over acpAgent.defaultProfile)',
    },
    api: {
      summary: 'Striart Control Protocol v1 on stdio, for IDE extensions (human plane)',
      description:
        'Serves the human control protocol (JSON-RPC 2.0: state, change subscription, actions, permission arbitration, 3-way tickets) on stdin/stdout — no network surface, works over Remote SSH, devcontainers and Codespaces. --schema prints the published schema. Refused inside an agent session.',
      examples: [
        'striart api --stdio',
        'striart api --stdio --framing content-length',
        'striart api --schema openrpc',
      ],
      stdio: 'serve the protocol on stdin/stdout (stdout is reserved for the protocol)',
      framing:
        'message framing: ndjson (one message per line, default) or content-length (LSP style)',
      schema: 'print the published schema: openrpc (methods) or json-schema (--json document)',
    },
    mcp: {
      summary: 'MCP server on stdio for an MCP host (Claude Code, Cursor…)',
      description:
        "Exposes the state, tickets and logs (resources) and — depending on the scope — merge and resolution as MCP tools (2026-07-28 and legacy eras). Started from an agent's clone, it acts on that agent only; outside any clone it is read-only unless mcp.scope: 'orchestrator'. stdout is reserved for the protocol.",
      examples: [
        'striart mcp',
        'striart mcp --root /path/to/repo --agent agent-a',
        'striart mcp --read-only',
      ],
      root: 'root of the main repository (takes precedence over the working directory)',
      agent: 'bounds the tools to this agent (its merge, its tickets)',
      readOnly: 'exposes no mutating tool',
      collab:
        'with --read-only and a bound agent, also allows posting collaboration messages (striart_collab_post) — nothing else',
    },
    hook: {
      summary: 'Advisory hooks for coding tools (collisions, end of session)',
      description:
        'Run BY the tool (Claude Code, Codex, Copilot CLI, Gemini CLI, Cline) on each event: warns about a file predicted or locked by another agent and notifies the end of a supervised session. Never blocking (exit 0, neutral answer on any anomaly). install/uninstall writes or removes the hook configuration, for the user (--user) or in an agent clone (--agent, untracked file excluded from git).',
      examples: [
        'striart hook install claude --user',
        'striart hook install codex --agent agent-a',
        'striart hook install gemini --user --dry-run',
        'striart hook uninstall claude --user',
      ],
      words:
        'install|uninstall <tool>, or <tool> <event> (called by the tool) — tools: claude, codex, copilot, gemini, cline',
      user: "the tool's USER configuration (works in every project, neutral outside a clone)",
      agent: "in this agent's clone (untracked file, excluded from git locally)",
      dryRun: 'show the files that would change, write nothing',
      root: 'trusted root (written by install --agent): its full config is loaded',
    },
    __complete: {
      summary: 'Internal: completion values',
      description: 'Called by the completion scripts.',
      examples: [],
    },
  },

  init: {
    working: 'Setting up .striart/',
    checking: 'Checking prerequisites',
    ready: (dir) => `Striart ready (${dir}).`,
    alreadyInitialized: (dir) => `already set up (${dir}): nothing to create.`,
    created: (item) => (item === '.gitignore' ? '.gitignore (.striart/ added)' : item),
    config: (configPath) => `configuration: ${configPath ?? 'no file, defaults in use'}`,
    nextStep: 'Next step:',
  },

  doctor: {
    running: 'Running the diagnosis',
    colLevel: 'LEVEL',
    colCheck: 'CHECK',
    colDetail: 'FINDING',
    actions: 'To do:',
    verdictOk: 'environment operational.',
    verdictWarn: (warn) => `usable, ${warn} ${plural(warn, 'warning', 'warnings')}.`,
    verdictFail: (fail, warn) =>
      `${fail} ${plural(fail, 'prerequisite missing', 'prerequisites missing')}${warn ? `, ${warn} ${plural(warn, 'warning', 'warnings')}` : ''}: fix the errors above.`,
  },

  start: {
    creating: (agent) => `Creating the clone of ${agent}`,
    reusing: (agent) => `Rehabilitating the clone of ${agent}`,
    ready: (agent, dir) => `agent ${agent} ready in ${dir}.`,
    branch: (branch) => `branch: ${branch}`,
    terminalOpened: (agent, command) => `tab opened for ${agent} (${command}).`,
    terminalFailed: (error) => `could not open the terminal: ${error}`,
    attachManually: 'the terminal host is running: join it by hand.',
    launchManually: 'start your coding tool in the clone:',
  },

  run: {
    twoPrompts: 'the prompt is given twice (positional and --prompt) with different values.',
    emptyPrompt: 'the task prompt is empty.',
    needsUnattended: (option) => `${option} only makes sense with --autonomous or --on-main.`,
    reuseNeedsAgent: '--reuse needs an explicit agent name (--agent).',
    routing: 'Router: predicting the touched files',
    sessionRunning: 'Agent session running',
    onMainIntro: (profile) =>
      `session on the main repository (profile ${profile ?? 'default'}): merge, sync, promote and resolve --apply are blocked until it ends.`,
    autonomousIntro: (profile) =>
      `autonomous mode (profile ${profile ?? 'default'}): the Test Gate is the only judge, nobody reviews before the merge.`,
    sessionEnded: (status, duration, exitCode) =>
      `session ended after ${duration}: ${status}${exitCode !== null ? `, exit code ${exitCode}` : ''}.`,
    autonomousQueued: (taskId) =>
      `collision detected: no session started, task ${taskId} queued (it will restart in supervised mode).`,
    autonomousCleaned: 'full cycle: merge succeeded, Test Gate green, clone deleted.',
    autonomousKept: (reason) => `merge succeeded; clone kept: ${reason}`,
    alreadyIntegratedWarning: (agent) =>
      `${agent}: its commit was already in the target branch — this cycle merged nothing and did not replay the Test Gate; clone cleaned up.`,
    serializationRelaxedWarning: (agent, blockers) =>
      `${agent}: vague or repo-wide task, but it did not wait for ${blockers} — session ended in failure, clone kept with no commit to merge. A collision on a specific file still blocks.`,
    autonomousStatus: (status, reason) => `${status}: ${reason}`,
    cloneKept: (dir) => `clone kept: ${dir}`,
    striartCommitted: (sha, n, author) =>
      `Striart commit ${sha}: ${n} ${plural(n, 'file', 'files')} left by the agent, author ${author}.`,
    commitExcluded: (kind, files) =>
      kind === 'secrets'
        ? `kept out of the commit (secretPatterns): ${files}`
        : `kept out of the commit (files injected by Striart): ${files}`,
    commitSkippedAgent:
      'the agent committed itself: no Striart commit (commitPolicy agent-then-striart).',
    kept: (code, detail) =>
      (
        ({
          SESSION_FAILED:
            detail === 'BUDGET_EXCEEDED'
              ? 'token budget exceeded: session stopped, nothing was merged, clone kept. Check `striart usage`, raise tokens.budgets if intended, or review the clone’s work.'
              : `session ${detail ?? ''} — clone kept for diagnosis.`,
          NO_COMMIT:
            detail === 'human'
              ? "commitPolicy 'human': nobody commits, the work stays in the clone for your review."
              : 'the agent exited without a commit — nothing to merge, clone kept.',
          NO_CHANGES: 'the agent exited without any change — nothing to commit or merge.',
          ONLY_EXCLUDED_CHANGES:
            'only excluded files were left (secrets, injected files) — nothing was committed.',
          COMMIT_REFUSED: `Striart commit refused (${detail ?? '?'}): the clone is in an ambiguous state, check it by hand.`,
          COMMIT_FAILED: `Striart commit failed (${detail ?? '?'}) — nothing was merged.`,
          MERGE_BLOCKED: `merge ${detail ?? ''} — the agent's work is not lost.`,
          CLEANUP_SKIPPED: `clean-up skipped (${detail ?? '?'}).`,
          HUMAN_REVIEW_REQUIRED:
            "commitPolicy 'human': the agent committed but nothing is merged automatically — the clone is kept for your review.",
        }) as Record<string, string>
      )[code] ?? null,
    collision: (blocker, agent, files) =>
      `${agent} and ${blocker} would both touch ${files}: sequential start.`,
    waitsFor: (after) => `waits for ${after} to finish.`,
    queued: (agent, taskId) => `task ${taskId} (${agent}) queued.`,
    predicted: (files) => `predicted files: ${files}`,
    serialized: (reason) => `the Router serialized the task (whole repository): ${reason}.`,
    sharedIgnored: (files) => `bookkeeping files left out of collision detection: ${files}.`,
    importLink: (by, file) => `${by} imports ${file}`,
    dependsOn: (a, b) => `${a} depends on ${b}`,
    semanticLink: (agent, links) =>
      `semantic link with ${agent} (${links}): no git conflict expected, the Test Gate will decide.`,
    workspaceLink: (agent, links) => `packages linked with ${agent}: ${links}.`,
  },

  plan: {
    validating: 'Validating the plan',
    applying: 'Applying the plan',
    sessionFailed: (agent, code, detail) =>
      `supervised session of ${agent} could not be opened (${code}): ${detail} The plan is interrupted instead of waiting for an agent nobody launched.`,
    notFound: (file) => `plan not found: ${file}`,
    valid: (n) => `valid plan: ${n} ${plural(n, 'task', 'tasks')}, nothing started.`,
    colTask: 'TASK',
    colMode: 'MODE',
    colAfter: 'AFTER',
    derivedName: '(name derived from the prompt)',
    applied: (n) => `plan applied: ${n} ${plural(n, 'task', 'tasks')}.`,
    autonomousTask: (name, status) => `${name} (autonomous): ${status}`,
    queuedTask: (name) => `${name}: queued`,
    notApplied: (name) =>
      `${name}: not applied (stop requested) — rerun the plan without the tasks already done.`,
    colKind: 'KIND',
    kind: (kind) => kind,
    run: (id, mode, concurrency) =>
      `plan ${id}: ${mode === 'parallel' ? `parallel (${concurrency} at a time)` : 'sequential'}.`,
    node: (name, kind, status) => `${name} (${kind}): ${status}`,
    nodeDetail: (detail) => `detail: ${detail}`,
    nodeAgents: (agents) => `clones: ${agents}`,
    nodeKept: 'clone(s) kept for a human decision.',
    verdicts: (list) => `verdicts: ${list}`,
    progress: {
      started: (name, kind) => `${name} (${kind}) started`,
      finished: (name, kind, status) => `${name} (${kind}): ${status}`,
      turn: (agent, role, round) => `${agent}: ${role}'s turn (round ${round})`,
      turnDone: (agent, role, status) => `${agent}: ${role} → ${status}`,
      serializationRelaxed: (name, blockers) =>
        `${name} is not waiting for ${blockers} (session failed, clone has no commit to merge)`,
      waiting: (name, reason, ref) =>
        `${name} waits for ${
          (
            {
              dependency: 'the end of',
              collision: 'the colliding agents to leave:',
              attended: 'the end of the supervised session of',
              'human-review': 'the human verdict',
            } as Record<string, string>
          )[reason] ?? reason
        } ${ref}`,
      verdict: (reviewer, round, verdict) => `review: ${reviewer} (round ${round}) → ${verdict}`,
    },
  },

  completion: {
    header: (shell, install) => `# striart — ${shell} completion. Install: ${install}`,
  },

  api: {
    needsTransport: 'Choose a transport: striart api --stdio (or --schema to print the schema).',
  },

  review: {
    idRequired: 'A verdict needs the id of a review request.',
    commentRequired: '--request-changes needs --comment: the author must know what to fix.',
    empty: 'no human review.',
    colId: 'ID',
    colAgent: 'AGENT',
    colReviewer: 'REVIEWER',
    colRound: 'ROUND',
    colState: 'STATE',
    colSince: 'SINCE',
    state: (status, alive) =>
      status === 'PENDING'
        ? alive
          ? 'pending'
          : 'orphaned (nobody waits anymore)'
        : status === 'ANSWERED'
          ? 'answered'
          : 'expired',
    answered: (id, verdict) => `review ${id}: ${verdict} recorded.`,
    gateStillDecides: 'the Test Gate decides the merge.',
    pendingHint: 'striart review <id> --approve | --request-changes --comment "…" | --reject',
  },

  profiles: {
    acpBinaryDownloaded: (id, version) =>
      `acpRegistry.allowBinaryDownload: downloaded ${id} ${version} (sha256 verified).`,
    empty: 'no profile configured (agentProfiles is empty).',
    emptyHint: 'docs/en/configuration.md (agentProfiles)',
    colName: 'PROFILE',
    colTransport: 'TRANSPORT',
    colTimeout: 'TIMEOUT',
    colEnv: 'VARIABLES',
    colInvocation: 'INVOCATION',
    usage: 'Use them with --profile (run --autonomous / --on-main) or in a plan.',
    colPreset: 'PRESET',
    colWrite: 'WRITE',
    colCommit: 'COMMIT',
    colInstructions: 'RULES',
    colStatus: 'STATUS',
    colTool: 'TOOL',
    colVersion: 'VERSION',
    colPath: 'PATH',
    colProfiles: 'PROFILES',
    experimental: 'experimental',
    ready: 'ready',
    detectFound: 'installed',
    detectOutdated: 'too old',
    detectMissing: 'missing',
    detectUnknownVersion: 'unreadable version',
    detectSummary: (found: number, total: number) =>
      `${found} of ${total} tool(s) detected — probe: PATH then "--version" in an empty directory, never the repository configuration.`,
    catalogUsage:
      "An experimental preset must be declared explicitly: agentProfiles: { <key>: { preset: '<id>' } }.",
    importTitle: (name: string, version: string) => `ACP agent ${name} ${version}`,
    importPaste: 'Profile to add to agentProfiles (striart.config):',
    importResolvedAtLaunch: (tool: string) =>
      `${tool} will resolve the pinned package on first launch (Striart downloads nothing).`,
    importInstallBinary: (archive: string, sha256: string | null) =>
      `Binary distribution: install ${archive}${sha256 ? ` (sha256 ${sha256})` : ' (no published checksum)'} and put the binary on your PATH — or set acpRegistry.allowBinaryDownload: true.`,
    importDownloaded: (dir: string) => `Downloaded, checksum verified, extracted to ${dir}.`,
  },

  status: {
    empty: 'no active agent.',
    colAgent: 'AGENT',
    colState: 'STATE',
    colMode: 'MODE',
    colSession: 'SESSION',
    colPending: 'PENDING',
    colBranch: 'BRANCH',
    colTool: 'TOOL',
    colSize: 'SIZE',
    colLastCommit: 'LAST COMMIT',
    session: (s) => {
      if (!s || s.state === 'idle') return '—';
      if (s.state === 'running')
        return `PID ${s.pid} (${s.via === 'pty' ? 'terminal' : 'autonomous'})`;
      return 'recent activity';
    },
    brokenDetail: (status) =>
      status === 'MISSING'
        ? 'clone missing from disk'
        : status === 'REMOVING'
          ? 'clone removal in progress'
          : 'clone unreadable by git',
    stateTicket: 'TICKET',
    attention: 'To handle',
    missing: (agent) => `the clone of ${agent} disappeared from disk.`,
    tickets: (n) => `${n} open conflict ${plural(n, 'ticket', 'tickets')}.`,
    manualMode: 'manual mode on: the semantic merge is off, every conflict becomes a ticket.',
    mainSession: (reason, pid, since) =>
      `main repository reserved: "${reason}" (PID ${pid}, for ${since}).`,
    ready: (n) => `${n} startable queued ${plural(n, 'task', 'tasks')}.`,
    waiting: (n) => `${n} blocked queued ${plural(n, 'task', 'tasks')}.`,
    noWatcher:
      'no watcher running: the commits of supervised agents will not be merged automatically.',
    humanReviews: (n) => `${n} human ${plural(n, 'review waits', 'reviews wait')} for a verdict.`,
    orchestrations: (n) =>
      `${n} ${plural(n, 'orchestration', 'orchestrations')} running (version 2 plan / orchestrate).`,
    idleSessions: (n, names) =>
      `${n} idle live ${plural(n, 'session', 'sessions')}: ${names} (no activity, no fresh signal).`,
    orphanRuns: (n) =>
      `${n} interrupted ${plural(n, 'orchestration', 'orchestrations')}: its process stopped before the end.`,
    overlapAgents: (a, b, files, n) =>
      `${a} and ${b} both modified ${files}${n > 0 ? ` (+${n})` : ''} (not predicted by the Router): conflict likely at merge.`,
    overlapTarget: (agent, files, n, branch) =>
      `${agent} modified ${files}${n > 0 ? ` (+${n})` : ''} which ${branch} also advanced: conflict likely at its merge.`,
    overlapDeferred: (agents) =>
      `overlaps not observed for ${agents} (git call budget of the cycle reached: overlap.maxGitCalls).`,
    overlapUnavailable: (reason) => `overlaps cannot be observed (${reason}).`,
    overlapScope: "overlaps only cover the agents' COMMITTED work (not edits in progress).",
  },

  queue: {
    retrying: 'Retrying the queue',
    unblocked: (taskId, agent) => `task ${taskId} started (${agent}).`,
    nothingUnblocked: 'no task unblocked.',
    blockedReason: (code) => `start refused (${code})`,
    stillBlocked: 'still blocked',
    empty: 'no task.',
    colTask: 'TASK',
    colAgent: 'AGENT',
    colState: 'STATE',
    colWhy: 'REASON',
    colFiles: 'PREDICTED FILES',
    running: 'running',
    blockedBy: (agent, files) => `blocked by ${agent} (${files})`,
    after: (ref) => `waits for ${ref}`,
    ready: 'nothing blocks it anymore',
    readyHint: 'some tasks are no longer blocked:',
  },

  reconcile: {
    running: 'Reconciling',
    cleared: (agents) => `dead sessions cleared: ${agents}.`,
    stillWaiting: (n) => `${n} ${plural(n, 'task', 'tasks')} still waiting.`,
    nothing: 'nothing to reconcile: the state is already consistent.',
  },

  usage: {
    empty: 'no usage recorded for the period.',
    unknownRole: (role: string, roles: string) => `Unknown role "${role}". Roles: ${roles}.`,
    colKey: 'KEY',
    colCalls: 'CALLS',
    colInput: 'INPUT',
    colOutput: 'OUTPUT',
    colCache: 'CACHE READ',
    colTokens: 'TOTAL',
    colCost: 'COST USD',
    byRole: 'By role',
    byAgent: 'By agent',
    byTask: 'By task',
    byModel: 'By model',
    byDay: 'By day',
    unpriced: (n: number) =>
      `${n} ${plural(n, 'call', 'calls')} without a declared price (cost is incomplete — see tokens.pricing).`,
    estimated: (n: number) =>
      `${n} ${plural(n, 'call', 'calls')} estimated locally (the provider reported no usage).`,
    unmetered: (n: number) =>
      `${n} unmetered ${plural(n, 'session', 'sessions')} (no structured output: only the timeout bounds them).`,
    promptCache: (pct: string) => `prompt cache: ${pct} of input served from the provider cache.`,
    resultCache: (hits: number, eligible: number) =>
      `result cache: ${hits}/${eligible} eligible calls served locally.`,
    instructions: (tokens: number) => `injected instructions: ~${tokens} tokens per session.`,
    skipped: (n: number) => `${n} unreadable ${plural(n, 'line', 'lines')} skipped in the ledger.`,
    none: '—',
  },

  history: {
    empty: 'no Striart merge in history.',
    colDate: 'DATE',
    colType: 'TYPE',
    colAgent: 'AGENT',
    colMerge: 'MERGE',
    colAgentCommit: 'AGENT COMMIT',
    colResolution: 'RESOLUTION',
    type: (type) => (type === 'rollback' ? 'rollback' : 'merge'),
    resolution: (resolution, ticketId, files) => {
      if (resolution === 'manual') return `manual (${ticketId})`;
      if (resolution === 'semantic') return `semantic: ${files.join(', ')}`;
      return 'automatic';
    },
  },

  merge: {
    running: (agent) => `Merging ${agent} (Test Gate)`,
    upToDate: (agent) => `${agent}: nothing to merge, already up to date.`,
    alreadyIntegrated: (agent) =>
      `${agent}: its commit is already in the target branch (integrated by another path): nothing to merge.`,
    merged: (agent, mergeSha, agentSha) =>
      `${agent} merged: commit ${mergeSha} (agent ${agentSha}), Test Gate green.`,
    semanticFiles: (files) => `conflicts resolved by semantic merge: ${files}`,
    gateRetries: (n) => `merge fixed after ${n} Test Gate ${plural(n, 'round', 'rounds')}.`,
    renameHazard: (source, ours, theirs) =>
      `${source} deleted on both sides, content found under two names (main: ${ours}, agent: ${theirs}): likely double rename, check the duplicate.`,
    pushFailed: (error) => `push failed (the local merge stays valid): ${error}`,
    deliveredBranch: (ref, sha) =>
      `delivered on origin/${ref} (${sha}): approve it from the forge (PR/MR), the target branch was not pushed.`,
    memoryFailed: (error) => `shared memory not updated: ${error}`,
    conflict: (agent, files) => `merge conflict with ${agent} on ${files}: merge aborted.`,
    semanticFailed: (error) => `the semantic merge failed: ${error}`,
    unmergeableTitle: 'out of reach of the semantic merge:',
    deletedBy: (side) => ` (deleted on the ${side} side)`,
    conflictKind: (kind) =>
      (
        ({
          delete: 'delete versus modify',
          path: 'path conflict (rename)',
          binary: 'binary file',
          lockfile: 'generated lockfile (regenerate it)',
          oversized: 'too large for the LLM',
          submodule: 'git submodule',
          symlink: 'symbolic link',
          mode: 'diverging executable bit',
          opaque: 'unreadable',
        }) as Record<string, string>
      )[kind] ?? kind,
    gateFailed: (agent, exitCode) =>
      `red Test Gate for ${agent}${exitCode !== null ? ` (code ${exitCode})` : ''}: merge aborted.`,
    gateFailedSemantic: 'the code merged by the LLM did not pass the tests.',
    manualMode: 'manual mode on (3 semantic failures in a row): every conflict becomes a ticket.',
    protectedRefused: (agent, files) =>
      `merge of ${agent} refused: the agent changes protected paths (${files}).`,
    protectedChange: (file, status, pattern, kind) =>
      `${file}: ${
        ({ A: 'added', M: 'modified', D: 'deleted', T: 'type changed' } as Record<string, string>)[
          status
        ] ?? status
      } — ${
        (
          {
            instructions: 'agent instructions',
            'agent-config': 'agent configuration',
            'striart-config': 'Striart configuration',
          } as Record<string, string>
        )[kind] ?? kind
      } (${pattern})`,
    protectedHelp: (ticketId) =>
      `decide the final content of each path (.resolved, or .delete to drop it), then "striart resolve --apply ${ticketId}" (behind the Test Gate); or "striart resolve --close ${ticketId}" to discard that work.`,
  },

  sync: {
    running: (agent) => `Rebasing ${agent}`,
    runningAll: 'Rebasing the agents',
    noAgents: 'no active agent.',
    rebased: (agent, head, n) =>
      `${agent} rebased on ${head} (${n} ${plural(n, 'commit', 'commits')} caught up).`,
    stashed: 'work in progress stashed then restored (disjoint files checked).',
    upToDate: (agent) => `${agent} already up to date.`,
    skippedOverlap: (agent, files) =>
      `${agent}: work in progress on ${files}, also touched by incoming commits — rebase deferred.`,
    skippedDirty: (agent, n) =>
      `${agent}: work in progress (${n} modified ${plural(n, 'file', 'files')}), rebase deferred.`,
    skippedSession: (agent, pid) =>
      `${agent}: autonomous session running (PID ${pid ?? '?'}), rebase at the end of its cycle.`,
    rebaseConflict: (agent) =>
      `${agent}: rebase conflict, aborted; the conflict will be handled at merge time.`,
    stashKept: 'work in progress kept in the clone stash.',
    stashConflict: (agent) =>
      `${agent}: restoring the work in progress conflicts after the rebase — it is safe in the clone stash, resolve it by hand.`,
  },

  stop: {
    running: (agent) => `Stopping ${agent}`,
    stopped: (agent, dir) => `${agent} removed from the registry; clone kept: ${dir}.`,
    artifactFailed: (agent, what, message) =>
      `${agent} is stopped, but its ${what} could not be cleaned up: ${message}`,
    queueFailed: (agent, code) =>
      `${agent} is stopped, but the queue could not be unblocked (${code}): waiting tasks stay queued.`,
    stoppedMissing: (agent) =>
      `${agent} removed from the registry (its clone had already disappeared).`,
    hostStopping: (agent) =>
      `the terminal of ${agent} is still stopping: its clone stays protected until it exits.`,
    hostUntouched: (agent, why) =>
      `the terminal of ${agent} is left running (${why}): close it by hand before "striart clean ${agent}".`,
    hostWhy: (reason) =>
      reason === 'unverified'
        ? 'process cannot be identified'
        : reason === 'denied'
          ? 'belongs to another user'
          : 'stop failed, see the log',
  },

  rollback: {
    running: 'Undoing the last merge',
    reset: (agent, undone, head) => `merge of ${agent} undone (${undone}): branch back on ${head}.`,
    resynced: (agent) => `the commits of ${agent} are pending again and can be merged again.`,
    notResynced: (agent) =>
      `${agent} not realigned (stopped or clone missing): merge again by hand if needed.`,
    reflog: 'recoverable from the reflog (git reflog).',
    revert: (agent, head) => `merge of ${agent} reverted (${head}): published history is kept.`,
    doNotRemerge: (agent) =>
      `do not merge ${agent} again as is: the same commit would reproduce the undone state.`,
  },

  promote: {
    running: 'Promotion: global Test Gate',
    upToDate: 'nothing to promote: main is already level with staging.',
    promoted: (n, sha) =>
      `${n} ${plural(n, 'commit', 'commits')} promoted: main fast-forwarded to ${sha}.`,
    gateFailed: (exitCode) =>
      `red global Test Gate${exitCode !== null ? ` (code ${exitCode})` : ''}: promotion refused, main untouched.`,
    rolledBack: 'staging reset to main (--rollback).',
    stagingKept: 'staging kept for analysis.',
  },

  clean: {
    running: 'Cleaning clones',
    artifactFailed: (agent, what, message) =>
      `${agent}: its ${what} could not be cleaned up: ${message}`,
    removed: (agent, size, wasActive) =>
      `${agent} deleted${wasActive ? ' (active agent stopped)' : ''}: ${size} freed.`,
    skipped: (agent, reason) =>
      `${agent} kept: ${
        (
          {
            SESSION_LIVE: 'a session lives in this clone (never deleted, even with --force)',
            ACTIVE: 'active agent',
            PENDING: 'unmerged work',
            IN_USE: 'recent disk activity, a session may still work in it',
            BUSY: 'folder locked by a process',
          } as Record<string, string>
        )[reason] ?? reason
      }.`,
    nothing: 'no clone to clean.',
    total: (size) => `total freed: ${size}.`,
  },

  gc: {
    running: 'Sweeping idle sessions',
    disabled: 'Idle GC is disabled (idle.enabled: false): nothing is detected.',
    nothing: 'no registered agent.',
    stage: {
      active: 'active',
      protected: 'protected',
      idle: 'idle',
      warned: 'warned',
      closable: 'closable',
    },
    session: { live: 'live session', ended: 'session ended', none: 'never launched' },
    agentLine: (agent, stage, idle, session, host) =>
      `${agent}: ${stage}${idle ? ` for ${idle}` : ''} — ${session}${host === 'none' ? '' : ` (${host})`}.`,
    blockedBy: (codes) => `protected by: ${codes}.`,
    reasons: (codes) => `active: ${codes}.`,
    closeBlocked: (codes) => `cannot be closed yet: ${codes}.`,
    closeNotBefore: (date) => `closable from ${date} without further activity.`,
    wouldWarn: (agent) => `${agent} would be warned.`,
    wouldClose: (agent) => `the session of ${agent} would be closed.`,
    warned: (agent) => `${agent} warned: its session becomes closable after the grace period.`,
    closed: (agent, host, code) =>
      code === 'CLOSING'
        ? `session of ${agent} (${host}): stop requested, exit in progress — clone and work kept.`
        : `session of ${agent} (${host}) closed cleanly — clone and work kept.`,
    refused: (agent, code, detail) =>
      `session of ${agent} NOT closed (${code}${detail ? `: ${detail}` : ''}) — left untouched.`,
    notAuthorized:
      'closing is not authorized: add this repository to idle.closeRoots in the user config (striart doctor).',
    authorizationError: (code) => `user config unreadable (${code}): no automatic closing.`,
    holds: (codes) => `cautious sweep, nothing is closed: ${codes}.`,
    summary: (idle, warned, closed, dryRun) =>
      `${idle} idle ${idle === 1 ? 'agent' : 'agents'}, ${warned} ${dryRun ? 'to warn' : 'warned'}, ${closed} ${dryRun ? 'to close' : closed === 1 ? 'session closed' : 'sessions closed'}.`,
  },

  prune: {
    running: 'Retention',
    cloneRemoved: (agent, date, size, dryRun) =>
      `clone ${agent} ${dryRun ? 'would be deleted' : 'deleted'} (idle since ${date}, ${size}).`,
    cloneKept: (agent, date) => `clone ${agent} kept (activity on ${date}).`,
    keptReason: (reason) =>
      reason === 'PTY_HOST_LIVE'
        ? 'A terminal is still open on it: close it before retrying.'
        : reason,
    failed: (kind, name, cause) =>
      `${kind === 'clone' ? 'clone' : kind === 'ticket' ? 'ticket' : 'log'} ${name}: could not be deleted (${cause}).`,
    ticketRemoved: (id, date, dryRun) =>
      `ticket ${id} ${dryRun ? 'would be deleted' : 'deleted'} (resolved on ${date}).`,
    nothing: (days) => `nothing to prune (retention: ${days} ${plural(days, 'day', 'days')}).`,
    total: (size, days, dryRun) =>
      `${dryRun ? 'reclaimable space' : 'space freed'}: ${size} (retention: ${days} ${plural(days, 'day', 'days')}).`,
  },

  resolve: {
    applying: (id) => `Applying the resolution of ${id} (Test Gate)`,
    unlocked: 'semantic merge back on (failure counter reset).',
    closed: (id, dir) => `ticket ${id} marked resolved (${dir}).`,
    prepared: (file, source) => `${file}.resolved seeded from .${source}: edit it.`,
    alreadyPrepared: (file) => `${file}: already prepared, unchanged.`,
    acceptNeedsPrepare: '--accept-theirs only works with --prepare.',
    held: (file) =>
      `${file}: protected path, NOT seeded from the agent's version — write ${file}.resolved yourself, or explicitly accept its version:`,
    editThenApply: 'Edit the .resolved files (or create a .delete file to delete), then:',
    applied: (id, sha) => `ticket ${id} resolved and merged (commit ${sha}), Test Gate green.`,
    files: (files) => `files: ${files}`,
    duplicatesClosed: (ids) => `duplicates of the same conflict closed: ${ids}`,
    alreadyClean: (id) => `ticket ${id}: no conflict anymore, nothing to apply.`,
    gateFailed: (id, exitCode) =>
      `red Test Gate after resolving ticket ${id}${exitCode !== null ? ` (code ${exitCode})` : ''}: the ticket stays open, adjust the .resolved files.`,
    streak: (n) => `${n} consecutive semantic ${plural(n, 'failure', 'failures')}.`,
    none: 'no open ticket.',
    colTicket: 'TICKET',
    colState: 'STATE',
    colReason: 'REASON',
    colAgent: 'AGENT',
    colAttempts: 'ATTEMPTS',
    colDate: 'DATE',
    colFiles: 'FILES',
    stateOpen: 'open',
    stateResolved: 'resolved',
    stateCorrupt: (cause) => `unreadable (${cause})`,
    unknownField: '—',
    corrupt: (id, cause) =>
      `ticket ${id} is unreadable (${cause}): its content can be neither read, prepared nor applied — inspect its folder, then close it.`,
    howTo: (n) =>
      `${n} open ${plural(n, 'ticket', 'tickets')}: prepare then apply the resolution behind the Test Gate, or --close if already fixed by hand.`,
  },

  hook: {
    collision: (entries) =>
      `Striart: ${entries
        .map((e) => `${e.file} is predicted or locked by ${e.agents.join(', ')}`)
        .join(
          '; ',
        )}. Another agent is working on this file: editing it here will likely conflict at merge — coordinate or narrow your change (advisory only, nothing is blocked).`,
    sessionEnded: (agent, tool, reason) =>
      `Supervised session ended: ${agent} (${tool}${reason ? `, ${reason}` : ''}). Its commits will be merged by striart watch or striart merge ${agent}.`,
    warnings: {
      unknownTool: (tool) =>
        `hook skipped: unknown tool "${tool}" (claude, codex, copilot, gemini, cline).`,
      unknownEvent: (tool, event) => `hook skipped: unknown event "${event}" for ${tool}.`,
      noEvent: (reason) =>
        reason === 'TOO_LARGE'
          ? 'hook skipped: event too large on stdin (bounded read).'
          : reason === 'TIMEOUT'
            ? 'hook skipped: no complete event received on stdin in time.'
            : reason === 'TTY'
              ? 'hook skipped: no event on stdin (this command is run by the coding tool, not by hand).'
              : 'hook skipped: stdin unreadable.',
      invalidPayload: 'hook skipped: the received event is not a JSON object.',
      eventMismatch: (expected, actual) =>
        `hook skipped: the received event (${actual}) does not match the declared one (${expected}).`,
      contextFailed: (message) => `hook skipped: ${message}`,
      codeConfigUntrusted:
        'executable Striart config (striart.config.mjs) not loaded by a user-level hook: default hook settings, end-of-session notifications skipped. Install the hook in the clone (striart hook install <tool> --agent <name>) or use a data config (.striartrc.json).',
      configFailed: (message) => `Striart config unreadable for the hook: ${message}`,
      userConfigFailed: (message) => `Striart user config ignored (no trusted root): ${message}`,
    },
    scopeRequired:
      'say where to install the hook: --user (user configuration) or --agent <name> (clone).',
    installed: (tool, scope, agent, dryRun) =>
      `${dryRun ? '(dry run) ' : ''}${tool} hook installed ${scope === 'user' ? 'for the user' : `in the clone of ${agent}`}.`,
    uninstalled: (tool, scope, agent, dryRun) =>
      `${dryRun ? '(dry run) ' : ''}${tool} hook removed ${scope === 'user' ? 'from the user configuration' : `from the clone of ${agent}`}.`,
    change: (action, file) =>
      `${{ create: 'created', update: 'updated', remove: 'removed', unchanged: 'unchanged' }[action] ?? action}: ${file}`,
    reloadHint: (tool) =>
      tool === 'codex'
        ? 'Codex: approve the hook with /hooks (unmanaged hooks must be trusted before they run).'
        : tool === 'cline'
          ? 'Cline: enable Settings → Features → Enable Hooks.'
          : `restart ${tool} to load the hook.`,
  },

  lock: {
    released: (reason) => `main repository released ("${reason}").`,
    alreadyFree: 'main repository already free.',
    reserved: (reason, pid) => `main repository reserved for "${reason}" (PID ${pid} watched).`,
    reservedDetail:
      'merge, sync, promote, resolve --apply and the watch auto-merge are refused while that process lives.',
    free: 'main repository free.',
    busy: (reason, pid, date, since) =>
      `main repository reserved: "${reason}" (PID ${pid}, since ${date}, ${since}).`,
    deadPid: (reason, pid) =>
      `reservation "${reason}" inactive: PID ${pid} is dead (released by the next operation).`,
  },

  watch: {
    started: (dir) => `watcher running on ${dir} (Ctrl+C to quit).`,
    autoMerge: 'auto-merge: every commit goes through the Test Gate.',
    noMerge: 'auto-merge off (--no-merge): commits are only reported.',
    commit: (agent, branch, sha) => `new commit from ${agent} on ${branch} (${sha}).`,
    mergeSkipped: (agent) => `${agent} is autonomous: its merge happens at the end of its session.`,
    mergeError: (agent, error) => `cannot merge ${agent}: ${error}`,
    reconcileError: (error) => `periodic reconciliation failed: ${error}`,
    behind: (agent, n, branch) =>
      `${agent} is ${n} ${plural(n, 'commit', 'commits')} behind ${branch}: rebase at the next merge.`,
    caughtUp: (agent, branch) => `${agent} up to date again on ${branch}.`,
    draining: 'stopping: finishing the current operation (Ctrl+C again to force)',
    mergeDeferred: (agent) =>
      `${agent} not merged (stop requested): the next watch will not pick it up again.`,
    fetchError: (agent, error) => `silent fetch failed${agent ? ` for ${agent}` : ''}: ${error}`,
    overlapAgents: (a, b, files, n) =>
      `overlap observed: ${a} and ${b} both modified ${files}${n > 0 ? ` (+${n})` : ''} (not predicted by the Router).`,
    overlapTarget: (agent, files, n, branch) =>
      `overlap observed: ${agent} modified ${files}${n > 0 ? ` (+${n})` : ''} which ${branch} also advanced.`,
    overlapCatchup: (agent, status) =>
      status === 'REBASED'
        ? `${agent} rebased early (overlap observed).`
        : status === 'SKIPPED_SESSION'
          ? `${agent}: live session, early rebase postponed (clone untouchable).`
          : `${agent}: early rebase not done (${status}) — handled at its merge.`,
    overlapError: (error) => `overlap observation failed: ${error}`,
    idleWarned: (agent, idle, willClose) =>
      willClose
        ? `${agent} idle for ${idle}: its session will be closed after the grace period without further activity (clone and work kept).`
        : `${agent} idle for ${idle} (automatic closing is not enabled).`,
    idleError: (error) => `idle session sweep failed: ${error}`,
  },

  daemon: {
    label: (name) => (name === 'watch' ? 'watcher' : 'dashboard'),
    started: (label, pid) => `${label} started in the background (PID ${pid}).`,
    boot: 'restart at boot: register "striart watch --daemon" in the OS scheduler.',
    stopped: (label, pid) => `${label} stopped (PID ${pid}).`,
    staleCleaned: (pid) => `orphan PID file cleaned (PID ${pid}: the daemon no longer exists).`,
    stopping: (label, pid) =>
      `stop requested: the ${label} (PID ${pid}) finishes the current operation, then exits on its own.`,
    notRunning: (label) => `no background ${label}.`,
    running: (label, pid, since) => `${label} running (PID ${pid}, for ${since}).`,
    dead: (label, pid) =>
      `${label} not running (orphan PID file, PID ${pid}: the daemon no longer exists).`,
  },

  dashboard: {
    listening: (url) => `dashboard: ${url}`,
    quit: 'Ctrl+C to stop.',
    url: (url) => `address: ${url}`,
    signIn: (url) => `sign in (one-time link): ${url}`,
    signInDetail: (expiresAt) =>
      `the link expires at ${expiresAt} and works once; new link: striart dashboard --link. Do not share it.`,
    linkPending:
      'the dashboard is still starting: its sign-in link is not ready. Run "striart dashboard --link" in a moment.',
    noInstance:
      'no running dashboard for this repository: run "striart dashboard" or "striart dashboard --daemon".',
  },

  control: {
    autonomousMerged: (agent, kept) =>
      `✅ autonomous session ${agent}: work merged` + (kept ? ` — ${kept}` : ', clone cleaned.'),
    autonomousQueued: (agent) => `⏳ autonomous task of ${agent} queued (Router collision).`,
    autonomousBlocked: (agent, why) => `⛔ autonomous session ${agent}: ${why}`,
    autonomousFailed: (message) => `⛔ autonomous session: ${message}`,
  },

  attach: {
    wrongCwd: (cwd) => `"striart attach" runs from the agent's clone (current directory: ${cwd}).`,
    failed: (agent, error) => `cannot join ${agent}: ${error}. Is the terminal host still running?`,
    ended: 'session ended on the agent side.',
  },

  watchUi: {
    loading: 'Loading agents…',
    terminalEmpty: 'No command run yet — type /status or !ls to start.',
    idleTool: 'hosted tool finished? — "/relaunch" to start it again',
    refreshFailed: (error) => `Refresh failed: ${error}`,
    sending: (agent) => `Sending to "${agent}"`,
    relaunching: (agent) => `Relaunching "${agent}"`,
    relaunchNoAgent: 'no agent — "/relaunch agent-a" or select its tab',
    unknownAgent: (agent) => `Unknown agent: "${agent}".`,
    autonomousRefused: (agent) =>
      `"${agent}" is autonomous with no live ACP session — an argv session is one-shot (no process left to talk to), an ACP session is addressable only while it runs in its persistent host (acp.persistentHost). Use the dashboard or striart resolve.`,
    acpRefused: (agent, reason) => `ACP session of "${agent}": message refused — ${reason}`,
    relaunchAutonomous: (agent) =>
      `"${agent}" is autonomous: /relaunch only restarts the tool of an attended agent (pty).`,
    hostUnavailable: (agent, error) => `pty host unavailable for "${agent}": ${error}`,
    injectFailed: (agent, error) => `Could not deliver to "${agent}": ${error}`,
    dashboardForeground:
      '"dashboard" starts an HTTP server that runs forever — use "dashboard --daemon" to start it in the background from this field ("dashboard --stop"/"--status" to control it), or run it in a separate terminal.',
    foregroundRefused: (cmd, reason) => `"${cmd}" cannot run from this field: ${reason}.`,
    foreground: {
      watch:
        'it would start a second watcher next to the one hosting this panel — duplicate merges, main.lock contention',
      protocol:
        'it serves a protocol on stdin/stdout — this field cannot be its client, it would hang until the timeout',
      terminal:
        'it must own the real terminal (raw mode) — incompatible with this panel, which already owns it',
      internal: 'internal command, never meant for a human (started by --open)',
    },
    unavailableHere: (reason) => `unavailable here (${reason})`,
    dashboardSuggestion: 'runs in the foreground alone — use "--daemon" from this field',
    initSuggestion: '.striart/ is already there if you are in this panel — rarely useful here',
    clearSuggestion:
      'Clears the Commands pane — in an agent detail view, sends the real shell clear command to that agent',
    relaunchSuggestion:
      '[agent] — types the start command again (useful when the hosted tool stopped)',
    exitSuggestion: 'Quits this panel (like Ctrl+C)',
    // `watch --ui` cockpit: persistent screen with stable positions (header,
    // key figures, agents, detail, bottom pane, input, key bar).
    cockpit: {
      appName: 'striart watch',
      starting: 'Starting the cockpit (loading modules, a few seconds)',
      watcherOn: 'watcher running',
      watcherMerge: 'auto merge',
      watcherNoMerge: 'merge disabled',
      stale: (since) => `stale data since ${since}`,
      loading: 'loading…',
      kpiAgents: 'agents',
      kpiCommits: 'pending commits',
      kpiConflicts: 'conflicts',
      kpiQueue: 'queue',
      kpiAgentsShort: 'ag.',
      kpiCommitsShort: 'commits',
      kpiConflictsShort: 'conflicts',
      kpiQueueShort: 'queue',
      colAgent: 'AGENT',
      colState: 'STATE',
      colCommits: 'COMMITS',
      colLast: 'LAST COMMIT',
      colAge: 'AGE',
      colBranch: 'BRANCH',
      colMode: 'MODE',
      colSession: 'SESSION',
      groupAttention: 'To handle',
      groupRunning: 'Running',
      groupIdle: 'Idle',
      sectionAgents: 'Agents',
      sectionDetail: (agent) => `Detail · ${agent}`,
      sectionJournal: 'Journal',
      sectionCommands: 'Commands',
      sectionOutput: (agent) => `Output · ${agent}`,
      emptyTitle: 'No agent yet.',
      emptyHint: 'Create the first one: striart start agent-a',
      noSelection: 'No agent selected.',
      detailSession: 'Session',
      idleState: (stage, duration) =>
        stage === 'closable'
          ? `idle ${duration}, closable`
          : stage === 'warned'
            ? `idle ${duration}, warned`
            : `idle ${duration}`,
      detailBranch: 'Branch',
      detailCommits: 'Commits',
      detailFiles: 'Files',
      detailTicket: 'Ticket',
      detailLoading: 'reading the clone…',
      detailUnreadable: (error) => `unreadable clone: ${error}`,
      pendingNone: 'no commit waiting to be merged',
      pendingCount: (n) => `${n} ${plural(n, 'commit', 'commits')} waiting to be merged`,
      filesNone: 'no changed file',
      filesMore: (n) => `+${n} more`,
      uncommitted: (n) => `${n} uncommitted ${plural(n, 'change', 'changes')}`,
      ticketLine: (id, reason) => `${id} · ${reason}`,
      journalEmpty: 'No event yet. Watcher commits, merges and rebases will show up here.',
      outputEmpty: 'No output: this agent has no hosted terminal (autonomous mode).',
      outputDisconnected: 'hosted terminal unreachable for now — retrying',
      terminalSmall: (cols, rows) =>
        `Terminal too small (${cols}×${rows}): enlarge it to see the whole screen (80×24 recommended).`,
      promptIdle: 'Press / for a command, @ to write to an agent, ? for help.',
      modeCommand: 'command',
      modeMessage: 'message',
      modeShell: 'shell',
      merging: (agent) => `Merging "${agent}"`,
      syncing: (agent) => `Syncing "${agent}"`,
      done: (label, elapsed) => `${label} (${elapsed})`,
      seeCommands: 'details in the Commands pane (Tab)',
      confirmMergeTitle: (agent, target) => `Merge "${agent}" into ${target}?`,
      confirmMergePending: (n) =>
        `${n} pending ${plural(n, 'commit', 'commits')} will be integrated.`,
      confirmMergeNone: 'No commit waiting: the merge will not change anything.',
      confirmMergeGate:
        'The Test Gate runs before any commit: on failure the merge is aborted and a ticket is created.',
      confirmMergeTicket:
        'A conflict ticket is open for this agent ("striart resolve"): this merge may fail again.',
      plainConfirm: 'Answer "y" to confirm; any other answer cancels.',
      confirmMergeLive:
        'An autonomous session is running on this clone: the merge is refused while it runs.',
      cancelled: 'Cancelled.',
      plainKeys:
        '  m <agent> merge (y to confirm), s <agent> sync, /command, !shell, @agent text, ? help, q quit',
      keys: {
        select: 'select',
        details: 'details',
        merge: 'merge',
        sync: 'sync',
        command: 'command',
        message: '@agent message',
        shell: 'shell',
        pane: 'journal/commands',
        help: 'help',
        quit: 'quit',
        send: 'send',
        cancel: 'cancel',
        complete: 'complete',
        history: 'suggestions/history',
        confirm: 'confirm',
        back: 'back',
        scroll: 'scroll',
        close: 'close',
      },
      helpTitle: 'Help — shortcuts',
      helpSections: [
        {
          title: 'Navigation',
          rows: [
            ['↑ ↓  j k', 'select an agent'],
            ['Enter', 'agent details and output (Esc to go back)'],
            ['Tab', 'switch the bottom pane (journal, commands)'],
            ['PgUp PgDn', 'scroll the bottom pane'],
          ],
        },
        {
          title: 'Actions on the selected agent',
          rows: [
            ['m', 'merge into the target branch, behind the Test Gate (confirmation)'],
            ['s', 'sync: rebase the agent onto the target branch'],
          ],
        },
        {
          title: 'Input (focus moves to the field; Esc abandons it)',
          rows: [
            ['/', 'striart command (/status, /resolve, /clear, /relaunch, /exit)'],
            ['@', 'message an agent (@agent text); bare text → selected agent'],
            ['!', 'real shell command'],
            ['Tab', 'complete the suggestion'],
          ],
        },
        {
          title: 'General',
          rows: [
            ['?', 'this help'],
            ['Esc', 'go back (confirmation, help, details, input)'],
            ['q  Ctrl+C', 'quit (the watcher stops)'],
          ],
        },
      ],
    },
    agentAutonomous: 'autonomous — message goes to its live ACP session',
    agentSupervised: 'supervised, active',
    agentInactive: 'inactive',
  },

  acpProxy: {
    optionProfile: 'Agent',
    optionProfileHelp:
      'Upstream coding agent working in the Striart clone (locked at the first prompt)',
    optionPermissions: 'Permissions',
    optionPermissionsHelp: "Who decides on the agent's requests (locked at the first prompt)",
    permissionLabels: {
      ask: 'Ask me (in the editor)',
      reject: 'Reject all',
      allow: 'Allow all',
      profile: "Profile's policy",
    },
    optionMerge: 'End of session',
    optionMergeHelp: 'What Striart does with the work when the session ends',
    mergeLabels: { auto: 'Merge under the Test Gate', manual: 'Keep the clone (manual merge)' },
    commandFinish: 'End the session: commit policy, merge under the Test Gate, cleanup',
    commandStatus: "Show this session's clone, upstream agent and settings",
    started: (agent: string, profile: string, clonePath: string) =>
      `🧬 [striart] clone "${agent}" created (${clonePath}) — upstream agent: ${profile}. All work happens in this clone; your main repository is only touched by the final merge, under the Test Gate.\n`,
    ideMcpIgnored: (n: number) =>
      `ℹ️ [striart] ${n} editor MCP server(s) not passed to the upstream agent: they would act on your main repository, not on the clone.\n`,
    replacedControls: (n: number) =>
      `ℹ️ [striart] ${n} control character(s) in the prompt replaced with "�".\n`,
    foreignTurn:
      '\n↪ [striart] a message from another Striart surface (watch --ui) is being processed.\n',
    turnCancelled:
      '\n⏹ [striart] turn cancelled. Closing the session now keeps the clone unmerged; send another prompt to finish the work first.\n',
    elicitationElsewhere:
      '\n❓ [striart] the agent asks a question this editor cannot display: answer it in the dashboard (striart dashboard) — unanswered, it will be cancelled (fail closed).\n',
    permissionLost: (title: string) =>
      `\nℹ️ [striart] request "${title}" was already decided elsewhere or expired.\n`,
    collisionWaiting: (agents: string) =>
      `⏳ [striart] the Router predicts a collision with ${agents}: waiting for them to finish before creating the clone.\n`,
    finishing:
      '\n🏁 [striart] ending the session: closing the upstream agent, commit policy, merge under the Test Gate…\n',
    cancelIgnoredWhileFinishing:
      '\n⏳ [striart] the merge is running: it is never interrupted (the repository is never left "merging").\n',
    outcomeMerged: (agent: string, sha: string) =>
      `✅ [striart] "${agent}" work merged (commit ${sha.slice(0, 8)}), Test Gate green, clone cleaned up.\n`,
    outcomeAlreadyIntegrated: (agent: string, sha: string) =>
      `✅ [striart] "${agent}" work was already in the target branch (commit ${sha.slice(0, 8)}): nothing merged, Test Gate not replayed, clone cleaned up.
`,
    outcomeKept: (agent: string, reason: string, clonePath: string | null) =>
      `⛔ [striart] "${agent}": ${reason}${clonePath ? ` Clone kept: ${clonePath}` : ''}\n`,
    outcomeNothing: 'ℹ️ [striart] no task started: nothing to merge.\n',
    keptReasons: {
      SESSION_FAILED: (detail: string | null) =>
        detail === 'BUDGET_EXCEEDED'
          ? 'token budget exceeded: session stopped, nothing was merged, clone kept (see `striart usage`).'
          : `the upstream session ended ${detail ?? 'FAILED'}; nothing was merged.`,
      NO_COMMIT: 'the agent committed nothing: nothing to merge.',
      NO_CHANGES: 'the agent changed nothing: nothing to merge.',
      ONLY_EXCLUDED_CHANGES:
        'only files excluded from commits were left (secrets, injected files).',
      COMMIT_REFUSED: (detail: string | null) =>
        `Striart commit refused (${detail ?? '?'}): the clone state is ambiguous.`,
      COMMIT_FAILED: (detail: string | null) => `Striart could not commit (${detail ?? '?'}).`,
      MERGE_BLOCKED: (detail: string | null) =>
        `merge blocked (${detail ?? '?'}): Test Gate red or conflict — a ticket is waiting for you (striart status).`,
      CLEANUP_SKIPPED: (detail: string | null) =>
        `merged, but the clone could not be cleaned up (${detail ?? '?'}).`,
      HUMAN_REVIEW_REQUIRED: (agent: string) =>
        `commitPolicy 'human': nothing is merged automatically — review the clone, then run "striart merge ${agent}".`,
      MERGE_DEFERRED: (agent: string, detail: string | null) =>
        detail === 'DISCONNECTED'
          ? `the editor disconnected without ending the session: the merge is up to you (striart merge ${agent}).`
          : `the merge is up to you (striart merge ${agent}).`,
    },
    logAt: (logPath: string) => `📄 [striart] session log: ${logPath}\n`,
    status: (p: {
      agent: string | null;
      profile: string;
      permissions: string;
      merge: string;
      turns: number;
      clonePath: string | null;
    }) =>
      `[striart] agent: ${p.agent ?? '(clone created at the first prompt)'} · upstream: ${p.profile} · permissions: ${p.permissions} · end: ${p.merge} · turns: ${p.turns}${p.clonePath ? ` · clone: ${p.clonePath}` : ''}\n`,
  },

  doctorChecks: {
    label: (id) => DOCTOR_LABELS[id] ?? null,
    detail: (key, params) => DOCTOR_DETAILS[key]?.(params) ?? null,
    hint: (key, params) => DOCTOR_HINTS[key]?.(params) ?? null,
  },

  errors: (code, details) => ERRORS[code]?.(details) ?? null,
};
