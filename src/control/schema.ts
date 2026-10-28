/**
 * Schémas PUBLIÉS du Striart Control Protocol v1 et du contrat `--json` de
 * la CLI — source unique.
 *
 * Trois usages, une seule définition :
 *  1. validation positive des paramètres côté serveur (validate.ts) ;
 *  2. description publiée aux clients : document OpenRPC 1.3
 *     (`schemas/striart-control-v1.openrpc.json`, `rpc.discover`,
 *     `striart api --schema openrpc`) et bundle JSON Schema 2020-12 du
 *     document `--json` (`schemas/striart-document-v1.schema.json`,
 *     `striart api --schema json-schema`) ;
 *  3. tests de contrat communs CLI ↔ protocole (mêmes `$defs`).
 * Les fichiers de `schemas/` sont GÉNÉRÉS depuis ce module ; un test
 * (control-contract) échoue s'ils divergent.
 *
 * Politique de version : à l'intérieur de la v1, seuls des ajouts
 * compatibles (champ facultatif, méthode, valeur d'énumération documentée
 * comme ouverte). Les objets de données acceptent des champs inconnus : un
 * client DOIT les ignorer. Les paramètres, eux, sont fermés
 * (`additionalProperties: false`) — une faute de frappe est refusée, jamais
 * ignorée.
 */
import { CONTROL_PROTOCOL_VERSION, SCHEMA_VERSION } from './envelope.ts';
import type { JsonSchema } from './validate.ts';

const REF_PREFIX = '#/components/schemas/';

const ref = (name: string): JsonSchema => ({ $ref: `${REF_PREFIX}${name}` });
const str = (description?: string): JsonSchema =>
  description ? { type: 'string', description } : { type: 'string' };
const nullableStr: JsonSchema = { type: ['string', 'null'] };
const int = (minimum?: number): JsonSchema =>
  minimum === undefined ? { type: 'integer' } : { type: 'integer', minimum };
const nullableInt: JsonSchema = { type: ['integer', 'null'] };
const bool: JsonSchema = { type: 'boolean' };
const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
  extra: JsonSchema = {},
): JsonSchema => ({ type: 'object', properties, required, ...extra });
const variant = (
  discriminant: string,
  value: string,
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): JsonSchema =>
  obj({ [discriminant]: { const: value }, ...properties }, [discriminant, ...required]);

// --- Identifiants (paramètres) ------------------------------------------------

const PARAMETER_DEFS: Record<string, JsonSchema> = {
  AgentName: {
    type: 'string',
    description:
      'Agent name: a letter or digit, then letters, digits, "-" or "_", 64 characters at most (same rule as the CLI).',
    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
    'x-striart-error': 'INVALID_AGENT_NAME',
  },
  TicketId: {
    type: 'string',
    description: 'Conflict ticket id (its folder name under .striart/conflicts/).',
    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$',
    'x-striart-error': 'INVALID_ARGUMENT',
  },
  ElicitationId: {
    type: 'string',
    description: 'Id of a pending elicitation (structured question of an ACP agent).',
    pattern: '^elic-[0-9a-f-]{8,36}$',
    'x-striart-error': 'INVALID_ARGUMENT',
  },
  ReviewId: {
    type: 'string',
    description: 'Id of a human review request (.striart/reviews/<id>.json).',
    pattern: '^rev-[0-9a-f]{12}$',
    'x-striart-error': 'INVALID_ARGUMENT',
  },
  ReviewVerdictValue: {
    description: 'Verdict of a review: approve, request-changes or reject.',
    enum: ['approve', 'request-changes', 'reject'],
    'x-striart-error': 'REVIEW_VERDICT_INVALID',
  },
  ReviewSummary: {
    type: 'string',
    description: 'Free-text summary of the verdict (neutralised and bounded by the domain).',
    maxLength: 16_384,
    'x-striart-error': 'REVIEW_VERDICT_INVALID',
  },
  ReviewCommentsInput: {
    type: 'array',
    description:
      'Structured remarks (50 at most). Paths are relative to the project and checked by the domain.',
    maxItems: 50,
    items: obj(
      {
        file: { type: ['string', 'null'], maxLength: 1024 },
        line: { type: ['integer', 'null'], minimum: 1 },
        severity: { enum: ['blocker', 'major', 'minor', 'info'] },
        body: { type: 'string', minLength: 1, maxLength: 16_384 },
      },
      ['severity', 'body'],
      { additionalProperties: false },
    ),
    'x-striart-error': 'REVIEW_VERDICT_INVALID',
  },
  PermissionId: {
    type: 'string',
    description: 'Id of a pending semi-autonomous permission request.',
    pattern: '^perm-[0-9a-f-]{8,36}$',
    'x-striart-error': 'PERMISSION_ID_INVALID',
  },
  PermissionOptionId: {
    type: 'string',
    description: 'One of the optionId values the agent proposed for this request.',
    minLength: 1,
    maxLength: 256,
    'x-striart-error': 'PERMISSION_ID_INVALID',
  },
  Prompt: {
    type: 'string',
    description: 'Task prompt — data, never code: passed to the agent as one argv element.',
    pattern: '\\S',
    maxLength: 200_000,
    'x-striart-error': 'EMPTY_PROMPT',
  },
  ProfileName: {
    type: 'string',
    description: 'Key of config.agentProfiles.',
    minLength: 1,
    maxLength: 128,
  },
  SubscriptionId: { type: 'string', pattern: '^sub-[0-9]{1,12}$' },
};

// --- Enveloppe partagée CLI ↔ protocole --------------------------------------

const ENVELOPE_DEFS: Record<string, JsonSchema> = {
  ErrorKind: {
    enum: ['usage', 'refusal', 'failure'],
    description:
      'usage = invalid input (CLI exit 2); refusal = a Striart guard said no (exit 3); failure = execution failed, may be transient (exit 1).',
  },
  Outcome: {
    enum: ['ok', 'refused', 'failed'],
    description: 'Outcome of an operation that returned a result (the CLI maps it to exit 0/3/1).',
  },
  ErrorObject: obj({
    code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', description: 'Stable machine code.' },
    kind: ref('ErrorKind'),
    message: str('Human message, localized (STRIART_LANG).'),
    hint: { type: ['string', 'null'], description: 'Next action, ideally an exact command.' },
    details: {
      type: 'object',
      description: 'Identifiers only (agent, ticket, path, PID) — secrets are redacted.',
    },
  }),
  Warning: obj({ code: str(), message: str() }),
  Document: {
    description:
      'Machine document: `striart <command> --json` on stdout, and the `result` (or `error.data`) of every Striart Control Protocol call.',
    oneOf: [ref('ResultDocument'), ref('ErrorDocument')],
  },
  /**
   * Résultat d'une opération : `ok` vaut true quand l'issue est nominale ;
   * un résultat abouti mais non nominal (merge en conflit, gate rouge…) a
   * `ok: false`, `outcome` dit pourquoi, `data` porte le détail.
   */
  ResultDocument: obj(
    {
      schemaVersion: { const: SCHEMA_VERSION },
      command: str('CLI command name, or protocol method name.'),
      ok: bool,
      outcome: ref('Outcome'),
      data: {},
      warnings: arr(ref('Warning')),
    },
    ['schemaVersion', 'command', 'ok', 'data'],
  ),
  ErrorDocument: obj({
    schemaVersion: { const: SCHEMA_VERSION },
    command: nullableStr,
    ok: { const: false },
    error: ref('ErrorObject'),
  }),
  StreamEvent: obj(
    {
      schemaVersion: { const: SCHEMA_VERSION },
      command: str(),
      type: str(),
      at: str(),
      data: {},
    },
    ['schemaVersion', 'command', 'type', 'at'],
  ),
};

