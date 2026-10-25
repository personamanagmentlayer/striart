/**
 * Identité d'un process (nom d'image, ligne de commande, parent), lue auprès
 * de l'OS — sans jamais passer par un shell.
 *
 * Sert à `striart lock --start` sans `--pid` : la réservation du repo
 * principal vit tant que le PID surveillé vit. Le parent direct de la CLI
 * n'est le shell de l'utilisateur que dans certains cas ; ailleurs, c'est un
 * intermédiaire qui meurt avec la CLI, et la réservation serait désarmée à
 * la seconde où la commande rend la main (constaté : Git Bash, `cmd /c`).
 * Fail closed : quand on ne peut pas établir que le PID est un shell
 * interactif durable, on refuse et on demande un `--pid` explicite.
 *
 * Lecture auprès de l'OS : le binaire natif (`striart-native proc info`,
 * src/native.ts) — une requête groupée pour tous les PID, sans PowerShell,
 * `ps` ni outil système, avec l'heure de création de chaque process. Un
 * binaire absent ou invalide est une StriartError NATIVE_* propagée, jamais
 * une identité « inconnue » qui passerait pour un fait.
 */
import path from 'node:path';
import { nativeProcessInfo } from './native.ts';
import type { NativeProcessRecord } from './native.ts';
import { isProcessAlive } from './process-tree.js';

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  /** Nom d'image normalisé : minuscules, sans chemin ni `.exe`, sans `-` de login shell. */
  name: string;
  /** Ligne de commande complète, null si l'OS ne la fournit pas. */
  commandLine: string | null;
  /**
   * Création du process, ms depuis l'epoch Unix ; null si illisible (process
   * d'un autre utilisateur). Départage un process de celui qui reprend son
   * numéro : le repreneur est forcément créé après.
   */
  startTimeMs: number | null;
}

export type ShellAssessment =
  | { ok: true; shell: ProcessInfo }
  | {
      ok: false;
      reason: 'UNKNOWN' | 'NOT_A_SHELL' | 'NON_INTERACTIVE' | 'FORK_WRAPPER';
      process: ProcessInfo | null;
    };

const INTERACTIVE_SHELLS = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ksh',
  'mksh',
  'tcsh',
  'csh',
  'nu',
  'elvish',
  'xonsh',
  'pwsh',
  'powershell',
  'cmd',
]);

export function isInteractiveShellName(name: string): boolean {
  return INTERACTIVE_SHELLS.has(name);
}

/**
 * Le shell dans lequel l'humain tape, au plus près dans la chaîne : le
 * premier shell interactif qui n'exécute PAS une commande unique. Sous
 * Windows, `striart` passe souvent par `cmd /c striart.cmd` (shim npm) :
 * ce cmd-là n'est pas le terminal de l'utilisateur, le PowerShell au-dessus
 * l'est — c'est sa syntaxe qu'il faut proposer.
 */
export function declaringShellName(chain: readonly ProcessInfo[]): string | null {
  return (
    chain.find((info) => isInteractiveShellName(info.name) && !isNonInteractiveInvocation(info))
      ?.name ?? null
  );
}

export function normalizeImageName(raw: string): string {
  const base = raw.trim().split(/[\\/]/).pop() ?? '';
  return base
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

/**
 * Découpe une ligne de commande en arguments (guillemets doubles reconnus).
 * Suffisant pour repérer des drapeaux ; jamais utilisé pour exécuter quoi
 * que ce soit.
 */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let pending = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      pending = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (pending) args.push(current);
      current = '';
      pending = false;
    } else {
      current += ch;
      pending = true;
    }
  }
  if (pending) args.push(current);
  return args;
}

/**
 * Le shell exécute-t-il une commande puis se termine (`bash -c`, `cmd /c`,
 * `pwsh -Command` sans `-NoExit`) ? Si oui, il mourra avec la CLI.
 */
export function isNonInteractiveInvocation(info: ProcessInfo): boolean {
  if (info.commandLine === null) return false;
  const args = splitCommandLine(info.commandLine)
    .slice(1)
    .map((arg) => arg.toLowerCase());
  if (info.name === 'cmd') return args.includes('/c');
  if (info.name === 'pwsh' || info.name === 'powershell') {
    if (args.includes('-noexit')) return false;
    return args.some((arg) =>
      ['-c', '-command', '-f', '-file', '-encodedcommand', '-e', '-ec'].includes(arg),
    );
  }
  // Shells POSIX : `-c` seul ou groupé (`-lc`, `-ic`…) avant la commande.
  return args.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg) && !arg.startsWith('--'));
}

