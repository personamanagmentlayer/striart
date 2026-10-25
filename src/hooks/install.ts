import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StriartError } from '../errors.js';
import { AGENT_NAME_RE } from '../agent-name.ts';
import { ensureCloneExcludes, removeCloneExcludes } from '../git-exclude.ts';
import { safeRemove, safeWriteFile } from '../safe-write.ts';
import { writePrivateFileAtomic } from '../terminal/private-file.ts';
import { posixCommandLine, quotePosix, quotePowerShell } from '../terminal/quote.ts';
import { HOOK_TOOLS, getAdapter } from './adapters.ts';
import type { HookAdapter, HookTool } from './adapters.ts';

/**
 * `striart hook install|uninstall <outil> (--user | --agent <nom>)`.
 *
 * Génère la configuration de hook de l'outil, sur commande explicite, à
 * l'un des deux seuls emplacements admis :
 *  - `user`  : la configuration UTILISATEUR de l'outil (~/.claude/settings.json,
 *    ~/.codex/hooks.json, ~/.copilot/hooks/striart.json, ~/.gemini/settings.json,
 *    ~/Documents/Cline/Hooks/) — le hook sert alors dans tout projet et reste
 *    neutre hors d'un clone Striart ;
 *  - `clone` : le CLONE d'un agent, dans un fichier non suivi par git et
 *    exclu localement (`.git/info/exclude`) — jamais un fichier versionné du
 *    dépôt cible (`HOOK_TARGET_TRACKED`) : l'agent le commiterait, et la
 *    garde des chemins protégés refuserait le merge.
 *
 * Chaque réglage existant de l'utilisateur est préservé : seules les
 * entrées de Striart (reconnues à leur marque) sont ajoutées, remplacées ou
 * retirées. Un fichier illisible n'est JAMAIS réécrit (`HOOK_CONFIG_UNREADABLE`).
 *
 * Lancement du hook, du plus sûr au moins sûr selon ce que l'outil permet :
 *  - Claude Code (`command` + `args`) et Copilot CLI (`exec` + `args`) : forme
 *    exec, AUCUN shell ;
 *  - Codex et Gemini CLI n'acceptent qu'une chaîne de commande, passée à un
 *    shell : POSIX → chaque élément cité (`quotePosix`) ; Windows → l'outil
 *    peut utiliser cmd ou PowerShell, dont les citations sont incompatibles :
 *    la chaîne est un chemin de lanceur `.cmd` SANS espace ni caractère
 *    spécial (valide tel quel dans les deux), et c'est le lanceur — écrit
 *    par Striart, grammaire cmd connue — qui cite Node et la CLI ;
 *  - Cline exécute un script nommé d'après l'événement : script sh (POSIX)
 *    ou PowerShell (Windows), valeurs citées pour leur grammaire.
 */

export type HookScope = 'user' | 'clone';

export interface HookFileChange {
  path: string;
  action: 'create' | 'update' | 'unchanged' | 'remove';
}

export interface HookInstallParams {
  tool: string;
  scope: HookScope;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Exécutable Node (défaut : chemin réel de process.execPath). */
  nodePath?: string;
  /** Point d'entrée de la CLI (défaut : src/cli.js de cette installation). */
  cliPath?: string;
  /** Portée `clone` : racine du dépôt, agent et chemin de son clone (issus du registre). */
  root?: string;
  agent?: string;
  clonePath?: string;
  dryRun?: boolean;
}

/** Marque des entrées Codex (champ `statusMessage`, affiché pendant l'exécution). */
export const CODEX_STATUS = 'Striart: agent collision check (advisory)';
/** Marque des entrées Gemini CLI (champ `name`). */
export const GEMINI_NAME = 'striart-advisory';
/** Marque des scripts écrits par Striart (scripts Cline, lanceurs Windows). */
export const HOOK_MARKER = 'striart-hook (advisory)';

/** Matchers des outils d'écriture (événements d'outil uniquement). */
const MATCHERS: Partial<Record<HookTool, string>> = {
  claude: 'Edit|Write|MultiEdit|NotebookEdit',
  codex: 'apply_patch|Edit|Write',
  gemini: 'write_file|replace',
};