// --- Objets de données --------------------------------------------------------

const TICKET_REASONS = [
  'MERGE_CONFLICT',
  'UNMERGEABLE_CONFLICT',
  'GATE_FAILED',
  'SEMANTIC_MERGE_FAILED',
  'SEMANTIC_GATE_FAILED',
  'PROMOTION_GATE_FAILED',
  'COMMIT_HOOK_REJECTED',
];

const DATA_DEFS: Record<string, JsonSchema> = {
  AgentSession: {
    oneOf: [
      variant('state', 'running', { via: { enum: ['autonomous', 'pty'] }, pid: int(1) }),
      variant('state', 'recent-activity', { via: { type: 'null' }, pid: { type: 'null' } }, []),
      variant('state', 'idle', { via: { type: 'null' }, pid: { type: 'null' } }, []),
    ],
  },
  RouterDetails: {
    description:
      'Router detail at launch (additive, informative: no decision depends on it). `serialized` tells why the task was serialized behind every active agent (sentinel `**`); `shared` lists bookkeeping files left out of collision detection (`tokens.router.sharedFiles`). Lists are bounded (`counts` holds the real totals); the raw model output never appears.',
    ...obj(
      {
        promptVersion: nullableStr,
        serialized: nullable(
          obj({ kind: str(), reasons: arr(str()), code: str(), kept: int(0), total: int(0) }, [
            'kind',
          ]),
        ),
        files: arr(
          obj(
            {
              path: str(),
              confidence: { type: ['number', 'null'] },
              source: str(),
              reason: str(),
              from: str(),
            },
            ['path', 'source'],
          ),
        ),
        shared: arr(str()),
        expansion: arr(
          obj({ path: str(), reason: str(), from: str(), confidence: { type: 'number' } }),
        ),
        tree: nullable(obj({ mode: str(), total: int(0), shown: int(0), omitted: int(0) })),
        counts: obj({ files: int(0), shared: int(0), expansion: int(0) }),
      },
      ['serialized', 'files', 'shared', 'expansion'],
    ),
  },
  ObservedOverlap: {
    description:
      'A file REALLY touched (committed work, diff against the agent base) by two agents (`kind: agents`, only files the Router had not predicted for both) or by an agent while the target branch also advanced it (`kind: target`). Observed at runtime, independent of any prediction. `files` is bounded; `fileCount` is the real total.',
    ...obj(
      {
        kind: { enum: ['agents', 'target'] },
        agents: arr(str()),
        files: arr(str()),
        fileCount: int(0),
        filesTruncated: bool,
        key: str('Stable id of the signal (kind, agents, file set).'),
      },
      ['kind', 'agents', 'files', 'fileCount', 'key'],
    ),
  },
  OverlapReport: {
    description:
      'Runtime overlap net (additive). Read-only: git diffs between COMMITS, never a worktree. `coverage.uncommitted` is always false: uncommitted edits are NOT seen. `cost.gitCalls` is bounded by `cost.budget` per observation; agents beyond the budget are listed in `deferred`, agents whose git facts could not be read in `errors` (stable reason only, never a git message). When the observation itself fails the value is `{unavailable: true, reason}`.',
    oneOf: [
      obj(
        {
          targetBranch: str(),
          overlaps: arr(ref('ObservedOverlap')),
          deferred: arr(str()),
          errors: arr(obj({ agent: str(), reason: str() })),
          agentsObserved: int(0),
          ignoredShared: int(0),
          skippedUnsafe: int(0),
          truncated: bool,
          coverage: obj({ committed: { const: true }, uncommitted: { const: false } }),
          cost: obj({
            gitCalls: int(0),
            budget: int(0),
            cacheHits: int(0),
            durationMs: { type: 'number', minimum: 0 },
          }),
          generatedAt: str(),
        },
        ['targetBranch', 'overlaps', 'deferred', 'errors', 'coverage', 'cost'],
      ),
      obj({ unavailable: { const: true }, reason: str() }),
    ],
  },
  IdleAgent: {
    description:
      'Idle-GC verdict for one agent (additive). `state`: active (at least one fresh signal, or a signal that could not be read — fail closed), idle (EVERY signal is older than the threshold) or protected (a guard: pending human request, open ticket, orchestration plan, merge in progress, main-repo session, removal, exclusion). `session`: live process / ended (clone kept) / never launched. `closable` is true only when the warning, the grace period, the threshold and the authorization are all met.',
    ...obj(
      {
        agent: str(),
        state: { enum: ['active', 'idle', 'protected'] },
        stage: { enum: ['active', 'protected', 'idle', 'warned', 'closable'] },
        session: { enum: ['live', 'ended', 'none'] },
        host: { enum: ['acp', 'pty', 'process', 'none'] },
        idleMs: { type: ['number', 'null'] },
        lastActivityAt: nullableStr,
        lastActivitySignal: nullableStr,
        reasons: arr(str()),
        blockers: arr(str()),
        plan: { enum: ['none', 'warn', 'close'] },
        closable: bool,
        closeBlockedBy: arr(str()),
        warnedAt: nullableStr,
        closeNotBefore: nullableStr,
        signals: arr(obj({ name: str(), status: str(), at: nullableStr })),
        worktreeSkipped: bool,
      },
      ['agent', 'state', 'stage', 'session', 'host', 'plan', 'closable'],
    ),
  },
  IdleStatus: {
    description:
      'Idle GC (additive, read-only): a dry-run classification of every agent plus the date of the last real sweep. When it cannot be computed the value is `{available: false, reason}`.',
    oneOf: [
      obj(
        {
          available: { const: true },
          lastSweepAt: nullableStr,
          generatedAt: str(),
          enabled: bool,
          action: { enum: ['report', 'warn', 'close'] },
          closeAuthorized: bool,
          authorizationError: nullableStr,
          holds: arr(str()),
          thresholds: obj({ warnAfterMs: int(0), closeAfterMs: int(0), graceMs: int(0) }),
          agents: arr(ref('IdleAgent')),
        },
        ['available', 'enabled', 'action', 'agents'],
      ),
      obj({ available: { const: false }, reason: str() }),
    ],
  },
  IdleSweepReport: obj(
    {
      generatedAt: str(),
      dryRun: bool,
      enabled: bool,
      action: { enum: ['report', 'warn', 'close'] },
      closeAuthorized: bool,
      authorizationError: nullableStr,
      forced: bool,
      suspended: bool,
      holds: arr(str()),
      thresholds: obj({ warnAfterMs: int(0), closeAfterMs: int(0), graceMs: int(0) }),
      agents: arr(ref('IdleAgent')),
      warned: arr(str()),
      closed: arr(obj({ agent: str(), host: str(), code: str() })),
      refused: arr(obj({ agent: str(), host: str(), code: str(), detail: nullableStr })),
    },
    ['generatedAt', 'dryRun', 'enabled', 'action', 'agents', 'warned', 'closed', 'refused'],
  ),
  Agent: obj(
    {
      name: str(),
      status: {
        enum: ['ACTIVE', 'MISSING', 'BROKEN', 'REMOVING'],
        description:
          'REMOVING: the clone is being deleted (`removing` in the registry) — never shown as active or broken.',
      },
      removing: bool,
      removingSince: str(),
      branch: str(),
      currentBranch: str(),
      command: nullableStr,
      mode: { enum: ['attended', 'autonomous'] },
      profile: nullableStr,
      pendingCommits: int(0),
      lastMessage: nullableStr,
      sizeBytes: nullableInt,
      sizeHuman: nullableStr,
      sizesComputedAt: {
        type: ['string', 'null'],
        description:
          'When `sizeBytes` was measured (ISO 8601). Sizes are cached (at most 5 minutes old, refreshed sooner when the clone changes); activity and session state are never cached.',
      },
      session: ref('AgentSession'),
      acpHost: ref('AcpHostStatus'),
      routing: nullable(ref('RouterDetails')),
    },
    ['name', 'status', 'pendingCommits'],
  ),
  Collision: obj({ agent: str(), files: arr(str()) }),
  QueueRow: obj(
    {
      id: str(),
      agent: str(),
      status: { enum: ['RUNNING', 'WAITING'] },
      files: arr(str()),
      blockedBy: arr(ref('Collision')),
      after: nullableStr,
      ready: bool,
      routing: nullable(ref('RouterDetails')),
    },
    ['id', 'agent', 'status', 'files', 'blockedBy'],
  ),
  QueueTask: obj(
    {
      id: str(),
      status: { const: 'WAITING' },
      agent: str(),
      prompt: str(),
      predictedFiles: arr(str()),
      routing: nullable(ref('RouterDetails')),
      collisions: arr(ref('Collision')),
      command: nullableStr,
      after: nullableStr,
      createdAt: str(),
    },
    ['id', 'status', 'agent', 'predictedFiles', 'collisions', 'createdAt'],
  ),
  Ticket: obj(
    {
      id: ref('TicketId'),
      agent: str(),
      branch: str(),
      sha: str(),
      reason: { enum: TICKET_REASONS },
      conflictedFiles: arr(str()),
      unmergeable: arr(obj({ path: str(), kind: str() })),
      prompt: nullableStr,
      createdAt: str(),
      attempts: int(1),
      updatedAt: str(),
      dir: str(),
      resolved: bool,
    },
    ['id', 'agent', 'sha', 'reason', 'conflictedFiles', 'createdAt', 'dir'],
  ),
  CorruptTicket: {
    description:
      'A ticket whose ticket.json is unreadable or missing, listed instead of silently ignored. Its business fields are unknown (null); it can only be closed (ticket.close) — ticket.get / ticket.prepare / ticket.apply refuse it with TICKET_CORRUPT.',
    ...obj({
      id: ref('TicketId'),
      dir: str(),
      resolved: bool,
      status: { const: 'CORRUPT' },
      cause: { enum: ['MISSING', 'UNREADABLE', 'INVALID_JSON', 'INCOMPLETE'] },
      createdAt: str('Date of the ticket folder.'),
      agent: { type: 'null' },
      branch: { type: 'null' },
      sha: { type: 'null' },
      reason: { type: 'null' },
      conflictedFiles: arr(str()),
      prompt: { type: 'null' },
    }),
  },
  TicketEntry: {
    description:
      'An entry of a ticket list: a readable Ticket, or a CorruptTicket (status "CORRUPT").',
    oneOf: [ref('Ticket'), ref('CorruptTicket')],
  },
  ReviewVerdictDoc: obj({
    verdict: ref('ReviewVerdictValue'),
    summary: str(),
    comments: arr(
      obj({
        file: nullableStr,
        line: nullableInt,
        severity: { enum: ['blocker', 'major', 'minor', 'info'] },
        body: str(),
      }),
    ),
  }),
  HumanReview: {
    description:
      'A human review request. Untrusted text (diffstat, verdict summary and remarks come from git and agents): display as text only. "alive" = the orchestrator process waiting for the verdict still lives.',
    ...obj(
      {
        id: ref('ReviewId'),
        group: str(),
        agent: str(),
        reviewer: str(),
        round: int(1),
        branch: str(),
        sha: str(),
        baseCommit: str(),
        diffstat: str(),
        status: { enum: ['PENDING', 'ANSWERED', 'EXPIRED'] },
        verdict: nullable(ref('ReviewVerdictDoc')),
        createdAt: str(),
        answeredAt: nullableStr,
        expiresAt: str(),
        pid: int(1),
        alive: bool,
      },
      ['id', 'group', 'agent', 'status', 'createdAt', 'expiresAt', 'alive'],
    ),
  },
  OrchestrationRun: obj(
    {
      id: str(),
      mode: { enum: ['sequential', 'parallel'] },
      concurrency: int(1),
      status: { enum: ['running', 'done', 'interrupted'] },
      nodes: arr(
        obj(
          {
            id: nullableStr,
            kind: { enum: ['task', 'review', 'pipeline', 'race', 'team'] },
            state: { enum: ['pending', 'running', 'done', 'skipped'] },
            status: nullableStr,
            agent: nullableStr,
          },
          ['kind', 'state'],
        ),
      ),
      pid: int(1),
      startedAt: str(),
      updatedAt: str(),
      alive: bool,
    },
    ['id', 'status', 'nodes', 'startedAt', 'alive'],
  ),
  OrchestrationGroup: obj(
    {
      id: str(),
      kind: { enum: ['review', 'pipeline', 'race', 'team'] },
      runId: nullableStr,
      nodeId: nullableStr,
      agents: arr(str()),
      status: { enum: ['running', 'done'] },
      result: nullableStr,
      round: int(0),
      activeRoles: arr(str()),
      verdicts: arr(
        obj({ reviewer: str(), verdict: ref('ReviewVerdictValue') }, ['reviewer', 'verdict']),
      ),
      humanReview: nullableStr,
      pid: int(1),
      startedAt: str(),
      updatedAt: str(),
      alive: bool,
    },
    ['id', 'kind', 'agents', 'status', 'startedAt', 'alive'],
  ),
  OrchestrationSnapshot: obj({
    runs: arr(ref('OrchestrationRun')),
    groups: arr(ref('OrchestrationGroup')),
  }),
  OrchestrationStateData: {
    description:
      'Runs and groups of the orchestrated modes (alive computed) plus the human reviews.',
    ...obj({
      runs: arr(ref('OrchestrationRun')),
      groups: arr(ref('OrchestrationGroup')),
      reviews: arr(ref('HumanReview')),
    }),
  },
  ReviewListData: obj({ reviews: arr(ref('HumanReview')) }),
  ReviewAnswerData: obj({ review: ref('HumanReview') }),
  TicketDetail: {
    description: 'Full 3-way view of a ticket: BASE / OURS / THEIRS / LLM attempt per file.',
    allOf: [
      ref('Ticket'),
      obj({
        resolutions: arr(
          obj({
            path: str(),
            base: nullableStr,
            ours: nullableStr,
            theirs: nullableStr,
            llmAttempt: nullableStr,
          }),
        ),
        log: nullableStr,
        resolutionInputs: arr(
          obj({ path: str(), kind: { enum: ['content', 'delete', 'missing'] } }),
        ),
      }),
    ],
  },
  HeatmapEntry: obj({
    file: str(),
    agents: arr(str()),
    queued: arr(str()),
    conflicts: int(0),
    score: int(1),
  }),
  HistoryEntry: obj(
    {
      sha: str(),
      date: str(),
      type: { enum: ['merge', 'rollback'] },
      agent: nullableStr,
      semantic: bool,
      semanticFiles: arr(str()),
      ticketId: nullableStr,
    },
    ['sha', 'date', 'type'],
  ),
  StriartState: obj({ semanticFailureStreak: int(0), manualMode: bool }),
  DaemonStatus: obj(
    {
      running: bool,
      stale: bool,
      verified: bool,
      pid: nullableInt,
      startedAt: nullableStr,
      logPath: str(),
      url: nullableStr,
    },
    ['running', 'stale', 'pid', 'logPath'],
  ),
  PermissionRequest: obj(
    {
      kind: { const: 'permission' },
      id: ref('PermissionId'),
      agent: str(),
      taskId: str(),
      title: str(),
      options: arr(obj({ optionId: str(), name: str(), kind: str() }, ['optionId'])),
      status: { enum: ['PENDING', 'ANSWERED'] },
      answer: nullableStr,
      createdAt: str(),
      answeredAt: nullableStr,
      expiresAt: str(),
    },
    ['id', 'agent', 'title', 'options', 'status', 'expiresAt'],
  ),
  AcpHostStatus: obj(
    {
      running: bool,
      stale: bool,
      verified: bool,
      listening: bool,
      pid: nullableInt,
      startedAt: nullableStr,
    },
    ['running', 'stale', 'listening', 'pid'],
  ),
  ElicitationRequest: {
    description:
      'Structured question of an ACP agent, routed to the human. `message`, `url` and `requestedSchema` come from the agent: UNTRUSTED content — display as text, never interpret; a `url` is shown, never opened automatically.',
    ...obj(
      {
        kind: { const: 'elicitation' },
        id: ref('ElicitationId'),
        agent: str(),
        taskId: str(),
        mode: { enum: ['form', 'url'] },
        message: str(),
        requestedSchema: { type: ['object', 'null'] },
        url: nullableStr,
        status: { enum: ['PENDING', 'ANSWERED'] },
        answer: { type: ['object', 'null'] },
        createdAt: str(),
        answeredAt: nullableStr,
        expiresAt: str(),
      },
      ['kind', 'id', 'agent', 'mode', 'message', 'status', 'expiresAt'],
    ),
  },
  MainSessionStatus: obj({ pid: nullableInt, reason: str(), startedAt: str(), alive: bool }, [
    'pid',
    'reason',
    'startedAt',
    'alive',
  ]),
  ProfileSummary: obj(
    {
      name: str(),
      command: str(),
      invocation: str(),
      envKeys: arr(str()),
      timeout: nullableInt,
      acp: bool,
    },
    ['name', 'command', 'envKeys', 'acp'],
  ),
  ControlState: obj({
    instanceId: str('Random id of the serving instance: a change means a restart.'),
    revision: {
      type: 'integer',
      minimum: 1,
      description:
        'Monotonic per instance: a client keeps the highest revision it rendered and ignores older ones.',
    },
    generatedAt: str(),
    agents: arr(ref('Agent')),
    tasks: arr(ref('QueueRow')),
    tickets: arr(ref('TicketEntry')),
    heatmap: arr(ref('HeatmapEntry')),
    history: arr(ref('HistoryEntry')),
    state: ref('StriartState'),
    daemon: ref('DaemonStatus'),
    permissions: arr(ref('PermissionRequest')),
    elicitations: arr(ref('ElicitationRequest')),
    mainSession: nullable(ref('MainSessionStatus')),
    orchestration: ref('OrchestrationSnapshot'),
    reviews: arr(ref('HumanReview')),
    overlaps: ref('OverlapReport'),
    idle: ref('IdleStatus'),
    profiles: arr(ref('ProfileSummary')),
    config: obj({
      testCommand: str(),
      targetBranch: str(),
      semanticMerge: bool,
      autoRebase: bool,
      autoPush: bool,
    }),
  }),
  StatusData: {
    description: 'Data of `striart status --json` (same objects as ControlState).',
    ...obj({
      agents: arr(ref('Agent')),
      queue: arr(ref('QueueRow')),
      tickets: arr(ref('TicketEntry')),
      state: ref('StriartState'),
      daemon: ref('DaemonStatus'),
      mainSession: nullable(ref('MainSessionStatus')),
      overlaps: ref('OverlapReport'),
      idle: ref('IdleStatus'),
    }),
  },
  GateResult: obj({ success: bool, exitCode: nullableInt, timedOut: bool, log: str() }, [
    'success',
    'timedOut',
  ]),
  Timings: {
    description:
      'Durations per phase of the operation, in milliseconds (monotonic clock). Every phase is always present (0 when it does not apply); `lockHeld` is the time the main lock was HELD, `total` the whole call. Additive field: clients ignore phases they do not know.',
    ...obj(
      {
        unit: { const: 'ms' },
        route: { type: 'number', minimum: 0 },
        lockWait: { type: 'number', minimum: 0 },
        sync: { type: 'number', minimum: 0 },
        merge: { type: 'number', minimum: 0 },
        semantic: { type: 'number', minimum: 0 },
        gate: { type: 'number', minimum: 0 },
        commit: { type: 'number', minimum: 0 },
        delivery: { type: 'number', minimum: 0 },
        memory: { type: 'number', minimum: 0 },
        lockHeld: { type: 'number', minimum: 0 },
        total: { type: 'number', minimum: 0 },
      },
      ['unit', 'lockHeld', 'total'],
    ),
  },
  SyncResult: {
    oneOf: [
      variant('status', 'UP_TO_DATE', { agent: str(), mainHead: str() }),
      variant(
        'status',
        'REBASED',
        { agent: str(), mainHead: str(), rebasedCommits: int(0), stashed: bool },
        ['agent', 'mainHead'],
      ),
      variant('status', 'SKIPPED_DIRTY', { agent: str(), files: arr(str()), overlap: arr(str()) }, [
        'agent',
        'files',
      ]),
      variant('status', 'SKIPPED_SESSION', { agent: str(), pid: nullableInt }),
      variant(
        'status',
        'REBASE_CONFLICT',
        { agent: str(), mainHead: str(), error: str(), stashKept: bool },
        ['agent', 'error'],
      ),
      variant('status', 'STASH_CONFLICT', { agent: str(), mainHead: str(), error: str() }, [
        'agent',
        'error',
      ]),
    ],
  },
  MergeResult: {
    oneOf: [
      variant('status', 'UP_TO_DATE', { agent: str(), sha: str(), timings: ref('Timings') }, [
        'agent',
        'sha',
      ]),
      variant(
        'status',
        'MERGED',
        {
          agent: str(),
          sha: str(),
          mergeSha: str(),
          gate: ref('GateResult'),
          pushError: nullableStr,
          semantic: bool,
          resolvedFiles: arr(str()),
          timings: ref('Timings'),
        },
        ['agent', 'sha', 'mergeSha'],
      ),
      variant(
        'status',
        'CONFLICT',
        {
          reason: {
            enum: [
              'MERGE_CONFLICT',
              'UNMERGEABLE_CONFLICT',
              'SEMANTIC_MERGE_FAILED',
              'PROTECTED_PATHS_CHANGED',
            ],
          },
          agent: str(),
          sha: str(),
          conflictedFiles: arr(str()),
          ticket: ref('Ticket'),
          manualMode: bool,
          error: str(
            'French text of the core (kept for compatibility); `errorCode` is the contract.',
          ),
          errorCode: str(
            'Stable code of the semantic merge failure (e.g. SEMANTIC_MERGE_FAILED, TOKEN_BUDGET_EXCEEDED).',
          ),
          errorDetails: {
            type: 'object',
            description:
              'Public details of that failure (identifiers only: causeCode, provider, status…).',
          },
          timings: ref('Timings'),
        },
        ['reason', 'agent', 'ticket'],
      ),
      variant(
        'status',
        'GATE_FAILED',
        {
          agent: str(),
          sha: str(),
          gate: ref('GateResult'),
          ticket: ref('Ticket'),
          manualMode: bool,
          timings: ref('Timings'),
        },
        ['agent', 'gate', 'ticket'],
      ),
    ],
  },
  RunResult: {
    oneOf: [
      variant(
        'status',
        'STARTED',
        {
          info: obj({ name: str(), branch: str(), path: str() }, ['name']),
          predictedFiles: arr(str()),
          collisions: arr(ref('Collision')),
          routing: nullable(ref('RouterDetails')),
          timings: ref('Timings'),
        },
        ['info', 'predictedFiles'],
      ),
      variant(
        'status',
        'QUEUED',
        {
          task: ref('QueueTask'),
          predictedFiles: arr(str()),
          collisions: arr(ref('Collision')),
          routing: nullable(ref('RouterDetails')),
          timings: ref('Timings'),
        },
        ['task'],
      ),
    ],
  },
  TaskRunData: {
    description:
      'Attended: same shape as `striart run --json` (no terminal is opened by the protocol: `session` is null). Autonomous: the session runs in the background of the serving process; its end is reported by `control.notice`.',
    oneOf: [
      variant('mode', 'attended', { run: ref('RunResult'), session: { type: 'null' } }),
      variant('mode', 'autonomous', {
        launched: { const: true },
        agent: nullableStr,
        profile: str(),
      }),
    ],
  },
  StartedTask: obj({ task: ref('QueueTask'), info: obj({ name: str() }, ['name']) }, [
    'task',
    'info',
  ]),
  QueueRetryData: obj({
    action: { const: 'retry' },
    started: arr(ref('StartedTask')),
    stillWaiting: arr(ref('QueueTask')),
  }),
  ReconcileData: obj({
    sessionPidsCleared: arr(str()),
    started: arr(ref('StartedTask')),
    stillWaiting: arr(ref('QueueTask')),
  }),
  SyncData: obj({ results: arr(ref('SyncResult')) }),
  StopData: obj(
    {
      agent: str(),
      clonePath: str(),
      cloneMissing: bool,
      started: arr(ref('StartedTask')),
      stillWaiting: arr(ref('QueueTask')),
      ptyHost: { type: 'object' },
    },
    ['agent', 'started', 'stillWaiting'],
  ),
  PromoteResult: {
    oneOf: [
      variant('status', 'UP_TO_DATE', { sha: str(), timings: ref('Timings') }, ['sha']),
      variant(
        'status',
        'PROMOTED',
        { sha: str(), commits: int(0), gate: ref('GateResult'), timings: ref('Timings') },
        ['sha'],
      ),
      variant(
        'status',
        'GATE_FAILED',
        {
          sha: str(),
          gate: ref('GateResult'),
          ticket: ref('Ticket'),
          rolledBack: bool,
          timings: ref('Timings'),
        },
        ['sha', 'ticket'],
      ),
    ],
  },
  RollbackResult: obj(
    {
      status: { const: 'ROLLED_BACK' },
      mode: { enum: ['reset', 'revert'] },
      agent: str(),
      undoneSha: str(),
      newHead: str(),
      agentResynced: bool,
    },
    ['status', 'mode', 'undoneSha', 'newHead'],
  ),
  ManualResolutionResult: {
    oneOf: [
      variant(
        'status',
        'ALREADY_CLEAN',
        { ticketId: str(), agent: str(), sha: str(), timings: ref('Timings') },
        ['ticketId', 'agent', 'sha'],
      ),
      variant(
        'status',
        'GATE_FAILED',
        { ticketId: str(), agent: str(), gate: ref('GateResult'), timings: ref('Timings') },
        ['ticketId', 'agent', 'gate'],
      ),
      variant(
        'status',
        'MERGED',
        {
          ticketId: str(),
          agent: str(),
          sha: str(),
          mergeSha: str(),
          closedTickets: arr(str()),
          timings: ref('Timings'),
        },
        ['ticketId', 'mergeSha'],
      ),
    ],
  },
  ResolveData: {
    description: 'Same shapes as `striart resolve --json`.',
    oneOf: [
      variant('action', 'unlock', {}),
      variant('action', 'close', { ticket: ref('TicketEntry') }),
      variant('action', 'prepare', {
        ticketId: str(),
        files: arr(
          obj(
            {
              path: str(),
              created: bool,
              source: { enum: ['theirs', 'ours', 'base', null] },
              held: bool,
            },
            ['path', 'created', 'source'],
          ),
        ),
      }),
      variant('action', 'apply', { result: ref('ManualResolutionResult') }),
    ],
  },
  LockStopData: obj({
    action: { const: 'stop' },
    released: nullable(ref('MainSessionStatus')),
  }),
  CleanResult: obj({
    removed: arr(obj({ name: str(), freedBytes: int(0), wasActive: bool }, ['name', 'freedBytes'])),
    skipped: arr(obj({ name: str(), reason: str() })),
  }),
  PruneResult: obj(
    {
      retentionDays: int(0),
      dryRun: bool,
      freedBytes: int(0),
      clones: { type: 'object' },
      tickets: { type: 'object' },
    },
    ['retentionDays', 'dryRun', 'freedBytes', 'clones', 'tickets'],
  ),
  DoctorReport: obj(
    {
      healthy: bool,
      checks: arr(
        obj(
          {
            id: str(),
            level: { enum: ['ok', 'warn', 'fail', 'skip'] },
            label: str(),
            detail: str(),
            hint: nullableStr,
          },
          ['level', 'label'],
        ),
      ),
      summary: { type: 'object' },
    },
    ['healthy', 'checks'],
  ),
  SessionLog: obj({ agent: str(), path: str(), log: str() }),
  InitializeResult: obj({
    protocolVersion: { const: CONTROL_PROTOCOL_VERSION },
    schemaVersion: { const: SCHEMA_VERSION },
    server: obj({ name: { const: 'striart' }, version: str() }),
    transport: { enum: ['stdio', 'http'] },
    locale: { enum: ['fr', 'en'] },
    methods: arr(str()),
    notifications: arr(str()),
  }),
  SubscribeResult: obj({
    subscriptionId: ref('SubscriptionId'),
    seq: int(1),
    state: ref('ControlState'),
  }),
  UnsubscribeResult: obj({ subscriptionId: ref('SubscriptionId'), unsubscribed: bool }),
  StateChangedParams: obj(
    {
      subscriptionId: { anyOf: [ref('SubscriptionId'), { type: 'null' }] },
      seq: int(1),
      state: ref('ControlState'),
      droppedNotices: int(0),
    },
    ['subscriptionId', 'seq', 'state', 'droppedNotices'],
  ),
  NoticeParams: obj({ seq: int(1), type: str(), message: str() }),
};

