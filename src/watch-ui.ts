import React from 'react';
import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink';
import xtermHeadless from '@xterm/headless';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { cloneGit, listAgents } from './clone.ts';
import { loadConfig } from './config.ts';
import { listConflictTickets } from './conflicts.ts';
import { createIdleCellsProvider } from './idle/status.ts';
import type { IdleCell } from './idle/status.ts';
import { getQueueDashboard } from './orchestrator.ts';
import { connectAttachClient } from './pty-attach.ts';
import { defaultShell, ensurePtyHost, resolveAttendedCommand } from './pty-host.ts';
import { sendHumanPrompt } from './acp/host.ts';
import type { AgentMeta } from './types.js';
import { fr } from './cli/i18n/fr.ts';
import type { Messages } from './cli/i18n/fr.ts';
import { publicCommands } from './cli/registry.ts';
import type { ForegroundReason } from './cli/registry.ts';
import { detectCapabilities } from './cli/caps.ts';
import type { Capabilities } from './cli/caps.ts';
import type { Level } from './cli/output.ts';
import { inkStyleForTone } from './cli/render/tone.ts';
import { editInput, moveSelection, navAction, PAGE_SIZE } from './watch-ui-keys.ts';
import type { InputBuffer } from './watch-ui-keys.ts';
import { buildFrame, displayOrder } from './watch-ui-view.ts';
import type {
  ActivityView,
  AgentRow,
  BottomPane,
  ConfirmView,
  DetailInfo,
  FrameModel,
  JournalEntry,
  Line,
  Seg,
  ViewKind,
} from './watch-ui-view.ts';
import type { IBufferCell, IBufferLine, Terminal as HeadlessTerminal } from '@xterm/headless';

// `@xterm/headless` s'exporte en CommonJS (pas d'`exports` ESM) — Node ne
// peut pas détecter statiquement `Terminal` comme export nommé (message
// d'erreur au runtime : "Named export 'Terminal' not found"). Import par
// défaut puis déstructuration à l'exécution pour la VALEUR (le constructeur) ;
// le TYPE `HeadlessTerminal` vient de l'`import type` ci-dessus — même nom,
// deux imports distincts (TypeScript n'autorise pas un binding de valeur
// comme annotation de type).
const { Terminal: TerminalCtor } = xtermHeadless;

/**
 * `watch` interactif — UI Ink + bus de messages `@agent` (roadmap, Phase D).
 *
 * Pas de JSX : le type stripping natif de Node (décision archi migration
 * TypeScript) efface les TYPES, il ne transforme pas de syntaxe — JSX en
 * a besoin (vérifié : `node fichier.tsx` avec du JSX échoue en
 * `SyntaxError`). `React.createElement` direct est le seul chemin qui reste
 * dans la ligne « zéro build » du projet ; Ink lui-même n'exige pas JSX,
 * ce n'est qu'un sucre syntaxique côté React.
 *
 * Portée : le bus adresse les agents SUPERVISÉS (mode `attended`, pty
 * possédé — Phase B/C) et, depuis la Phase E (lot I6), les sessions
 * AUTONOMES ACP vivantes : portées par leur hôte de session persistant
 * (`src/acp/host.ts`), elles reçoivent le message comme un session/prompt
 * supplémentaire, joué après le tour en cours. Une session argv (one-shot,
 * plus de process à qui parler) ou une session ACP terminée est refusée
 * explicitement, jamais en silence (`routeAgentMessage`).
 */

const h = React.createElement;

/** Lignes de log conservées par agent (mémoire, pas persistant). */
const LOG_BUFFER_LINES = 500;

/**
 * Clé du tab virtuel "Terminal" dans `LogTailManager` — reçoit la sortie de
 * TOUTE commande `/…` ou `!…`, quel que soit l'agent affiché au moment où
 * elle est lancée (`console.log` + `patchConsole` abandonnés : sur écran
 * alternatif — `alternateScreen: true` — ils n'ont AUCUN scrollback, la
 * sortie d'une commande précédente est perdue dès qu'un redessin la
 * recouvre). `@` — jamais permis en premier caractère d'un nom d'agent
 * (`AGENT_NAME_RE` dans `agent-name.js` : alphanumérique uniquement en tête) —
 * rend cette clé structurellement impossible à confondre avec un agent réel,
 * pas juste par convention de nommage.
 */
export const TERMINAL_TAB = '@terminal';

export interface ParsedAgentMessage {
  agent: string;
  text: string;
}

/** `@agent message` → { agent, text }. `null` si la syntaxe ne matche pas. */
export function parseAgentMessage(input: string): ParsedAgentMessage | null {
  const match = /^@(\S+)\s+(.+)$/su.exec(input.trim());
  if (!match) return null;
  return { agent: match[1], text: match[2] };
}

export type MessageRouteResult = { ok: true } | { ok: false; reason: string };

/** État SGR actif (couleur/style) — pas de bytes d'échappement, que des props Ink. */
export interface SgrStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
}

/** Un fragment de texte + le style SGR actif à cet endroit — mappe 1:1 sur les props `Text` d'Ink. */
export interface StyledChunk extends SgrStyle {
  text: string;
}

/**
 * Palette ANSI 16 couleurs standard (thème par défaut du terminal intégré
 * VS Code / xterm.js — une référence largement répandue), PAS la palette de
 * marque Striart (`COLOR` ci-dessus) : coder 32 (vert) et 36 (cyan) sur la
 * même teinte de marque perdrait de l'information réelle émise par l'outil
 * hébergé. Fond (40-47/100-107) = même table, décalée de -10.
 */
const ANSI_COLOR_TABLE: Record<number, string> = {
  30: '#000000',
  31: '#CD3131',
  32: '#0DBC79',
  33: '#E5E510',
  34: '#2472C8',
  35: '#BC3FBC',
  36: '#11A8CD',
  37: '#E5E5E5',
  90: '#666666',
  91: '#F14C4C',
  92: '#23D18B',
  93: '#F5F543',
  94: '#3B8EEA',
  95: '#D670D6',
  96: '#29B8DB',
  97: '#FFFFFF',
};

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Cube 6×6×6 (16-231) + niveaux de gris (232-255) — conversion standard xterm 256 couleurs. */
function ansi256ToHex(n: number): string | undefined {
  if (!Number.isFinite(n) || n < 0 || n > 255) return undefined;
  if (n < 8) return ANSI_COLOR_TABLE[30 + n];
  if (n < 16) return ANSI_COLOR_TABLE[90 + (n - 8)];
  if (n < 232) {
    const c = n - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    return rgbToHex(
      r === 0 ? 0 : Math.round((r * 255) / 5),
      g === 0 ? 0 : Math.round((g * 255) / 5),
      b === 0 ? 0 : Math.round((b * 255) / 5),
    );
  }
  const gray = Math.round(((n - 232) * 255) / 23);
  return rgbToHex(gray, gray, gray);
}

/**
 * Style SGR d'une cellule du tampon xterm — direct depuis l'API de cellule
 * (`IBufferCell`), sans jamais repasser par du texte d'échappement littéral.
 * Couleur absente (`isFgDefault`/`isBgDefault`) = couleur terminal par
 * défaut, jamais codée en dur ; palette (`isFgPalette`) réutilise
 * `ansi256ToHex` (couvre déjà les 256 index, y compris les 16 premiers) ;
 * RGB (`isFgRGB`) déballe l'entier `0xRRGGBB` packé.
 */
function cellStyle(cell: IBufferCell): SgrStyle {
  const style: SgrStyle = {};
  if (cell.isBold()) style.bold = true;
  if (cell.isDim()) style.dimColor = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isInverse()) style.inverse = true;
  if (cell.isStrikethrough()) style.strikethrough = true;
  if (cell.isFgRGB()) {
    const rgb = cell.getFgColor();
    style.color = rgbToHex((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
  } else if (cell.isFgPalette()) {
    style.color = ansi256ToHex(cell.getFgColor());
  }
  if (cell.isBgRGB()) {
    const rgb = cell.getBgColor();
    style.backgroundColor = rgbToHex((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
  } else if (cell.isBgPalette()) {
    style.backgroundColor = ansi256ToHex(cell.getBgColor());
  }
  return style;
}

function sameStyle(a: SgrStyle, b: SgrStyle): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dimColor) === Boolean(b.dimColor) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.strikethrough) === Boolean(b.strikethrough) &&
    Boolean(a.inverse) === Boolean(b.inverse)
  );
}

/**
 * Convertit une ligne du tampon xterm en fragments stylés Ink — regroupe les
 * cellules consécutives de même style en un seul `StyledChunk` (un `Text`
 * par caractère serait correct mais ferait exploser le nombre de nœuds Ink
 * pour rien). Une cellule de largeur 0 est la suite d'un caractère large
 * (CJK, emoji) juste avant : `x` avance de `getWidth()`, jamais de 1, sinon
 * on lirait deux fois le même glyphe. Le padding blanc de fin de ligne est
 * coupé (même principe que `translateToString(trimRight: true)`) : sans ça,
 * chaque ligne ferait la pleine largeur du terminal émulé (80 par défaut),
 * bien au-delà de ce que la boîte Ink affiche réellement.
 */