/**
 * Évalue le process `pid` (et son parent) comme porteur d'une réservation.
 * Fonction pure sur la chaîne déjà lue : testable sans OS.
 */
export function assessDeclaringShell(
  chain: ProcessInfo[],
  platform: NodeJS.Platform = process.platform,
): ShellAssessment {
  const [target, parent] = chain;
  if (!target) return { ok: false, reason: 'UNKNOWN', process: null };
  if (!INTERACTIVE_SHELLS.has(target.name)) {
    return { ok: false, reason: 'NOT_A_SHELL', process: target };
  }
  if (isNonInteractiveInvocation(target)) {
    return { ok: false, reason: 'NON_INTERACTIVE', process: target };
  }
  // MSYS2/Cygwin (Git Bash) émulent fork() : la commande tourne sous une
  // copie du shell — même image, même ligne de commande que son parent — qui
  // meurt dès que la commande rend la main.
  if (
    platform === 'win32' &&
    parent !== undefined &&
    parent.name === target.name &&
    parent.commandLine !== null &&
    parent.commandLine === target.commandLine
  ) {
    return { ok: false, reason: 'FORK_WRAPPER', process: target };
  }
  return { ok: true, shell: target };
}

/** Enregistrement natif → ProcessInfo (nom d'image normalisé). */
export function toProcessInfo(record: NativeProcessRecord): ProcessInfo {
  return {
    pid: record.pid,
    ppid: record.ppid,
    name: normalizeImageName(record.name),
    commandLine: record.commandLine ? record.commandLine : null,
    startTimeMs: record.startTimeMs,
  };
}

/**
 * Lit `pid` puis ses ancêtres, jusqu'à `depth` process. Un maillon absent
 * (process mort entre-temps) arrête la chaîne : une chaîne vide signifie
 * « identité illisible », que l'appelant traite en fail closed. Un binaire
 * natif indisponible ou non conforme LÈVE (StriartError NATIVE_*) : ce n'est
 * pas une identité inconnue, c'est une installation à réparer.
 */
export async function readProcessChain(pid: number, depth = 2): Promise<ProcessInfo[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  const chain: ProcessInfo[] = [];
  let current: number | null = pid;
  while (current !== null && current > 0 && chain.length < depth) {
    const [record] = await nativeProcessInfo([current]);
    if (!record) break;
    const info = toProcessInfo(record);
    chain.push(info);
    // Sous Windows, le parent d'un process n'est jamais remplacé à sa mort :
    // son numéro peut désigner un process plus récent. Un « parent » créé
    // après son enfant n'est pas son parent — la chaîne s'arrête là.
    current = info.ppid;
    if (current !== null && chain.some((link) => link.pid === current)) break;
  }
  return trimForeignAncestors(chain);
}

/** Coupe la chaîne au premier maillon créé après son enfant (parent recyclé). */
export function trimForeignAncestors(chain: ProcessInfo[]): ProcessInfo[] {
  for (let i = 1; i < chain.length; i += 1) {
    const child = chain[i - 1].startTimeMs;
    const parent = chain[i].startTimeMs;
    if (child !== null && parent !== null && parent > child) return chain.slice(0, i);
  }
  return chain;
}

/**
 * Identité de plusieurs PID en UNE requête à l'OS (binaire natif). Un PID
 * absent de la réponse (mort, jamais attribué) est absent de la table. Lève
 * une StriartError NATIVE_* si le binaire natif est indisponible ou non
 * conforme.
 */
export async function readProcessInfos(pids: readonly number[]): Promise<Map<number, ProcessInfo>> {
  const valid = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const table = new Map<number, ProcessInfo>();
  if (valid.length === 0) return table;
  for (const record of await nativeProcessInfo(valid)) table.set(record.pid, toProcessInfo(record));
  return table;
}

/**
 * Commande corrective adaptée au shell, pour `--pid` : la variable qui
 * désigne le shell courant n'a pas le même nom partout, et sous Git Bash
 * `$$` est un PID MSYS, pas le PID Windows.
 */
export function pidHintForShell(
  name: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (name === 'pwsh' || name === 'powershell') return '$PID';
  if (platform === 'win32' && name !== null && ['bash', 'sh', 'zsh', 'dash'].includes(name)) {
    return '$(cat /proc/$$/winpid)';
  }
  if (name === 'cmd') return '<PID du terminal (voir Get-Process / tasklist)>';
  if (name === 'fish') return '$fish_pid';
  return '$$';
}