// --- Méthodes -----------------------------------------------------------------

export type Transport = 'stdio' | 'http';

export interface ParamSpec {
  name: string;
  required: boolean;
  schema: JsonSchema;
  description?: string;
}

export interface MethodSpec {
  name: string;
  summary: string;
  /** Agit sur le dépôt (plan humain uniquement) — exige un client authentifié. */
  mutating: boolean;
  params: ParamSpec[];
  /** Nom du `$def` décrivant `data`. */
  data: string;
  /** Transports qui servent la méthode (l'abonnement HTTP passe par GET /events). */
  transports: Transport[];
}

const BOTH: Transport[] = ['stdio', 'http'];
const p = (name: string, schema: JsonSchema, required = true, description?: string): ParamSpec => ({
  name,
  required,
  schema,
  ...(description ? { description } : {}),
});

export const METHOD_SPECS: readonly MethodSpec[] = Object.freeze([
  {
    name: 'control.initialize',
    summary: 'Handshake: negotiate the protocol version, list methods and notifications.',
    mutating: false,
    params: [
      p('protocolVersion', { type: 'integer', minimum: 1 }, true, 'Version the client speaks.'),
      p(
        'client',
        obj(
          { name: { type: 'string', maxLength: 100 }, version: { type: 'string', maxLength: 50 } },
          ['name'],
          {
            additionalProperties: false,
          },
        ),
        false,
      ),
    ],
    data: 'InitializeResult',
    transports: BOTH,
  },
  {
    name: 'rpc.discover',
    summary: 'This OpenRPC document (methods, parameters, results, notifications, schemas).',
    mutating: false,
    params: [],
    data: 'OpenRpcDocument',
    transports: BOTH,
  },
  {
    name: 'state.get',
    summary:
      'Full state: agents, queue, tickets, locks heatmap, history, main session, pending permissions, watcher, profiles.',
    mutating: false,
    params: [],
    data: 'ControlState',
    transports: BOTH,
  },
  {
    name: 'state.subscribe',
    summary:
      'Subscribe to state changes: the current state now, then `state.changed` and `control.notice` notifications. Over HTTP, use GET /events (Server-Sent Events) instead.',
    mutating: false,
    params: [],
    data: 'SubscribeResult',
    transports: ['stdio'],
  },
  {
    name: 'state.unsubscribe',
    summary: 'End a subscription.',
    mutating: false,
    params: [p('subscriptionId', ref('SubscriptionId'))],
    data: 'UnsubscribeResult',
    transports: ['stdio'],
  },
  {
    name: 'ticket.get',
    summary:
      'Read a conflict ticket in 3-way form (BASE / OURS / THEIRS / LLM attempt) with the Test Gate log.',
    mutating: false,
    params: [p('id', ref('TicketId'))],
    data: 'TicketDetail',
    transports: BOTH,
  },
  {
    name: 'session.log',
    summary: 'Tail of an autonomous session log (64 KB at most).',
    mutating: false,
    params: [p('agent', ref('AgentName'))],
    data: 'SessionLog',
    transports: BOTH,
  },
  {
    name: 'doctor.run',
    summary: 'Environment diagnosis (same report as `striart doctor --json`).',
    mutating: false,
    params: [],
    data: 'DoctorReport',
    transports: BOTH,
  },
  {
    name: 'task.run',
    summary:
      'Launch a task through the Router: a clone if no collision, else the queue. mode "autonomous" starts a supervised session in the background.',
    mutating: true,
    params: [
      p('prompt', ref('Prompt')),
      p('agent', { anyOf: [ref('AgentName'), { type: 'null' }] }, false),
      p('mode', { enum: ['attended', 'autonomous'] }, false),
      p('profile', { anyOf: [ref('ProfileName'), { type: 'null' }] }, false),
    ],
    data: 'TaskRunData',
    transports: BOTH,
  },
  {
    name: 'agent.merge',
    summary:
      "Merge an agent's last commit (rebase, semantic merge on conflict, blocking Test Gate).",
    mutating: true,
    params: [p('agent', ref('AgentName'))],
    data: 'MergeResult',
    transports: BOTH,
  },
  {
    name: 'agent.sync',
    summary: 'Rebase one agent (or all of them) on the target branch.',
    mutating: true,
    params: [p('agent', { anyOf: [ref('AgentName'), { type: 'null' }] }, false)],
    data: 'SyncData',
    transports: BOTH,
  },
  {
    name: 'agent.stop',
    summary: 'Stop an agent; refused while unmerged commits remain, unless force abandons them.',
    mutating: true,
    params: [p('agent', ref('AgentName')), p('force', bool, false)],
    data: 'StopData',
    transports: BOTH,
  },
  {
    name: 'queue.retry',
    summary: 'Start the queued tasks that nothing blocks any more.',
    mutating: true,
    params: [],
    data: 'QueueRetryData',
    transports: BOTH,
  },
  {
    name: 'reconcile.run',
    summary: 'Neutralize dead sessions and unblock the queue (`striart reconcile`).',
    mutating: true,
    params: [],
    data: 'ReconcileData',
    transports: BOTH,
  },
  {
    name: 'staging.promote',
    summary: 'Promote staging to the main branch under the global Test Gate.',
    mutating: true,
    params: [
      p('rollback', bool, false, 'Undo the target branch to its previous head if the gate is red.'),
    ],
    data: 'PromoteResult',
    transports: BOTH,
  },
  {
    name: 'merge.rollback',
    summary: 'Undo the last Striart merge of the target branch.',
    mutating: true,
    params: [],
    data: 'RollbackResult',
    transports: BOTH,
  },
  {
    name: 'ticket.prepare',
    summary:
      'Seed `.resolved` files from the agent version (never overwrites a prepared resolution).',
    mutating: true,
    params: [
      p('id', ref('TicketId')),
      p(
        'acceptTheirs',
        arr(str()),
        false,
        'Protected paths whose `.resolved` may be seeded from the agent version (explicit human decision; protected paths are otherwise never seeded).',
      ),
    ],
    data: 'ResolveData',
    transports: BOTH,
  },
  {
    name: 'ticket.apply',
    summary:
      'Replay the ticket merge with the prepared resolutions, under the main lock and the Test Gate.',
    mutating: true,
    params: [p('id', ref('TicketId'))],
    data: 'ResolveData',
    transports: BOTH,
  },
  {
    name: 'ticket.close',
    summary: 'Mark a ticket resolved by hand (no Test Gate) — human plane only.',
    mutating: true,
    params: [p('id', ref('TicketId'))],
    data: 'ResolveData',
    transports: BOTH,
  },
  {
    name: 'permission.answer',
    summary:
      'Arbitrate a semi-autonomous permission request with one of the options the agent proposed — human plane only.',
    mutating: true,
    params: [p('id', ref('PermissionId')), p('option', ref('PermissionOptionId'))],
    data: 'PermissionRequest',
    transports: BOTH,
  },
  {
    name: 'review.list',
    summary:
      'List the human review requests (most recent first), with "alive" = the waiting orchestrator still lives.',
    mutating: false,
    params: [],
    data: 'ReviewListData',
    transports: BOTH,
  },
  {
    name: 'review.answer',
    summary:
      'Give the verdict of a PENDING human review (approve, request-changes, reject, with a summary and structured remarks) — human plane only. The verdict is validated like an agent verdict; it only proposes: the merge still passes the Test Gate. Answered once; an expired or abandoned request is refused (REVIEW_NOT_PENDING).',
    mutating: true,
    params: [
      p('id', ref('ReviewId')),
      p('verdict', ref('ReviewVerdictValue')),
      p('summary', ref('ReviewSummary'), false),
      p('comments', ref('ReviewCommentsInput'), false),
    ],
    data: 'ReviewAnswerData',
    transports: BOTH,
  },
  {
    name: 'orchestration.state',
    summary:
      'Runs and groups of the orchestrated modes (review, team, pipeline, race) and the human reviews.',
    mutating: false,
    params: [],
    data: 'OrchestrationStateData',
    transports: BOTH,
  },
  {
    name: 'elicitation.answer',
    summary:
      "Answer an agent's structured question (accept with content validated against its requestedSchema, decline, cancel) — human plane only. Invalid content keeps the request open.",
    mutating: true,
    params: [
      p('id', ref('ElicitationId')),
      p('action', { enum: ['accept', 'decline', 'cancel'] }),
      p('content', { type: 'object' }, false, 'Form values (mode "form", action "accept").'),
    ],
    data: 'ElicitationRequest',
    transports: BOTH,
  },
  {
    name: 'mainSession.release',
    summary: 'Release the main repository session (`striart lock --stop`) — human plane only.',
    mutating: true,
    params: [],
    data: 'LockStopData',
    transports: BOTH,
  },
  {
    name: 'semantic.unlock',
    summary: 'Leave manual mode: re-enable the semantic merge (`striart resolve --unlock`).',
    mutating: true,
    params: [],
    data: 'ResolveData',
    transports: BOTH,
  },
  {
    name: 'clones.clean',
    summary:
      'Delete the clones of stopped agents with nothing pending (never all/force: the cleanClones guards keep the last word).',
    mutating: true,
    params: [p('agent', { anyOf: [ref('AgentName'), { type: 'null' }] }, false)],
    data: 'CleanResult',
    transports: BOTH,
  },
  {
    name: 'workspace.prune',
    summary: 'Prune idle stopped clones and resolved tickets (config retention).',
    mutating: true,
    params: [p('dryRun', bool, false)],
    data: 'PruneResult',
    transports: BOTH,
  },
  {
    name: 'workspace.gc',
    summary:
      'Idle GC sweep: detect idle agents, warn, and (action close or `close: true`, after the warning and grace period) cleanly close their SESSIONS. The clone and its work are always kept; no merge, no deletion. Human plane only.',
    mutating: true,
    params: [
      p('dryRun', bool, false),
      p('close', bool, false),
      p('agent', { anyOf: [ref('AgentName'), { type: 'null' }] }, false),
    ],
    data: 'IdleSweepReport',
    transports: BOTH,
  },
]);