function lineToChunks(line: IBufferLine, cols: number): StyledChunk[] {
  const chunks: StyledChunk[] = [];
  let x = 0;
  while (x < cols) {
    const cell = line.getCell(x);
    if (!cell) {
      x += 1;
      continue;
    }
    const width = cell.getWidth();
    const text = cell.getChars() || ' ';
    const style = cellStyle(cell);
    const last = chunks[chunks.length - 1];
    if (last && sameStyle(last, style)) {
      last.text += text;
    } else {
      chunks.push({ text, ...style });
    }
    x += width > 0 ? width : 1;
  }
  // Le blanc de fin de ligne peut être FUSIONNÉ dans le même chunk que le
  // texte qui précède (même style) — on ne peut donc pas se contenter de
  // retirer les chunks entièrement blancs, il faut aussi raboter le blanc
  // FINAL d'un chunk mixte (texte + padding), sans toucher au texte lui-même.
  while (chunks.length > 0) {
    const lastChunk = chunks[chunks.length - 1];
    const trimmed = lastChunk.text.replace(/\s+$/, '');
    if (trimmed === lastChunk.text) break; // pas de blanc en fin : rien à couper
    if (trimmed === '') {
      chunks.pop(); // chunk entièrement blanc — retiré, on réexamine le précédent
    } else {
      lastChunk.text = trimmed;
      break; // le chunk restant finit par du texte réel : terminé
    }
  }
  return chunks;
}

/**
 * Lit la queue du tampon d'un terminal émulé (@xterm/headless) — scrollback
 * INCLUS, pas seulement le viewport actuellement « affiché » par le
 * terminal headless (`buffer.length` compte scrollback + viewport ; les
 * `maxLines` dernières lignes de cet ensemble sont exactement ce qu'un
 * terminal réel montrerait si on remontait son historique jusqu'en bas) —
 * même sémantique que l'ancien `.slice(-LOG_BUFFER_LINES)` sur un tableau de
 * lignes accumulées à la main. Cœur pur testable sans pty ni socket : un
 * `Terminal` headless réel, nourri directement, suffit en test.
 */
export function readTerminalLines(term: HeadlessTerminal, maxLines: number): StyledChunk[][] {
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.length - maxLines);
  const lines: StyledChunk[][] = [];
  for (let y = start; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    lines.push(line ? lineToChunks(line, term.cols) : []);
  }
  return lines;
}

