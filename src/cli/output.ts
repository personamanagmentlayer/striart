/**
 * Sortie de la CLI (couche L2) : tout ce qui s'écrit sur le terminal passe
 * par ici, jamais par `console.*` dans les commandes.
 *
 * Discipline de flux :
 *  - stdout = les DONNÉES de la commande (résultat humain, ou un document
 *    `--json`, ou des événements ndjson) ;
 *  - stderr = progression, avertissements, erreurs, logs.
 * Ainsi `striart status | grep agent-a` ou `striart merge a --json | jq`
 * ne voient jamais une ligne de progression.
 *
 * Accessibilité : le niveau d'une ligne est toujours porté par un MOT
 * (« ok », « attention », « erreur »), le glyphe et la couleur ne font que le
 * doubler — lisible au lecteur d'écran, en daltonisme, en log CI.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import type { Capabilities, ThemeName } from './caps.ts';
import type { Messages } from './i18n/index.ts';
import { displayWidth, padEnd, sanitize, truncate } from './text.ts';

export type Level = 'ok' | 'info' | 'warn' | 'error' | 'skip';

type StyleFormat = Parameters<typeof styleText>[0];

const THEMES: Record<ThemeName, Record<Level | 'accent' | 'muted' | 'code', StyleFormat>> = {
  // Les 16 couleurs nommées suivent le thème du terminal (clair ou sombre) :
  // c'est le terminal qui garantit le contraste, pas une couleur fixe.
  default: {
    ok: 'green',
    info: 'reset',
    warn: 'yellow',
    error: ['red', 'bold'],
    skip: 'dim',
    accent: 'cyan',
    muted: 'dim',
    code: 'cyan',
  },
  // Jamais de paire rouge/vert : bleu pour le succès, magenta pour l'erreur.
  colorblind: {
    ok: 'blue',
    info: 'reset',
    warn: 'yellow',
    error: ['magenta', 'bold'],
    skip: 'dim',
    accent: 'blue',
    muted: 'dim',
    code: 'blue',
  },
  // Aucune teinte : uniquement gras / atténué / souligné.
  mono: {
    ok: 'bold',
    info: 'reset',
    warn: 'underline',
    error: 'bold',
    skip: 'dim',
    accent: 'bold',
    muted: 'dim',
    code: 'underline',
  },
};

const GLYPHS = {
  unicode: {
    ok: '✓',
    info: '·',
    warn: '!',
    error: '✗',
    skip: '–',
    arrow: '→',
    ellipsis: '…',
    empty: '—',
    tree: '└─',
  },
  ascii: {
    ok: '+',
    info: '-',
    warn: '!',
    error: 'x',
    skip: '-',
    arrow: '->',
    ellipsis: '...',
    empty: '-',
    tree: '`-',
  },
};

export type Glyphs = typeof GLYPHS.unicode;

export interface WritableLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface Column<Row> {
  key: string;
  header: string;
  value: (row: Row) => string;
  /** Plus la priorité est haute, plus la colonne résiste au manque de largeur (défaut 1). */
  priority?: number;
  /** Colonne compressible (ellipse) jusqu'à `min` colonnes, plutôt que retirée. */
  shrink?: { min: number };
  /** Style appliqué APRÈS calcul de largeur (jamais compté dans la largeur). */
  style?: (text: string, row: Row) => string;
}

export interface OutputOptions {
  caps: Capabilities;
  messages: Messages;
  stdout: WritableLike;
  stderr: WritableLike;
  /** `--quiet` : supprime la progression (jamais les erreurs ni les données). */
  quiet: boolean;
  /** `--json` : aucune sortie humaine sur stdout, progression muette. */
  json: boolean;
}

export class Output {
  readonly caps: Capabilities;
  readonly m: Messages;
  readonly glyphs: Glyphs;
  readonly json: boolean;
  private readonly stdout: WritableLike;
  private readonly stderr: WritableLike;
  private readonly quiet: boolean;
  private readonly theme: (typeof THEMES)[ThemeName];
  /** Racine du dépôt, pour afficher les chemins en relatif (renseignée dès qu'elle est connue). */
  root: string | null = null;
  private spinner: { timer: NodeJS.Timeout; text: string; startedAt: number } | null = null;

  constructor(options: OutputOptions) {
    this.caps = options.caps;
    this.m = options.messages;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.quiet = options.quiet;
    this.json = options.json;
    this.glyphs = options.caps.unicode ? GLYPHS.unicode : GLYPHS.ascii;
    this.theme = THEMES[options.caps.theme];
  }

  // ---------------------------------------------------------------- style

  private paint(format: StyleFormat, text: string, color: boolean): string {
    // 'reset' = aucun style : ne rien émettre plutôt que des séquences inutiles.
    if (!color || text === '' || format === 'reset') return text;
    return styleText(format, text, { validateStream: false });
  }

  /** Style pour stdout. */
  style(kind: Level | 'accent' | 'muted' | 'code', text: string): string {
    return this.paint(this.theme[kind], text, this.caps.colorStdout);
  }

  private styleErr(kind: Level | 'accent' | 'muted' | 'code', text: string): string {
    return this.paint(this.theme[kind], text, this.caps.colorStderr);
  }

