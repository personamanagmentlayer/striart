/**
 * Contrôles `striart doctor` du durcissement des données locales et du Test
 * Gate — fonctions PURES ou en lecture seule, que `doctor.js` enregistre (ce
 * module n'importe ni `doctor.js` ni son catalogue).
 *
 *  - `hardeningRelaxations(config)` : noms de relâchement à ajouter à la ligne
 *    `relaxations` (`doctor-relaxations.ts`) ;
 *  - `checkStateDirPrivacy(root, config)` : `.striart/` est-il réservé à
 *    l'utilisateur ? (lecture seule ; la correction est `striart init`, qui
 *    resserre l'existant) ;
 *  - `checkGateEnv(config, userGateEnvAllow)` : l'environnement du Test Gate
 *    est-il filtré, et les demandes du dépôt sont-elles autorisées ?
 */
import { collectConfiguredSecretEnvNames, buildGateEnv } from './gate-env.ts';
import { inspectStriartPrivacy } from './private-fs.ts';

type LooseConfig = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Relâchements de ce lot, aux noms stables de la ligne `relaxations`. */
export function hardeningRelaxations(config: LooseConfig): string[] {
  const out: string[] = [];
  if (config.gateEnv === 'inherit') out.push('gateEnv');
  if (config.privateStateDir === false) out.push('privateStateDir');
  return out;
}

export interface HardeningCheck {
  /** `ok` : conforme ; `warn` : défaut ou relâchement ; `skip` : rien à contrôler. */
  status: 'ok' | 'warn' | 'skip';
  /** Identifiant stable du constat (clé de catalogue i18n côté doctor). */
  id: string;
  /** Paramètres du message (identifiants et nombres, jamais de valeur secrète). */
  params: Record<string, unknown>;
}

export async function checkStateDirPrivacy(
  root: string,
  config: LooseConfig,
): Promise<HardeningCheck> {
  if (config.privateStateDir === false) {
    return { status: 'warn', id: 'state-privacy.relaxed', params: {} };
  }
  const report = await inspectStriartPrivacy(root);
  if (report.failed.length === 0) {
    return { status: 'ok', id: 'state-privacy.ok', params: { inspected: report.inspected } };
  }
  return {
    status: 'warn',
    id: 'state-privacy.open',
    params: {
      count: report.failed.length,
      // Quelques chemins pour agir ; la correction est `striart init`.
      examples: report.failed.slice(0, 5).map((f) => ({ path: f.path, reason: f.reason })),
      fix: 'striart init',
    },
  };
}

export function checkGateEnv(
  config: LooseConfig,
  userGateEnvAllow: readonly string[] = [],
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): HardeningCheck {
  if (config.gateEnv === 'inherit') {
    return { status: 'warn', id: 'gate-env.inherit', params: {} };
  }
  const built = buildGateEnv({
    baseEnv,
    repo: Array.isArray(config.gateEnv) ? config.gateEnv : null,
    userAllow: userGateEnvAllow,
    secretNames: collectConfiguredSecretEnvNames(config),
  });
  if (built.refused.length > 0) {
    return { status: 'warn', id: 'gate-env.refused', params: { names: built.refused } };
  }
  return {
    status: 'ok',
    id: 'gate-env.filtered',
    params: {
      passed: Object.keys(built.env).length,
      removedSecrets: built.removedSecrets.length,
      requested: Array.isArray(config.gateEnv) ? config.gateEnv.length : 0,
    },
  };
}