/** Écrit dans un terminal headless et résout une fois le tampon à jour (xterm.js traite `write` par file d'attente interne, jamais synchrone). */
export function writeToTerminal(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

const DEFAULT_TERM_COLS = 80;
const DEFAULT_TERM_ROWS = 24;

// Terminal synthétique du tab TERMINAL_TAB — pas un vrai pty à une taille
// imposée par un client distant, donc libre de choisir large (évite de
// couper un tableau `striart status` ou une ligne `git log` longue).
const TERMINAL_TAB_COLS = 200;
const TERMINAL_TAB_ROWS = 50;

/**
 * Achemine un message HUMAIN (tapé dans le champ de saisie — jamais une
 * sortie d'agent réinjectée) vers un agent :
 *  - supervisé : son pty possédé — démarre son hôte s'il n'existe pas encore
 *    (idempotent, même mécanisme que `--open`, Phase C) puis envoie via une
 *    connexion d'attache éphémère ;
 *  - autonome : sa session ACP vivante (Phase E) — le texte devient un
 *    session/prompt supplémentaire, via le canal du bus de l'hôte de session
 *    persistant ; aucune session vivante → refus explicite.
 * Refuse explicitement, jamais silencieusement, tout le reste.
 */
export async function routeAgentMessage(
  root: string,
  agentName: string,
  text: string,
  agentMeta: (AgentMeta & { name?: string }) | undefined,
  m: Messages = fr,
): Promise<MessageRouteResult> {
  if (!agentMeta) {
    return { ok: false, reason: m.watchUi.unknownAgent(agentName) };
  }
  if (agentMeta.mode === 'autonomous') {
    return routeToAcpSession(root, agentName, text, m);
  }

  try {
    await ensurePtyHost(root, agentName, {
      cwd: agentMeta.path,
      initialCommand: await resolveAttendedCommand(root, agentMeta),
    });
  } catch (error) {
    return {
      ok: false,
      reason: m.watchUi.hostUnavailable(agentName, (error as Error).message),
    };
  }

  return sendWithRetry(root, agentName, text, m);
}

/**
 * Phase E du bus `@agent` : remet le message humain à la session ACP
 * vivante de l'agent autonome (hôte persistant). Ni hôte ni session → refus
 * explicite qui dit pourquoi (argv one-shot, session terminée) ; refus de
 * l'hôte (bus désactivé, session en fermeture, texte invalide) → sa raison.
 */
async function routeToAcpSession(
  root: string,
  agentName: string,
  text: string,
  m: Messages,
): Promise<MessageRouteResult> {
  let delivered;
  try {
    delivered = await sendHumanPrompt(root, agentName, text);
  } catch (error) {
    return { ok: false, reason: m.watchUi.acpRefused(agentName, (error as Error).message) };
  }
  if ('code' in delivered) {
    if (delivered.code === 'ACP_SESSION_NOT_FOUND') {
      return { ok: false, reason: m.watchUi.autonomousRefused(agentName) };
    }
    return {
      ok: false,
      reason: m.watchUi.acpRefused(agentName, `${delivered.message} (${delivered.code})`),
    };
  }
  return { ok: true };
}

/**
 * `ensurePtyHost` résout désormais quand l'hôte natif a publié son PID file
 * (canal ouvert) ; le retry reste la défense contre une connexion refusée
 * transitoirement (instance de named pipe pas encore recréée entre deux
 * clients, hôte qui redémarre) — un premier message ne doit jamais échouer
 * par pure course, seulement sur une vraie indisponibilité.
 */
async function sendWithRetry(
  root: string,
  agentName: string,
  text: string,
  m: Messages,
  attemptsLeft = 15,
): Promise<MessageRouteResult> {
  const attempt = await new Promise<MessageRouteResult>((resolve) => {
    const conn = connectAttachClient(root, agentName, {
      onData: () => {},
      onConnect: () => {
        conn.sendMessage(text);
        conn.close();
        resolve({ ok: true });
      },
      onError: (error) => resolve({ ok: false, reason: error.message }),
    });
  });
  // 'reason' in attempt, pas `!attempt.ok` : cf. le contournement documenté
  // plus haut sur routeAgentMessage (bug de rétrécissement TS7 natif).
  if ('reason' in attempt) {
    if (attemptsLeft <= 0) {
      return { ok: false, reason: m.watchUi.injectFailed(agentName, attempt.reason) };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return sendWithRetry(root, agentName, text, m, attemptsLeft - 1);
  }
  return attempt;
}

/**
 * Découpe une ligne façon shell — guillemets simples/doubles respectés
 * (`--command "aider --model gpt-4o"`), rien de plus (pas de `$VAR`, pas de
 * pipe, pas d'échappement complexe). Suffisant pour retaper une commande
 * `striart` normale ; jamais passé à un shell derrière (`runStriartCommand`
 * construit un argv, `shell: false`) — ce découpage sert seulement à
 * séparer les mots, pas à les interpréter.
 */
export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/**
 * Commandes au premier plan (bloquantes par nature — boucle infinie ou
 * process interne) : n'ont aucun sens tapées ici, elles gèleraient le champ
 * de saisie jusqu'au timeout (`runStriartCommand` attend la fin du process,
 * 120 s max). Refus explicite avec la raison précise, jamais un blocage
 * silencieux — chaque commande a une contrainte différente, pas juste
 * « bloquante » :
 * - `watch` : un second watcher EN PLUS de celui qui héberge ce panneau
 *   dupliquerait la boucle de merge et se disputerait `main.lock`.
 * - `mcp` : sert un protocole sur stdin/stdout — ce champ ne peut pas lui
 *   fournir un client, il resterait bloqué à lire jusqu'au timeout pour rien.
 * - `attach` : doit posséder le terminal RÉEL (mode raw, E/S directes) —
 *   incompatible avec un sous-process exécuté en tâche de fond pendant
 *   qu'Ink garde la main sur ce même terminal.
 *
 * `dashboard` est un cas à part, traité séparément ci-dessous : seule la
 * forme qui démarre le serveur HTTP en premier plan est bloquante —
 * `--daemon`/`--stop`/`--status` rendent la main immédiatement (même
 * mécanisme que `watch --daemon`, `daemon.js`) et sont donc autorisés.
 */
/** Raison localisée pour laquelle une commande est refusée depuis ce champ (registre des commandes). */
function foregroundReason(cmd: string, m: Messages): string | null {
  const reason = publicCommands().find((c) => c.name === cmd)?.foreground;
  if (!reason || reason === 'server') return null;
  return m.watchUi.foreground[reason as Exclude<ForegroundReason, 'server'>];
}

export interface StriartCommandResult {
  ok: boolean;
  output: string;
}

/**
 * Exécute `striart <tokens>` tel qu'un humain l'aurait tapé dans un vrai
 * terminal — même binaire, même code, zéro logique dupliquée (règle n°0) :
 * le champ de saisie de `watch --ui` n'est pas une seconde implémentation
 * du CLI, c'est un raccourci vers le même `cli.js`. `shell: false` (argv
 * direct) : l'utilisateur local qui tape sa propre commande a le même
 * niveau de confiance qu'un vrai terminal, mais le texte ne repasse jamais
 * par un interpréteur shell.
 */
export async function runStriartCommand(
  root: string,
  tokens: string[],
  m: Messages = fr,
): Promise<StriartCommandResult> {
  const [cmd] = tokens;
  if (!cmd) return { ok: false, output: '' };
  if (
    cmd === 'dashboard' &&
    !tokens.includes('--daemon') &&
    !tokens.includes('--stop') &&
    !tokens.includes('--status')
  ) {
    return { ok: false, output: m.watchUi.dashboardForeground };
  }
  const reason = foregroundReason(cmd, m);
  if (reason) {
    return { ok: false, output: m.watchUi.foregroundRefused(cmd, reason) };
  }
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const result = await execa(process.execPath, [cliPath, ...tokens], {
    cwd: root,
    all: true,
    reject: false,
    timeout: 120_000,
    // L'onglet Terminal est un vrai émulateur (xterm) : couleur conservée.
    env: { ...process.env, FORCE_COLOR: process.env.NO_COLOR ? '0' : '1' },
  });
  return { ok: result.exitCode === 0, output: result.all ?? '' };
}

/**
 * Exécute une commande shell RÉELLE — "!" dans le champ, même convention que
 * Claude Code lui-même pour la même chose (contrairement à `runStriartCommand`,
 * qui ne lance QUE `striart <tokens>` en argv sans jamais repasser par un
 * shell). Toujours le shell par défaut de la machine (`defaultShell()`, déjà
 * utilisé pour héberger les agents — PowerShell sous Windows, sinon
 * $SHELL/bash) : pas de logique de sélection à inventer en plus, un shell
 * réel sait déjà lancer n'importe quel autre interpréteur installé
 * (`! bash -c "..."`, `! wsl ...`) sans qu'on ait besoin de le prévoir ici.
 * `-Command`/`-c` reçoit la commande comme un SEUL argument de tableau : le
 * texte va au parseur du shell, jamais à travers un `execa(str, {shell:true})`
 * dont le comportement de découpage diffère d'un OS à l'autre.
 *
 * Frontière de confiance IDENTIQUE au bus "@agent" (cf. SECURITY.md, « le bus
 * @agent a le même pouvoir que taper dans le terminal ») : l'entrée vient
 * exclusivement des frappes locales de `useInput`, jamais d'un agent, d'un
 * fichier ou d'un réseau — quiconque peut taper ici a de toute façon déjà un
 * vrai shell sur cette machine (l'adversaire réaliste du modèle de menace du
 * projet n'est PAS quelqu'un qui a déjà un shell local, cf. SECURITY.md).
 * Ce n'est donc pas une élévation de privilège, juste un raccourci vers ce
 * que l'utilisateur pourrait déjà faire dans une autre fenêtre.
 */
export async function runShellCommand(
  root: string,
  command: string,
): Promise<StriartCommandResult> {
  const shell = defaultShell();
  const isPowerShell = process.platform === 'win32';
  const result = await execa(
    shell,
    isPowerShell ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
    { cwd: root, all: true, reject: false, timeout: 120_000 },
  );
  return { ok: result.exitCode === 0, output: result.all ?? '' };
}

/** Entrées d'historique de saisie conservées (mémoire, pas persistant). */
const HISTORY_MAX_ENTRIES = 200;

interface LogState {
  lines: StyledChunk[][];
  connected: boolean;
}

/** Sous-ensemble d'`AgentMeta` nécessaire pour démarrer/rejoindre son pty possédé. */
export interface TailableAgent {
  name: string;
  path: string;
  command: string | null;
}

/**
 * Gestionnaire de connexions de lecture (tail live) — un client d'attache
 * par agent supervisé affiché, distinct des connexions éphémères de
 * `routeAgentMessage` (envoi ponctuel, jamais gardées ouvertes).
 *
 * Démarre l'hôte de pty au besoin (`ensurePtyHost`, idempotent — même
 * mécanisme que `--open` et `routeAgentMessage`) : sans ça, un agent jamais
 * ouvert via `--open` n'aurait tout simplement rien à rejoindre, et
 * resterait affiché 🔴 pour toujours plutôt que de devenir joignable.
 *
 * `appendData` nourrit un VRAI terminal émulé (`@xterm/headless`, un par
 * agent) avec la sortie brute du pty, plutôt que de découper le texte sur
 * `\n` en filtrant les séquences ANSI (ancienne approche, revue le
 * 2026-09-09). L'outil hébergé (Claude Code, Aider…) a sa PROPRE interface
 * plein écran : il redessine des zones précises EN PLACE par déplacement de
 * curseur, sans jamais émettre de `\n` entre deux états d'une même ligne.
 * L'ancien filtrage (garder le SGR, jeter le reste) traitait ces
 * déplacements comme invisibles et concaténait quand même le texte
 * qui suit — plusieurs états successifs de la même ligne s'empilaient sur
 * la même ligne affichée (constaté en usage réel : bannière + hint +
 * notification mélangés). Une vraie émulation applique le déplacement de
 * curseur ET l'écrasement en place, exactement comme un vrai terminal : la
 * grille lue via `readTerminalLines` reflète l'état d'écran RÉEL, jamais un
 * empilement. Le terminal émulé de chaque agent est dimensionné sur le
 * `cols`/`rows` réel du pty (frame `hello`, cf. `pty-attach.ts`) — PAS sur la
 * largeur de la boîte Ink : l'outil hébergé calcule ses retours à la ligne
 * et son curseur pour la taille réelle de SON pty, une taille différente ici
 * romprait cette cohérence. `readTerminalLines` ne garde ensuite que la
 * queue (scrollback compris) pour l'affichage.
 *
 * Exportée UNIQUEMENT pour tester `appendCommandOutput` (le seul membre qui
 * ne touche ni pty ni socket — le reste dépend de `ensurePtyHost`/
 * `connectAttachClient` réels, donc jamais testé en isolation, seulement via
 * les tests d'intégration de `routeAgentMessage`).
 */
export class LogTailManager {
  private root: string;
  private connections = new Map<string, ReturnType<typeof connectAttachClient>>();
  private starting = new Set<string>(); // ensurePtyHost en vol — évite les doublons entre deux ticks
  // Un release() pendant qu'un ensure() est en vol (ensurePtyHost peut
  // prendre un instant) doit annuler la connexion à venir, pas juste celle
  // déjà établie — sans ça un agent libéré entre deux ticks se reconnecte
  // quand même une fois l'attente terminée.
  private abandoned = new Set<string>();
  private terminals = new Map<string, HeadlessTerminal>(); // émulateur par agent, survit à une reconnexion (cf. release())
  private state = new Map<string, LogState>();
  // `key` = l'agent (ou TERMINAL_TAB) dont le contenu vient de changer — le
  // composant s'en sert pour marquer un tab "non lu" quand ce n'est pas
  // celui actuellement affiché.
  private onChange: (key: string) => void;

  constructor(root: string, onChange: (key: string) => void) {
    this.root = root;
    this.onChange = onChange;
  }

  trackedAgents(): string[] {
    return [...new Set([...this.connections.keys(), ...this.starting])];
  }

  async ensure(agentMeta: TailableAgent): Promise<void> {
    const agent = agentMeta.name;
    if (this.connections.has(agent) || this.starting.has(agent)) return;
    this.abandoned.delete(agent); // un nouvel ensure() annule un release() précédent
    this.starting.add(agent);
    if (!this.state.has(agent)) this.state.set(agent, { lines: [], connected: false });
    try {
      await ensurePtyHost(this.root, agent, {
        cwd: agentMeta.path,
        initialCommand: await resolveAttendedCommand(this.root, agentMeta),
      });
      if (this.abandoned.has(agent)) return; // libéré pendant l'attente
      this.connectNow(agentMeta);
    } catch {
      // Laissé déconnecté — le prochain tick de rafraîchissement (2s,
      // `refresh()` dans le composant) rappellera ensure() et retentera.
    } finally {
      this.starting.delete(agent);
    }
  }

  /** Crée (ou redimensionne) le terminal émulé de l'agent sur le cols/rows réel du pty — idempotent, survit à une reconnexion. */
  private ensureTerminal(agent: string, cols: number, rows: number): HeadlessTerminal {
    const existing = this.terminals.get(agent);
    if (!existing) {
      const term = new TerminalCtor({
        cols: cols || DEFAULT_TERM_COLS,
        rows: rows || DEFAULT_TERM_ROWS,
        scrollback: LOG_BUFFER_LINES,
        allowProposedApi: true, // requis pour l'API de tampon/cellule (buffer.active, getCell...)
      });
      this.terminals.set(agent, term);
      return term;
    }
    if (cols && rows && (existing.cols !== cols || existing.rows !== rows)) {
      existing.resize(cols, rows);
    }
    return existing;
  }

  private connectNow(agentMeta: TailableAgent): void {
    const agent = agentMeta.name;
    const conn = connectAttachClient(this.root, agent, {
      onConnect: ({ cols, rows }) => {
        this.ensureTerminal(agent, cols, rows);
        const s = this.state.get(agent);
        if (s) s.connected = true;
        this.onChange(agent);
      },
      // Un AUTRE client (`attach`, `--open`) redimensionne son terminal
      // après coup — sans ça, notre émulation resterait sur la taille
      // connue à la connexion, désynchronisée de ce que l'outil hébergé
      // croit avoir comme terminal (cf. commentaire de `ServerResizeFrame`).
      onResize: ({ cols, rows }) => this.ensureTerminal(agent, cols, rows),
      onData: (text) => this.appendData(agent, text),
      // Évincé par l'hôte (panneau trop lent à lire) : le client se
      // reconnecte et le rejeu redessine l'état courant — l'émulation repart
      // d'un écran vierge, sans quoi le rejeu s'empilerait sur l'ancien.
      onEvicted: () => this.terminals.get(agent)?.reset(),
      onExit: () => {
        // Retiré de `connections`, pas seulement marqué déconnecté : sans
        // ça, `ensure()` verrait toujours une entrée et ne retenterait
        // jamais — une connexion ratée resterait 🔴 pour toujours.
        this.connections.delete(agent);
        const s = this.state.get(agent);
        if (s) s.connected = false;
        this.onChange(agent);
      },
      onError: () => {
        this.connections.delete(agent);
        const s = this.state.get(agent);
        if (s) s.connected = false;
        this.onChange(agent);
      },
    });
    this.connections.set(agent, conn);
  }

  private appendData(agent: string, text: string): void {
    const term = this.terminals.get(agent);
    if (!term) return; // ne devrait pas arriver : créé au 'hello', reçu avant toute donnée
    void writeToTerminal(term, text).then(() => {
      const s = this.state.get(agent) ?? { lines: [], connected: true };
      s.lines = readTerminalLines(term, LOG_BUFFER_LINES);
      this.state.set(agent, s);
      this.onChange(agent);
    });
  }

  /**
   * Sortie de `/commande` ou `!commande` — accumulée dans le tab `TERMINAL_TAB`
   * QUEL QUE SOIT l'agent affiché au moment où la commande a été lancée (la
   * ligne d'activité en bas du panneau confirme déjà l'exécution ; ce tab
   * garde le texte complet, consultable en y basculant à tout moment).
   * Réutilise l'émulation de terminal existante (`ensureTerminal`,
   * `writeToTerminal`, `readTerminalLines`) plutôt que d'inventer un second
   * mécanisme : la sortie d'un `git`/`striart` réel peut contenir de vraies
   * séquences ANSI (couleur), qu'un simple découpage sur `\n` afficherait en
   * clair — l'émulation les interprète correctement, gratuitement. Largeur
   * volontairement généreuse (200 colonnes) : ce n'est pas un vrai pty à une
   * taille imposée, juste un consommateur de la même API — autant éviter de
   * couper les lignes larges (tableau de `striart status`, `git log`...).
   */
  appendCommandOutput(header: string, output: string): void {
    const term = this.ensureTerminal(TERMINAL_TAB, TERMINAL_TAB_COLS, TERMINAL_TAB_ROWS);
    const text = `${header}\r\n${(output || '(aucune sortie)').replace(/\r?\n/g, '\r\n')}\r\n\r\n`;
    void writeToTerminal(term, text).then(() => {
      const s = this.state.get(TERMINAL_TAB) ?? { lines: [], connected: true };
      s.lines = readTerminalLines(term, LOG_BUFFER_LINES);
      s.connected = true;
      this.state.set(TERMINAL_TAB, s);
      this.onChange(TERMINAL_TAB);
    });
  }

  /**
   * Ajoute UNE ligne au tab "Terminal" (événements de la boucle de watch :
   * commit, merge, rebase…), sans l'en-tête ni l'espacement d'une sortie de
   * commande.
   */
  appendLine(line: string): void {
    const term = this.ensureTerminal(TERMINAL_TAB, TERMINAL_TAB_COLS, TERMINAL_TAB_ROWS);
    void this.refreshTerminalTab(term, line);
  }

  /** Écrit dans le terminal émulé de l'onglet Terminal, puis republie ses lignes. */
  private async refreshTerminalTab(term: HeadlessTerminal, line: string): Promise<void> {
    const state = this.state.get(TERMINAL_TAB) ?? { lines: [], connected: true };
    try {
      await writeToTerminal(term, `${line.replace(/\r?\n/g, '\r\n')}\r\n`);
      state.lines = readTerminalLines(term, LOG_BUFFER_LINES);
      state.connected = true;
    } catch (error) {
      // Terminal émulé disposé entre-temps (/clear) ou en échec : l'onglet le
      // dit, au lieu d'une promesse rejetée sans gestionnaire.
      state.connected = false;
      const message = error instanceof Error ? error.message : String(error);
      state.lines = [...state.lines, [{ text: `[striart] ${message}`, color: 'red' }]];
    }
    this.state.set(TERMINAL_TAB, state);
    this.onChange(TERMINAL_TAB);
  }

  /**
   * "/clear" sur l'onglet Terminal — vide l'historique accumulé de sorties
   * de commandes. Dispose le terminal émulé plutôt que de le vider par une
   * séquence ANSI (`\x1b[2J`) : plus simple, et évite de dépendre d'un
   * comportement de reset qui varie entre implémentations de terminal.
   * Distinct d'un `/clear` sur un agent réel (`submitLine` du composant) :
   * là, c'est la VRAIE commande d'effacement du shell qui est envoyée dans
   * le pty — cette méthode-ci ne s'applique jamais à un agent, seulement à
   * TERMINAL_TAB, qui n'a pas de pty réel derrière.
   */
  clearTerminalTab(): void {
    this.terminals.get(TERMINAL_TAB)?.dispose();
    this.terminals.delete(TERMINAL_TAB);
    this.state.set(TERMINAL_TAB, { lines: [], connected: true });
    this.onChange(TERMINAL_TAB);
  }

  release(agent: string): void {
    this.abandoned.add(agent); // annule aussi un ensurePtyHost en vol, s'il y en a un
    this.connections.get(agent)?.close();
    this.connections.delete(agent);
    this.state.delete(agent);
    this.terminals.get(agent)?.dispose();
    this.terminals.delete(agent);
  }

  releaseAll(): void {
    for (const agent of this.trackedAgents()) this.release(agent);
    // TERMINAL_TAB n'est jamais dans trackedAgents() (pas une connexion pty,
    // alimenté seulement par appendCommandOutput) — nettoyé explicitement
    // pour ne pas laisser son terminal émulé vivant sans raison.
    this.terminals.get(TERMINAL_TAB)?.dispose();
    this.terminals.delete(TERMINAL_TAB);
    this.state.delete(TERMINAL_TAB);
  }

  get(agent: string): LogState {
    return this.state.get(agent) ?? { lines: [], connected: false };
  }
}

/**
 * Une ligne du journal d'événements de la boucle de watch, déjà qualifiée
 * (niveau sémantique + texte NON FIABLE, neutralisé à l'affichage). `continuation` :
 * détail ou piste rattachés à l'entrée précédente.
 */
export interface WatchUiEntry {
  tone: Level;
  text: string;
  continuation?: boolean;
}

/** Abonnement aux événements de la boucle de watch : rend la fonction de désabonnement. */
export type WatchLineSubscription = (listener: (entry: WatchUiEntry) => void) => () => void;

/** Capacités de présentation du cockpit (sondées UNE fois par `caps.ts`). */
export type CockpitCaps = Pick<
  Capabilities,
  'unicode' | 'colorStdout' | 'plain' | 'theme' | 'animate'
>;

interface AppProps {
  root: string;
  /**
   * Événements de la boucle de `watch` qui tourne dans le même process,
   * qualifiés par la CLI. Affichés dans le journal — jamais écrits sur
   * l'écran alternatif, où ils corrompraient le rendu.
   */
  subscribeLoop?: WatchLineSubscription;
  /** Catalogue de la langue choisie par la CLI. */
  m: Messages;
  caps: CockpitCaps;
  /** Le watcher du process fusionne-t-il automatiquement ? (informatif) */
  autoMerge: boolean;
}

/** Entrées du journal conservées (borne mémoire). */
const JOURNAL_MAX = 300;
/** Cadence maximale de repeinture déclenchée par les flux (sortie de pty, événements). */
const RENDER_THROTTLE_MS = 100;
/** Intervalle de rafraîchissement des données (les événements en déclenchent un aussitôt). */
const REFRESH_MS = 8000;
const IDLE_TICK_MS = 10_000;
const DETAIL_REFRESH_MS = 15000;
const DETAIL_COMMITS = 8;
const DETAIL_FILES = 12;

/** Ton Ink d'un segment — résolu depuis les thèmes de la CLI (une seule palette). */
export function segProps(
  seg: Seg,
  caps: Pick<CockpitCaps, 'colorStdout' | 'theme'>,
): Record<string, unknown> {
  const base = seg.tone ? inkStyleForTone(seg.tone, caps.theme, caps.colorStdout) : {};
  const props: Record<string, unknown> = { ...base };
  if (seg.bold) props.bold = true;
  if (seg.inverse) props.inverse = true;
  if (seg.italic) props.italic = true;
  if (seg.underline) props.underline = true;
  if (seg.strikethrough) props.strikethrough = true;
  if (caps.colorStdout) {
    if (seg.dimColor) props.dimColor = true;
    if (seg.color) props.color = seg.color;
    if (seg.backgroundColor) props.backgroundColor = seg.backgroundColor;
  }
  return props;
}

/** Une ligne de la trame → un `Text` Ink (jamais de retour à la ligne : la trame est déjà calibrée). */
function renderLine(line: Line, index: number, caps: CockpitCaps) {
  // Segments voisins de même style fusionnés : moins d'éléments React, donc moins de CPU.
  const merged: Array<{ props: Record<string, unknown>; sig: string; text: string }> = [];
  for (const seg of line.length === 0 ? [{ text: ' ' } as Seg] : line) {
    const props = segProps(seg, caps);
    const sig = JSON.stringify(props);
    const last = merged[merged.length - 1];
    if (last && last.sig === sig) last.text += seg.text;
    else merged.push({ props, sig, text: seg.text });
  }
  return h(
    Text,
    { key: index, wrap: 'truncate' },
    ...merged.map((part, j) => h(Text, { key: j, ...part.props }, part.text)),
  );
}

/** Lignes du tampon d'un terminal émulé → lignes de la vue (mêmes champs de style). */
function chunkLines(lines: StyledChunk[][]): Line[] {
  return lines.map((chunks) => chunks as Line);
}

interface GitCommitInfo {
  sha: string;
  at: string | null;
  subject: string;
}

/**
 * Détail d'un agent lu dans SON clone (jamais le dépôt principal) : commits
 * depuis le dernier merge, fichiers touchés, modifications non commitées.
 * Lecture seule ; tout échec est rendu (`error`), jamais avalé.
 */
export async function readAgentDetail(
  meta: AgentMeta & { name: string; path: string },
): Promise<DetailInfo> {
  const git = cloneGit(meta.path);
  const mergeBase = meta.lastMergedCommit ?? meta.baseCommit;
  try {
    const [log, names, status] = await Promise.all([
      git.raw([
        'log',
        `--max-count=${DETAIL_COMMITS}`,
        '--format=%H%x1f%cI%x1f%s',
        `${mergeBase}..HEAD`,
      ]),
      git.raw(['diff', '--name-status', `${mergeBase}..HEAD`]),
      git.raw(['status', '--porcelain']),
    ]);
    const commits: GitCommitInfo[] = log
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [sha, at, ...subject] = l.split('\x1f');
        return { sha, at: at || null, subject: subject.join('\x1f') };
      });
    const files = names
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [st, ...rest] = l.split('\t');
        return { status: st, path: rest[rest.length - 1] ?? '' };
      });
    return {
      loading: false,
      commits,
      commitTotal: commits.length,
      files: files.slice(0, DETAIL_FILES),
      fileTotal: files.length,
      uncommitted: status.split('\n').filter((l) => l.trim() !== '').length,
    };
  } catch (error) {
    return {
      loading: false,
      error: (error as Error).message.split('\n')[0],
      commits: [],
      commitTotal: 0,
      files: [],
      fileTotal: 0,
      uncommitted: 0,
    };
  }
}

