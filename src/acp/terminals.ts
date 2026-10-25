import { execa, type ResultPromise } from 'execa';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { killProcessTree, normalizeExitCode } from '../process-tree.js';
import { resolvePathInsideClone } from './protocol.ts';
import { JSONRPC } from './protocol.ts';

/**
 * Capacité `terminal` du client ACP v1 (terminal/create, output,
 * wait_for_exit, kill, release), BORNÉE au clone :
 *  - cwd forcé dans le clone (absent → racine du clone ; hors clone, lien
 *    symbolique compris → refus « invalid params », rien n'est lancé) ;
 *  - argv `shell: false` — la commande et ses arguments sont de la donnée,
 *    jamais interprétés par un shell ;
 *  - délai par commande (kill d'arbre à l'expiration), nombre de terminaux
 *    simultanés borné, sortie bornée (tronquée par le DÉBUT, à une frontière
 *    de caractère, comme le demande le protocole) ;
 *  - `STRIART_SESSION=1` posé en dernier, non surchargeable par l'`env`
 *    demandé : la garde de profondeur MCP ne se désarme pas par ce canal.
 *
 * Défense en profondeur, pas une sandbox (SECURITY.md) : l'outil de coding
 * reste du code de confiance qui garde son propre accès au système.
 */

/** Erreur JSON-RPC à renvoyer telle quelle à l'agent. */
export class RpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
  }
}

export interface TerminalLimits {
  timeoutMs: number;
  outputByteLimit: number;
  maxTerminals: number;
}