  /** Commande ou valeur à recopier (mise en évidence, jamais entre guillemets typographiques). */
  code(text: string): string {
    return this.style('code', text);
  }

  // --------------------------------------------------------------- valeurs

  /** Texte non fiable (commit d'agent, sortie git, raison libre) : neutralisé. */
  untrusted(text: string | null | undefined): string {
    return text ? sanitize(text) : '';
  }

  /**
   * Chemin affiché relatif à la racine du dépôt quand il est dedans
   * (`.striart/conflicts/agent-a-f72c`), cliquable si le terminal sait le
   * faire. L'absolu reste dans `--json`.
   */
  path(absolute: string, stream: 'stdout' | 'stderr' = 'stdout'): string {
    const shown =
      this.root && isInside(this.root, absolute)
        ? path.relative(this.root, absolute) || '.'
        : absolute;
    const text = sanitize(shown);
    const allowLink =
      this.caps.hyperlinks && (stream === 'stdout' ? this.caps.stdoutIsTTY : this.caps.stderrIsTTY);
    if (!allowLink) return text;
    return `\u001B]8;;${pathToFileURL(absolute).href}\u0007${text}\u001B]8;;\u0007`;
  }

  sha(sha: string | null | undefined): string {
    return sha ? sha.slice(0, 8) : this.glyphs.empty;
  }