/**
 * Verdict sur un PID publié par Striart lui-même (daemon, hôte de pty) :
 *  - `alive`      : vivant ET reconnu (ligne de commande attendue) ;
 *  - `dead`       : plus aucun process sous ce numéro ;
 *  - `foreign`    : un AUTRE process porte ce numéro (PID recyclé par l'OS
 *                   après un crash ou un reboot) — ce n'est plus le nôtre ;
 *  - `unverified` : vivant mais identité illisible (process d'un autre
 *                   utilisateur dont l'OS cache la ligne de commande).
 *
 * `isProcessAlive` seul ne distingue pas un PID recyclé : il est fait pour
 * S'ABSTENIR. Dès qu'une décision en dépend — tuer le process, refuser à vie
 * un démarrage, bloquer un nettoyage — il faut savoir si c'est encore le
 * nôtre. `unverified` reste traité comme vivant par les appelants (fail
 * closed : on ne tue ni ne remplace ce qu'on ne peut pas identifier).
 */
export type ProcessInstanceVerdict = 'alive' | 'dead' | 'foreign' | 'unverified';

export interface ExpectedStriartProcess {
  /**
   * Nom du script lancé par node (`cli.js`), ou du binaire natif lui-même
   * (`striart-native.exe`) — comparé au nom de fichier, pas au chemin.
   */
  scriptName: string;
  /**
   * Image attendue quand la ligne de commande est illisible (autre
   * utilisateur) : `node` par défaut (process Striart lancés par node), le
   * nom du binaire natif pour l'hôte de pty natif.
   */
  imageName?: string;
  /** Arguments qui doivent tous figurer dans la ligne de commande, dans cet ordre. */
  args: readonly string[];
  /**
   * Instant de publication du PID (champ `startedAt` du PID file, ISO 8601
   * ou ms epoch), écrit APRÈS le lancement du process. Un process créé plus
   * tard (au-delà de IDENTITY_START_MARGIN_MS) ne peut pas être celui qui a
   * été publié : c'est un repreneur du numéro → `foreign`, quelle que soit
   * sa ligne de commande (un autre `striart watch` lancé ensuite a la même).
   */
  startedAt?: string | number | null;
}

interface InstanceCheckDeps {
  isAlive?: (pid: number) => boolean;
  readChain?: (pid: number, depth: number) => Promise<ProcessInfo[]>;
  /** Faux en test : chaque appel relit l'identité. */
  cache?: boolean;
}

/**
 * Marge entre l'heure de création lue chez l'OS et le `startedAt` publié.
 * Le PID file est écrit après le lancement : le vrai process est donc créé
 * AVANT `startedAt`. La marge n'absorbe que l'écart entre deux horloges
 * (Date.now de Node, heure de création recalculée par l'OS — sous Linux
 * depuis l'heure du boot, sensible à un réglage d'horloge) ; elle ne laisse
 * passer un repreneur que s'il naît dans les 5 s qui suivent la publication,
 * après la mort du process publié — et sa ligne de commande doit encore
 * concorder.
 */
export const IDENTITY_START_MARGIN_MS = 5_000;

/**
 * Durée de validité d'un verdict d'identité. Lire l'identité coûte un appel
 * au binaire natif (quelques ms, groupé pour tous les PID d'un même
 * `status`). Un verdict ne peut devenir faux que si le process meurt puis
 * que son numéro est réattribué ; la mort est revérifiée à chaque appel
 * (`dead` n'est jamais servi depuis le cache, et un mort oublie son
 * verdict). La fenêtre résiduelle — mort ET réattribution entre deux sondes
 * — est bornée à 5 s (une période de sondage du dashboard), et ne sert que
 * l'affichage : toute décision destructive relit l'identité (`cache: false`),
 * heure de création comprise.
 */
const IDENTITY_CACHE_TTL_MS = 5_000;
const identityCache = new Map<string, { verdict: ProcessInstanceVerdict; at: number }>();

/** Retire les verdicts expirés (et ceux d'un PID donné) : la table reste bornée. */
function pruneIdentityCache(now: number, deadPid: number | null = null): void {
  for (const [key, entry] of identityCache) {
    if (
      now - entry.at >= IDENTITY_CACHE_TTL_MS ||
      (deadPid !== null && key.startsWith(`${deadPid}\0`))
    )
      identityCache.delete(key);
  }
}