/** Chemin Windows utilisable SANS guillemets, à l'identique, par cmd ET PowerShell. */
const WINDOWS_UNQUOTED_SAFE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/;

function requireAdapter(tool: string): HookAdapter {
  const adapter = getAdapter(tool);
  if (!adapter) {
    throw new StriartError(
      `Outil de hook inconnu : « ${tool} ». Attendu : ${HOOK_TOOLS.join(', ')}.`,
      { code: 'HOOK_TOOL_UNKNOWN', details: { tool }, hint: 'striart hook install claude --user' },
    );
  }
  return adapter;
}

const absoluteEnv = (value: string | undefined, platform: NodeJS.Platform) => {
  if (!value) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.isAbsolute(value) ? value : null;
};

interface Resolved {
  adapter: HookAdapter;
  tool: HookTool;
  scope: HookScope;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodePath: string;
  cliPath: string;
  root: string | null;
  agent: string | null;
  clonePath: string | null;
  dryRun: boolean;
  p: typeof path.posix;
}

async function resolveParams(params: HookInstallParams): Promise<Resolved> {
  const adapter = requireAdapter(params.tool);
  const platform = params.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (params.scope !== 'user' && params.scope !== 'clone') {
    throw new StriartError('Portée du hook requise : --user ou --agent <nom>.', {
      code: 'HOOK_SCOPE_REQUIRED',
      details: {},
      hint: 'striart hook install claude --user',
    });
  }
  if (params.scope === 'clone') {
    if (!params.root || !params.agent || !params.clonePath || !AGENT_NAME_RE.test(params.agent)) {
      throw new StriartError('Portée « clone » : racine, agent et clone requis.', {
        code: 'HOOK_SCOPE_REQUIRED',
        details: {},
        hint: 'striart hook install claude --agent agent-a',
      });
    }
  }
  let nodePath = params.nodePath;
  if (!nodePath) {
    // Chemin RÉEL : un gestionnaire de versions (fnm, nvm-windows) expose
    // Node par un lien de session qui disparaît avec le shell.
    nodePath = await realpath(process.execPath).catch(() => process.execPath);
  }
  const cliPath = params.cliPath ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  for (const value of [nodePath, cliPath, params.root ?? '', params.clonePath ?? '']) {
    if (/[\0\r\n]/.test(value)) {
      throw new StriartError(
        'Installation du hook refusée : un chemin contient un saut de ligne ou un caractère nul.',
        { code: 'HOOK_PATH_UNSAFE', details: {} },
      );
    }
  }
  return {
    adapter,
    tool: adapter.tool,
    scope: params.scope,
    home: params.home ?? os.homedir(),
    env: params.env ?? process.env,
    platform,
    nodePath,
    cliPath,
    root: params.scope === 'clone' ? params.root! : null,
    agent: params.scope === 'clone' ? params.agent! : null,
    clonePath: params.scope === 'clone' ? params.clonePath! : null,
    dryRun: params.dryRun === true,
    p,
  };
}

/** argv du hook : `node cli.js hook <outil> <événement> [--root <racine>]`. */
function hookArgv(r: Resolved, event: string): string[] {
  return [r.nodePath, r.cliPath, 'hook', r.tool, event, ...(r.root ? ['--root', r.root] : [])];
}

// ---------------------------------------------------------------- cibles

interface FilePlan {
  path: string;
  /** Contenu voulu, null = fichier à supprimer. */
  content: string | null;
  mode: number;
  /** Chemin relatif au clone (portée clone) : contrôlé non suivi, exclu localement. */
  cloneRelative: string | null;
}

function userDirFor(r: Resolved, envName: string, fallback: string[]): string {
  return absoluteEnv(r.env[envName], r.platform) ?? r.p.join(r.home, ...fallback);
}

