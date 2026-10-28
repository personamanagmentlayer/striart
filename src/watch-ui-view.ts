/**
 * Vue pure du cockpit `striart watch --ui` : un MODÈLE (état déjà collecté)
 * entre, des LIGNES de segments stylés sortent — exactement `rows` lignes de
 * `cols` colonnes au plus. Aucune E/S, aucun React, aucune horloge cachée
 * (l'instant est un paramètre) : la trame se teste à largeur fixe, avec et
 * sans couleur, et se joue à l'identique dans Ink, dans le mode linéaire et
 * dans les captures.
 *
 * Mise en page (positions STABLES — la mémoire spatiale de l'utilisateur) :
 *
 *   en-tête        striart watch · ● watcher actif · cible · dépôt · heure
 *   chiffres clés  agents · commits en attente · conflits · file
 *   agents         tableau groupé « À traiter · En cours · Inactifs »
 *   détail         session, branche, commits, fichiers, ticket de l'agent
 *   panneau bas    journal des événements ↔ sortie des commandes
 *   retour         dernière action (toast) ou erreur de rafraîchissement
 *   saisie         champ /commande · @agent · !shell
 *   touches        barre de raccourcis TOUJOURS visible, contextuelle
 *
 * Accessibilité : un état = un MOT + un GLYPHE + un ton ; jamais la couleur
 * seule (le rendu sans couleur porte la même information). Tout texte venu
 * d'un agent, d'un commit, d'un fichier ou d'un ticket est neutralisé par
 * `sanitize` avant de devenir un segment.
 */
import type { Capabilities } from './cli/caps.ts';
import type { Messages } from './cli/i18n/fr.ts';
import { glyphsFor } from './cli/output.ts';
import type { IdleCell } from './idle/status.ts';
import type { Glyphs, Level, Tone } from './cli/output.ts';
import { agentStateView, GROUP_ORDER, stateGlyphChar } from './cli/render/agents.ts';
import type { AgentGroup } from './cli/render/agents.ts';
import { layoutColumns } from './cli/render/table.ts';
import { asciiStatic } from './cli/render/ascii.ts';
import { displayWidth, padEnd, sanitize, truncate, wrapWords } from './cli/text.ts';

// ───────────────────────────── segments et lignes ─────────────────────────────

/** Un fragment de texte stylé. `tone` = ton sémantique ; le reste = attributs bruts (sortie émulée d'un terminal). */
export interface Seg {
  text: string;
  tone?: Tone;
  bold?: boolean;
  inverse?: boolean;
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export type Line = Seg[];

export const lineText = (line: Line): string => line.map((s) => s.text).join('');
export const frameText = (lines: Line[]): string => lines.map(lineText).join('\n');
const lineWidth = (line: Line): number => line.reduce((n, s) => n + displayWidth(s.text), 0);

/** Coupe une ligne à `width` colonnes (ellipse à la fin), sans jamais retourner à la ligne. */
export function fitLine(line: Line, width: number, ellipsis: string): Line {
  if (width <= 0) return [];
  if (lineWidth(line) <= width) return line;
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    const w = displayWidth(s.text);
    if (used + w <= width - displayWidth(ellipsis)) {
      out.push(s);
      used += w;
      continue;
    }
    const room = width - used;
    const text = truncate(s.text, room, ellipsis);
    if (text !== '') out.push({ ...s, text });
    return out;
  }
  return out;
}

/** Gauche + droite alignée à droite ; la gauche cède la place si la ligne est trop étroite. */
function leftRight(left: Line, right: Line, width: number, ellipsis: string): Line {
  const rw = lineWidth(right);
  if (rw === 0) return left;
  const room = width - rw - 1;
  const l = fitLine(left, Math.max(0, room), ellipsis);
  const gap = Math.max(1, width - lineWidth(l) - rw);
  return [...l, { text: ' '.repeat(gap) }, ...right];
}

// ───────────────────────────────── modèle ─────────────────────────────────

export interface AgentRow {
  name: string;
  status: string;
  mode?: string;
  profile?: string | null;
  session?: { state: string; via: string | null; pid: number | null } | null;
  pendingCommits: number;
  branch: string;
  lastMessage: string | null;
  /** Date ISO du dernier commit (pour l'âge relatif), si connue. */
  lastCommitAt: string | null;
  sizeBytes?: number;
  ticket: { id: string; reason: string } | null;
  /** Inactivité signalée par le GC (src/idle/) ; absent = rien à signaler (actif, protégé, GC coupé). */
  idle?: IdleCell | null;
}

export interface DetailInfo {
  loading: boolean;
  error?: string;
  commits: Array<{ sha: string; at: string | null; subject: string }>;
  commitTotal: number;
  files: Array<{ status: string; path: string }>;
  fileTotal: number;
  uncommitted: number;
}

export interface JournalEntry {
  at: number;
  tone: Level;
  text: string;
  /** Ligne rattachée à la précédente (détail, piste) : sans heure, indentée. */
  continuation?: boolean;
}

export interface ActivityView {
  id: number;
  label: string;
  status: 'pending' | 'ok' | 'error';
  startedAt: number;
  endedAt: number | null;
  detail?: string;
}

export interface SuggestionView {
  kind: 'agent' | 'command';
  value: string;
  description: string;
}

export type ViewKind = 'main' | 'zoom' | 'help' | 'confirm';
export type BottomPane = 'journal' | 'commands';

export interface ConfirmView {
  title: string;
  lines: string[];
}