export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface ManagedTerminal {
  id: string;
  subprocess: ResultPromise;
  output: string;
  outputBytes: number;
  limit: number;
  truncated: boolean;
  exit: Promise<ExitStatus>;
  exitStatus: ExitStatus | null;
  timer: NodeJS.Timeout;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ARGS = 1_024;

/** Ne garde que les `limit` derniers octets d'un texte, sans couper un caractère. */
export function keepTail(text: string, limit: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  let start = buffer.length - limit;
  // Octets de continuation UTF-8 (10xxxxxx) : avancer jusqu'au début d'un caractère.
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly cloneRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly limits: TerminalLimits;
  private readonly log: (text: string) => void;

  constructor({
    cloneRoot,
    env,
    limits,
    log,
  }: {
    cloneRoot: string;
    env: NodeJS.ProcessEnv;
    limits: TerminalLimits;
    log: (text: string) => void;
  }) {
    this.cloneRoot = cloneRoot;
    this.env = env;
    this.limits = limits;
    this.log = log;
  }

  async create(params: Record<string, unknown>): Promise<{ terminalId: string }> {
    const command = params.command;
    if (typeof command !== 'string' || command.trim() === '' || command.includes('\0')) {
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        'terminal/create: "command" must be a non-empty string.',
      );
    }
    const args = params.args ?? [];
    if (
      !Array.isArray(args) ||
      args.length > MAX_ARGS ||
      !args.every((a) => typeof a === 'string' && !a.includes('\0'))
    ) {
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        'terminal/create: "args" must be an array of strings.',
      );
    }
    const extraEnv: Record<string, string> = {};
    if (params.env != null) {
      if (!Array.isArray(params.env)) {
        throw new RpcError(JSONRPC.INVALID_PARAMS, 'terminal/create: "env" must be an array.');
      }
      for (const entry of params.env as Array<{ name?: unknown; value?: unknown }>) {
        if (
          typeof entry?.name !== 'string' ||
          !ENV_NAME_RE.test(entry.name) ||
          typeof entry.value !== 'string' ||
          entry.value.includes('\0')
        ) {
          throw new RpcError(JSONRPC.INVALID_PARAMS, 'terminal/create: invalid "env" entry.');
        }
        extraEnv[entry.name] = entry.value;
      }
    }
    const requestedCwd = params.cwd == null ? this.cloneRoot : params.cwd;
    const cwd =
      typeof requestedCwd === 'string'
        ? await resolvePathInsideClone(this.cloneRoot, requestedCwd)
        : null;
    if (!cwd) {
      this.log(`\n[terminal] REFUSÉ (cwd hors du clone) : ${String(requestedCwd)}\n`);
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        'terminal/create: cwd outside the clone is refused.',
      );
    }
    // Le plafond borne les terminaux VIVANTS : un terminal terminé que l'agent
    // oublie de libérer ne doit pas épuiser les emplacements. Ceux qui restent
    // (sortie consultable) sont bornés eux aussi — le plus ancien est libéré.
    const all = [...this.terminals.values()];
    if (all.filter((t) => t.exitStatus === null).length >= this.limits.maxTerminals) {
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        `terminal/create: at most ${this.limits.maxTerminals} terminals at once.`,
      );
    }
    const finished = all.filter((t) => t.exitStatus !== null);
    while (finished.length >= this.limits.maxTerminals) {
      const oldest = finished.shift() as ManagedTerminal;
      this.terminals.delete(oldest.id);
      clearTimeout(oldest.timer);
    }
    const requestedLimit = params.outputByteLimit;
    const limit =
      Number.isInteger(requestedLimit) && (requestedLimit as number) > 0
        ? Math.min(requestedLimit as number, this.limits.outputByteLimit)
        : this.limits.outputByteLimit;

    const id = `term-${randomUUID()}`;
    const subprocess = execa(command, args as string[], {
      cwd,
      shell: false,
      reject: false,
      stdin: 'ignore',
      all: true,
      detached: process.platform !== 'win32',
      // STRIART_SESSION en dernier : non surchargeable (garde de profondeur MCP).
      env: { ...this.env, ...extraEnv, STRIART_SESSION: '1' },
      extendEnv: false,
    });
    const terminal: ManagedTerminal = {
      id,
      subprocess,
      output: '',
      outputBytes: 0,
      limit,
      truncated: false,
      exitStatus: null,
      exit: Promise.resolve({ exitCode: null, signal: null }),
      timer: setTimeout(() => {
        this.log(`\n[terminal] ${id} tué (délai de ${this.limits.timeoutMs}ms dépassé)\n`);
        void killProcessTree(subprocess);
      }, this.limits.timeoutMs),
    };
    terminal.timer.unref();
    // setEncoding : le décodeur recolle un caractère multi-octets coupé entre
    // deux chunks (chunk.toString() le casserait en U+FFFD).
    subprocess.all?.setEncoding('utf8');
    subprocess.all?.on('data', (chunk: string) => this.append(terminal, chunk));
    terminal.exit = subprocess.then((result) => {
      clearTimeout(terminal.timer);
      if (result.failed && result.exitCode === undefined && result.shortMessage) {
        // Spawn impossible (binaire introuvable) : la cause devient la sortie.
        this.append(terminal, `${result.shortMessage}\n`);
      }
      const status: ExitStatus = {
        exitCode: normalizeExitCode(result.exitCode ?? null),
        signal: result.signal ?? null,
      };
      terminal.exitStatus = status;
      this.log(
        `[terminal] ${id} sorti (code ${status.exitCode ?? '—'}, signal ${status.signal ?? '—'})\n`,
      );
      return status;
    });
    this.terminals.set(id, terminal);
    this.log(
      `\n[terminal] ${id} : ${[command, ...(args as string[])].join(' ')} (cwd: ${path.relative(this.cloneRoot, cwd) || '.'})\n`,
    );
    return { terminalId: id };
  }

  private append(terminal: ManagedTerminal, chunk: string): void {
    terminal.output += chunk;
    terminal.outputBytes += Buffer.byteLength(chunk, 'utf8');
    // Troncature paresseuse (au double de la borne) : ré-encoder la sortie à
    // chaque chunk serait quadratique sur une commande bavarde.
    if (terminal.outputBytes > terminal.limit * 2) this.trim(terminal);
  }

  private trim(terminal: ManagedTerminal): void {
    if (terminal.outputBytes <= terminal.limit) return;
    terminal.output = keepTail(terminal.output, terminal.limit);
    terminal.outputBytes = Buffer.byteLength(terminal.output, 'utf8');
    terminal.truncated = true;
  }

  private get(params: Record<string, unknown>): ManagedTerminal {
    const terminal =
      typeof params.terminalId === 'string' ? this.terminals.get(params.terminalId) : undefined;
    if (!terminal) {
      throw new RpcError(JSONRPC.RESOURCE_NOT_FOUND, 'Unknown or released terminal.');
    }
    return terminal;
  }

  output(params: Record<string, unknown>) {
    const terminal = this.get(params);
    this.trim(terminal);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  }

  async waitForExit(params: Record<string, unknown>): Promise<ExitStatus> {
    return this.get(params).exit;
  }

  async kill(params: Record<string, unknown>): Promise<null> {
    const terminal = this.get(params);
    if (!terminal.exitStatus) await killProcessTree(terminal.subprocess);
    return null;
  }

  async release(params: Record<string, unknown>): Promise<null> {
    const terminal = this.get(params);
    this.terminals.delete(terminal.id);
    clearTimeout(terminal.timer);
    if (!terminal.exitStatus) {
      await killProcessTree(terminal.subprocess);
      await terminal.exit.catch(() => null);
    }
    return null;
  }

  /** Fin de session : tout terminal encore ouvert est tué et libéré. */
  async releaseAll(): Promise<void> {
    const ids = [...this.terminals.keys()];
    await Promise.all(ids.map((terminalId) => this.release({ terminalId }).catch(() => null)));
  }
}