/** Fichier de configuration JSON visé (outils à fichier JSON). */
function jsonTarget(r: Resolved): { path: string; rel: string | null } {
  const inClone = (rel: string) => ({ path: r.p.join(r.clonePath!, ...rel.split('/')), rel });
  switch (r.tool) {
    case 'claude':
      return r.scope === 'clone'
        ? inClone('.claude/settings.local.json')
        : {
            path: r.p.join(userDirFor(r, 'CLAUDE_CONFIG_DIR', ['.claude']), 'settings.json'),
            rel: null,
          };
    case 'codex':
      return r.scope === 'clone'
        ? inClone('.codex/hooks.json')
        : { path: r.p.join(userDirFor(r, 'CODEX_HOME', ['.codex']), 'hooks.json'), rel: null };
    case 'gemini':
      return r.scope === 'clone'
        ? inClone('.gemini/settings.json')
        : { path: r.p.join(r.home, '.gemini', 'settings.json'), rel: null };
    case 'copilot':
      return r.scope === 'clone'
        ? inClone('.github/hooks/striart.json')
        : {
            path: r.p.join(userDirFor(r, 'COPILOT_HOME', ['.copilot']), 'hooks', 'striart.json'),
            rel: null,
          };
    default:
      throw new Error(`Outil sans fichier JSON : ${r.tool}`);
  }
}

/** Dossier des scripts Cline. */
function clineDir(r: Resolved): { dir: string; rel: string | null } {
  if (r.scope === 'clone')
    return { dir: r.p.join(r.clonePath!, '.clinerules', 'hooks'), rel: '.clinerules/hooks' };
  return { dir: r.p.join(r.home, 'Documents', 'Cline', 'Hooks'), rel: null };
}

// ------------------------------------------------- lanceur Windows (.cmd)

function launcherPath(r: Resolved): string {
  const dir =
    absoluteEnv(r.env.STRIART_HOOK_BIN_DIR, 'win32') ??
    (absoluteEnv(r.env.LOCALAPPDATA, 'win32')
      ? path.win32.join(r.env.LOCALAPPDATA!, 'striart', 'hooks')
      : null);
  if (!dir) {
    throw new StriartError(
      'Installation du hook impossible : %LOCALAPPDATA% est absent ; définis STRIART_HOOK_BIN_DIR (chemin absolu sans espace).',
      { code: 'HOOK_PATH_UNSAFE', details: { tool: r.tool } },
    );
  }
  const suffix = r.root
    ? `-${createHash('sha256').update(`${r.root}\0${r.agent}`).digest('hex').slice(0, 8)}`
    : '';
  const file = path.win32.join(dir, `striart-${r.tool}${suffix}-hook.cmd`);
  if (!WINDOWS_UNQUOTED_SAFE.test(file)) {
    throw new StriartError(
      `Installation du hook refusée : le lanceur ${file} contient un espace ou un caractère spécial, que cmd et PowerShell ne liraient pas de la même façon. Définis STRIART_HOOK_BIN_DIR vers un dossier sans espace.`,
      { code: 'HOOK_PATH_UNSAFE', details: { path: file } },
    );
  }
  return file;
}

function launcherContent(r: Resolved): string {
  const values = [r.nodePath, r.cliPath, ...(r.root ? [r.root] : [])];
  // Entre guillemets doubles, cmd ne développe que %VAR% ; `"` est interdit
  // dans un nom de fichier Windows. Refuser ces deux-là rend la ligne exacte.
  if (values.some((v) => v.includes('%') || v.includes('"'))) {
    throw new StriartError(
      'Installation du hook refusée : un chemin contient « % » ou « " », que le lanceur cmd ne sait pas transmettre fidèlement.',
      { code: 'HOOK_PATH_UNSAFE', details: {} },
    );
  }
  const q = (v: string) => `"${v}"`;
  const root = r.root ? ` --root ${q(r.root)}` : '';
  return `@echo off\r\nrem ${HOOK_MARKER} - genere par "striart hook install ${r.tool}"\r\n${q(r.nodePath)} ${q(r.cliPath)} hook ${r.tool} %1${root}\r\n`;
}

/** Chaîne de commande (Codex, Gemini) pour un événement. */
function commandString(r: Resolved, event: string): string {
  if (r.platform === 'win32') return `${launcherPath(r)} ${event}`;
  return posixCommandLine(hookArgv(r, event));
}

