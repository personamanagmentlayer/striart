/**
 * `striart watch --ui --plain` (et `TERM=dumb`) : le cockpit en MODE LINÉAIRE.
 *
 * Pas d'écran plein, pas de repeinture, pas de couleur ni de glyphe : un flux
 * de lignes horodatées qui ne fait que s'allonger — ce qu'un lecteur d'écran,
 * une plage braille, un terminal anachronique ou un journal de CI savent lire.
 * Même vocabulaire que le cockpit (mêmes états, mêmes niveaux en toutes
 * lettres `[erreur]`), mêmes actions (même code que la CLI), mêmes garde-fous
 * (le merge exige une confirmation explicite `y`).
 *
 * Écran = stdout (les données de la commande) ; la saisie vient de stdin.
 */
import readline from 'node:readline';
import { listAgents } from './clone.js';
import { listConflictTickets } from './conflicts.js';
import { loadConfig } from './config.js';
import { Output } from './cli/output.ts';
import { agentStateView, stateGlyphChar } from './cli/render/agents.ts';
import { createIdleCellsProvider } from './idle/status.ts';
import type { IdleCell } from './idle/status.ts';
import { idleLabel } from './watch-ui-view.ts';
import type { Messages } from './cli/i18n/fr.ts';
import type { Capabilities } from './cli/caps.ts';
import { asciiStatic } from './cli/render/ascii.ts';
import { sanitize } from './cli/text.ts';
import {
  parseAgentMessage,
  resolveAgentMeta,
  routeAgentMessage,
  runShellCommand,
  runStriartCommand,
  tokenizeCommand,
} from './watch-ui.ts';
import type { WatchLineSubscription } from './watch-ui.ts';
import type { AgentMeta } from './types.js';

const REFRESH_MS = 5000;

const ANSI_SEQUENCES = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
const stripAnsi = (text: string): string => text.replace(ANSI_SEQUENCES, '');

