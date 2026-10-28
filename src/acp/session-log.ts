import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { writePrivateFile } from '../private-fs.ts';
import { redactSecrets, secretValuesFromEnv } from '../redact-secrets.ts';
import { ensureStateProtection, repoRootOfStriartPath } from '../state-protection.ts';

/**
 * Log d'une session ACP, écrit AU FIL DE L'EAU (et non plus en une fois à la
 * fin) : une session portée par un hôte persistant peut durer des heures et
 * recevoir plusieurs prompts — son déroulé doit être lisible pendant
 * qu'elle tourne, et survivre à un crash de l'hôte. Les écritures sont
 * sérialisées (une seule en vol) et regroupées : jamais d'entrelacement,
 * mémoire bornée au lot en attente.
 *
 * Le journal contient du code et des sorties d'outils : fichier réservé à
 * l'utilisateur (0600 / ACL héritée d'un `.striart/` durci) et CAVIARDÉ des
 * secrets (valeurs des variables à clé de l'environnement, puis motifs connus)
 * avant chaque écriture. Le caviardage s'applique au lot regroupé : un secret
 * émis en flux, coupé entre deux lots, n'est reconnu que par ses valeurs
 * exactes connues.
 */
export class SessionLog {
  readonly path: string;
  private pending: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private scheduled = false;
  private readonly secretValues: string[];

  constructor(logPath: string) {
    this.path = logPath;
    this.secretValues = secretValuesFromEnv(process.env);
  }

  /** Crée (ou tronque) le fichier avec son en-tête. */
  async open(header: string): Promise<void> {
    const root = repoRootOfStriartPath(this.path);
    if (root) await ensureStateProtection(root);
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    await writePrivateFile(this.path, redactSecrets(header, { values: this.secretValues }));
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
    const batch = redactSecrets(this.pending.join(''), { values: this.secretValues });
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