/** Ligne du registre (+ ticket ouvert, date du dernier commit) → ligne du tableau. */
export function toAgentRow(
  agent: AgentMeta & { name: string; status: string },
  ticket: { id: string; reason: string } | null,
  lastCommitAt: string | null,
  idle: IdleCell | null = null,
): AgentRow {
  const a = agent as AgentMeta & {
    name: string;
    status: string;
    currentBranch?: string;
    lastMessage?: string | null;
    pendingCommits?: number;
    sizeBytes?: number;
    session?: AgentRow['session'];
    profile?: string | null;
  };
  return {
    name: a.name,
    status: a.status,
    mode: a.mode,
    profile: a.profile ?? null,
    session: a.session ?? null,
    pendingCommits: a.pendingCommits ?? 0,
    branch: a.currentBranch ?? a.branch,
    lastMessage: a.lastMessage ?? null,
    lastCommitAt,
    sizeBytes: a.sizeBytes,
    ticket,
    // Additif : absent tant que rien n'est à signaler (le tableau et les instantanés restent inchangés).
    ...(idle ? { idle } : {}),
  };
}

/**
 * Résout la meta d'un agent pour le bus `@agent` — d'abord dans l'instantané
 * React courant (rapide, cas normal), un appel `listAgents` frais en repli
 * seulement si absent. Protège contre la fenêtre entre le montage de l'UI
 * et le premier sondage réussi : sans ce repli, taper un message avant que
 * le premier `listAgents()` ait résolu rapporterait "Agent inconnu" pour un
 * agent pourtant bien réel — une course au démarrage, pas un vrai agent
 * manquant, ne doit jamais produire ce message.
 */
