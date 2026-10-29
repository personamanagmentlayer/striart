/**
 * Synthèse des protections RELÂCHÉES par la configuration — ligne unique
 * `relaxations` de `striart doctor`.
 *
 * Chaque relâchement garde sa ligne dédiée (mcp, protected, profiles,
 * orchestration, lock…) : ce module ne remplace aucune, il donne la vue
 * d'ensemble « combien de garde-fous ai-je baissés, lesquels ? » en un
 * endroit. Il est calculé à partir des MÊMES sources que ces lignes (les
 * fonctions `*Relaxations` / `*RelaxedProtections` des domaines), jamais
 * d'une liste parallèle recopiée — ajouter un relâchement à un domaine le
 * fait apparaître ici sans autre changement, sauf pour les clés « plates »
 * énumérées dans `flatRelaxations`.
 *
 * Pur et synchrone : doctor lui passe ce qu'il a déjà lu (config chargée,
 * politique des chemins protégés résolue, racines de confiance de la config
 * UTILISATEUR). Une source illisible n'est jamais comptée comme « non
 * relâchée » en silence : elle est rendue dans `unreadable`.
 */
import { acpRelaxedProtections, resolveAcpOptions } from './acp/protocol.ts';
import { acpAgentRelaxedProtections, resolveAcpAgentSettings } from './acp-agent/settings.ts';
import { hardeningRelaxations } from './hardening-checks.ts';
import { idleRelaxations } from './idle/settings.ts';
import { mcpRelaxations, resolveMcpSettings } from './mcp/settings.ts';
import { orchestrationRelaxations } from './orchestration/settings.ts';
import { overlapRelaxations } from './overlap-settings.ts';
import { tokensRelaxations } from './tokens/settings.ts';

/** Forme minimale lue ici (la config chargée a ces champs, tous facultatifs). */
type LooseConfig = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RelaxationInputs {
  /** Config du dépôt, déjà chargée et validée par `loadConfig` (null = indisponible). */
  config: LooseConfig | null;
  /** `resolveProtectedPathsPolicy(config).relaxed` — résolu par doctor. */
  protectedRelaxed?: { allow: readonly string[]; caseSensitive: boolean } | null;
  /** `hooks.trustedRoots` de la config UTILISATEUR (hors dépôt). */
  userTrustedRoots?: readonly string[];
  /** `env.allow` de la config UTILISATEUR : élargit la liste blanche du `.env` du dépôt. */
  userEnvAllow?: readonly string[];
  /** `gate.envAllow` de la config UTILISATEUR : plafond des variables que le dépôt peut demander pour le Test Gate. */
  userGateEnvAllow?: readonly string[];
  /** Bloc `network` de la config UTILISATEUR (src/net.ts) : hôtes joignables en HTTP en clair. */
  userNetwork?: { allowInsecureHosts: readonly string[] };
  /** La config utilisateur n'a pas pu être lue : le bloc réseau est non évaluable. */
  userNetworkUnreadable?: boolean;
  /** NODE_TLS_REJECT_UNAUTHORIZED=0 dans l'environnement (vérification TLS coupée). */
  tlsVerificationDisabled?: boolean;
}

export interface RelaxationReport {
  /** Identifiants stables, dédoublonnés et triés. */
  names: string[];
  /**
   * POLITIQUES choisies (`nom:valeur`), jamais comptées comme relâchement : un choix qui ne baisse
   * aucune garde — ex. `delivery:branch`, qui livre le commit testé sur une branche de revue au
   * lieu de la cible.
   */
  policies: string[];
  /** Sources qui n'ont pas pu être évaluées (jamais comptées comme sûres). */
  unreadable: string[];
}