export interface FrameModel {
  cols: number;
  rows: number;
  now: number;
  root: string;
  targetBranch: string;
  /** Le watcher fusionne-t-il automatiquement ? */
  autoMerge: boolean;
  loaded: boolean;
  refreshError: string | null;
  /** Instant du dernier rafraîchissement réussi ; sert à signaler des données obsolètes. */
  lastRefreshAt: number | null;
  agents: AgentRow[];
  selected: string | null;
  openTickets: number;
  queueWaiting: number;
  detail: DetailInfo | null;
  view: ViewKind;
  bottom: BottomPane;
  /** Le panneau non affiché a reçu du contenu depuis sa dernière visite. */
  unread: { journal: boolean; commands: boolean };
  journal: JournalEntry[];
  journalScroll: number;
  commandLines: Line[];
  commandsScroll: number;
  outputLines: Line[];
  outputConnected: boolean;
  idleTool: boolean;
  outputScroll: number;
  confirm: ConfirmView | null;
  input: { focused: boolean; text: string; cursor: number };
  suggestions: SuggestionView[];
  activeSuggestion: number;
  activity: ActivityView[];
}

export interface ViewCtx {
  m: Messages;
  caps: Pick<Capabilities, 'unicode' | 'colorStdout' | 'plain'>;
}

/** Seuil en dessous duquel l'écran n'a plus de sens : un message clair, jamais un cadre cassé. */
export const MIN_COLS = 40;
export const MIN_ROWS = 10;
/** Durée d'affichage d'une action terminée dans la ligne de retour. */
export const TOAST_MS = 12_000;
/** Un événement sans rafraîchissement depuis ce délai rend les données « obsolètes ». */
export const STALE_AFTER_MS = 25_000;

// ─────────────────────────────── utilitaires ───────────────────────────────

