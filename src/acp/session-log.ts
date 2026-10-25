import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Log d'une session ACP, écrit AU FIL DE L'EAU (et non plus en une fois à la
 * fin) : une session portée par un hôte persistant peut durer des heures et
 * recevoir plusieurs prompts — son déroulé doit être lisible pendant
 * qu'elle tourne, et survivre à un crash de l'hôte. Les écritures sont
 * sérialisées (une seule en vol) et regroupées : jamais d'entrelacement,
 * mémoire bornée au lot en attente.
 */
export class SessionLog {
  readonly path: string;
  private pending: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private scheduled = false;

  constructor(logPath: string) {
    this.path = logPath;
  }

  /** Crée (ou tronque) le fichier avec son en-tête. */
  async open(header: string): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true });
    await writeFile(this.path, header, 'utf8');
  }

  append(text: string | null | undefined): void {
    if (!text) return;
    this.pending.push(text);
    if (this.scheduled) return;
    this.scheduled = true;
    this.writing = this.writing.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    this.scheduled = false;
    const batch = this.pending.join('');
    this.pending = [];
    if (!batch) return;
    await appendFile(this.path, batch, 'utf8').catch((error) => {
      logger.warn({ err: error, logPath: this.path }, 'Écriture du log de session impossible');
    });
  }

  /** Attend que tout ce qui a été journalisé soit sur disque. */
  async flush(): Promise<void> {
    for (;;) {
      const current = this.writing;
      await current;
      if (current === this.writing && this.pending.length === 0) return;
      if (this.pending.length > 0 && !this.scheduled) {
        this.scheduled = true;
        this.writing = this.writing.then(() => this.drain());
      }
    }
  }
}