export interface NotificationSpec {
  name: string;
  summary: string;
  params: string;
}

export const NOTIFICATION_SPECS: readonly NotificationSpec[] = Object.freeze([
  {
    name: 'state.changed',
    summary:
      'The state changed (disk, agent refs, an action). Idempotent: render the latest revision. Over HTTP: SSE event "state.changed".',
    params: 'StateChangedParams',
  },
  {
    name: 'control.notice',
    summary:
      'Human-readable event (merge done, gate red, autonomous session end). Over HTTP: SSE event "control.notice".',
    params: 'NoticeParams',
  },
]);

export function methodSpec(name: string): MethodSpec | undefined {
  return METHOD_SPECS.find((m) => m.name === name);
}

/** Schéma objet FERMÉ des paramètres d'une méthode (validation positive). */
export function paramsSchema(spec: MethodSpec): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(spec.params.map((param) => [param.name, param.schema])),
    required: spec.params.filter((param) => param.required).map((param) => param.name),
    additionalProperties: false,
  };
}

/** Schéma du document de résultat d'une méthode. */
export function resultSchema(spec: MethodSpec): JsonSchema {
  return {
    allOf: [
      ref('ResultDocument'),
      { properties: { command: { const: spec.name }, data: ref(spec.data) } },
    ],
  };
}