/** Texte statique localisé → ASCII quand le terminal n'affiche pas l'Unicode. */
function makeText(unicode: boolean): (text: string) => string {
  return unicode ? (text) => text : asciiStatic;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Libellé d'inactivité d'un agent (« inactif 3 h, averti »), ou null si rien à signaler. */
export function idleLabel(m: Messages, cell: IdleCell | null | undefined): string | null {
  if (!cell) return null;
  const first = /^\d+\s?[^\d\s]+/.exec(m.units.duration(cell.minutes * 60_000))?.[0];
  return m.watchUi.cockpit.idleState(cell.stage, first ?? `${cell.minutes} min`);
}

/** Âge court (« 3m », « 2h ») : première unité de la durée localisée. */
export function ageText(m: Messages, iso: string | null, now: number, empty: string): string {
  if (!iso) return empty;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return empty;
  // Première unité seulement (« 3 min », « 2h ») : un âge se lit d'un coup d'œil.
  return /^\d+\s?[^\d\s]+/.exec(m.units.duration(Math.max(0, ms)))?.[0] ?? empty;
}

function midTruncate(text: string, max: number, ellipsis: string): string {
  if (displayWidth(text) <= max) return text;
  const keep = Math.max(1, max - displayWidth(ellipsis));
  // Garde la fin d'un chemin : c'est la partie qui identifie le dépôt.
  const tail: string[] = [];
  let w = 0;
  for (const ch of [...text].reverse()) {
    const cw = displayWidth(ch);
    if (w + cw > keep) break;
    tail.unshift(ch);
    w += cw;
  }
  return ellipsis + tail.join('');
}

/** Ordre d'affichage : groupes « À traiter · En cours · Inactifs », ordre du registre conservé dedans. */
export function groupAgents(
  agents: AgentRow[],
  ticketLabel: string,
): Array<{ group: AgentGroup; agents: AgentRow[] }> {
  const buckets = new Map<AgentGroup, AgentRow[]>(GROUP_ORDER.map((g) => [g, []]));
  for (const a of agents) {
    const view = agentStateView(a, a.ticket !== null, ticketLabel);
    buckets.get(view.group)!.push(a);
  }
  return GROUP_ORDER.map((group) => ({ group, agents: buckets.get(group)! })).filter(
    (b) => b.agents.length > 0,
  );
}

/** Agents dans l'ordre exact de l'écran (aplati) : la sélection suit CET ordre. */
export function displayOrder(agents: AgentRow[], ticketLabel: string): AgentRow[] {
  return groupAgents(agents, ticketLabel).flatMap((b) => b.agents);
}

// ─────────────────────────────── composants ───────────────────────────────

class Painter {
  readonly g: Glyphs;
  readonly t: (text: string) => string;
  readonly model: FrameModel;
  readonly ctx: ViewCtx;
  constructor(model: FrameModel, ctx: ViewCtx) {
    this.model = model;
    this.ctx = ctx;
    this.g = glyphsFor(ctx.caps.unicode);
    this.t = makeText(ctx.caps.unicode);
  }
  get m(): Messages {
    return this.ctx.m;
  }
  get cols(): number {
    return this.model.cols;
  }
  /** Texte NON FIABLE → segment neutralisé. */
  untrusted(text: string | null | undefined): string {
    return text ? sanitize(text) : '';
  }
  keycap(key: string): Seg {
    const k = key.replace(/↑/g, this.g.up).replace(/↓/g, this.g.down);
    return { text: ` ${k} `, inverse: true };
  }
}

function headerLine(p: Painter): Line {
  const { model: md, m, g } = p;
  const c = m.watchUi.cockpit;
  const stale =
    md.refreshError !== null ||
    (md.lastRefreshAt !== null && md.now - md.lastRefreshAt > STALE_AFTER_MS);
  const clockSeg: Line = [{ text: clock(md.now).slice(0, 5), tone: 'muted' }];
  const status = (withMergeNote: boolean): Line => {
    if (!md.loaded && md.refreshError === null) {
      return [{ text: `  ${g.info} ${c.loading}`, tone: 'muted' }];
    }
    if (stale) {
      const since =
        md.lastRefreshAt === null ? g.empty : m.units.duration(md.now - md.lastRefreshAt);
      return [{ text: `  ${g.warn} ${p.t(c.stale(since))}`, tone: 'warn' }];
    }
    const line: Line = [{ text: `  ${g.active} ${c.watcherOn}`, tone: 'ok' }];
    if (withMergeNote) {
      line.push({
        text: ` ${g.info} ${md.autoMerge ? c.watcherMerge : c.watcherNoMerge}`,
        tone: md.autoMerge ? 'muted' : 'warn',
      });
    }
    return line;
  };
  const title: Line = [{ text: c.appName, bold: true, tone: 'accent' }];
  const target: Line = [{ text: `  ${g.arrow} ${p.untrusted(md.targetBranch)}`, tone: 'muted' }];
  // De la plus riche à la plus sobre : le dépôt tombe d'abord, puis la note de merge, puis la cible.
  const attempts: Array<[boolean, boolean, boolean]> = [
    [true, true, true],
    [false, true, true],
    [false, false, true],
    [false, false, false],
  ];
  const room = p.cols - lineWidth(clockSeg) - 1;
  let left: Line = [...title, ...status(false)];
  for (const [withRoot, withMerge, withTarget] of attempts) {
    const candidate: Line = [...title, ...status(withMerge), ...(withTarget ? target : [])];
    if (withRoot) {
      const rootRoom = room - lineWidth(candidate) - 2;
      if (rootRoom < 16) continue;
      candidate.push({
        text: `  ${midTruncate(p.untrusted(md.root), rootRoom, g.ellipsis)}`,
        tone: 'muted',
      });
    }
    left = candidate;
    if (lineWidth(candidate) <= room) break;
  }
  return leftRight(left, clockSeg, p.cols, g.ellipsis);
}

function kpiLine(p: Painter): Line {
  const { model: md, m, g } = p;
  const c = m.watchUi.cockpit;
  const wide = p.cols >= 72;
  const pending = md.agents.reduce((n, a) => n + a.pendingCommits, 0);
  const items: Array<{ label: string; value: number; tone?: Tone; glyph?: string }> = [
    { label: wide ? c.kpiAgents : c.kpiAgentsShort, value: md.agents.length },
    {
      label: wide ? c.kpiCommits : c.kpiCommitsShort,
      value: pending,
      tone: pending > 0 ? 'accent' : undefined,
    },
    {
      label: wide ? c.kpiConflicts : c.kpiConflictsShort,
      value: md.openTickets,
      tone: md.openTickets > 0 ? 'error' : undefined,
      glyph: md.openTickets > 0 ? g.error : undefined,
    },
    { label: wide ? c.kpiQueue : c.kpiQueueShort, value: md.queueWaiting },
  ];
  const line: Line = [];
  items.forEach((it, i) => {
    if (i > 0) line.push({ text: '   ' });
    const quiet = it.value === 0 && it.tone === undefined;
    if (it.glyph) line.push({ text: `${it.glyph} `, tone: it.tone, bold: true });
    line.push({ text: `${it.label} `, tone: it.tone ?? 'muted' });
    line.push({ text: String(it.value), tone: quiet ? 'muted' : it.tone, bold: !quiet });
  });
  return line;
}

function ruleLine(p: Painter, title: Line, right: Line = []): Line {
  const { g } = p;
  const lead: Line = [
    { text: `${g.rule}${g.rule} `, tone: 'muted' },
    ...title,
    { text: ' ', tone: 'muted' },
  ];
  const rightW = lineWidth(right);
  const fill = Math.max(0, p.cols - lineWidth(lead) - (rightW > 0 ? rightW + 1 : 0));
  const out: Line = [...lead, { text: g.rule.repeat(fill), tone: 'muted' }];
  if (rightW > 0) out.push({ text: ' ' }, ...right);
  return fitLine(out, p.cols, g.ellipsis);
}

// ─────────────────────────────── tableau agents ───────────────────────────────

interface Cell {
  text: string;
  tone?: Tone;
  bold?: boolean;
}

interface AgentColumn {
  header: string;
  priority: number;
  shrink?: { min: number };
  align?: 'right';
  cell: (a: AgentRow) => Cell;
}

function agentColumns(p: Painter): AgentColumn[] {
  const { model: md, m, g } = p;
  const c = m.watchUi.cockpit;
  const stateOf = (a: AgentRow) => agentStateView(a, a.ticket !== null, m.status.stateTicket);
  return [
    {
      header: c.colAgent,
      priority: 10,
      cell: (a) => ({ text: `${a.name === md.selected ? g.select : ' '} ${p.untrusted(a.name)}` }),
    },
    {
      header: c.colState,
      priority: 9,
      cell: (a) => {
        const v = stateOf(a);
        const idle = idleLabel(m, a.idle);
        // Inactif signalé : le mot de l'état reste, l'inactivité s'y ajoute — jamais la couleur seule.
        return {
          text: `${stateGlyphChar(g, v.glyph)} ${v.label}${idle ? ` (${idle})` : ''}`,
          tone: a.idle && a.idle.stage !== 'idle' ? 'warn' : v.level,
        };
      },
    },
    {
      header: c.colCommits,
      priority: 8,
      align: 'right',
      cell: (a) =>
        a.pendingCommits > 0
          ? { text: `${a.pendingCommits} ${g.up}`, tone: 'accent', bold: true }
          : { text: g.info, tone: 'muted' },
    },
    {
      header: c.colLast,
      priority: 7,
      shrink: { min: 14 },
      cell: (a) =>
        a.status === 'ACTIVE'
          ? { text: p.untrusted((a.lastMessage ?? '').split('\n')[0]) }
          : { text: m.status.brokenDetail(a.status), tone: 'muted' },
    },
    {
      header: c.colAge,
      priority: 6,
      align: 'right',
      cell: (a) => ({ text: ageText(m, a.lastCommitAt, md.now, g.empty), tone: 'muted' }),
    },
    {
      header: c.colMode,
      priority: 5,
      cell: (a) => ({
        text: p.untrusted(m.common.mode(a.mode ?? 'attended', a.profile)),
        tone: 'muted',
      }),
    },
    {
      header: c.colSession,
      priority: 4,
      cell: (a) => ({ text: m.status.session(a.session ?? null), tone: 'muted' }),
    },
    {
      header: c.colBranch,
      priority: 3,
      shrink: { min: 12 },
      cell: (a) => ({ text: p.untrusted(a.branch), tone: 'muted' }),
    },
  ];
}

interface AgentTable {
  header: Line;
  rowLine: (a: AgentRow) => Line;
}

function buildAgentTable(p: Painter, ordered: AgentRow[]): AgentTable {
  const { g } = p;
  const gap = 2;
  const columns = agentColumns(p);
  const cells = ordered.map((a) => columns.map((col) => col.cell(a)));
  const natural = columns.map((col, i) =>
    Math.max(displayWidth(col.header), ...cells.map((r) => displayWidth(r[i].text))),
  );
  const { visible, widths } = layoutColumns(columns, natural, p.cols, gap);
  const place = (text: string, i: number, last: boolean): string => {
    const shown = truncate(text, widths[i], g.ellipsis);
    if (last) return columns[i].align === 'right' ? padStart(shown, widths[i]) : shown;
    return columns[i].align === 'right' ? padStart(shown, widths[i]) : padEnd(shown, widths[i]);
  };
  const header: Line = [];
  visible.forEach((i, n) => {
    if (n > 0) header.push({ text: ' '.repeat(gap) });
    header.push({ text: place(columns[i].header, i, n === visible.length - 1), tone: 'muted' });
  });
  const rowLine = (a: AgentRow): Line => {
    const idx = ordered.indexOf(a);
    const selected = a.name === p.model.selected;
    const line: Line = [];
    visible.forEach((i, n) => {
      if (n > 0) line.push({ text: ' '.repeat(gap) });
      const cell = cells[idx][i];
      const text = place(cell.text, i, n === visible.length - 1);
      // Colonne AGENT : la sélection est un marqueur ET une vidéo inverse, jamais la couleur seule.
      if (i === 0 && selected) line.push({ text, inverse: true, bold: true });
      else line.push({ text, tone: cell.tone, bold: cell.bold || selected });
    });
    return line;
  };
  return { header, rowLine };
}

function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

interface TableItem {
  kind: 'group' | 'agent';
  line: Line;
  name?: string;
}

/** Lignes du tableau (groupes + agents), fenêtrées autour de la sélection si `room` manque. */
function agentItems(
  p: Painter,
  table: AgentTable,
  room: number,
): { lines: Line[]; window: string } {
  const { model: md, m, g } = p;
  const c = m.watchUi.cockpit;
  const groups = groupAgents(md.agents, m.status.stateTicket);
  const withGroups = groups.reduce((n, b) => n + b.agents.length + 1, 0) <= room;
  const items: TableItem[] = [];
  for (const b of groups) {
    if (withGroups) {
      const label = { attention: c.groupAttention, running: c.groupRunning, idle: c.groupIdle }[
        b.group
      ];
      items.push({
        kind: 'group',
        line: [
          { text: `${label}`, tone: b.group === 'attention' ? 'error' : 'muted', bold: true },
          { text: ` (${b.agents.length})`, tone: 'muted' },
        ],
      });
    }
    for (const a of b.agents) items.push({ kind: 'agent', line: table.rowLine(a), name: a.name });
  }
  if (items.length <= room) return { lines: items.map((i) => i.line), window: '' };
  const at = Math.max(
    0,
    items.findIndex((i) => i.name === md.selected),
  );
  const start = Math.min(Math.max(0, at - Math.floor(room / 2)), items.length - room);
  const shown = items.slice(start, start + room);
  const agentsShown = shown.filter((i) => i.kind === 'agent').length;
  return {
    lines: shown.map((i) => i.line),
    window: `${start > 0 ? g.up : ' '}${start + room < items.length ? g.down : ' '} ${agentsShown}/${md.agents.length}`,
  };
}

// ─────────────────────────────── détail agent ───────────────────────────────

const label = (_p: Painter, text: string): Seg => ({ text: padEnd(text, 9), tone: 'muted' });

function sessionLine(p: Painter, a: AgentRow): Line {
  const { m, g } = p;
  const line: Line = [
    label(p, m.watchUi.cockpit.detailSession),
    a.session?.state === 'running'
      ? { text: g.active, tone: 'ok' }
      : { text: g.idle, tone: 'muted' },
    { text: ` ${m.status.session(a.session ?? null)}` },
    {
      text: ` ${g.info} ${p.untrusted(m.common.mode(a.mode ?? 'attended', a.profile))}`,
      tone: 'muted',
    },
  ];
  if (a.sizeBytes != null)
    line.push({ text: ` ${g.info} ${m.units.bytes(a.sizeBytes)}`, tone: 'muted' });
  const idle = idleLabel(m, a.idle);
  if (idle) {
    line.push({
      text: ` ${g.info} ${idle}`,
      tone: a.idle && a.idle.stage !== 'idle' ? 'warn' : 'muted',
    });
  }
  return line;
}

function branchLine(p: Painter, a: AgentRow): Line {
  const { g, model: md } = p;
  return [
    label(p, p.m.watchUi.cockpit.detailBranch),
    { text: p.untrusted(a.branch) },
    { text: ` ${g.arrow} ${p.untrusted(md.targetBranch)}`, tone: 'muted' },
  ];
}

function commitsLines(p: Painter, a: AgentRow, d: DetailInfo | null, max: number): Line[] {
  const { m, g, model: md } = p;
  const c = m.watchUi.cockpit;
  const head: Line = [
    label(p, c.detailCommits),
    a.pendingCommits > 0
      ? { text: p.t(c.pendingCount(a.pendingCommits)), tone: 'accent' }
      : { text: p.t(c.pendingNone), tone: 'muted' },
  ];
  const lines: Line[] = [head];
  if (d?.error) {
    lines[0] = [
      label(p, c.detailCommits),
      { text: c.detailUnreadable(p.untrusted(d.error)), tone: 'error' },
    ];
    return lines;
  }
  if (!d || d.loading) {
    if (a.pendingCommits > 0)
      lines[0].push({ text: ` ${g.info} ${c.detailLoading}`, tone: 'muted' });
    return lines;
  }
  for (const commit of d.commits.slice(0, Math.max(0, max - 1))) {
    lines.push([
      { text: '          ' },
      { text: p.untrusted(commit.sha.slice(0, 7)), tone: 'code' },
      { text: ` ${padStart(ageText(m, commit.at, md.now, g.empty), 4)} `, tone: 'muted' },
      { text: p.untrusted(commit.subject) },
    ]);
  }
  const shownCommits = Math.min(d.commits.length, Math.max(0, max - 1));
  if (d.commitTotal > shownCommits && max > 1) {
    lines.push([
      { text: '          ' },
      { text: p.t(c.filesMore(d.commitTotal - shownCommits)), tone: 'muted' },
    ]);
  }
  return lines;
}

function filesLines(p: Painter, d: DetailInfo | null, max: number): Line[] {
  const { m, g } = p;
  const c = m.watchUi.cockpit;
  const head = label(p, c.detailFiles);
  if (!d || d.loading) return [[head, { text: c.detailLoading, tone: 'muted' }]];
  if (d.error) return [[head, { text: g.empty, tone: 'muted' }]];
  if (d.files.length === 0 && d.uncommitted === 0) {
    return [[head, { text: p.t(c.filesNone), tone: 'muted' }]];
  }
  const asLine = (prefix: Seg, files: DetailInfo['files']): Line => {
    const line: Line = [prefix];
    files.forEach((f, i) => {
      if (i > 0) line.push({ text: '  ' });
      line.push(
        { text: p.untrusted(f.path) },
        { text: ` ${p.untrusted(f.status)}`, tone: 'muted' },
      );
    });
    return line;
  };
  if (max <= 1) {
    const room = Math.max(1, Math.floor((p.cols - 12) / 24));
    const line = asLine(head, d.files.slice(0, room));
    if (d.fileTotal > room)
      line.push({ text: `  ${p.t(c.filesMore(d.fileTotal - room))}`, tone: 'muted' });
    if (d.uncommitted > 0)
      line.push({ text: `  ${g.info} ${p.t(c.uncommitted(d.uncommitted))}`, tone: 'warn' });
    return [line];
  }
  const lines: Line[] = [];
  d.files.slice(0, max).forEach((f, i) => {
    lines.push([
      i === 0 ? head : { text: ' '.repeat(9) },
      { text: padEnd(p.untrusted(f.status), 3), tone: 'muted' },
      { text: p.untrusted(f.path) },
    ]);
  });
  if (d.fileTotal > Math.min(d.files.length, max) && lines.length > 0) {
    lines[lines.length - 1].push({
      text: `  ${p.t(c.filesMore(d.fileTotal - Math.min(d.files.length, max)))}`,
      tone: 'muted',
    });
  }
  if (d.uncommitted > 0)
    lines.push([
      { text: ' '.repeat(9) },
      { text: p.t(c.uncommitted(d.uncommitted)), tone: 'warn' },
    ]);
  return lines;
}

function ticketLines(p: Painter, a: AgentRow): Line[] {
  const { m, g } = p;
  const c = m.watchUi.cockpit;
  if (!a.ticket) return [[label(p, c.detailTicket), { text: g.empty, tone: 'muted' }]];
  return [
    [
      label(p, c.detailTicket),
      {
        text: `${g.error} ${p.t(c.ticketLine(p.untrusted(a.ticket.id), p.untrusted(a.ticket.reason)))}`,
        tone: 'error',
        bold: true,
      },
      { text: `  ${g.arrow} `, tone: 'muted' },
      { text: `striart resolve --prepare ${p.untrusted(a.ticket.id)}`, tone: 'code' },
    ],
  ];
}

/** Contenu du détail, sur `count` lignes (priorité : ce qui demande une action d'abord). */
function detailContent(p: Painter, a: AgentRow | undefined, count: number): Line[] {
  const { m } = p;
  const c = m.watchUi.cockpit;
  if (!a) {
    // Aucun agent du tout : le panneau des agents l'a déjà dit (chargement, vide ou erreur).
    return p.model.agents.length === 0 ? [] : [[{ text: c.noSelection, tone: 'muted' }]];
  }
  const d = p.model.detail;
  let lines: Line[];
  if (count >= 6) {
    lines = [
      sessionLine(p, a),
      branchLine(p, a),
      ...commitsLines(p, a, d, 2),
      ...filesLines(p, d, 1),
      ...ticketLines(p, a),
    ];
  } else if (count >= 3) {
    const commitsHead = commitsLines(p, a, d, 1)[0];
    lines = a.ticket
      ? [ticketLines(p, a)[0], sessionLine(p, a), commitsHead]
      : [sessionLine(p, a), commitsHead, ...filesLines(p, d, 1)];
  } else {
    lines = [a.ticket ? ticketLines(p, a)[0] : sessionLine(p, a)];
  }
  return lines.slice(0, count);
}

// ─────────────────────────────── panneau du bas ───────────────────────────────

function journalLines(
  p: Painter,
  room: number,
  scroll: number,
): { lines: Line[]; scrolled: number } {
  const { model: md, m, g } = p;
  if (md.journal.length === 0) {
    return { lines: [[{ text: p.t(m.watchUi.cockpit.journalEmpty), tone: 'muted' }]], scrolled: 0 };
  }
  const all: Line[] = md.journal.map((e) => {
    const body: Line = [
      { text: p.untrusted(e.text), tone: e.tone === 'skip' ? 'muted' : undefined },
    ];
    if (e.continuation)
      return [
        { text: '         ' },
        { text: '  ' },
        ...body.map((s) => ({ ...s, tone: 'muted' as Tone })),
      ];
    return [
      { text: `${clock(e.at)} `, tone: 'muted' },
      { text: `${g[e.tone]} `, tone: e.tone },
      ...body,
    ];
  });
  const maxScroll = Math.max(0, all.length - room);
  const scrolled = Math.min(scroll, maxScroll);
  const end = all.length - scrolled;
  return { lines: all.slice(Math.max(0, end - room), end), scrolled };
}

function tailLines(
  source: Line[],
  room: number,
  scroll: number,
): { lines: Line[]; scrolled: number } {
  const maxScroll = Math.max(0, source.length - room);
  const scrolled = Math.min(scroll, maxScroll);
  const end = source.length - scrolled;
  return { lines: source.slice(Math.max(0, end - room), end), scrolled };
}

function paneTabs(p: Painter): Line {
  const { model: md, m } = p;
  const c = m.watchUi.cockpit;
  const tab = (text: string, active: boolean, unread: boolean): Line =>
    active
      ? [{ text: `[${text}]`, bold: true, tone: 'accent' }]
      : [{ text: ` ${text}${unread ? ` ${p.g.active}` : ''} `, tone: 'muted' }];
  return [
    ...tab(c.sectionJournal, md.bottom === 'journal', md.unread.journal),
    { text: ' ' },
    ...tab(c.sectionCommands, md.bottom === 'commands', md.unread.commands),
  ];
}

function scrolledHint(p: Painter, scrolled: number): Line {
  return scrolled > 0 ? [{ text: `${p.g.up} ${scrolled}`, tone: 'warn' }] : [];
}

function bottomPane(p: Painter, height: number): Line[] {
  const { model: md, m } = p;
  const room = Math.max(0, height - 1);
  let body: Line[];
  let scrolled = 0;
  if (md.bottom === 'journal') {
    ({ lines: body, scrolled } = journalLines(p, room, md.journalScroll));
  } else if (md.commandLines.every((l) => l.length === 0)) {
    body = [[{ text: p.t(m.watchUi.terminalEmpty), tone: 'muted' }]];
  } else {
    ({ lines: body, scrolled } = tailLines(md.commandLines, room, md.commandsScroll));
  }
  const out: Line[] = [ruleLine(p, paneTabs(p), scrolledHint(p, scrolled)), ...body];
  return out.slice(0, height);
}

// ─────────────────────────────── retour / saisie / touches ───────────────────────────────

function toastLine(p: Painter): Line {
  const { model: md, m, g } = p;
  const last = md.activity[md.activity.length - 1];
  // Un résultat s'efface après quelques secondes : le toast signale, il n'encombre pas.
  if (last && (last.endedAt === null || md.now - last.endedAt < TOAST_MS)) {
    const end = last.endedAt ?? md.now;
    const elapsed = `${((end - last.startedAt) / 1000).toFixed(1)}s`;
    const text = m.watchUi.cockpit.done(last.label, elapsed);
    const glyph =
      last.status === 'pending'
        ? g.spinner[Math.floor(md.now / 100) % g.spinner.length]
        : last.status === 'ok'
          ? g.ok
          : g.error;
    const tone: Tone = last.status === 'error' ? 'error' : last.status === 'ok' ? 'ok' : 'accent';
    const line: Line = [
      { text: `${glyph} `, tone },
      { text: p.untrusted(text), tone },
    ];
    if (last.detail) line.push({ text: ` ${g.info} ${p.untrusted(last.detail)}`, tone: 'muted' });
    return line;
  }
  if (md.refreshError !== null) {
    return [
      {
        text: `${g.warn} ${p.t(m.watchUi.refreshFailed(p.untrusted(md.refreshError)))}`,
        tone: 'warn',
      },
    ];
  }
  return [];
}

function inputLine(p: Painter): Line {
  const { model: md, m } = p;
  if (!md.input.focused) return [{ text: p.t(m.watchUi.cockpit.promptIdle), tone: 'muted' }];
  const { text, cursor } = md.input;
  const chars = [...text];
  const before = chars.slice(0, cursor).join('');
  const at = chars[cursor] ?? ' ';
  const after = chars.slice(cursor + 1).join('');
  const bare = !/^[/@!]/.test(text) && md.selected ? md.selected : null;
  const line: Line = [];
  if (bare) line.push({ text: `${p.untrusted(bare)} `, tone: 'muted' });
  line.push({ text: '> ', tone: 'accent', bold: true });
  line.push(
    { text: p.untrusted(before) },
    { text: p.untrusted(at) || ' ', inverse: true },
    { text: p.untrusted(after) },
  );
  return line;
}

interface HelpItem {
  key: string;
  text: string;
  prio: number;
}

function helpItems(p: Painter): HelpItem[] {
  const { model: md } = p;
  const k = p.m.watchUi.cockpit.keys;
  if (md.view === 'confirm') {
    return [
      { key: 'y', text: k.confirm, prio: 10 },
      { key: 'Échap', text: k.cancel, prio: 10 },
    ];
  }
  if (md.view === 'help')
    return [
      { key: 'Échap', text: k.close, prio: 10 },
      { key: 'q', text: k.quit, prio: 9 },
    ];
  if (md.input.focused) {
    return [
      { key: 'Entrée', text: k.send, prio: 10 },
      { key: 'Échap', text: k.cancel, prio: 10 },
      { key: '↑↓', text: k.history, prio: 6 },
      { key: 'Tab', text: k.complete, prio: 5 },
    ];
  }
  if (md.view === 'zoom') {
    return [
      { key: 'Échap', text: k.back, prio: 10 },
      { key: '↑↓', text: k.scroll, prio: 7 },
      { key: 'm', text: k.merge, prio: 8 },
      { key: 's', text: k.sync, prio: 6 },
      { key: '/', text: k.command, prio: 5 },
      { key: '?', text: k.help, prio: 9 },
      { key: 'q', text: k.quit, prio: 9 },
    ];
  }
  return [
    { key: '↑↓', text: k.select, prio: 9 },
    { key: 'Entrée', text: k.details, prio: 8 },
    { key: 'm', text: k.merge, prio: 7 },
    { key: 's', text: k.sync, prio: 6 },
    { key: '/', text: k.command, prio: 7 },
    { key: '@', text: k.message, prio: 6 },
    { key: '!', text: k.shell, prio: 3 },
    { key: 'Tab', text: k.pane, prio: 4 },
    { key: '?', text: k.help, prio: 10 },
    { key: 'q', text: k.quit, prio: 10 },
  ];
}

/** Barre de touches : les raccourcis de plus basse priorité tombent d'abord quand la largeur manque. */
function helpBar(p: Painter): Line {
  let items = helpItems(p);
  const render = (list: HelpItem[]): Line => {
    const line: Line = [];
    list.forEach((it, i) => {
      if (i > 0) line.push({ text: '  ' });
      line.push(p.keycap(it.key), { text: ` ${p.t(it.text)}` });
    });
    return line;
  };
  while (items.length > 1 && lineWidth(render(items)) > p.cols) {
    const lowest = Math.min(...items.map((i) => i.prio));
    const idx = items.map((i) => i.prio).lastIndexOf(lowest);
    items = items.filter((_, i) => i !== idx);
  }
  return render(items);
}

function suggestionLines(p: Painter, max: number): Line[] {
  const { model: md, g } = p;
  if (md.suggestions.length === 0 || max <= 0) return [];
  const start = Math.min(
    Math.max(0, md.activeSuggestion - Math.floor(max / 2)),
    Math.max(0, md.suggestions.length - max),
  );
  return md.suggestions.slice(start, start + max).map((s, i) => {
    const active = start + i === md.activeSuggestion;
    const prefix = s.kind === 'agent' ? '@' : '/';
    const line: Line = [
      {
        text: `${active ? g.select : ' '} ${prefix}${p.untrusted(s.value)}`,
        inverse: active,
        bold: active,
      },
      { text: `  ${p.untrusted(p.t(s.description))}`, tone: 'muted' },
    ];
    return line;
  });
}

// ─────────────────────────────── vues complètes ───────────────────────────────

function emptyAgentsPanel(p: Painter, room: number): Line[] {
  const { m } = p;
  const c = m.watchUi.cockpit;
  const lines: Line[] = [];
  if (!p.model.loaded && p.model.refreshError === null) {
    lines.push([{ text: m.watchUi.loading, tone: 'muted' }]);
  } else if (p.model.refreshError !== null && !p.model.loaded) {
    lines.push([
      {
        text: `${p.g.error} ${p.t(m.watchUi.refreshFailed(p.untrusted(p.model.refreshError)))}`,
        tone: 'error',
      },
    ]);
  } else {
    lines.push([{ text: c.emptyTitle }]);
    lines.push([{ text: p.t(c.emptyHint), tone: 'code' }]);
  }
  return lines.slice(0, room);
}

function confirmPanel(p: Painter, height: number): Line[] {
  const cf = p.model.confirm;
  const { g } = p;
  if (!cf) return [];
  const lines: Line[] = [
    ruleLine(p, [{ text: `${g.warn} ${p.t(p.untrusted(cf.title))}`, tone: 'warn', bold: true }]),
    // Retour à la ligne aux espaces : une conséquence tronquée n'est pas une conséquence expliquée.
    ...cf.lines.flatMap((t) =>
      wrapWords(p.t(p.untrusted(t)), Math.max(20, p.cols - 4)).map((part): Line => [
        { text: `  ${part}` },
      ]),
    ),
    [],
    [
      { text: '  ' },
      p.keycap('y'),
      { text: ` ${p.m.watchUi.cockpit.keys.confirm}   ` },
      p.keycap('Échap'),
      { text: ` ${p.m.watchUi.cockpit.keys.cancel}` },
    ],
  ];
  return lines.slice(0, height);
}

function helpPage(p: Painter, height: number): Line[] {
  const c = p.m.watchUi.cockpit;
  const lines: Line[] = [ruleLine(p, [{ text: p.t(c.helpTitle), bold: true, tone: 'accent' }])];
  for (const section of c.helpSections) {
    lines.push([{ text: p.t(section.title), bold: true }]);
    for (const [key, desc] of section.rows) {
      lines.push([
        { text: '  ' },
        { text: padEnd(p.t(key), 12), tone: 'accent', bold: true },
        { text: p.t(desc) },
      ]);
    }
  }
  return lines.slice(0, height);
}

function zoomView(p: Painter, height: number): Line[] {
  const { model: md, m, g } = p;
  const c = m.watchUi.cockpit;
  const a = md.agents.find((x) => x.name === md.selected);
  const lines: Line[] = [
    ruleLine(p, [
      { text: p.t(c.sectionDetail(a ? p.untrusted(a.name) : g.empty)), bold: true, tone: 'accent' },
    ]),
  ];
  if (a) {
    const budget = Math.max(6, Math.min(16, Math.floor(height * 0.5)));
    const fixed = [sessionLine(p, a), branchLine(p, a), ...ticketLines(p, a)];
    const rest = Math.max(2, budget - fixed.length);
    const commitRoom = Math.max(1, Math.floor(rest / 2));
    lines.push(...fixed);
    const commits = commitsLines(p, a, md.detail, commitRoom + 1);
    lines.push(...commits);
    lines.push(...filesLines(p, md.detail, Math.max(1, rest - commits.length)));
  } else {
    lines.push([{ text: c.noSelection, tone: 'muted' }]);
  }
  const outRoom = Math.max(0, height - lines.length - 1);
  lines.push(
    ruleLine(
      p,
      [
        {
          text: p.t(c.sectionOutput(a ? p.untrusted(a.name) : g.empty)),
          bold: true,
          tone: 'accent',
        },
      ],
      md.outputConnected
        ? md.idleTool
          ? [{ text: p.t(m.watchUi.idleTool), tone: 'warn' as Tone }]
          : []
        : [{ text: p.t(c.outputDisconnected), tone: 'warn' as Tone }],
    ),
  );
  let body: Line[];
  let scrolled = 0;
  if (md.outputLines.length === 0) {
    body = [[{ text: a?.mode === 'autonomous' ? c.outputEmpty : g.empty, tone: 'muted' }]];
  } else {
    ({ lines: body, scrolled } = tailLines(md.outputLines, outRoom, md.outputScroll));
  }
  if (scrolled > 0)
    lines[lines.length - 1] = ruleLine(
      p,
      [
        {
          text: p.t(c.sectionOutput(a ? p.untrusted(a.name) : g.empty)),
          bold: true,
          tone: 'accent',
        },
      ],
      scrolledHint(p, scrolled),
    );
  lines.push(...body.slice(0, outRoom));
  return lines.slice(0, height);
}

/** Budget vertical de la vue principale. Exporté pour les tests de mise en page. */
export function allocate(rows: number, suggestions: number, agentItemsWanted: number) {
  // en-tête + chiffres + titre agents + en-têtes colonnes + retour + saisie + touches
  const fixed = 7;
  const free = Math.max(0, rows - fixed - suggestions);
  const detailContent = free >= 22 ? 6 : free >= 12 ? 3 : 1;
  const detail = 1 + detailContent;
  const bottomMin = 4;
  const agents = Math.max(1, Math.min(agentItemsWanted, free - detail - bottomMin));
  const bottom = Math.max(2, free - detail - agents);
  return { detailContent, detail, agents, bottom };
}

/** Trame complète : exactement `rows` lignes, aucune plus large que `cols`. */
export function buildFrame(model: FrameModel, ctx: ViewCtx): Line[] {
  const p = new Painter(model, ctx);
  const { m } = p;
  const c = m.watchUi.cockpit;
  const { cols, rows } = model;

  let lines: Line[];
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    lines = [
      [{ text: c.appName, bold: true, tone: 'accent' }],
      [{ text: p.t(c.terminalSmall(cols, rows)), tone: 'warn' }],
    ];
    return finish(p, [...padTo(lines, rows - 1), helpBar(p)], rows);
  }

  const header = headerLine(p);
  const footer: Line[] = [];
  const sug = model.input.focused ? suggestionLines(p, Math.min(5, Math.max(0, rows - 14))) : [];
  footer.push(toastLine(p), ...sug, inputLine(p), helpBar(p));

  if (model.view === 'help') {
    const body = helpPage(p, rows - 2);
    lines = [header, ...padTo(body, rows - 2), footer[footer.length - 1]];
    return finish(p, lines, rows);
  }
  if (model.view === 'zoom') {
    const body = zoomView(p, rows - 1 - footer.length);
    lines = [header, ...padTo(body, rows - 1 - footer.length), ...footer];
    return finish(p, lines, rows);
  }

  const ordered = displayOrder(model.agents, m.status.stateTicket);
  const groupsCount = groupAgents(model.agents, m.status.stateTicket).length;
  const budget = allocate(rows, sug.length, Math.max(2, ordered.length + groupsCount));
  const agentRoom = budget.agents;

  const body: Line[] = [];
  if (model.agents.length === 0) {
    body.push(ruleLine(p, [{ text: c.sectionAgents, bold: true, tone: 'accent' }]));
    body.push([]);
    body.push(...padTo(emptyAgentsPanel(p, agentRoom), agentRoom));
  } else {
    const table = buildAgentTable(p, ordered);
    const { lines: rowsLines, window } = agentItems(p, table, agentRoom);
    body.push(
      ruleLine(
        p,
        [
          { text: c.sectionAgents, bold: true, tone: 'accent' },
          { text: ` (${model.agents.length})`, tone: 'muted' },
        ],
        window ? [{ text: window, tone: 'muted' }] : [],
      ),
    );
    body.push(table.header);
    body.push(...padTo(rowsLines, agentRoom));
  }

  if (model.view === 'confirm') {
    const confirmH = rows - 2 - body.length - footer.length;
    body.push(...padTo(confirmPanel(p, confirmH), confirmH));
  } else {
    const sel = model.agents.find((a) => a.name === model.selected);
    body.push(
      ruleLine(p, [
        {
          text: p.t(c.sectionDetail(sel ? p.untrusted(sel.name) : p.g.empty)),
          bold: true,
          tone: 'accent',
        },
      ]),
    );
    body.push(...padTo(detailContent(p, sel, budget.detailContent), budget.detailContent));
    const bottomH = rows - 2 - body.length - footer.length;
    body.push(...padTo(bottomPane(p, bottomH), bottomH));
  }
  lines = [header, kpiLine(p), ...body, ...footer];
  return finish(p, lines, rows);
}

function padTo(lines: Line[], height: number): Line[] {
  if (height <= 0) return [];
  const cut = lines.slice(0, height);
  while (cut.length < height) cut.push([]);
  return cut;
}

/** Calibre : `rows` lignes exactement, chacune coupée à `cols` colonnes. */
function finish(p: Painter, lines: Line[], rows: number): Line[] {
  const kept = lines.slice(0, rows);
  // Le pied de page (touches) doit rester la DERNIÈRE ligne : s'il a été coupé, on le replace.
  const out = kept.map((l) => fitLine(l, p.cols, p.g.ellipsis));
  while (out.length < rows) out.push([]);
  return out;
}