// ------------------------------------------------------- JSON : fusion

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function unreadable(file: string, reason: string): StriartError {
  return new StriartError(
    `Configuration de l'outil illisible (${file}) : ${reason}. Elle n'a pas été modifiée — corrige-la puis relance.`,
    { code: 'HOOK_CONFIG_UNREADABLE', details: { path: file } },
  );
}

async function readJsonDoc(file: string): Promise<Json | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unreadable(file, (error as NodeJS.ErrnoException).code ?? 'lecture impossible');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (error) {
    throw unreadable(file, (error as Error).message);
  }
  if (!isObject(doc)) throw unreadable(file, 'la racine n’est pas un objet JSON');
  if (doc.hooks !== undefined && !isObject(doc.hooks))
    throw unreadable(file, '« hooks » n’est pas un objet');
  return doc;
}

/** Entrée Striart dans un groupe de handlers (Claude Code, Codex, Gemini). */
function isOurHandler(tool: HookTool, h: unknown): boolean {
  if (!isObject(h)) return false;
  if (tool === 'claude')
    return Array.isArray(h.args) && h.args[1] === 'hook' && h.args[2] === 'claude';
  if (tool === 'codex') return h.statusMessage === CODEX_STATUS;
  if (tool === 'gemini') return h.name === GEMINI_NAME;
  return false;
}

/** Retire les entrées Striart des événements de l'outil ; groupes et événements vidés supprimés. */
function stripOurs(tool: HookTool, doc: Json, file: string): Json {
  const hooks = isObject(doc.hooks) ? { ...doc.hooks } : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw unreadable(file, `« hooks.${event} » n’est pas un tableau`);
    const kept = groups
      .map((group) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) return group;
        const handlers = group.hooks.filter((h) => !isOurHandler(tool, h));
        if (handlers.length === group.hooks.length) return group;
        return handlers.length === 0 ? null : { ...group, hooks: handlers };
      })
      .filter((g) => g !== null);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return { ...doc, hooks };
}

function ourHandler(r: Resolved, event: string, sessionEnd: boolean): Json {
  if (r.tool === 'claude') {
    const [command, ...args] = hookArgv(r, event);
    return { type: 'command', command, args, timeout: sessionEnd ? 10 : 15 };
  }
  if (r.tool === 'codex') {
    const command = commandString(r, event);
    return {
      type: 'command',
      command,
      ...(r.platform === 'win32' ? { commandWindows: command } : {}),
      // SessionEnd : délai par défaut 1 s, plafond 3 s (documenté).
      timeout: sessionEnd ? 3 : 10,
      statusMessage: CODEX_STATUS,
    };
  }
  return {
    type: 'command',
    name: GEMINI_NAME,
    command: commandString(r, event),
    timeout: 10_000,
    description:
      'Striart: warns when a file is predicted or locked by another agent (never blocks).',
  };
}

function withOurs(r: Resolved, doc: Json): Json {
  const hooks = isObject(doc.hooks) ? { ...doc.hooks } : {};
  for (const event of r.adapter.installEvents) {
    const sessionEnd = r.adapter.events[event] === 'session-end';
    const matcher = sessionEnd ? undefined : MATCHERS[r.tool];
    const group: Json = {
      ...(matcher ? { matcher } : {}),
      hooks: [ourHandler(r, event, sessionEnd)],
    };
    hooks[event] = [...((hooks[event] as unknown[]) ?? []), group];
  }
  return { ...doc, hooks };
}

const isEmptyDoc = (doc: Json) =>
  Object.keys(doc).every((k) => k === 'hooks') &&
  (!isObject(doc.hooks) || Object.keys(doc.hooks).length === 0);

const serialize = (doc: Json) => `${JSON.stringify(doc, null, 2)}\n`;

async function existingMode(file: string): Promise<number | null> {
  const info = await stat(file).catch(() => null);
  return info ? info.mode & 0o777 : null;
}