const ALL_DEFS: Record<string, JsonSchema> = {
  ...PARAMETER_DEFS,
  ...ENVELOPE_DEFS,
  ...DATA_DEFS,
  OpenRpcDocument: {
    type: 'object',
    description: 'OpenRPC 1.3 document (https://spec.open-rpc.org).',
    required: ['openrpc', 'info', 'methods'],
  },
};

/** Tous les schémas publiés (composants + paramètres/résultats de méthode), pour la vérification de fermeture. */
export function publishedSchemas(): JsonSchema[] {
  return [
    ...Object.values(ALL_DEFS),
    ...METHOD_SPECS.flatMap((spec) => [paramsSchema(spec), resultSchema(spec)]),
  ];
}

/** Composants partagés (). */
export function componentSchemas(): Record<string, JsonSchema> {
  return structuredClone(ALL_DEFS);
}

const DESCRIPTION = [
  'Human control plane of Striart: read the orchestrator state, follow its changes, and act as the human in the loop (launch, merge, sync, stop, promote, rollback, resolve, arbitrate permissions, release the main session, reconcile).',
  'JSON-RPC 2.0, named parameters. Transports: stdio (`striart api --stdio`, NDJSON or Content-Length framing — for IDE extensions, no network surface) and HTTP loopback (`striart dashboard`: POST /rpc + GET /events Server-Sent Events, sign-in link + HttpOnly session cookie, Host/Origin/X-Striart checks).',
  'Every result is a Striart Document ({schemaVersion, command, ok, outcome, data, warnings}); every error carries the same Document in `error.data` (code/kind/message/hint/details) — the shapes of `striart <command> --json`.',
  'The agent plane (MCP) never exposes permission arbitration, ticket closing nor lock release: they exist only here.',
].join('\n\n');