export async function resolveAgentMeta(
  root: string,
  snapshot: Array<AgentMeta & { name: string }>,
  name: string,
): Promise<(AgentMeta & { name?: string }) | undefined> {
  const cached = snapshot.find((a) => a.name === name);
  if (cached) return cached;
  const fresh = await listAgents(root).catch(() => []);
  return fresh.find((a) => a.name === name);
}

interface StriartCommandInfo {
  name: string;
  description: string;
}

/**
 * Catalogue des commandes striart proposées par l'autocomplétion "/" — même
 * liste que les sous-commandes publiques de `cli.js` (les internes masquées
 * ne sont jamais destinées à un humain) et plus "exit" (natif à ce panneau, pas une vraie commande
 * striart). Les restrictions (`watch`/`mcp`/`attach`, `dashboard` sans
 * `--daemon`) restent tranchées par `runStriartCommand` au moment de
 * soumettre — signalées ici juste pour prévenir avant même de taper Entrée.
 */
function striartCommands(m: Messages): StriartCommandInfo[] {
  const fromRegistry = publicCommands().map((spec) => {
    const reason = foregroundReason(spec.name, m);
    // Repli EXPLICITE (le nom de la commande) si le catalogue n'a pas son entrée : le cockpit ne
    // plante jamais pour un texte manquant. Le test de cohérence registre ↔ catalogue
    // (tests/unit/cli-registry-i18n.test.js) reste la garde qui l'interdit à la livraison.
    const entry = (m.commands as Record<string, { summary?: string } | undefined>)[spec.name];
    let description: string =
      typeof entry?.summary === 'string' && entry.summary !== '' ? entry.summary : spec.name;
    if (spec.name === 'dashboard') description = m.watchUi.dashboardSuggestion;
    else if (reason) description = m.watchUi.unavailableHere(reason);
    else if (spec.name === 'init') description = m.watchUi.initSuggestion;
    return { name: spec.name, description };
  });
  return [
    ...fromRegistry,
    { name: 'clear', description: m.watchUi.clearSuggestion },
    { name: 'relaunch', description: m.watchUi.relaunchSuggestion },
    { name: 'exit', description: m.watchUi.exitSuggestion },
  ];
}

export interface Suggestion {
  kind: 'agent' | 'command';
  value: string;
  description: string;
}

/**
 * Suggestions actives pour l'autocomplétion "@"/"/" — recalculées à chaque
 * frappe, jamais mémorisées (entrée courte, pas besoin de `useMemo`). Seul
 * le premier mot après le préfixe compte : un espace signifie qu'on est déjà
 * dans le corps du message (`@agent-a ...`) ou les arguments (`/merge ...`)
 * — plus rien à compléter à ce stade, la liste redevient vide.
 */
export function computeSuggestions(
  input: string,
  agents: Array<AgentMeta & { name: string; status: string }>,
  m: Messages = fr,
): Suggestion[] {
  if (input.startsWith('@')) {
    const partial = input.slice(1);
    if (partial.includes(' ')) return [];
    return agents
      .filter((a) => a.name.toLowerCase().startsWith(partial.toLowerCase()))
      .map((a) => ({
        kind: 'agent' as const,
        value: a.name,
        description:
          a.mode === 'autonomous'
            ? m.watchUi.agentAutonomous
            : a.status === 'ACTIVE'
              ? m.watchUi.agentSupervised
              : m.watchUi.agentInactive,
      }));
  }
  if (input.startsWith('/')) {
    const partial = input.slice(1).toLowerCase();
    if (partial.includes(' ')) return [];
    return striartCommands(m)
      .filter((c) => c.name.startsWith(partial))
      .map((c) => ({
        kind: 'command' as const,
        value: c.name,
        description: c.description,
      }));
  }
  return [];
}

/**
 * Best-effort, JAMAIS garanti : reconnaît la forme d'une invite de shell
 * INACTIVE (PowerShell "PS C:\...>", cmd.exe "C:\...>", POSIX
 * "user@host:~$"/"#", zsh "~ %") sur la dernière ligne non vide de l'écran
 * émulé — signal purement informatif que l'outil hébergé (Claude Code...)
 * s'est terminé (crash, "/exit" tapé dedans...) et que le pty n'héberge plus
 * que le shell nu en dessous. Jamais utilisé pour une décision automatique
 * (pas de relance auto, décidé explicitement le 2026-09-10) : un thème de
 * prompt personnalisé (oh-my-posh, Starship...) qui ne matche aucun de ces
 * motifs fait juste manquer le signal, jamais l'inverse de grave — le pire
 * cas est un badge optimiste, pas une action non voulue.
 */