/** Clés « plates » : un réglage, un nom, une condition. */
function flatRelaxations(config: LooseConfig, inputs: RelaxationInputs): string[] {
  const out: string[] = [];
  if (config.acpRegistry?.allowBinaryDownload === true) out.push('acpRegistry.allowBinaryDownload');
  if ((config.acpRegistry?.allowEnv?.length ?? 0) > 0) out.push('acpRegistry.allowEnv');
  if (config.agentInstructions?.enabled === false) out.push('agentInstructions.enabled');
  const breakAfter = config.lock?.breakFrozenHolderAfterMs;
  if (breakAfter !== undefined && breakAfter !== null) out.push('lock.breakFrozenHolderAfterMs');
  // Config-as-code qui désactive une protection ou choisit un exécutable :
  //  - secretPatterns: [] coupe l'exclusion des secrets des clones ET le scan
  //    des secrets historiques ;
  //  - pty.shell autre que 'auto' : exécutable choisi par le dépôt ;
  //  - terminal.launcher 'custom' : argv de lancement choisi par le dépôt.
  if (Array.isArray(config.secretPatterns) && config.secretPatterns.length === 0)
    out.push('secretPatterns');
  const ptyShell = config.pty?.shell;
  if (typeof ptyShell === 'string' && ptyShell !== 'auto') out.push('pty.shell');
  if (config.terminal?.launcher === 'custom') out.push('terminal.launcher');
  if (config.unknownConfigKeys === 'warn') out.push('unknownConfigKeys');
  if (config.gateContainer === 'process') out.push('gateContainer');
  if (config.dashboardHostname === 'localhost') out.push('dashboardHostname');
  // Test Gate sans le conteneur natif : pas de confinement ni de détection d'orphelins.
  if (config.llm?.allowAnyApiKeyEnv === true) out.push('llm.allowAnyApiKeyEnv');
  if (config.llm?.allowInsecureTransport === true) out.push('llm.allowInsecureTransport');
  if (Array.isArray(config.dashboardAllowedHosts) && config.dashboardAllowedHosts.length > 0)
    out.push('dashboardAllowedHosts');
  for (const [name, profile] of Object.entries(config.agentProfiles ?? {})) {
    if ((profile as LooseConfig | null)?.experimental === true)
      out.push(`agentProfiles.${name}.experimental`);
  }
  if (inputs.protectedRelaxed) {
    if (inputs.protectedRelaxed.allow.length > 0) out.push('protectedAgentPaths.allow');
    if (inputs.protectedRelaxed.caseSensitive) out.push('protectedAgentPaths.matchCase');
  }
  if ((inputs.userTrustedRoots?.length ?? 0) > 0) out.push('hooks.trustedRoots');
  if ((inputs.userEnvAllow?.length ?? 0) > 0) out.push('env.allow');
  if ((inputs.userGateEnvAllow?.length ?? 0) > 0) out.push('gate.envAllow');
  if ((inputs.userNetwork?.allowInsecureHosts.length ?? 0) > 0)
    out.push('network.allowInsecureHosts');
  if (inputs.tlsVerificationDisabled) out.push('env.NODE_TLS_REJECT_UNAUTHORIZED');
  return out;
}

/** Politiques actives (information) : voir `RelaxationReport.policies`. */
function activePolicies(config: LooseConfig | null): string[] {
  const out: string[] = [];
  if (config?.delivery === 'branch') out.push('delivery:branch');
  // Fermeture automatique des sessions inactives : une POLITIQUE (opt-in), qui exige de surcroît
  // l'autorisation de la config utilisateur (idle.closeRoots) — jamais comptée comme relâchement.
  if (config?.idle?.action === 'close') out.push('idle:close');
  else if (config?.idle?.action === 'warn') out.push('idle:warn');
  return out;
}

export function collectRelaxations(inputs: RelaxationInputs): RelaxationReport {
  const found = new Set<string>();
  const unreadable = new Set<string>();
  const { config } = inputs;

  if (config) {
    for (const name of flatRelaxations(config, inputs)) found.add(name);
    for (const name of hardeningRelaxations(config)) found.add(name);
    for (const r of mcpRelaxations(resolveMcpSettings(config as never))) found.add(r.key);
    for (const r of orchestrationRelaxations(config as never)) found.add(r.key);
    for (const r of tokensRelaxations(config)) found.add(r.key);
    for (const r of overlapRelaxations(config)) found.add(r.key);
    for (const r of idleRelaxations(config)) found.add(r.key);

    for (const [name, profile] of Object.entries(config.agentProfiles ?? {})) {
      if (!(profile as LooseConfig | null)?.acp) continue;
      try {
        for (const id of acpRelaxedProtections(resolveAcpOptions(profile as never)))
          found.add(`${id}@${name}`);
      } catch {
        // Profil ACP invalide : la validation de la config le refuse déjà ; ici on
        // refuse seulement de le compter pour sûr.
        unreadable.add(`agentProfiles.${name}.acp`);
      }
    }
    if (config.acpAgent !== undefined) {
      try {
        for (const id of acpAgentRelaxedProtections(resolveAcpAgentSettings(config.acpAgent)))
          found.add(id);
      } catch {
        unreadable.add('acpAgent');
      }
    }
  } else {
    // Sans config, seules les sources hors dépôt restent évaluables.
    for (const name of flatRelaxations({}, inputs)) found.add(name);
  }

  if (inputs.userNetworkUnreadable) unreadable.add('network');

  return {
    names: [...found].sort(),
    policies: activePolicies(config).sort(),
    unreadable: [...unreadable].sort(),
  };
}
