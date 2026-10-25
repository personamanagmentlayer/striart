import React from 'react';
import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink';
import { execa } from 'execa';
import xtermHeadless from '@xterm/headless';
import { fileURLToPath } from 'node:url';
import { listAgents } from './clone.js';
import { listConflictTickets } from './conflicts.js';
import { connectAttachClient } from './pty-attach.ts';
import { defaultShell, ensurePtyHost, resolveAttendedCommand } from './pty-host.ts';
import { sendHumanPrompt } from './acp/host.ts';
import type { AgentMeta } from './types.js';
import { fr } from './cli/i18n/fr.ts';
import type { Messages } from './cli/i18n/fr.ts';
import { publicCommands } from './cli/registry.ts';
import type { ForegroundReason } from './cli/registry.ts';
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
 * Palette de marque Striart — cyan (structure/neutre/en cours), violet
 * (succès/sélection), rouge (erreur — jamais discret). Trois principes de
 * design retenus pour cette UI : (1) jamais de silence — chaque action a
 * une confirmation visible avec un temps écoulé, pas un état qui disparaît
 * sans laisser de trace ; (2) l'erreur est une procédure — un ticket créé
 * (`printMergeResult`, déjà ainsi côté CLI) reste visible, jamais juste
 * « échec » ; (3) le TUI est un cockpit — l'état qui compte (tickets
 * ouverts) est affiché en permanence, jamais un aller chercher ailleurs.
 */
const COLOR = { cyan: '#00D4AA', violet: '#7B61FF', red: '#FF4D4D' };

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

interface LogState {
  lines: StyledChunk[][];
  connected: boolean;
}

/**
 * Une action visible du cockpit (principe « jamais de silence ») — de son
 * lancement à sa conclusion, avec le temps écoulé. `detail` porte la
 * procédure en cas d'erreur (principe « l'erreur est une procédure ») : la
 * sortie complète d'une commande striart (ticket compris, cf.
 * `printMergeResult`), pas juste un « échec » laconique.
 */
interface ActivityEntry {
  id: number;
  label: string;
  status: 'pending' | 'ok' | 'error';
  startedAt: number;
  endedAt: number | null;
  detail?: string;
}

const MAX_ACTIVITY_ENTRIES = 4;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Lignes remontées par pression Page Up/Down — fixe plutôt qu'accordé à la
 * hauteur réelle du tab : simple, prévisible, pas besoin d'exactitude ici. */
const SCROLL_PAGE_SIZE = 10;
/** Entrées d'historique de saisie conservées (mémoire, pas persistant). */
const HISTORY_MAX_ENTRIES = 200;

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

/** Abonnement aux lignes de la boucle de watch : rend la fonction de désabonnement. */
export type WatchLineSubscription = (listener: (line: string) => void) => () => void;

interface AppProps {
  root: string;
  /**
   * Événements de la boucle de `watch` qui tourne dans le même process,
   * déjà mis en forme par la CLI. Affichés dans le tab "Terminal" — jamais
   * écrits sur l'écran alternatif, où ils corrompraient le rendu.
   */
  subscribeLoop?: WatchLineSubscription;
  /** Catalogue de la langue choisie par la CLI. */
  m: Messages;
}