/**
 * Regroupe les lectures d'identité demandées dans une même fenêtre (un
 * `status` lit le daemon et chaque hôte de pty en parallèle) : une seule
 * requête à l'OS pour toutes.
 */
const BATCH_WINDOW_MS = 15;
let pendingBatch: { pids: Set<number>; result: Promise<Map<number, ProcessInfo>> } | null = null;

function readIdentityBatched(pid: number): Promise<ProcessInfo | undefined> {
  if (!pendingBatch) {
    const pids = new Set<number>();
    const result = new Promise<Map<number, ProcessInfo>>((resolve, reject) => {
      setTimeout(() => {
        pendingBatch = null;
        // Un échec du binaire natif atteint TOUS les demandeurs du lot.
        readProcessInfos([...pids]).then(resolve, reject);
      }, BATCH_WINDOW_MS);
    });
    pendingBatch = { pids, result };
  }
  pendingBatch.pids.add(pid);
  return pendingBatch.result.then((table) => table.get(pid));
}

/**
 * `cache` : faux pour toute décision DESTRUCTIVE (tuer un process, oublier
 * son PID file). Le cache ne sert que les décisions d'abstention et
 * d'affichage — un verdict ne peut devenir faux que si le process meurt puis
 * que son numéro est réattribué entre deux sondes ; s'abstenir à tort fait
 * patienter, tuer à tort frappe un innocent.
 */
export async function checkProcessInstance(
  pid: number,
  expected: ExpectedStriartProcess,
  { isAlive = isProcessAlive, readChain, cache = true }: InstanceCheckDeps = {},
): Promise<ProcessInstanceVerdict> {
  const now = Date.now();
  if (!isAlive(pid)) {
    // Mort constatée : son verdict ne doit jamais resservir à un process
    // qui recevrait ce numéro.
    pruneIdentityCache(now, pid);
    return 'dead';
  }
  const startedAtMs = parseStartedAt(expected.startedAt);
  const key = `${pid}\0${startedAtMs ?? ''}\0${expected.scriptName}\0${expected.args.join('\0')}`;
  const cached = cache ? identityCache.get(key) : undefined;
  if (cached && now - cached.at < IDENTITY_CACHE_TTL_MS) return cached.verdict;
  const info = readChain ? (await readChain(pid, 1))[0] : await readIdentityBatched(pid);
  const verdict = info ? judgeIdentity(info, expected, startedAtMs) : 'unverified';
  // Une identité illisible peut le devenir (droits, outil système lent) : on
  // ne fige que les verdicts établis.
  if (cache && verdict !== 'unverified') {
    pruneIdentityCache(now);
    identityCache.set(key, { verdict, at: now });
  }
  return verdict;
}

/** `startedAt` d'un PID file → ms epoch ; null si absent ou illisible. */
export function parseStartedAt(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function judgeIdentity(
  info: ProcessInfo,
  expected: ExpectedStriartProcess,
  startedAtMs: number | null,
): ProcessInstanceVerdict {
  // Créé après la publication de son PID : ce n'est pas le process publié.
  if (
    startedAtMs !== null &&
    info.startTimeMs !== null &&
    info.startTimeMs > startedAtMs + IDENTITY_START_MARGIN_MS
  ) {
    return 'foreign';
  }
  if (info.commandLine === null) {
    // Ligne de commande cachée (autre utilisateur, sous Windows sans droits
    // d'administration) : l'image reste lisible. Un process qui n'est pas
    // node (ou que le binaire natif attendu) ne peut pas être un process
    // Striart.
    const image = normalizeImageName(info.name);
    const expectedImage = expected.imageName ? normalizeImageName(expected.imageName) : null;
    const matches = expectedImage ? image === expectedImage : info.name.startsWith('node');
    return matches ? 'unverified' : 'foreign';
  }
  const tokens = splitCommandLine(info.commandLine);
  // win32.basename coupe sur les deux séparateurs : une ligne de commande
  // Windows lue depuis n'importe quel OS (tests) reste comparable.
  const script = tokens.findIndex((token) => path.win32.basename(token) === expected.scriptName);
  if (script === -1) return 'foreign';
  const rest = tokens.slice(script + 1);
  let cursor = 0;
  for (const arg of expected.args) {
    const found = rest.indexOf(arg, cursor);
    if (found === -1) return 'foreign';
    cursor = found + 1;
  }
  return 'alive';
}