function clock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function runWatchPlain(
  root: string,
  options: {
    subscribeLoop?: WatchLineSubscription;
    messages: Messages;
    signal?: AbortSignal;
    caps: Pick<Capabilities, 'unicode' | 'colorStdout' | 'plain' | 'theme' | 'animate'>;
    autoMerge: boolean;
    /** Flux d'E/S (tests) ; défaut = le vrai terminal. */
    io?: {
      stdin: NodeJS.ReadableStream & { isTTY?: boolean };
      stdout: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
    };
  },
): Promise<void> {
  const { subscribeLoop, messages: m, signal, caps, autoMerge } = options;
  const stdin = options.io?.stdin ?? process.stdin;
  const stdout = options.io?.stdout ?? process.stdout;
  const c = m.watchUi.cockpit;
  const out = new Output({
    caps: {
      stdoutIsTTY: Boolean(stdout.isTTY),
      stderrIsTTY: Boolean(process.stderr.isTTY),
      stdinIsTTY: Boolean(stdin.isTTY),
      colorStdout: false,
      colorStderr: false,
      unicode: false,
      columns: stdout.columns ?? null,
      hyperlinks: false,
      taskbarProgress: false,
      animate: false,
      plain: true,
      ci: false,
      theme: caps.theme,
    },
    messages: m,
    stdout,
    stderr: process.stderr,
    quiet: false,
    json: false,
  });
  out.root = root;
  /** Textes statiques localisés : ASCII pur (lecteur d'écran, plage braille, console ancienne). */
  const T = asciiStatic;
  const say = (level: 'ok' | 'info' | 'warn' | 'error' | 'skip', text: string) =>
    out.print(`${clock()} [${m.levels[level]}] ${sanitize(text)}`);

  let targetBranch = 'main';
  try {
    targetBranch = (await loadConfig(root)).targetBranch ?? 'main';
  } catch {
    // Config illisible : la lecture des agents le dira juste en dessous.
  }
  out.print(
    T(
      `${c.appName} - ${c.watcherOn} (${autoMerge ? c.watcherMerge : c.watcherNoMerge}) - ${targetBranch} - ${sanitize(root)}`,
    ),
  );
  out.print(T(c.promptIdle));
  out.print(T(c.plainKeys));

  // ── instantané des agents, ré-affiché seulement quand il change ──
  const idleProvider = createIdleCellsProvider(root);
  let metas: Array<AgentMeta & { name: string; status: string }> = [];
  let lastSignature = '';
  const snapshot = async () => {
    try {
      const list = await listAgents(root);
      metas = list;
      const tickets = (await listConflictTickets(root).catch(() => [])) as Array<{
        agent?: string;
        id: string;
      }>;
      const ticketed = new Set(tickets.map((t) => t.agent).filter(Boolean));
      const idleByAgent = await idleProvider(list).catch(() => new Map<string, IdleCell>());
      const rows = list.map((a) => {
        const view = agentStateView(a, ticketed.has(a.name), m.status.stateTicket);
        const pending = (a as { pendingCommits?: number }).pendingCommits ?? 0;
        return { a, view, pending, idle: idleLabel(m, idleByAgent.get(a.name)) };
      });
      const signature = JSON.stringify(
        rows.map((r) => [r.a.name, r.view.label, r.pending, r.idle]),
      );
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (rows.length === 0) {
        say('info', T(`${c.emptyTitle} ${c.emptyHint}`));
        return;
      }
      say(
        tickets.length > 0 ? 'error' : 'info',
        T(`${c.kpiAgents} ${rows.length}, ${c.kpiConflicts} ${tickets.length}`),
      );
      out.table(
        [
          {
            key: 'agent',
            header: c.colAgent,
            value: (r: (typeof rows)[number]) => r.a.name,
            priority: 10,
          },
          {
            key: 'state',
            header: c.colState,
            value: (r) =>
              `${stateGlyphChar(out.glyphs, r.view.glyph)} ${r.view.label}${r.idle ? ` (${r.idle})` : ''}`,
            priority: 9,
          },
          { key: 'pending', header: c.colCommits, value: (r) => String(r.pending), priority: 8 },
          {
            key: 'last',
            header: c.colLast,
            value: (r) =>
              String((r.a as { lastMessage?: string }).lastMessage ?? '').split('\n')[0],
            priority: 5,
            shrink: { min: 14 },
          },
        ],
        rows,
      );
    } catch (error) {
      say('warn', T(m.watchUi.refreshFailed((error as Error).message)));
    }
  };
  await snapshot();
  const interval = setInterval(() => void snapshot(), REFRESH_MS);

  const unsubscribe = subscribeLoop?.((entry) => {
    out.print(
      `${entry.continuation ? '         ' : `${clock()} [${m.levels[entry.tone]}] `}${sanitize(entry.text)}`,
    );
  });

  // ── saisie : une ligne = une intention ──
  const rl = readline.createInterface({ input: stdin, terminal: false });
  let pendingMerge: string | null = null;
  let selected: string | null = null;
  const finished = new Promise<void>((resolve) => {
    rl.on('close', resolve);
    signal?.addEventListener('abort', () => rl.close(), { once: true });
  });

  const runCli = async (label: string, argv: string[]) => {
    say('info', label);
    const result = await runStriartCommand(root, argv, m);
    for (const line of stripAnsi(result.output).split(/\r?\n/)) {
      if (line.trim() !== '') out.print(`  ${sanitize(line)}`);
    }
    say(result.ok ? 'ok' : 'error', label);
    void snapshot();
  };

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return;
    void (async () => {
      if (pendingMerge) {
        const agent = pendingMerge;
        pendingMerge = null;
        if (line === 'y' || line === 'Y') await runCli(c.merging(agent), ['merge', agent]);
        else say('info', T(c.cancelled));
        return;
      }
      if (line === 'q' || line === '/exit') {
        rl.close();
        return;
      }
      if (line === '?' || line === 'help') {
        for (const section of c.helpSections) {
          out.print(T(section.title));
          for (const [key, desc] of section.rows) out.print(T(`  ${key}  ${desc}`));
        }
        return;
      }
      const [first, second] = line.split(/\s+/);
      if ((first === 'm' || first === 's') && (second || selected)) {
        const agent = second ?? selected!;
        selected = agent;
        if (first === 's') {
          await runCli(c.syncing(agent), ['sync', agent]);
          return;
        }
        const row = metas.find((a) => a.name === agent);
        const pending = (row as { pendingCommits?: number } | undefined)?.pendingCommits ?? 0;
        out.print(T(c.confirmMergeTitle(agent, targetBranch)));
        out.print(T(`  ${pending > 0 ? c.confirmMergePending(pending) : c.confirmMergeNone}`));
        out.print(T(`  ${c.confirmMergeGate}`));
        out.print(T(`  ${c.plainConfirm}`));
        pendingMerge = agent;
        return;
      }
      if (line.startsWith('!')) {
        const result = await runShellCommand(root, line.slice(1).trim());
        for (const l of result.output.split(/\r?\n/))
          if (l.trim() !== '') out.print(`  ${sanitize(l)}`);
        say(result.ok ? 'ok' : 'error', line);
        return;
      }
      if (line.startsWith('/')) {
        const tokens = tokenizeCommand(line.slice(1));
        if (tokens.length > 0) await runCli(`striart ${tokens.join(' ')}`, tokens);
        return;
      }
      const parsed = line.startsWith('@') ? parseAgentMessage(line) : null;
      const target = parsed?.agent ?? selected ?? metas[0]?.name;
      const text = parsed?.text ?? (line.startsWith('@') ? null : line);
      if (!target || !text) return;
      selected = target;
      const meta = await resolveAgentMeta(root, metas, target);
      const result = await routeAgentMessage(root, target, text, meta, m);
      if ('reason' in result) say('error', result.reason);
      else say('ok', m.watchUi.sending(target));
    })();
  });

  try {
    await finished;
  } finally {
    clearInterval(interval);
    unsubscribe?.();
    rl.close();
  }
}