async function planJsonTool(r: Resolved, install: boolean): Promise<FilePlan[]> {
  const target = jsonTarget(r);
  const plans: FilePlan[] = [];
  const mode = (await existingMode(target.path)) ?? 0o600;
  if (r.tool === 'copilot') {
    const doc = await readJsonDoc(target.path);
    if (doc && !isCopilotOurs(doc)) {
      throw new StriartError(
        `Installation du hook refusée : ${target.path} existe et n'a pas été écrit par Striart.`,
        { code: 'HOOK_TARGET_FOREIGN', details: { path: target.path } },
      );
    }
    plans.push({
      path: target.path,
      content: install ? serialize(copilotDoc(r)) : null,
      mode,
      cloneRelative: target.rel,
    });
    return plans;
  }
  const doc = (await readJsonDoc(target.path)) ?? {};
  const stripped = stripOurs(r.tool, doc, target.path);
  const next = install ? withOurs(r, stripped) : stripped;
  plans.push({
    path: target.path,
    content: isEmptyDoc(next) ? null : serialize(next),
    mode,
    cloneRelative: target.rel,
  });
  if ((r.tool === 'codex' || r.tool === 'gemini') && r.platform === 'win32') {
    plans.push({
      path: launcherPath(r),
      content: install ? launcherContent(r) : null,
      mode: 0o700,
      cloneRelative: null,
    });
  }
  return plans;
}

function copilotDoc(r: Resolved): Json {
  const hooks: Json = {};
  for (const event of r.adapter.installEvents) {
    const [exec, ...args] = hookArgv(r, event);
    hooks[event] = [{ type: 'command', exec, args, timeoutSec: 10 }];
  }
  return { version: 1, hooks };
}

function isCopilotOurs(doc: Json): boolean {
  if (!isObject(doc.hooks)) return false;
  const handlers = Object.values(doc.hooks).flatMap((v) => (Array.isArray(v) ? v : [null]));
  return (
    handlers.length > 0 &&
    handlers.every(
      (h) =>
        isObject(h) && Array.isArray(h.args) && h.args[1] === 'hook' && h.args[2] === 'copilot',
    )
  );
}

// ------------------------------------------------------- Cline : scripts

function clineScript(r: Resolved, event: string): string {
  const argv = hookArgv(r, event);
  if (r.platform === 'win32') {
    // Charge utile relayée en UTF-8 (Windows PowerShell 5.1 encode sinon en ASCII).
    return [
      `# ${HOOK_MARKER} - généré par « striart hook install cline ».`,
      '$utf8 = New-Object System.Text.UTF8Encoding $false',
      '[Console]::InputEncoding = $utf8',
      '$OutputEncoding = $utf8',
      `[Console]::In.ReadToEnd() | & ${argv.map(quotePowerShell).join(' ')}`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# ${HOOK_MARKER} - généré par « striart hook install cline ».`,
    `exec ${argv.map(quotePosix).join(' ')}`,
    '',
  ].join('\n');
}

async function planCline(r: Resolved, install: boolean): Promise<FilePlan[]> {
  const { dir, rel } = clineDir(r);
  const plans: FilePlan[] = [];
  for (const event of r.adapter.installEvents) {
    const name = r.platform === 'win32' ? `${event}.ps1` : event;
    const file = r.p.join(dir, name);
    const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw unreadable(file, error.code ?? 'lecture impossible');
    });
    if (current !== null && !current.includes(HOOK_MARKER)) {
      throw new StriartError(
        `Installation du hook refusée : le script Cline ${file} existe et n'a pas été écrit par Striart (Cline n'exécute qu'un script par événement).`,
        { code: 'HOOK_TARGET_FOREIGN', details: { path: file } },
      );
    }
    plans.push({
      path: file,
      content: install ? clineScript(r, event) : null,
      mode: 0o700,
      cloneRelative: rel ? `${rel}/${name}` : null,
    });
  }
  return plans;
}

// ------------------------------------------------- clone : garde-fous git

