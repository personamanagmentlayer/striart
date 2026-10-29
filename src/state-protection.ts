/**
 * Point d'entrée UNIQUE de la protection des données locales (`.striart/`) pour
 * les modules qui y écrivent : journaux de session, tickets, journaux ACP,
 * `striart init`. Le mécanisme est dans `private-fs.ts` ; ici seulement la
 * décision (« protéger ou relâcher explicitement ») et sa mémoire par process.
 *
 * Relâchement : `privateStateDir: false` dans la config du dépôt. Il est
 * journalisé (un avertissement par process) et affiché par `striart doctor` ;
 * sans lui, un échec de resserrement est une erreur (`STATE_UNPROTECTED`),
 * jamais un repli silencieux.
 */
import path from 'node:path';
import { loadConfig } from './config.ts';
import { logger } from './logger.ts';
import { striartDir } from './paths.ts';
import { hardenStriartDir, type PrivacyReport } from './private-fs.ts';

const settled = new Map<string, Promise<PrivacyReport | null>>();

/** Racine du dépôt déduite d'un chemin situé sous `<racine>/.striart/…` (null sinon). */
export function repoRootOfStriartPath(file: string): string | null {
  const normalized = path.resolve(file);
  const marker = `${path.sep}.striart${path.sep}`;
  const at = normalized.lastIndexOf(marker);
  return at > 0 ? normalized.slice(0, at) : null;
}

async function configuredEnabled(root: string): Promise<boolean> {
  try {
    const config = (await loadConfig(root)) as { privateStateDir?: boolean };
    return config.privateStateDir !== false;
  } catch {
    // Config illisible ou invalide : la protection reste ACTIVE (fail closed) —
    // une erreur de config ne désactive jamais un garde-fou.
    return true;
  }
}

/**
 * Garantit que `.striart/` de `root` n'est lisible que par l'utilisateur
 * courant (migration idempotente de l'existant comprise). `config` : la config
 * déjà chargée par l'appelant ; absente, elle est lue (une fois par process).
 * `fresh` : le dossier vient d'être créé par l'appelant (journal en debug).
 * Mémorisé par racine.
 */
export function ensureStateProtection(
  root: string,
  config?: { privateStateDir?: boolean } | null,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<PrivacyReport | null> {
  const key = path.resolve(striartDir(root));
  const known = settled.get(key);
  if (known) return known;
  const pending = (async () => {
    const enabled = config ? config.privateStateDir !== false : await configuredEnabled(root);
    if (!enabled) {
      logger.warn(
        { dir: key },
        'privateStateDir: false — les données locales de .striart/ ne sont PAS réservées à l’utilisateur (relâchement explicite)',
      );
      return null;
    }
    const report = await hardenStriartDir(root);
    if (report.tightened.length > 0) {
      // Une migration d'un `.striart/` PRÉEXISTANT mérite une ligne ; le
      // resserrement d'un dossier que ce process vient de créer (`init` sur un
      // dépôt neuf) est le comportement normal, pas un événement : niveau debug.
      // Un init idempotent ne resserre rien et ne journalise donc rien.
      logger[fresh ? 'debug' : 'info'](
        { dir: key, tightened: report.tightened.length },
        'Données locales de .striart/ resserrées (utilisateur seul)',
      );
    }
    return report;
  })();
  settled.set(key, pending);
  pending.catch(() => settled.delete(key));
  return pending;
}

/** Oublie la mémoire (tests). */
export function resetStateProtectionMemo(): void {
  settled.clear();
}