export function looksLikeIdleShellPrompt(lines: StyledChunk[][]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i]
      .map((c) => c.text)
      .join('')
      .trim();
    if (text === '') continue;
    return (
      /^(PS )?[A-Za-z]:[\\/]\S*>\s*$/.test(text) ||
      /^\S+@\S+:\S*[$#]\s*$/.test(text) ||
      /^\S+\s*%\s*$/.test(text)
    );
  }
  return false;
}

function App({ root, subscribeLoop, m, caps, autoMerge }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const c = m.watchUi.cockpit;

  // ── données collectées (rafraîchies, jamais re-rendues si inchangées) ──
  const [agentRows, setAgentRows] = React.useState<AgentRow[]>([]);
  const metasRef = React.useRef<Array<AgentMeta & { name: string; status: string }>>([]);
  const [openTickets, setOpenTickets] = React.useState(0);
  const [queueWaiting, setQueueWaiting] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const lastRefreshAt = React.useRef<number | null>(null);
  const [targetBranch, setTargetBranch] = React.useState('main');
  const dataSignature = React.useRef('');
  const commitDates = React.useRef(new Map<string, string | null>());
  const idleProvider = React.useRef(createIdleCellsProvider(root));

  // ── navigation ──
  const [selectedRaw, setSelected] = React.useState<string | null>(null);
  const [view, setView] = React.useState<ViewKind>('main');
  const [bottom, setBottom] = React.useState<BottomPane>('journal');
  const [unread, setUnread] = React.useState({ journal: false, commands: false });
  const [journalScroll, setJournalScroll] = React.useState(0);
  const [commandsScroll, setCommandsScroll] = React.useState(0);
  const [outputScroll, setOutputScroll] = React.useState(0);
  const [confirmAgent, setConfirmAgent] = React.useState<string | null>(null);
  const [detailState, setDetailState] = React.useState<{ name: string; info: DetailInfo } | null>(
    null,
  );
  const detailSignature = React.useRef('');

  // ── saisie ──
  const [inputFocused, setInputFocused] = React.useState(false);
  const [input, setInput] = React.useState<InputBuffer>({ text: '', cursor: 0 });
  const [selectionIndex, setSelectionIndex] = React.useState(0);
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [draftInput, setDraftInput] = React.useState('');

  // ── flux et activité ──
  const journalRef = React.useRef<JournalEntry[]>([]);
  const bottomRef = React.useRef(bottom);
  bottomRef.current = bottom;
  const [activity, setActivity] = React.useState<ActivityView[]>([]);
  const activityIdRef = React.useRef(0);
  const [, setVersion] = React.useState(0);

  // Repeinture regroupée : un flux rapide (sortie d'un pty, rafale d'événements)
  // ne provoque jamais plus de ~10 rendus par seconde.
  const renderTimer = React.useRef<NodeJS.Timeout | null>(null);
  const scheduleRender = React.useCallback(() => {
    if (renderTimer.current) return;
    renderTimer.current = setTimeout(() => {
      renderTimer.current = null;
      setVersion((v) => v + 1);
    }, RENDER_THROTTLE_MS);
  }, []);

  const tailManagerRef = React.useRef<LogTailManager | null>(null);
  if (!tailManagerRef.current) {
    tailManagerRef.current = new LogTailManager(root, (key) => {
      if (key === TERMINAL_TAB && bottomRef.current !== 'commands') {
        setUnread((prev) => (prev.commands ? prev : { ...prev, commands: true }));
      }
      scheduleRender();
    });
  }
  const tail = tailManagerRef.current;

  const addJournal = React.useCallback(
    (entry: WatchUiEntry) => {
      const list = journalRef.current;
      list.push({ at: Date.now(), ...entry });
      if (list.length > JOURNAL_MAX) list.splice(0, list.length - JOURNAL_MAX);
      if (bottomRef.current !== 'journal') {
        setUnread((prev) => (prev.journal ? prev : { ...prev, journal: true }));
      }
      scheduleRender();
    },
    [scheduleRender],
  );

  // ── sélection effective : suit l'ordre d'écran, jamais un agent disparu ──
  const ordered = displayOrder(agentRows, m.status.stateTicket);
  const selected =
    selectedRaw && ordered.some((a) => a.name === selectedRaw)
      ? selectedRaw
      : (ordered[0]?.name ?? null);
  const selectedRow = ordered.find((a) => a.name === selected);

  // ── activité (« jamais de silence » : chaque action a un début, une fin, une durée) ──
  const pushActivity = React.useCallback((label: string): number => {
    const id = ++activityIdRef.current;
    setActivity((list) =>
      [
        ...list,
        { id, label, status: 'pending' as const, startedAt: Date.now(), endedAt: null },
      ].slice(-4),
    );
    return id;
  }, []);
  const resolveActivity = React.useCallback(
    (id: number, status: 'ok' | 'error', detail?: string) => {
      setActivity((list) =>
        list.map((entry) =>
          entry.id === id ? { ...entry, status, detail, endedAt: Date.now() } : entry,
        ),
      );
    },
    [],
  );

  // ── cible de merge (config), une fois ──
  React.useEffect(() => {
    let cancelled = false;
    void loadConfig(root)
      .then((config: { targetBranch?: string }) => {
        if (!cancelled && config.targetBranch) setTargetBranch(config.targetBranch);
      })
      .catch(() => {
        // Config illisible : le rafraîchissement des agents le dira ; la cible reste « main » à l'affichage.
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  // ── événements de la boucle de watch → journal ──
  const refreshSoon = React.useRef<() => void>(() => {});
  React.useEffect(() => {
    if (!subscribeLoop) return undefined;
    return subscribeLoop((entry) => {
      addJournal(entry);
      if (!entry.continuation) refreshSoon.current();
    });
  }, [subscribeLoop, addJournal]);

  // ── horloge et chronomètre ──
  // L'heure (HH:MM) et les âges (« 3 min ») n'ont pas besoin de plus d'un rendu toutes les 10 s :
  // chaque image écrite coûte (ConPTY surtout). 10 images/s SEULEMENT pendant qu'une action tourne.
  React.useEffect(() => {
    const id = setInterval(() => setVersion((v) => v + 1), IDLE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const hasPending = activity.some((entry) => entry.status === 'pending');
  React.useEffect(() => {
    if (!hasPending || !caps.animate) return undefined;
    const id = setInterval(() => setVersion((v) => v + 1), 100);
    return () => clearInterval(id);
  }, [hasPending, caps.animate]);

  // ── rafraîchissement des données ──
  React.useEffect(() => {
    const manager = tailManagerRef.current!;
    let cancelled = false;
    let refreshing = false;
    let again = false; // un événement est arrivé pendant un rafraîchissement : en refaire un juste après
    const refresh = async () => {
      if (refreshing) {
        again = true;
        return;
      }
      refreshing = true;
      try {
        // Trois lectures indépendantes : en parallèle (la collecte à froid les enchaînait).
        const [list, tickets, queue] = await Promise.all([
          listAgents(root),
          listConflictTickets(root).catch(() => []),
          getQueueDashboard({ root }).catch(() => []),
        ]);
        if (cancelled) return;
        // Date du dernier commit : une lecture git par HEAD jamais vu, pas par rafraîchissement.
        const missing = list.filter(
          (a) => a.status === 'ACTIVE' && a.head && !commitDates.current.has(a.head),
        );
        await Promise.all(
          missing.map(async (a) => {
            try {
              const out = await cloneGit(a.path).raw(['log', '-1', '--format=%cI']);
              commitDates.current.set(a.head, out.trim() || null);
            } catch {
              commitDates.current.set(a.head, null); // clone illisible : l'état BROKEN l'affiche déjà
            }
          }),
        );
        if (commitDates.current.size > 200) commitDates.current.clear();
        if (cancelled) return;
        const ticketByAgent = new Map<string, { id: string; reason: string }>();
        for (const t of tickets as Array<{ id: string; agent?: string; reason?: string }>) {
          if (typeof t.agent === 'string' && !ticketByAgent.has(t.agent)) {
            ticketByAgent.set(t.agent, { id: t.id, reason: t.reason ?? '?' });
          }
        }
        // Inactivité (GC) : lecture en lecture seule, mémoïsée ~15 s, jamais bloquante (un GC
        // indisponible n'a simplement pas de cellule).
        const idleByAgent = await idleProvider
          .current(list)
          .catch(() => new Map<string, IdleCell>());
        if (cancelled) return;
        const nextRows = list.map((a) =>
          toAgentRow(
            a,
            ticketByAgent.get(a.name) ?? null,
            commitDates.current.get(a.head) ?? null,
            idleByAgent.get(a.name) ?? null,
          ),
        );
        const waiting = (queue as Array<{ status: string }>).filter(
          (r) => r.status === 'WAITING',
        ).length;
        metasRef.current = list;
        lastRefreshAt.current = Date.now();
        // Rien n'a changé : aucun état React touché, donc aucune repeinture.
        const signature = JSON.stringify([nextRows, tickets.length, waiting]);
        if (signature !== dataSignature.current) {
          dataSignature.current = signature;
          setAgentRows(nextRows);
          setOpenTickets(tickets.length);
          setQueueWaiting(waiting);
        }
        setLoaded(true);
        setRefreshError(null);
        const attended = list.filter((a) => a.status === 'ACTIVE' && a.mode !== 'autonomous');
        const attendedNames = new Set(attended.map((a) => a.name));
        for (const agentMeta of attended) void manager.ensure(agentMeta);
        for (const name of manager.trackedAgents()) {
          if (!attendedNames.has(name)) manager.release(name);
        }
      } catch (error) {
        // Remonté, jamais avalé : une erreur permanente (mauvaise racine, registre
        // corrompu) doit se VOIR, pas se traduire par un écran vide sans explication.
        if (!cancelled) setRefreshError((error as Error).message);
      } finally {
        refreshing = false;
        if (again && !cancelled) {
          again = false;
          void refresh();
        }
      }
    };
    let soonTimer: NodeJS.Timeout | null = null;
    refreshSoon.current = () => {
      if (soonTimer) return;
      soonTimer = setTimeout(() => {
        soonTimer = null;
        void refresh();
      }, 250);
    };
    void refresh();
    const interval = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (soonTimer) clearTimeout(soonTimer);
      refreshSoon.current = () => {};
      manager.releaseAll();
    };
  }, [root]);

  // ── détail de l'agent sélectionné (lu dans son clone) ──
  const selectedKey = selectedRow
    ? `${selectedRow.name}|${selectedRow.pendingCommits}|${selectedRow.lastCommitAt ?? ''}`
    : '';
  React.useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;
    const load = async () => {
      const meta = metasRef.current.find((a) => a.name === selected);
      if (!meta || meta.status !== 'ACTIVE') return;
      const info = await readAgentDetail(meta);
      if (cancelled) return;
      const signature = `${selected}|${JSON.stringify(info)}`;
      if (signature === detailSignature.current) return;
      detailSignature.current = signature;
      setDetailState({ name: selected, info });
    };
    void load();
    const id = setInterval(load, DETAIL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // La clé change quand les commits de l'agent changent : relecture immédiate.
  }, [selected, selectedKey]);

  // Arrêt : même séquence pour Ctrl+C, `q` et `/exit` — le watcher du process s'arrête avec l'UI.
  const shutdown = React.useCallback(() => {
    tailManagerRef.current?.releaseAll();
    exit();
  }, [exit]);

  const sendAgentMessage = React.useCallback(
    (agentName: string, text: string) => {
      setSelected(agentName);
      const activityId = pushActivity(m.watchUi.sending(agentName));
      void resolveAgentMeta(root, metasRef.current, agentName)
        .then((meta) => routeAgentMessage(root, agentName, text, meta, m))
        .then((result: MessageRouteResult) => {
          // `'reason' in result`, pas `if (result.ok)` : contourne un défaut de
          // rétrécissement d'union (TS7 natif, `strict: false`) — cf. routeAgentMessage.
          if ('reason' in result) {
            resolveActivity(activityId, 'error', result.reason);
            addJournal({
              tone: 'error',
              text: `${m.watchUi.sending(agentName)} — ${result.reason}`,
            });
          } else {
            resolveActivity(activityId, 'ok');
          }
        });
    },
    [root, m, pushActivity, resolveActivity, addJournal],
  );

  /** Lance `striart <argv>` (même code que la CLI) ; la sortie va au panneau Commandes, le résultat au journal. */
  const runCliAction = React.useCallback(
    (label: string, argv: string[], echo: string) => {
      const activityId = pushActivity(label);
      const startedAt = Date.now();
      void runStriartCommand(root, argv, m).then((result) => {
        tailManagerRef.current!.appendCommandOutput(`❯ ${echo}`, result.output);
        const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
        resolveActivity(
          activityId,
          result.ok ? 'ok' : 'error',
          result.ok ? undefined : c.seeCommands,
        );
        addJournal({
          tone: result.ok ? 'ok' : 'error',
          text: `${c.done(label, elapsed)}${result.ok ? '' : ` — ${c.seeCommands}`}`,
        });
        refreshSoon.current();
      });
    },
    [root, m, c, pushActivity, resolveActivity, addJournal],
  );

  const blurInput = React.useCallback(() => {
    setInputFocused(false);
    setInput({ text: '', cursor: 0 });
    setSelectionIndex(0);
    setHistoryIndex(-1);
    setDraftInput('');
  }, []);

  /**
   * Grammaire du champ : « / » pour les commandes striart (y compris « /exit »,
   * natif à ce panneau), « ! » pour un vrai shell, « @agent texte » pour écrire
   * à un agent, texte nu → agent sélectionné.
   */
  const submitLine = React.useCallback(
    (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      setHistory((prev) =>
        prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed].slice(-HISTORY_MAX_ENTRIES),
      );

      if (trimmed.startsWith('!')) {
        const command = trimmed.slice(1).trim();
        if (!command) return;
        setBottom('commands');
        setUnread((prev) => ({ ...prev, commands: false }));
        const activityId = pushActivity(`! ${command}`);
        void runShellCommand(root, command).then((result) => {
          tailManagerRef.current!.appendCommandOutput(`❯ ${trimmed}`, result.output);
          resolveActivity(
            activityId,
            result.ok ? 'ok' : 'error',
            result.ok ? undefined : c.seeCommands,
          );
        });
        return;
      }

      if (trimmed.startsWith('/')) {
        const rest = trimmed.slice(1).trim();
        if (!rest) return;
        const [cmd] = tokenizeCommand(rest);
        if (cmd === 'exit') {
          shutdown();
          return;
        }
        // « /clear » : dans le détail d'un agent, la VRAIE commande d'effacement de son
        // shell (même frontière de confiance que le bus @agent, SECURITY.md) ; ailleurs,
        // l'historique du panneau Commandes.
        if (cmd === 'clear') {
          if (view === 'zoom' && selected) {
            sendAgentMessage(selected, process.platform === 'win32' ? 'cls' : 'clear');
          } else {
            tailManagerRef.current!.clearTerminalTab();
          }
          return;
        }
        if (cmd === 'relaunch') {
          const targetAgent = tokenizeCommand(rest)[1] ?? selected;
          const activityId = pushActivity(
            targetAgent ? m.watchUi.relaunching(targetAgent) : 'striart relaunch',
          );
          if (!targetAgent) {
            resolveActivity(activityId, 'error', m.watchUi.relaunchNoAgent);
            return;
          }
          setSelected(targetAgent);
          void resolveAgentMeta(root, metasRef.current, targetAgent)
            .then(async (meta) => {
              if (!meta) return { ok: false as const, reason: m.watchUi.unknownAgent(targetAgent) };
              // Une session autonome n'a pas d'outil à relancer dans un pty : un contresens.
              if (meta.mode === 'autonomous')
                return { ok: false as const, reason: m.watchUi.relaunchAutonomous(targetAgent) };
              const tool = await resolveAttendedCommand(root, meta);
              return routeAgentMessage(root, targetAgent, tool, meta, m);
            })
            .then((result: MessageRouteResult) => {
              if ('reason' in result) resolveActivity(activityId, 'error', result.reason);
              else resolveActivity(activityId, 'ok');
            });
          return;
        }
        setBottom('commands');
        setUnread((prev) => ({ ...prev, commands: false }));
        runCliAction(`striart ${rest}`, tokenizeCommand(rest), trimmed);
        return;
      }

      if (trimmed.startsWith('@')) {
        const parsed = parseAgentMessage(trimmed);
        // « @ » incomplet : rien à envoyer, jamais pris pour du texte vers l'agent sélectionné.
        if (parsed) sendAgentMessage(parsed.agent, parsed.text);
        return;
      }

      if (selected) sendAgentMessage(selected, trimmed);
    },
    [
      root,
      m,
      c,
      view,
      selected,
      pushActivity,
      resolveActivity,
      shutdown,
      sendAgentMessage,
      runCliAction,
    ],
  );

  // ── suggestions (champ en saisie seulement) ──
  const suggestions = inputFocused ? computeSuggestions(input.text, metasRef.current, m) : [];
  const activeSuggestion =
    suggestions.length > 0 ? Math.min(selectionIndex, suggestions.length - 1) : 0;

  const scrollBy = (delta: number) => {
    if (view === 'zoom') setOutputScroll((o) => Math.max(0, o + delta));
    else if (bottom === 'journal') setJournalScroll((o) => Math.max(0, o + delta));
    else setCommandsScroll((o) => Math.max(0, o + delta));
  };

  const confirmedMerge = () => {
    const agent = confirmAgent;
    setConfirmAgent(null);
    setView('main');
    if (agent) runCliAction(c.merging(agent), ['merge', agent], `striart merge ${agent}`);
  };

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      shutdown();
      return;
    }

    // Confirmation d'une action risquée : SEUL « y » la déclenche (Entrée n'est jamais un oui).
    if (view === 'confirm') {
      if (char === 'y' || char === 'Y') confirmedMerge();
      else if (key.escape || char === 'n' || char === 'N') {
        setConfirmAgent(null);
        setView('main');
      }
      return;
    }

    // Champ de saisie : tout caractère imprimable est du texte, aucun raccourci ne part.
    if (inputFocused) {
      if (key.escape) {
        blurInput();
        return;
      }
      if (key.tab || key.return) {
        if (suggestions.length > 0) {
          const chosen = suggestions[activeSuggestion];
          const text = `${input.text[0]}${chosen.value} `;
          setInput({ text, cursor: [...text].length });
          setSelectionIndex(0);
          return;
        }
        if (key.tab) return;
      }
      if (key.upArrow || key.downArrow) {
        if (suggestions.length > 0) {
          setSelectionIndex((i) => {
            const next = key.upArrow ? i - 1 : i + 1;
            return ((next % suggestions.length) + suggestions.length) % suggestions.length;
          });
          return;
        }
        if (history.length === 0) return;
        if (key.upArrow) {
          if (historyIndex === -1) setDraftInput(input.text);
          const nextIndex =
            historyIndex === -1 ? history.length - 1 : Math.max(historyIndex - 1, 0);
          setHistoryIndex(nextIndex);
          setInput({ text: history[nextIndex], cursor: [...history[nextIndex]].length });
        } else if (historyIndex !== -1) {
          const nextIndex = historyIndex + 1;
          if (nextIndex >= history.length) {
            setHistoryIndex(-1);
            setInput({ text: draftInput, cursor: [...draftInput].length });
          } else {
            setHistoryIndex(nextIndex);
            setInput({ text: history[nextIndex], cursor: [...history[nextIndex]].length });
          }
        }
        return;
      }
      if (key.pageUp || key.pageDown) {
        scrollBy(key.pageUp ? PAGE_SIZE : -PAGE_SIZE);
        return;
      }
      const result = editInput(input, char, key);
      if (result.submit !== null) {
        const line = result.submit;
        blurInput();
        submitLine(line);
        return;
      }
      setInput(result.buffer);
      setSelectionIndex(0);
      setHistoryIndex(-1);
      return;
    }

    // Aide en surcouche.
    if (view === 'help') {
      if (key.escape || char === '?') setView('main');
      else if (char === 'q') shutdown();
      return;
    }

    // Un collage ou une frappe rapide qui commence par un préfixe de saisie : le champ le reçoit en entier.
    if (char.length > 1 && !key.ctrl && !key.meta && /^[/@!]/.test(char)) {
      const result = editInput({ text: '', cursor: 0 }, char, key);
      if (result.submit !== null) submitLine(result.submit);
      else {
        setInputFocused(true);
        setInput(result.buffer);
      }
      return;
    }

    const action = navAction(char, key);
    if (!action) return;
    switch (action.type) {
      case 'quit':
        shutdown();
        return;
      case 'help':
        setView('help');
        return;
      case 'back':
        if (view === 'zoom') setView('main');
        else if (view === 'main') {
          if (bottom === 'journal') setJournalScroll(0);
          else setCommandsScroll(0);
        }
        return;
      case 'select':
        if (view === 'zoom') {
          scrollBy(-action.delta);
          return;
        }
        setSelected(
          moveSelection(
            ordered.map((a) => a.name),
            selected,
            action.delta,
          ),
        );
        setOutputScroll(0);
        return;
      case 'select-edge':
        if (view !== 'zoom') {
          setSelected(
            ordered.length === 0
              ? null
              : ordered[action.edge === 'first' ? 0 : ordered.length - 1].name,
          );
        }
        return;
      case 'scroll':
        scrollBy(action.delta);
        return;
      case 'pane': {
        if (view !== 'main') return;
        const next: BottomPane = bottom === 'journal' ? 'commands' : 'journal';
        setBottom(next);
        setUnread((prev) => ({ ...prev, [next]: false }));
        return;
      }
      case 'zoom':
        if (selected && view === 'main') {
          setOutputScroll(0);
          setView('zoom');
        }
        return;
      case 'focus':
        setInputFocused(true);
        // « @ » pré-remplit le nom de l'agent sélectionné : on n'a qu'à écrire le message.
        {
          const text = action.prefix === '@' && selected ? `@${selected} ` : action.prefix;
          setInput({ text, cursor: [...text].length });
        }
        return;
      case 'merge':
        if (selected) {
          setConfirmAgent(selected);
          setView('confirm');
        }
        return;
      case 'sync':
        if (selected)
          runCliAction(c.syncing(selected), ['sync', selected], `striart sync ${selected}`);
        return;
    }
  });

  // ── trame ──
  const detail = detailState && detailState.name === selected ? detailState.info : null;
  const isCommandsEmpty = tail.get(TERMINAL_TAB).lines.every((l) => l.length === 0);
  const selectedLog = selected
    ? tail.get(selected)
    : { lines: [] as StyledChunk[][], connected: false };
  const confirmRow = confirmAgent ? agentRows.find((a) => a.name === confirmAgent) : undefined;
  const confirm: ConfirmView | null =
    view === 'confirm' && confirmAgent
      ? {
          title: c.confirmMergeTitle(confirmAgent, targetBranch),
          lines: [
            confirmRow && confirmRow.pendingCommits > 0
              ? c.confirmMergePending(confirmRow.pendingCommits)
              : c.confirmMergeNone,
            c.confirmMergeGate,
            ...(confirmRow?.session?.via === 'autonomous' && confirmRow.session.state === 'running'
              ? [c.confirmMergeLive]
              : []),
            ...(confirmRow?.ticket ? [c.confirmMergeTicket] : []),
          ],
        }
      : null;

  const model: FrameModel = {
    cols: columns,
    rows,
    now: Date.now(),
    root,
    targetBranch,
    autoMerge,
    loaded,
    refreshError,
    lastRefreshAt: lastRefreshAt.current,
    agents: agentRows,
    selected,
    openTickets,
    queueWaiting,
    detail,
    view,
    bottom,
    unread,
    journal: journalRef.current,
    journalScroll,
    commandLines: isCommandsEmpty ? [] : chunkLines(tail.get(TERMINAL_TAB).lines),
    commandsScroll,
    outputLines: chunkLines(selectedLog.lines),
    outputConnected: selectedLog.connected || selectedRow?.mode === 'autonomous',
    idleTool: selectedLog.connected && looksLikeIdleShellPrompt(selectedLog.lines),
    outputScroll,
    confirm,
    input: { focused: inputFocused, text: input.text, cursor: input.cursor },
    suggestions,
    activeSuggestion,
    activity,
  };
  const frame = buildFrame(model, { m, caps });
  return h(
    Box,
    { flexDirection: 'column', width: columns },
    ...frame.map((line, i) => renderLine(line, i, caps)),
  );
}

/** Capacités par défaut quand l'appelant n'en fournit pas (tests, usage direct). */
function defaultCaps(): CockpitCaps {
  const caps = detectCapabilities({
    env: process.env,
    platform: process.platform,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    plain: false,
    color: null,
  });
  return caps;
}

/**
 * Point d'entrée : `striart watch --ui`. Résout quand l'utilisateur quitte
 * (`q`, `/exit`, Ctrl+C) ou quand la CLI abandonne `signal`.
 *
 * `alternateScreen` : écran alternatif natif d'Ink (mécanisme de vim/htop) —
 * le terminal est restauré tel qu'avant à la sortie. `incrementalRendering` +
 * `maxFps` : seules les lignes qui changent sont réécrites, à ≤ 12 images/s
 * (pas de scintillement, CPU au repos négligeable). `--plain` / `TERM=dumb` :
 * pas d'écran plein du tout, mode linéaire lisible par un lecteur d'écran.
 */
export async function runWatchUi(
  root: string,
  {
    subscribeLoop,
    messages = fr,
    signal,
    caps = defaultCaps(),
    autoMerge = true,
    io,
  }: {
    subscribeLoop?: WatchLineSubscription;
    messages?: Messages;
    /** Arrêt demandé de l'extérieur (SIGINT/SIGTERM reçus par la CLI) : l'UI se démonte. */
    signal?: AbortSignal;
    /** Capacités du terminal (sonde unique de la CLI). */
    caps?: CockpitCaps;
    /** Le watcher du process fusionne-t-il automatiquement ? (informatif) */
    autoMerge?: boolean;
    /** Flux d'E/S d'Ink (tests : terminal simulé) ; défaut = le vrai terminal. */
    io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
  } = {},
): Promise<void> {
  if (signal?.aborted) return;
  if (caps.plain) {
    const { runWatchPlain } = await import('./watch-plain.ts');
    await runWatchPlain(root, { subscribeLoop, messages, signal, caps, autoMerge, io });
    return;
  }
  const instance = render(h(App, { root, subscribeLoop, m: messages, caps, autoMerge }), {
    ...(io ?? {}),
    alternateScreen: true,
    exitOnCtrlC: false,
    // Aucun console.* dans le produit (journaux dans un fichier) : rien à rediriger dans l'écran.
    patchConsole: false,
    maxFps: 12,
    incrementalRendering: true,
    // `caps.plain` a déjà écarté le cas non interactif (répartition ci-dessus, et
    // src/cli/caps.ts pour la détection CI/TTY) : arrivé ici, le mode interactif
    // d'Ink doit s'appliquer. Sans ce `true`, Ink détecte lui-même l'environnement
    // via `is-in-ci` et désactive tout rendu incrémental dès que CI (ou un outil
    // comme vitest) positionne CI=1 dans le process — l'écran ne s'écrit alors
    // qu'au démontage, jamais en continu (vu en CI : les tests d'écran simulé,
    // qui attendent un rendu immédiat, expiraient silencieusement).
    interactive: true,
  });
  const onAbort = () => instance.unmount();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await instance.waitUntilExit();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