function statusIcon(agent: AgentMeta & { name: string; status: string }): string {
  if (agent.mode === 'autonomous') return '🤖';
  return agent.status === 'ACTIVE' ? '👤' : '⚪';
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
    let description: string = m.commands[spec.name as keyof Messages['commands']].summary;
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

const MAX_SUGGESTIONS_SHOWN = 8;

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

function App({ root, subscribeLoop, m }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [agents, setAgents] = React.useState<Array<AgentMeta & { name: string; status: string }>>(
    [],
  );
  // TERMINAL_TAB par défaut — le tab "Terminal" est toujours disponible,
  // jamais un agent absent : pas de course de démarrage à gérer ici.
  const [selected, setSelected] = React.useState<string | null>(TERMINAL_TAB);
  const [loaded, setLoaded] = React.useState(false); // vrai après le 1er listAgents() réussi
  const [input, setInput] = React.useState('');
  const [selectionIndex, setSelectionIndex] = React.useState(0);
  const [openTickets, setOpenTickets] = React.useState(0);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<ActivityEntry[]>([]);
  const [, bumpTick] = React.useState(0);
  // Tabs dont le contenu a changé pendant qu'un AUTRE tab était affiché —
  // purement informatif (aucune notion de "lu" persistée), effacé dès que
  // l'utilisateur bascule dessus (cf. l'effect plus bas).
  const [unread, setUnread] = React.useState<Set<string>>(new Set());
  // Toujours à jour pour la fermeture d'`onChange` ci-dessous, créée UNE
  // SEULE fois via l'init paresseuse de `tailManagerRef` — sans cette ref,
  // elle capturerait la valeur de `selected` du tout premier rendu pour
  // toujours (école du piège classique de fermeture React).
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  const tailManagerRef = React.useRef<LogTailManager | null>(null);
  if (!tailManagerRef.current) {
    tailManagerRef.current = new LogTailManager(root, (key) => {
      bumpTick((t) => t + 1);
      if (key !== selectedRef.current) {
        setUnread((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
      }
    });
  }
  const activityIdRef = React.useRef(0);
  // Historique des lignes soumises (tous préfixes confondus) — `↑`/`↓`
  // rappellent une entrée quand le champ n'est pas vide et qu'aucune
  // suggestion n'est active (cf. useInput) ; `-1` = pas en train de
  // parcourir, `draftInput` garde ce qui était tapé avant d'y entrer.
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [draftInput, setDraftInput] = React.useState('');
  // Lignes remontées depuis le bas dans le tab affiché (Page Up/Down) —
  // remis à 0 à chaque changement de tab (cf. effect plus bas) : on atterrit
  // toujours sur le direct en changeant d'onglet, jamais sur un ancien
  // défilement oublié.
  const [scrollOffset, setScrollOffset] = React.useState(0);

  // Principe « jamais de silence » : chaque action lancée depuis le champ de
  // saisie reste visible, du départ à la conclusion, avec son temps écoulé —
  // jamais une ligne de statut unique qui écrase la précédente sans laisser
  // de trace.
  const pushActivity = React.useCallback((label: string): number => {
    const id = ++activityIdRef.current;
    setActivity((list) =>
      [
        ...list,
        { id, label, status: 'pending' as const, startedAt: Date.now(), endedAt: null },
      ].slice(-MAX_ACTIVITY_ENTRIES),
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

  // Changer de tab : on atterrit toujours sur le direct (pas un défilement
  // oublié d'une visite précédente), et le tab qu'on vient d'ouvrir n'a plus
  // de raison de rester marqué "non lu".
  React.useEffect(() => {
    setScrollOffset(0);
    if (!selected) return;
    setUnread((prev) => {
      if (!prev.has(selected)) return prev;
      const next = new Set(prev);
      next.delete(selected);
      return next;
    });
  }, [selected]);

  // Lignes de la boucle de watch (commit, merge, rebase…) → tab "Terminal".
  React.useEffect(() => {
    if (!subscribeLoop) return undefined;
    return subscribeLoop((line) => tailManagerRef.current?.appendLine(line));
  }, [subscribeLoop]);

  // Fait avancer le chronomètre des actions en cours — seulement pendant
  // qu'il y en a une, pour ne pas redessiner pour rien une fois tout réglé.
  React.useEffect(() => {
    if (!activity.some((entry) => entry.status === 'pending')) return undefined;
    const ticker = setInterval(() => bumpTick((t) => t + 1), 200);
    return () => clearInterval(ticker);
  }, [activity]);

  // Rafraîchit la liste des agents et garde une connexion de lecture par
  // agent supervisé actif — jamais pour l'autonome (pas de pty à suivre).
  React.useEffect(() => {
    const manager = tailManagerRef.current!;
    let cancelled = false;
    let refreshing = false; // pas de chevauchement si un listAgents traîne (plusieurs agents = plusieurs commandes git)
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const list = await listAgents(root);
        if (cancelled) return;
        setAgents(list);
        setLoaded(true);
        setRefreshError(null);
        const attended = list.filter((a) => a.status === 'ACTIVE' && a.mode !== 'autonomous');
        const attendedNames = new Set(attended.map((a) => a.name));
        for (const agentMeta of attended) void manager.ensure(agentMeta);
        for (const name of manager.trackedAgents()) {
          if (!attendedNames.has(name)) manager.release(name);
        }
        setSelected((current) => {
          // TERMINAL_TAB n'est jamais dans attendedNames (ce n'est pas un
          // agent) : sans ce garde, le tick de rafraîchissement (2s) le
          // remplacerait par le premier agent dès qu'il y en a un.
          if (current === TERMINAL_TAB) return current;
          if (current && attendedNames.has(current)) return current;
          return [...attendedNames][0] ?? TERMINAL_TAB;
        });
        // Principe « cockpit » : les tickets ouverts (procédure d'erreur en
        // cours — Test Gate rouge, conflit hors fusion sémantique...) sont
        // affichés en permanence, jamais un aller voir ailleurs pour savoir
        // s'il y a du travail humain en attente.
        const tickets = await listConflictTickets(root).catch(() => []);
        if (!cancelled) setOpenTickets(tickets.length);
      } catch (error) {
        // Remonté, jamais avalé en silence — une erreur permanente (mauvais
        // root, registre corrompu...) doit être VISIBLE, pas se traduire par
        // un panneau vide indéfiniment sans explication.
        if (!cancelled) setRefreshError((error as Error).message);
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const interval = setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      manager.releaseAll();
    };
  }, [root]);

  // Partagé entre Ctrl+C et "/exit" tapé dans le champ — même séquence
  // d'arrêt, jamais dupliquée : `watch --ui` porte aussi le watcher habituel
  // (chokidar, intervals de fetch/réconciliation, chaîne de merge), le mode
  // raw d'Ink n'intercepte jamais Ctrl+C comme un vrai SIGINT, donc sans ce
  // `process.exit` ces handles actifs garderaient le process vivant,
  // invisible, après la disparition de l'UI.
  const shutdown = React.useCallback(() => {
    // Sortie voulue : l'UI se démonte, `runWatchUi` rend la main et la
    // commande `watch` arrête proprement la boucle (watchers, timers)
    // avant de sortir en 0.
    tailManagerRef.current?.releaseAll();
    exit();
  }, [exit]);

  // Partagé entre "@agent message" et le texte sans préfixe (envoyé à
  // l'agent sélectionné) — même acheminement, jamais dupliqué.
  const sendAgentMessage = React.useCallback(
    (agentName: string, text: string) => {
      setSelected(agentName);
      const activityId = pushActivity(m.watchUi.sending(agentName));
      void resolveAgentMeta(root, agents, agentName)
        .then((meta) => routeAgentMessage(root, agentName, text, meta, m))
        .then((result: MessageRouteResult) => {
          // `'reason' in result`, pas `if (result.ok)` : contourne un bug de
          // rétrécissement de union discriminée par littéral booléen dans
          // @typescript/native (TS7) sous `strict: false` explicite (tsconfig
          // du projet) — reproduit et isolé en bisectant les compilerOptions,
          // absent de TS6 et absent quand `strict` n'est pas déclaré du tout.
          if ('reason' in result) {
            resolveActivity(activityId, 'error', result.reason);
          } else {
            resolveActivity(activityId, 'ok');
          }
        });
    },
    [agents, root, pushActivity, resolveActivity, m],
  );

  /**
   * Grammaire du champ, revue le 2026-09-10 : "/" pour TOUTES les commandes
   * striart (y compris "/exit", natif à ce panneau) plutôt que du texte nu —
   * cohérent avec l'autocomplétion ("/" liste les commandes, "@" liste les
   * agents) et avec les outils hébergés eux-mêmes (Claude Code utilise déjà
   * "/" pour ses propres commandes). Le texte SANS préfixe n'est plus une
   * commande implicite : il part vers l'agent actuellement sélectionné, pour
   * ne plus avoir à retaper "@agent-a" à chaque message vers le même agent —
   * seul "@autre-agent" reste nécessaire pour changer de cible.
   */
  const submitLine = React.useCallback(
    (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Historique de saisie (`↑`/`↓` le rappellent, cf. useInput) — tous
      // préfixes confondus, dédoublonné sur les répétitions consécutives
      // (marteler Entrée sur la même commande n'empile pas de doublons).
      setHistory((prev) =>
        prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed].slice(-HISTORY_MAX_ENTRIES),
      );
      setHistoryIndex(-1);
      setDraftInput('');

      if (trimmed.startsWith('!')) {
        const command = trimmed.slice(1).trim();
        if (!command) return; // "!" seul : rien à faire
        // Même canal de sortie/activité que "/" — voir plus bas — mais un
        // VRAI shell (`runShellCommand`) plutôt qu'un argv `striart` : pas de
        // garde "premier plan" ici, un shell interactif au sens plein (build
        // qui tourne longtemps, `git log` sans --no-pager qui attend une
        // touche...) reste possible et bloquera le champ jusqu'au même
        // timeout de 120s que "/" — attendu d'un vrai shell, pas un bug.
        const activityId = pushActivity(`! ${command}`);
        void runShellCommand(root, command).then((result) => {
          tailManagerRef.current!.appendCommandOutput(`❯ ${trimmed}`, result.output);
          resolveActivity(
            activityId,
            result.ok ? 'ok' : 'error',
            result.ok ? undefined : m.watchUi.seeTerminalTab,
          );
        });
        return;
      }

      if (trimmed.startsWith('/')) {
        const rest = trimmed.slice(1).trim();
        if (!rest) return; // "/" seul : rien à faire
        const [cmd] = tokenizeCommand(rest);
        if (cmd === 'exit') {
          shutdown();
          return;
        }
        // "/clear" — adapté à l'onglet actif, pas un seul comportement :
        // sur TERMINAL_TAB, vide notre propre historique de sorties de
        // commandes (rien d'autre à effacer, ce n'est pas un vrai pty) ;
        // sur un agent, envoie la VRAIE commande d'effacement de son shell
        // (`defaultShell()` — PowerShell/`cls`, POSIX/`clear`) : la même
        // frontière de confiance que le bus "@agent" (SECURITY.md), pas un
        // nettoyage local qui laisserait l'écran distant réel inchangé.
        if (cmd === 'clear') {
          if (selected === TERMINAL_TAB) {
            tailManagerRef.current!.clearTerminalTab();
          } else if (selected) {
            sendAgentMessage(selected, process.platform === 'win32' ? 'cls' : 'clear');
          }
          return;
        }
        // "/relaunch [agent]" — retape la commande de lancement de l'agent
        // (`resolveAttendedCommand`, même résolution que `--open`/l'hôte de
        // pty) : utile quand le badge 🟡 signale que l'outil hébergé s'est
        // arrêté dans un pty par ailleurs toujours vivant. Sans argument,
        // cible l'agent actuellement sélectionné (jamais TERMINAL_TAB, qui
        // n'est pas un agent).
        if (cmd === 'relaunch') {
          const argAgent = tokenizeCommand(rest)[1];
          const targetAgent = argAgent ?? (selected !== TERMINAL_TAB ? selected : null);
          const activityId = pushActivity(
            targetAgent ? m.watchUi.relaunching(targetAgent) : 'striart relaunch',
          );
          if (!targetAgent) {
            resolveActivity(activityId, 'error', m.watchUi.relaunchNoAgent);
            return;
          }
          setSelected(targetAgent);
          void resolveAgentMeta(root, agents, targetAgent)
            .then(async (meta) => {
              if (!meta) return { ok: false as const, reason: m.watchUi.unknownAgent(targetAgent) };
              // Une session autonome n'a pas d'outil à relancer dans un pty :
              // envoyer la commande de l'outil comme prompt serait un contresens.
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
        // Sortie dans le tab TERMINAL_TAB (`appendCommandOutput`), jamais via
        // `console.log` : sur écran alternatif (`alternateScreen: true`)
        // `console.log`/`patchConsole` n'a aucun scrollback — la sortie
        // disparaît dès qu'un redessin la recouvre. La procédure complète
        // (ticket, chemin de résolution — `printMergeResult` la construit
        // déjà côté CLI) reste donc consultable en revenant sur ce tab,
        // jamais réduite à un « échec » dans le cockpit.
        const activityId = pushActivity(`striart ${rest}`);
        void runStriartCommand(root, tokenizeCommand(rest), m).then((result) => {
          tailManagerRef.current!.appendCommandOutput(`❯ ${trimmed}`, result.output);
          resolveActivity(
            activityId,
            result.ok ? 'ok' : 'error',
            result.ok ? undefined : m.watchUi.seeTerminalTab,
          );
        });
        return;
      }

      if (trimmed.startsWith('@')) {
        const parsed = parseAgentMessage(trimmed);
        // "@" incomplet (pas encore de message après le nom, ex. autocomplétion
        // à peine validée) : rien à envoyer, jamais interprété comme du texte
        // littéral vers l'agent sélectionné.
        if (parsed) sendAgentMessage(parsed.agent, parsed.text);
        return;
      }

      // TERMINAL_TAB n'est pas un agent — un texte nu tapé pendant qu'il est
      // affiché n'a nulle part où aller, contrairement à un vrai agent
      // sélectionné.
      if (selected && selected !== TERMINAL_TAB) sendAgentMessage(selected, trimmed);
    },
    [selected, agents, root, pushActivity, resolveActivity, shutdown, sendAgentMessage, m],
  );

  // Recalculées à chaque rendu (donc à jour dans la fermeture de useInput
  // ci-dessous) — cf. `computeSuggestions` : liste vide dès qu'on est déjà
  // dans le corps du message ou les arguments (un espace après le premier mot).
  const suggestions = computeSuggestions(input, agents, m);
  const activeSuggestionIndex =
    suggestions.length > 0 ? Math.min(selectionIndex, suggestions.length - 1) : 0;

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      shutdown();
      return;
    }

    // Tab ou Entrée SUR une suggestion active : complète le mot en cours
    // plutôt que de soumettre — même convention que Discord/Slack (une
    // deuxième pression sur Entrée, une fois la liste vide car le mot est
    // déjà complet, envoie enfin). Le préfixe ("@" ou "/") est celui déjà
    // tapé, jamais deviné.
    if ((key.tab || key.return) && suggestions.length > 0) {
      setInput(`${input[0]}${suggestions[activeSuggestionIndex].value} `);
      setSelectionIndex(0);
      return;
    }

    // `char` est parfois un CHUNK de plusieurs caractères d'un coup (frappe
    // rapide, entrée automatisée/collée) — jamais garanti un caractère par
    // appel. `key.return` ne détecte QUE le cas où le chunk EST juste la
    // touche Entrée seule ; un \r/\n en fin de chunk plus long (texte +
    // Entrée arrivés ensemble) doit être détecté explicitement, sinon la
    // ligne entière — retour compris — finit ajoutée telle quelle au champ
    // de saisie au lieu d'être soumise.
    if (char) {
      const newlineIdx = char.search(/[\r\n]/);
      if (newlineIdx !== -1) {
        const line = input + char.slice(0, newlineIdx);
        setInput('');
        setSelectionIndex(0);
        submitLine(line);
        return;
      }
    }

    if (key.return) {
      const line = input;
      setInput('');
      setSelectionIndex(0);
      submitLine(line);
      return;
    }
    if (key.pageUp || key.pageDown) {
      // Défilement dans le tab affiché — indépendant du direct : remonter ne
      // "suit" jamais un nouvel arrivage (comme le scrollback d'un vrai
      // terminal), on ne revient au direct qu'en rechangeant de tab (effect
      // plus haut) ou en redescendant explicitement.
      setScrollOffset((offset) =>
        Math.max(0, offset + (key.pageUp ? SCROLL_PAGE_SIZE : -SCROLL_PAGE_SIZE)),
      );
      return;
    }
    if (key.upArrow || key.downArrow) {
      // Une liste de suggestions active absorbe les flèches en premier
      // (navigation dedans).
      if (suggestions.length > 0) {
        setSelectionIndex((i) => {
          const next = key.upArrow ? i - 1 : i + 1;
          return ((next % suggestions.length) + suggestions.length) % suggestions.length;
        });
        return;
      }
      // Champ non vide, pas de suggestion : on est en train de taper quelque
      // chose — les flèches rappellent l'historique plutôt que de changer de
      // tab (qui garde ce rôle uniquement à champ vide, juste en dessous).
      // Pas la convention d'un vrai shell (qui rappelle même à champ vide),
      // mais la case "champ vide" est déjà prise par le changement d'onglet.
      if (input !== '') {
        if (history.length === 0) return;
        if (key.upArrow) {
          if (historyIndex === -1) setDraftInput(input); // sauvegardé avant d'entrer dans l'historique
          const nextIndex =
            historyIndex === -1 ? history.length - 1 : Math.max(historyIndex - 1, 0);
          setHistoryIndex(nextIndex);
          setInput(history[nextIndex]);
        } else if (historyIndex !== -1) {
          const nextIndex = historyIndex + 1;
          if (nextIndex >= history.length) {
            setHistoryIndex(-1);
            setInput(draftInput);
          } else {
            setHistoryIndex(nextIndex);
            setInput(history[nextIndex]);
          }
        }
        return;
      }
      // TERMINAL_TAB en premier — toujours disponible, jamais absent de la
      // liste (contrairement à un agent qui peut s'arrêter).
      const names = [
        TERMINAL_TAB,
        ...agents
          .filter((a) => a.status === 'ACTIVE' && a.mode !== 'autonomous')
          .map((a) => a.name),
      ];
      const idx = selected ? names.indexOf(selected) : -1;
      const nextIdx = key.upArrow
        ? (idx - 1 + names.length) % names.length
        : (idx + 1) % names.length;
      setSelected(names[nextIdx]);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      setSelectionIndex(0);
      setHistoryIndex(-1); // édition manuelle : on n'est plus "sur" une entrée d'historique
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setInput((s) => s + char);
      setSelectionIndex(0);
      setHistoryIndex(-1);
    }
  });

  const activityIcon = (entry: ActivityEntry): string => {
    if (entry.status === 'ok') return '✓';
    if (entry.status === 'error') return '✗';
    return SPINNER_FRAMES[Math.floor(Date.now() / 100) % SPINNER_FRAMES.length];
  };
  const activityColor = (entry: ActivityEntry): string => {
    if (entry.status === 'ok') return COLOR.violet;
    if (entry.status === 'error') return COLOR.red;
    return COLOR.cyan;
  };
  const activityElapsed = (entry: ActivityEntry): string => {
    const end = entry.endedAt ?? Date.now();
    return `${((end - entry.startedAt) / 1000).toFixed(1)}s`;
  };

  // Budget de lignes DÉLIBÉRÉMENT conservateur, jamais une hauteur fixe posée
  // sur la boîte elle-même : un `height` explicite mal calculé (chrome sous-
  // estimé, ligne de statut oubliée du compte) fait déborder le rendu de la
  // fenêtre — Ink recalcule alors sa remontée de curseur sur une hauteur
  // fausse, et chaque tick réempile un nouveau cadre au lieu de redessiner
  // en place. Indépendant de l'OS/terminal : n'importe quel terminal trop
  // petit pour la hauteur réclamée aurait le même symptôme. La boîte de log
  // n'a PAS de `height` : elle se dimensionne à ses enfants réels, jamais
  // plus — la seule chose à borner est COMBIEN de lignes on lui donne.
  // Budget relevé (18 → 20) avec la zone d'activité : jusqu'à
  // MAX_ACTIVITY_ENTRIES lignes remplacent l'ancienne ligne de statut
  // unique — sous-estimer à nouveau ce chrome reproduirait exactement le
  // bug de débordement déjà corrigé une fois.
  const CHROME_LINES = 20;
  const maxVisibleLines = Math.max(rows - CHROME_LINES, 3);
  const selectedLog = selected
    ? tailManagerRef.current!.get(selected)
    : { lines: [], connected: false };
  // Uniquement si connecté : sur 🔴 la question ne se pose pas, et un pty
  // qui vient tout juste de démarrer (écran encore vide) ne doit jamais se
  // lire comme "outil terminé" — cf. looksLikeIdleShellPrompt.
  const idleShell = selectedLog.connected && looksLikeIdleShellPrompt(selectedLog.lines);
  // Nombre de lignes CONSTANT à chaque rendu (complété, espace plutôt que
  // chaîne vide — un `Text` Ink avec un contenu vide s'effondre à hauteur
  // ZÉRO, vérifié par pilotage réel). Root cause du réempilement signalé en
  // usage réel (le cadre grandissait à chaque tick au lieu de se redessiner
  // en place, jusqu'à remplir tout le scrollback) identifiée le 2026-09-09 :
  // Ink redessine par diff (remontée curseur + effacement des lignes
  // précédentes) dans le buffer PRINCIPAL du terminal — sur Windows Terminal
  // en particulier, un déplacement de curseur fait suivre le viewport
  // jusqu'en haut du scrollback, donc chaque frame semble s'empiler sur la
  // précédente au lieu de l'écraser (bug documenté, indépendant de Striart :
  // https://github.com/anthropics/claude-code/issues/34794). `render()` bascule
  // désormais sur le buffer alternatif natif d'Ink (`alternateScreen: true`,
  // dispo depuis Ink 7 — déjà la version installée ici) : mécanisme du plein
  // écran de vim/htop/less, écran fixe sans scrollback, donc sans viewport à
  // faire suivre — élimine la cause plutôt que de la contourner. `rows`/
  // `columns` viennent maintenant de `useWindowSize()` (et non plus
  // `useStdout()`), le seul hook Ink qui redéclenche un rendu React au
  // redimensionnement — sans lui le plein écran restait figé à la taille du
  // terminal au lancement.
  // `[{ text: ' ' }]`, pas `[]` — une ligne réellement vide (chunks == [])
  // s'effondrerait à la même hauteur ZÉRO que le remplissage de padding
  // ci-dessus (même comportement Ink, même parade).
  // Avant la toute première commande, TERMINAL_TAB serait sinon une boîte
  // vide sans explication — même principe « jamais de silence » que pour
  // les autres états vides du panneau (agent absent, etc.).
  const isEmptyTerminalTab =
    selected === TERMINAL_TAB && selectedLog.lines.every((chunks) => chunks.length === 0);
  const sourceLines = isEmptyTerminalTab
    ? [[{ text: m.watchUi.terminalEmpty }]]
    : selectedLog.lines;
  // Page Up/Down (cf. useInput) — `clampedScroll` ne suit JAMAIS un nouvel
  // arrivage automatiquement (comme le scrollback d'un vrai terminal) :
  // remonter puis laisser filer du nouveau contenu ne redescend pas tout
  // seul, un changement de tab le fait (effect plus haut).
  const maxScroll = Math.max(sourceLines.length - maxVisibleLines, 0);
  const clampedScroll = Math.min(scrollOffset, maxScroll);
  const windowEnd = sourceLines.length - clampedScroll;
  const windowStart = Math.max(windowEnd - maxVisibleLines, 0);
  const windowLines = sourceLines.slice(windowStart, windowEnd);
  const visibleLines = Array.from(
    { length: maxVisibleLines },
    (_, i) => windowLines[i] ?? [{ text: ' ' }],
  );

  return h(
    Box,
    { flexDirection: 'column', width: columns },
    h(Text, { bold: true, color: COLOR.cyan }, m.watchUi.title),
    // Principe « cockpit » : un ticket ouvert (procédure d'erreur en cours)
    // reste affiché en permanence tant qu'il n'est pas traité — jamais à
    // découvrir seulement en tapant `resolve`. Toujours UN `Text` rendu
    // (jamais `null`) pour une mise en page stable — cf. la note détaillée
    // sur `visibleLines` plus haut : la hauteur variable n'était PAS la
    // cause du signalement de titre en double (infirmé par test), mais une
    // hauteur constante reste une bonne pratique de mise en page.
    h(
      Text,
      { bold: true, color: COLOR.red },
      openTickets > 0 ? m.watchUi.ticketsOpen(openTickets) : ' ', // espace, pas '' — cf. visibleLines : un Text vide s'effondre à hauteur 0 dans Ink
    ),
    h(
      Box,
      { borderStyle: 'round', borderColor: COLOR.cyan, paddingX: 1, marginTop: 1 },
      h(
        Text,
        { wrap: 'truncate-end' },
        // Un `Text` par tab plutôt qu'une seule chaîne jointe : c'est ce qui
        // permet de colorer l'indicateur "non lu" par tab (Ink `Text` ne
        // segmente jamais la couleur au mot dans une chaîne unique — même
        // limite déjà contournée ailleurs dans ce fichier pour le contenu
        // stylé du tail). "◀" repère la sélection.
        h(
          Text,
          {
            key: 'terminal-tab',
            color: unread.has(TERMINAL_TAB) ? COLOR.violet : undefined,
            bold: unread.has(TERMINAL_TAB),
          },
          `🖥️ ${m.watchUi.terminalTab}${unread.has(TERMINAL_TAB) ? ' •' : ''}${selected === TERMINAL_TAB ? ' ◀' : ''}`,
        ),
        !loaded
          ? h(Text, { key: 'loading' }, `   ${m.watchUi.loading}`)
          : agents.length === 0
            ? h(Text, { key: 'none' }, `   ${m.watchUi.noAgents}`)
            : agents.map((a) =>
                h(
                  Text,
                  {
                    key: a.name,
                    color: unread.has(a.name) ? COLOR.violet : undefined,
                    bold: unread.has(a.name),
                  },
                  `   ${statusIcon(a)} ${a.name}${unread.has(a.name) ? ' •' : ''}${a.name === selected ? ' ◀' : ''}`,
                ),
              ),
      ),
    ),
    h(
      Box,
      {
        borderStyle: 'round',
        borderColor: COLOR.cyan,
        flexDirection: 'column',
        marginTop: 1,
        paddingX: 1,
      },
      h(
        Text,
        { dimColor: true },
        (selected === TERMINAL_TAB
          ? m.watchUi.terminalHeader
          : selected
            ? `${selected} ${!selectedLog.connected ? '🔴' : idleShell ? `🟡 ${m.watchUi.idleTool}` : '🟢'}`
            : m.watchUi.noSupervised) +
          (clampedScroll > 0 ? `  ${m.watchUi.scrolled(clampedScroll)}` : ''),
      ),
      ...visibleLines.map((chunks, i) => {
        const displayChunks = chunks.length > 0 ? chunks : [{ text: ' ' }];
        return h(
          Text,
          { key: i, wrap: 'truncate-end' },
          ...displayChunks.map((c, j) =>
            h(
              Text,
              {
                key: j,
                color: c.color,
                backgroundColor: c.backgroundColor,
                bold: c.bold,
                dimColor: c.dimColor,
                italic: c.italic,
                underline: c.underline,
                strikethrough: c.strikethrough,
                inverse: c.inverse,
              },
              c.text,
            ),
          ),
        );
      }),
    ),
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: COLOR.violet, bold: true }, '> '),
      h(Text, null, input, h(Text, { inverse: true }, ' ')),
    ),
    // Autocomplétion "@"/"/" — liste filtrée en direct, ↑/↓ pour naviguer,
    // Tab ou Entrée pour compléter (cf. useInput). Bornée à
    // MAX_SUGGESTIONS_SHOWN : "/" seul liste ~24 commandes, les afficher
    // toutes pousserait la zone d'activité hors de l'écran sur un petit
    // terminal — un compteur "+N autres" comble la coupe plutôt que de la
    // passer sous silence.
    suggestions.length > 0
      ? h(
          Box,
          { flexDirection: 'column', paddingLeft: 2 },
          ...suggestions.slice(0, MAX_SUGGESTIONS_SHOWN).map((s, i) => {
            const isActive = i === activeSuggestionIndex;
            return h(
              Text,
              {
                key: `${s.kind}:${s.value}`,
                color: isActive ? COLOR.violet : undefined,
                inverse: isActive,
              },
              `${s.kind === 'agent' ? '@' : '/'}${s.value}  ${s.description}`,
            );
          }),
          suggestions.length > MAX_SUGGESTIONS_SHOWN
            ? h(
                Text,
                { dimColor: true },
                m.watchUi.moreSuggestions(suggestions.length - MAX_SUGGESTIONS_SHOWN),
              )
            : null,
        )
      : null,
    // Zone d'activité — principe « jamais de silence » : chaque action
    // reste visible avec son temps écoulé, jusqu'à MAX_ACTIVITY_ENTRIES à
    // la fois, au lieu d'une ligne de statut unique qui efface la précédente.
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      activity.length === 0
        ? h(
            Box,
            { flexDirection: 'column' },
            h(Text, { dimColor: true }, m.watchUi.help1),
            h(Text, { dimColor: true }, m.watchUi.help2),
          )
        : activity.map((entry) =>
            h(
              Text,
              { key: entry.id, color: activityColor(entry) },
              `${activityIcon(entry)} ${entry.label} (${activityElapsed(entry)})${
                entry.detail ? ` — ${entry.detail}` : ''
              }`,
            ),
          ),
      refreshError
        ? h(Text, { color: COLOR.red }, `⚠️ ${m.watchUi.refreshFailed(refreshError)}`)
        : null,
    ),
  );
}

/**
 * Point d'entrée : `striart watch --ui`. Résout quand l'utilisateur quitte
 * (Ctrl+C). `alternateScreen: true` : buffer d'écran alternatif natif d'Ink
 * (mécanisme de vim/htop/less) — restaure le contenu du terminal tel qu'avant
 * le lancement à la sortie, et élimine le bug de réempilement des frames
 * documenté au-dessus de `maxVisibleLines` (pas de scrollback à faire suivre
 * dans un écran alternatif).
 */
export async function runWatchUi(
  root: string,
  {
    subscribeLoop,
    messages = fr,
    signal,
  }: {
    subscribeLoop?: WatchLineSubscription;
    messages?: Messages;
    /** Arrêt demandé de l'extérieur (SIGINT/SIGTERM reçus par la CLI) : l'UI se démonte. */
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  if (signal?.aborted) return;
  const instance = render(h(App, { root, subscribeLoop, m: messages }), { alternateScreen: true });
  const onAbort = () => instance.unmount();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await instance.waitUntilExit();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