async function assertUntracked(clonePath: string, rels: string[]): Promise<void> {
  if (rels.length === 0) return;
  const { cloneGit } = await import('../clone.js');
  const out: string = await cloneGit(clonePath).raw(['ls-files', '--', ...rels]);
  const tracked = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (tracked.length > 0) {
    throw new StriartError(
      `Installation du hook refusée : ${tracked.join(', ')} est versionné par le dépôt. L'agent le commiterait et la garde des chemins protégés refuserait le merge — installe le hook pour l'utilisateur (--user).`,
      {
        code: 'HOOK_TARGET_TRACKED',
        details: { path: tracked[0] },
        hint: 'striart hook install <outil> --user',
      },
    );
  }
}

const excludeLine = (rel: string) => `/${rel}`;

async function updateExcludes(clonePath: string, rels: string[], add: boolean): Promise<void> {
  if (rels.length === 0) return;
  const entries = rels.map(excludeLine);
  if (add) await ensureCloneExcludes(clonePath, entries);
  else await removeCloneExcludes(clonePath, entries);
}

// ------------------------------------------------------------- exécution

async function apply(r: Resolved, plans: FilePlan[], install: boolean): Promise<HookFileChange[]> {
  const changes: HookFileChange[] = [];
  for (const plan of plans) {
    const current = await readFile(plan.path, 'utf8').catch(() => null);
    let action: HookFileChange['action'];
    if (plan.content === null) action = current === null ? 'unchanged' : 'remove';
    else if (current === null) action = 'create';
    else action = current === plan.content ? 'unchanged' : 'update';
    changes.push({ path: plan.path, action });
  }
  if (r.dryRun) return changes;
  const rels = plans.map((p) => p.cloneRelative).filter((rel): rel is string => rel !== null);
  if (r.scope === 'clone') {
    // Exclusion AVANT l'écriture : jamais un instant où le fichier apparaît
    // non suivi et non exclu (un `git add -A` de l'agent le capturerait).
    if (install) await updateExcludes(r.clonePath!, rels, true);
  }
  for (const [i, plan] of plans.entries()) {
    const action = changes[i].action;
    if (action === 'unchanged') continue;
    // Portée clone : un agent sandboxé peut avoir planté un lien (fichier ou
    // dossier intermédiaire) — écriture et retrait passent par safe-write, qui
    // ne suit jamais de lien (SAFE_WRITE_UNSAFE sinon).
    if (r.scope === 'clone' && r.clonePath && plan.cloneRelative !== null) {
      if (action === 'remove') await safeRemove(r.clonePath, plan.cloneRelative);
      else await safeWriteFile(r.clonePath, plan.cloneRelative, plan.content!, { mode: plan.mode });
      continue;
    }
    if (action === 'remove') {
      await rm(plan.path, { force: true });
      continue;
    }
    await mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomic(plan.path, plan.content!, {
      mode: plan.mode,
      code: 'HOOK_PATH_UNSAFE',
    });
  }
  if (r.scope === 'clone' && !install) await updateExcludes(r.clonePath!, rels, false);
  return changes;
}

/** Chemins visés dans le clone (relatifs), connus AVANT toute lecture. */
function cloneTargets(r: Resolved): string[] {
  if (r.tool === 'cline') {
    const { rel } = clineDir(r);
    return r.adapter.installEvents.map((e) => `${rel}/${r.platform === 'win32' ? `${e}.ps1` : e}`);
  }
  const { rel } = jsonTarget(r);
  return rel ? [rel] : [];
}

async function plan(r: Resolved, install: boolean): Promise<FilePlan[]> {
  // Un fichier versionné est refusé en premier : c'est la raison qui décide
  // (le modifier casserait le merge), quel que soit son contenu.
  if (r.scope === 'clone' && install) await assertUntracked(r.clonePath!, cloneTargets(r));
  return r.tool === 'cline' ? planCline(r, install) : planJsonTool(r, install);
}

export async function installHooks(params: HookInstallParams): Promise<HookFileChange[]> {
  const r = await resolveParams(params);
  return apply(r, await plan(r, true), true);
}

export async function uninstallHooks(params: HookInstallParams): Promise<HookFileChange[]> {
  const r = await resolveParams(params);
  return apply(r, await plan(r, false), false);
}
