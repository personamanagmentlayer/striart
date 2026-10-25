/**
 * Adaptateurs des hooks advisory de Striart, un par outil de coding.
 *
 * Chaque outil a son propre schéma d'événement (stdin) et sa propre forme de
 * réponse (stdout) — vérifiés dans la documentation officielle (10/2026) :
 *  - Claude Code  (code.claude.com/docs/en/hooks) : PreToolUse / PostToolUse /
 *    SessionEnd ; `tool_name` + `tool_input.file_path|notebook_path` ; réponse
 *    `hookSpecificOutput.additionalContext` (au modèle) + `systemMessage` (à
 *    l'humain), sans `permissionDecision`.
 *  - Codex        (hooks.json) : mêmes noms d'événements et même forme de
 *    réponse ; `apply_patch` porte le patch dans `tool_input.command`.
 *  - Copilot CLI  (docs.github.com, hooks-configuration) : preToolUse /
 *    postToolUse / sessionEnd en camelCase ; `toolName`, `toolArgs` (objet ou
 *    chaîne JSON) ; `preToolUse` n'accepte qu'une DÉCISION (allow/deny/ask) —
 *    il reste donc muet ; `postToolUse` accepte `additionalContext`.
 *  - Gemini CLI   (geminicli.com/docs/hooks) : BeforeTool / AfterTool /
 *    SessionEnd ; stdout parsé en JSON (toujours `{}` au minimum) ;
 *    `systemMessage`, `hookSpecificOutput.additionalContext` (AfterTool).
 *  - Cline        (scripts nommés d'après l'événement) : PreToolUse /
 *    PostToolUse / TaskComplete / TaskCancel ; `preToolUse.tool` +
 *    `parameters.path`, racine `workspaceRoots[0]` ; réponse JSON
 *    `{cancel: false, contextModification?}` — `cancel` vaut TOUJOURS false.
 *
 * Invariant commun : aucune réponse ne bloque, ne refuse ni ne réécrit une
 * action (advisory). Le code de sortie est toujours 0 (décidé par la CLI).
 */

export const HOOK_TOOLS = Object.freeze(['claude', 'codex', 'copilot', 'gemini', 'cline'] as const);
export type HookTool = (typeof HOOK_TOOLS)[number];

export type HookKind = 'pre-tool' | 'post-tool' | 'session-end';

export interface ParsedHookEvent {
  /** Répertoire de travail de la session (base des chemins relatifs). */
  cwd: string | null;
  toolName: string | null;
  /** Fichiers écrits par l'outil, tels que donnés (absolus ou relatifs à `cwd`). */
  files: string[];
  /** Motif de fin de session, si l'outil en donne un. */
  reason: string | null;
  /** Nom de l'événement déclaré dans la charge utile, s'il y figure. */
  eventName: string | null;
}

export interface HookAdapter {
  tool: HookTool;
  /** Événements reconnus (nom exact de l'outil) → nature. */
  events: Readonly<Record<string, HookKind>>;
  /** Événements enregistrés par `striart hook install` (ceux où un avis est utile). */
  installEvents: readonly string[];
  /** Outils d'écriture (filtre du matcher et de l'extraction), comparés sans casse. */
  writeTools: readonly string[];
  parse(payload: Record<string, unknown>): ParsedHookEvent;
  /** Sortie stdout ('' = rien) pour cet événement et cet avis (null = rien à signaler). */
  render(event: string, kind: HookKind, message: string | null): string;
}

/** Longueur maximale d'un chemin retenu (au-delà : donnée hostile ou corrompue). */
const MAX_PATH_LENGTH = 4096;
/** Nombre maximal de fichiers retenus par événement. */
const MAX_FILES = 256;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function cleanPath(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PATH_LENGTH) return null;
  if (/[\0\r\n]/.test(v)) return null;
  return v;
}

function unique(files: (string | null)[]): string[] {
  return [...new Set(files.filter((f): f is string => f !== null))].slice(0, MAX_FILES);
}

/** Clés de chemin usuelles des outils d'écriture. */
const PATH_KEYS = [
  'file_path',
  'filePath',
  'notebook_path',
  'path',
  'absolute_path',
  'target_file',
];

function pathsFromInput(input: Record<string, unknown> | null): string[] {
  if (!input) return [];
  return unique(PATH_KEYS.map((k) => cleanPath(input[k])));
}

/**
 * Chemins d'un patch au format `apply_patch` (Codex) :
 * `*** Add File: …`, `*** Update File: …`, `*** Delete File: …`, `*** Move to: …`.
 */
export function extractPatchFiles(patch: string): string[] {
  const files: (string | null)[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match) files.push(cleanPath(match[1].trim()));
  }
  return unique(files);
}

const isWriteTool = (adapter: { writeTools: readonly string[] }, name: string | null) =>
  name !== null && adapter.writeTools.some((t) => t.toLowerCase() === name.toLowerCase());

/** Forme de réponse commune à Claude Code et Codex. */
function renderClaudeLike(event: string, kind: HookKind, message: string | null): string {
  if (!message || kind === 'session-end') return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: message },
    systemMessage: message,
  });
}