  /** Date locale lisible (AAAA-MM-JJ HH:MM), stable entre machines. */
  date(iso: string | null | undefined): string {
    if (!iso) return this.glyphs.empty;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return sanitize(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Durée relative courte (« 12 min », « 3 h »), pour un état vivant. */
  since(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return this.glyphs.empty;
    const ms = now - Date.parse(iso);
    return Number.isFinite(ms) ? this.m.units.duration(Math.max(0, ms)) : this.glyphs.empty;
  }

  duration(ms: number): string {
    return this.m.units.duration(ms);
  }

  bytes(n: number): string {
    return this.m.units.bytes(n);
  }

  // ---------------------------------------------------------------- stdout

  /** Ligne brute de données (déjà composée). */
  print(text = ''): void {
    if (this.json) return;
    this.stdout.write(`${text}\n`);
  }

  /** Ligne de statut : glyphe + MOT de niveau + message, puis la piste éventuelle. */
  line(level: Level, message: string, hint?: string | null): void {
    if (this.json) return;
    this.stdout.write(`${this.formatLine(level, message, 'stdout')}\n`);
    if (hint) this.stdout.write(`${this.formatHint(hint, 'stdout')}\n`);
  }

  /** Détail rattaché à la ligne précédente (indenté). */
  detail(text: string): void {
    this.print(`  ${text}`);
  }

  /** Commande suggérée, à part, prête à copier. */
  hint(hint: string): void {
    if (this.json) return;
    this.stdout.write(`${this.formatHint(hint, 'stdout')}\n`);
  }

  heading(text: string): void {
    this.print(this.style('accent', text));
  }

  /**
   * Tableau aligné. Hors terminal (largeur inconnue) : jamais tronqué. Dans
   * un terminal trop étroit : les colonnes de plus basse priorité tombent
   * d'abord, puis les colonnes compressibles prennent une ellipse.
   */
  table<Row>(columns: Column<Row>[], rows: Row[]): void {
    if (this.json || rows.length === 0) return;
    const cells = rows.map((row) =>
      columns.map((c) => sanitize(c.value(row)) || this.glyphs.empty),
    );
    let visible = columns.map((_, i) => i);
    const natural = columns.map((c, i) =>
      Math.max(displayWidth(c.header), ...cells.map((r) => displayWidth(r[i]))),
    );
    const widths = [...natural];
    const gap = 2;
    const total = () => visible.reduce((sum, i) => sum + widths[i], 0) + gap * (visible.length - 1);
    const limit = this.caps.columns;
    if (limit !== null) {
      // Les colonnes sont sacrifiées de la MOINS importante à la plus
      // importante : chacune est d'abord compressée (si elle l'accepte),
      // puis retirée si ça ne suffit pas. Une colonne secondaire disparaît
      // donc avant qu'une colonne importante ne soit tronquée. La première
      // colonne (l'identifiant de la ligne) n'est jamais retirée.
      const byPriority = [...visible]
        .slice(1)
        .sort((a, b) => (columns[a].priority ?? 1) - (columns[b].priority ?? 1));
      for (const i of byPriority) {
        if (total() <= limit) break;
        const shrink = columns[i].shrink;
        if (shrink) widths[i] = Math.max(shrink.min, widths[i] - (total() - limit));
        if (total() > limit) visible = visible.filter((v) => v !== i);
      }
    }
    const header = visible
      .map((i, n) => {
        const text = truncate(columns[i].header, widths[i], this.glyphs.ellipsis);
        return n === visible.length - 1 ? text : padEnd(text, widths[i]);
      })
      .join(' '.repeat(gap));
    this.print(this.style('muted', header));
    rows.forEach((row, r) => {
      const line = visible
        .map((i, n) => {
          const text = truncate(cells[r][i], widths[i], this.glyphs.ellipsis);
          const styled = columns[i].style ? columns[i].style(text, row) : text;
          // Pas d'espaces de fin de ligne : la dernière colonne n'est pas complétée.
          return n === visible.length - 1
            ? styled
            : styled + ' '.repeat(widths[i] - displayWidth(text));
        })
        .join(' '.repeat(gap));
      this.print(line);
    });
  }

  // ---------------------------------------------------------------- stderr

  /** Avertissement non bloquant (stderr), jamais mélangé aux données. */
  /**
   * Avertissement et erreur reçoivent du texte BRUT (jamais stylé), qui peut
   * intégrer une valeur externe (sortie de git, nom de fichier, message du
   * domaine) : neutralisé ici, une fois pour tous les appelants.
   */
  warn(message: string, hint?: string | null): void {
    this.clearSpinner();
    this.stderr.write(`${this.formatLine('warn', sanitize(message), 'stderr')}\n`);
    if (hint) this.stderr.write(`${this.formatHint(hint, 'stderr')}\n`);
  }

  /** Erreur (stderr). */
  error(message: string, hint?: string | null, code?: string | null): void {
    this.clearSpinner();
    const suffix = code ? ` ${this.styleErr('muted', `(${code})`)}` : '';
    this.stderr.write(`${this.formatLine('error', sanitize(message), 'stderr')}${suffix}\n`);
    if (hint) this.stderr.write(`${this.formatHint(hint, 'stderr')}\n`);
  }

  /** Étape de progression (stderr) : muette en `--json` et `--quiet`. */
  step(message: string): void {
    if (this.json || this.quiet) return;
    this.clearSpinner();
    this.stderr.write(`${this.styleErr('muted', `${this.glyphs.ellipsis} ${message}`)}\n`);
  }

  /**
   * Opération longue : spinner animé + temps écoulé sur un terminal, une
   * ligne d'étape sinon, et barre de progression indéterminée dans la barre
   * des tâches (Windows Terminal). Toujours nettoyé, même en cas d'erreur.
   */
  async task<T>(message: string, work: () => Promise<T>): Promise<T> {
    if (this.json || this.quiet || !this.caps.animate) {
      this.step(message);
      return work();
    }
    this.startSpinner(message);
    try {
      return await work();
    } finally {
      this.clearSpinner();
    }
  }

  private startSpinner(text: string): void {
    const frames = this.caps.unicode
      ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      : ['-', '\\', '|', '/'];
    let frame = 0;
    const startedAt = Date.now();
    if (this.caps.taskbarProgress) this.stderr.write('\u001B]9;4;3;0\u0007');
    const render = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const clock =
        elapsed >= 2
          ? ` ${this.styleErr('muted', `(${this.m.units.duration(elapsed * 1000)})`)}`
          : '';
      this.stderr.write(`\r\u001B[2K${this.styleErr('accent', frames[frame])} ${text}${clock}`);
      frame = (frame + 1) % frames.length;
    };
    render();
    const timer = setInterval(render, 80);
    timer.unref();
    this.spinner = { timer, text, startedAt };
  }

  private clearSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner.timer);
    this.stderr.write('\r\u001B[2K');
    if (this.caps.taskbarProgress) this.stderr.write('\u001B]9;4;0;0\u0007');
    this.spinner = null;
  }

  /**
   * Efface la ligne du spinner sans l'arrêter (un log va s'écrire) : il se
   * redessine sous le log au tick suivant.
   */
  clearSpinnerLine(): void {
    if (this.spinner) this.stderr.write('\r\u001B[2K');
  }

  /** À appeler avant toute sortie brutale (signal) : remet le terminal propre. */
  dispose(): void {
    this.clearSpinner();
  }

  // ------------------------------------------------------------ formatage

  private formatLine(level: Level, message: string, stream: 'stdout' | 'stderr'): string {
    const paint = stream === 'stdout' ? this.style.bind(this) : this.styleErr.bind(this);
    if (this.caps.plain) return `[${this.m.levels[level]}] ${message}`;
    return `${paint(level, `${this.glyphs[level]} ${this.m.levels[level]}`)}${this.m.levelSeparator}${message}`;
  }

  private formatHint(hint: string, stream: 'stdout' | 'stderr'): string {
    const paint = stream === 'stdout' ? this.style.bind(this) : this.styleErr.bind(this);
    // Une piste contient des valeurs du registre ou de la config (chemin,
    // commande d'outil) : neutralisée comme tout texte non fiable.
    return `  ${paint('muted', this.glyphs.arrow)} ${paint('code', sanitize(hint))}`;
  }

  // ------------------------------------------------------------- machine

  /** Un document JSON unique, sur une ligne (contrat `--json`). */
  document(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value, jsonReplacer)}\n`);
  }

  /** Un événement d'un flux ndjson (`watch --json`, `dashboard --json`). */
  event(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value, jsonReplacer)}\n`);
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Les `Error` imbriquées deviennent `{message, code}` (jamais de pile dans un document). */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { message: value.message, ...(typeof code === 'string' ? { code } : {}) };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