/** Codes JSON-RPC du protocole (le détail stable est dans `error.data.error.code`). */
export const RPC_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  FAILURE: -32000,
  REFUSAL: -32001,
  UNAUTHENTICATED: -32002,
});

/**
 * Document OpenRPC 1.3 complet du protocole. `serverVersion` (servi par
 * `rpc.discover`) n'entre pas dans le fichier publié de schemas/ : celui-ci
 * ne change qu'avec le contrat, pas à chaque version de Striart.
 */
export function buildOpenRpcDocument(serverVersion?: string): Record<string, unknown> {
  return {
    openrpc: '1.3.2',
    info: {
      title: 'Striart Control Protocol',
      version: `${CONTROL_PROTOCOL_VERSION}.0.0`,
      description: DESCRIPTION,
      license: { name: 'MIT' },
      ...(serverVersion ? { 'x-striart-version': serverVersion } : {}),
    },
    'x-schemaVersion': SCHEMA_VERSION,
    'x-protocolVersion': CONTROL_PROTOCOL_VERSION,
    'x-transports': {
      stdio: {
        command: 'striart api --stdio [--framing ndjson|content-length]',
        framing: {
          ndjson: 'One JSON-RPC message per line (UTF-8, LF). 1 MiB per message at most.',
          'content-length':
            'LSP-style "Content-Length: <bytes>\\r\\n\\r\\n<json>" frames (vscode-jsonrpc, lsp4j). 1 MiB per message at most.',
        },
      },
      http: {
        command: 'striart dashboard',
        endpoints: {
          'GET /auth?code=<one-time>':
            'Exchanges a one-time sign-in link for the session cookie, then redirects to /.',
          'POST /rpc':
            'JSON-RPC 2.0 (single or batch). Requires the session cookie, Origin = this server, X-Striart: 1, Content-Type: application/json.',
          'GET /events':
            'Server-Sent Events: "state.changed" and "control.notice", data = the JSON-RPC notification, id = seq. A slow client is disconnected and reconnects (the state is idempotent).',
        },
      },
    },
    'x-errors': Object.entries(RPC_ERROR_CODES).map(([name, code]) => ({ name, code })),
    methods: METHOD_SPECS.map((spec) => ({
      name: spec.name,
      summary: spec.summary,
      paramStructure: 'by-name',
      params: spec.params.map((param) => ({
        name: param.name,
        required: param.required,
        ...(param.description ? { description: param.description } : {}),
        schema: param.schema,
      })),
      result: { name: 'document', schema: resultSchema(spec) },
      'x-mutating': spec.mutating,
      'x-transports': spec.transports,
    })),
    'x-notifications': NOTIFICATION_SPECS.map((n) => ({
      name: n.name,
      summary: n.summary,
      params: ref(n.params),
    })),
    components: { schemas: componentSchemas() },
  };
}

/** Bundle JSON Schema 2020-12 du document `--json` (refs réécrits en `$defs`). */
export function buildDocumentJsonSchema(): Record<string, unknown> {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === '$ref' && typeof v === 'string' ? v.replace(REF_PREFIX, '#/$defs/') : rewrite(v),
      ]),
    );
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:striart:schema:document:v1',
    title: 'Striart machine document v1',
    description:
      'Output of `striart <command> --json` and the result / error.data of the Striart Control Protocol v1.',
    $ref: '#/$defs/Document',
    $defs: rewrite(ALL_DEFS),
  };
}

/** Racine de résolution des `$ref` pour validate.ts. */
export const SCHEMA_ROOT: JsonSchema = { components: { schemas: ALL_DEFS } };