function claudeLikeParse(adapter: { writeTools: readonly string[] }) {
  return (payload: Record<string, unknown>): ParsedHookEvent => {
    const toolName = str(payload.tool_name);
    const input = obj(payload.tool_input);
    let files: string[] = [];
    if (isWriteTool(adapter, toolName)) {
      files = pathsFromInput(input);
      const command = input ? input.command : null;
      if (typeof command === 'string' && command.includes('*** ')) {
        files = unique([...files, ...extractPatchFiles(command)]);
      } else if (Array.isArray(command)) {
        // apply_patch peut arriver en argv (["apply_patch", "<patch>"]).
        const patch = command.find((c) => typeof c === 'string' && c.includes('*** '));
        if (typeof patch === 'string') files = unique([...files, ...extractPatchFiles(patch)]);
      }
    }
    return {
      cwd: cleanPath(payload.cwd),
      toolName,
      files,
      reason: str(payload.reason),
      eventName: str(payload.hook_event_name),
    };
  };
}

const claude: HookAdapter = {
  tool: 'claude',
  events: { PreToolUse: 'pre-tool', PostToolUse: 'post-tool', SessionEnd: 'session-end' },
  installEvents: ['PreToolUse', 'SessionEnd'],
  writeTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  parse: (p) => claudeLikeParse(claude)(p),
  render: renderClaudeLike,
};

const codex: HookAdapter = {
  tool: 'codex',
  events: { PreToolUse: 'pre-tool', PostToolUse: 'post-tool', SessionEnd: 'session-end' },
  installEvents: ['PreToolUse', 'SessionEnd'],
  writeTools: ['apply_patch', 'Edit', 'Write'],
  parse: (p) => claudeLikeParse(codex)(p),
  render: renderClaudeLike,
};

const copilot: HookAdapter = {
  tool: 'copilot',
  events: { preToolUse: 'pre-tool', postToolUse: 'post-tool', sessionEnd: 'session-end' },
  // preToolUse : sa seule sortie possible est une décision — et un code non
  // nul y vaut un REFUS. Il n'est donc jamais installé.
  installEvents: ['postToolUse', 'sessionEnd'],
  writeTools: ['edit', 'create', 'str_replace_editor', 'apply_patch', 'write'],
  parse(payload) {
    const toolName = str(payload.toolName) ?? str(payload.tool_name);
    let args: Record<string, unknown> | null = obj(payload.toolArgs) ?? obj(payload.tool_input);
    if (!args && typeof payload.toolArgs === 'string') {
      try {
        args = obj(JSON.parse(payload.toolArgs));
      } catch {
        // toolArgs illisible : aucun chemin à en tirer, l'événement reste neutre.
        args = null;
      }
    }
    return {
      cwd: cleanPath(payload.cwd),
      toolName,
      files: isWriteTool(copilot, toolName) ? pathsFromInput(args) : [],
      reason: str(payload.reason),
      eventName: str(payload.hookEventName) ?? str(payload.hook_event_name),
    };
  },
  render(_event, kind, message) {
    if (!message || kind !== 'post-tool') return '';
    return JSON.stringify({ additionalContext: message });
  },
};

const gemini: HookAdapter = {
  tool: 'gemini',
  events: { BeforeTool: 'pre-tool', AfterTool: 'post-tool', SessionEnd: 'session-end' },
  installEvents: ['BeforeTool', 'SessionEnd'],
  writeTools: ['write_file', 'replace', 'edit'],
  parse: (p) => claudeLikeParse(gemini)(p),
  render(event, kind, message) {
    if (!message || kind === 'session-end') return '{}';
    if (kind === 'post-tool') {
      return JSON.stringify({
        systemMessage: message,
        hookSpecificOutput: { hookEventName: event, additionalContext: message },
      });
    }
    return JSON.stringify({ systemMessage: message });
  },
};

const cline: HookAdapter = {
  tool: 'cline',
  events: {
    PreToolUse: 'pre-tool',
    PostToolUse: 'post-tool',
    TaskComplete: 'session-end',
    TaskCancel: 'session-end',
  },
  installEvents: ['PreToolUse', 'TaskComplete', 'TaskCancel'],
  writeTools: [
    'write_to_file',
    'replace_in_file',
    'apply_diff',
    'insert_content',
    'search_and_replace',
  ],
  parse(payload) {
    const roots = Array.isArray(payload.workspaceRoots) ? payload.workspaceRoots : [];
    const section = obj(payload.preToolUse) ?? obj(payload.postToolUse);
    const toolName = section ? (str(section.tool) ?? str(section.toolName)) : null;
    return {
      cwd: cleanPath(roots[0]),
      toolName,
      files: isWriteTool(cline, toolName) ? pathsFromInput(obj(section?.parameters)) : [],
      reason: null,
      eventName: str(payload.hookName),
    };
  },
  render(_event, _kind, message) {
    return JSON.stringify(
      message ? { cancel: false, contextModification: message } : { cancel: false },
    );
  },
};

const ADAPTERS: Record<HookTool, HookAdapter> = { claude, codex, copilot, gemini, cline };

export function getAdapter(tool: string): HookAdapter | null {
  return (HOOK_TOOLS as readonly string[]).includes(tool) ? ADAPTERS[tool as HookTool] : null;
}

/** Nom exact de l'événement pour cet outil (comparaison sans casse), ou null. */
export function canonicalEvent(adapter: HookAdapter, event: string): string | null {
  if (typeof event !== 'string') return null;
  return Object.keys(adapter.events).find((e) => e.toLowerCase() === event.toLowerCase()) ?? null;
}

/** Sortie neutre de l'outil pour un événement (rien à signaler). */
export function neutralOutput(adapter: HookAdapter | null, event: string | null): string {
  if (!adapter) return '';
  const canonical = event ? canonicalEvent(adapter, event) : null;
  const kind = canonical ? adapter.events[canonical] : 'pre-tool';
  return adapter.render(canonical ?? '', kind, null);
}
