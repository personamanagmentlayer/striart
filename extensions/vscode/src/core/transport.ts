/**
 * Transport du client : un sous-process `striart api --stdio`, en argv,
 * `shell: false`. L'interface est minuscule pour qu'un faux serveur la
 * remplace dans les tests unitaires.
 */
import { spawn } from 'node:child_process';

export interface TransportClose {
  code: number | null;
  signal: string | null;
  /** Fin de stderr (bornée) : sert à classer l'échec (NOT_INITIALIZED, …). */
  stderr: string;
  /** Erreur de lancement (ENOENT, EACCES…). */
  error: Error | null;
}

export interface Transport {
  write(data: string): void;
  onData(callback: (chunk: Buffer) => void): void;
  onClose(callback: (info: TransportClose) => void): void;
  /** Fermeture ordonnée : stdin fermé (le serveur termine), puis arrêt forcé après un délai. */
  close(): void;
  /** Arrêt immédiat. */
  kill(): void;
}

export interface SpawnTransportOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Ligne de stderr reçue (journalisation). */
  onStderrLine?: (line: string) => void;
  graceMs?: number;
}

const STDERR_KEEP = 8 * 1024;

export function spawnTransport(options: SpawnTransportOptions): Transport {
  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  let lineBuffer = '';
  let spawnError: Error | null = null;
  let closed = false;
  const closeListeners: Array<(info: TransportClose) => void> = [];

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    stderrTail = (stderrTail + text).slice(-STDERR_KEEP);
    lineBuffer += text;
    let nl: number;
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, nl).replace(/\r$/, '');
      lineBuffer = lineBuffer.slice(nl + 1);
      if (line.trim()) options.onStderrLine?.(line.slice(0, 2000));
    }
    if (lineBuffer.length > 8192) lineBuffer = lineBuffer.slice(-8192);
  });
  // stdin peut se fermer sous nos pieds (EPIPE) : jamais une exception non gérée.
  child.stdin.on('error', () => {
    // La fermeture du process est rapportée par 'close' ; rien d'autre à faire.
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  child.on('close', (code, signal) => {
    if (closed) return;
    closed = true;
    const info: TransportClose = { code, signal, stderr: stderrTail, error: spawnError };
    for (const listener of closeListeners) listener(info);
  });

  let forceTimer: NodeJS.Timeout | null = null;
  return {
    write(data) {
      if (!child.stdin.writable) return;
      child.stdin.write(data);
    },
    onData(callback) {
      child.stdout.on('data', callback);
    },
    onClose(callback) {
      closeListeners.push(callback);
    },
    close() {
      if (closed) return;
      child.stdin.end();
      forceTimer ??= setTimeout(() => child.kill(), options.graceMs ?? 3000);
      forceTimer.unref();
    },
    kill() {
      if (!closed) child.kill();
    },
  };
}
