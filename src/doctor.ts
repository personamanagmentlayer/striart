/**
 * striart doctor — diagnostic complet de l'environnement.
 *
 * Répond en une commande à "pourquoi ça ne marche pas ?" : version de git,
 * état du repo, initialisation, config, branche cible, LLM joignable,
 * secrets historiques, verrou, session principale, agents, tickets. Chaque
 * check est indépendant et ne throw jamais — le résultat est une liste de
 * constats ok/warn/fail/skip, affichable en table humaine ou en JSON (CI).
 *
 * Contrat de gravité — c'est lui qui rend le bilan honnête :
 *  - `fail` : la prochaine commande Striart échouera (start, run, merge…) ;
 *  - `warn` : Striart fonctionne, mais une capacité est dégradée ou une
 *    action humaine est attendue (ticket ouvert, LLM injoignable…) ;
 *  - `skip` : le contrôle n'a pas de sens ici (dépend d'un échec amont, ou
 *    fonctionnalité désactivée par la config).
 *
 * Chaque constat sépare le fait (`detail`) de l'action (`hint`), et porte
 * une `key` stable avec ses `params` bruts : la CLI le reformule dans la
 * langue de l'utilisateur ; `label`/`detail`/`hint` restent le texte
 * français de référence (dashboard, MCP).
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { loadConfig, listUnknownConfigKeys } from './config.ts';
import { resolveLlmConfig } from './llm.ts';
import { probeOllama } from './ollama.ts';
import { inspectNetwork, readCaFile } from './net.ts';
import { dirStats, formatBytes, listAgents, scanHistoricalSecrets, striartDir } from './clone.ts';
import { listConflictTickets } from './conflicts.ts';
import { readState } from './state.ts';
import { readMainSessionStatus } from './main-session.ts';
import { readMainLockStatus, stopHolderCommand } from './lock.ts';
import { readStateLockStatus } from './state-lock.ts';
import { readQueue } from './queue.ts';
import { NATIVE_BIN_ENV, PINNED_NATIVE_KEY_IDS, nativeDiagnostic } from './native.ts';
import {
  resolvePtyShell,
  windowsPowerShellProfileRisk,
  windowsPowerShellProfiles,
} from './pty-host.ts';
import { resolveProtectedPathsPolicy } from './protected-paths.ts';
import { mcpRelaxations, resolveMcpSettings } from './mcp/settings.ts';
import { orchestrationRelaxations } from './orchestration/settings.ts';
import { llmResilienceRelaxations } from './llm-resilience.ts';
import { instructionsFootprint } from './tokens/footprint.ts';
import { usageSummary } from './tokens/report.ts';
import { collectRelaxations } from './doctor-relaxations.ts';
import { idleRelaxations, resolveIdleSettings } from './idle/settings.ts';
import { closeAuthorization } from './idle/authorize.ts';
import { readUserConfig } from './user-config.ts';
import { checkGateEnv, checkStateDirPrivacy } from './hardening-checks.ts';
import {
  GIT_STATUS_WARN_MS,
  STATE_LOCK_ALERT_MS,
  STATE_LOCK_BUDGET_MS,
  boundedDirSize,
  latencyLevel,
  measureGitStatus,
  measureStateLockLatency,
} from './doctor-perf.ts';
import type { AgentProfile } from './types.js';

/** Version minimale pour sparse-checkout --no-cone (nettoyage des secrets). */
const GIT_RECOMMENDED = [2, 35];
/** Version minimale absolue pour les opérations Striart. */
const GIT_MINIMUM = [2, 25];

/**
 * @typedef {'ok'|'warn'|'fail'|'skip'} DoctorLevel
 * @typedef {{
 *   id: string, label: string, level: DoctorLevel, detail: string, hint: string|null,
 *   key: string, params: Record<string, unknown>
 * }} DoctorCheck
 * @typedef {{checks: DoctorCheck[], healthy: boolean, summary: Record<DoctorLevel, number>}} DoctorReport
 */

/** Libellés de référence (français) par contrôle. */
const LABELS = {
  git: 'Version de git',
  native: 'Composant natif',
  gate: 'Test Gate',
  pty: 'Hôte de terminal (pty)',
  repo: 'Dépôt Git',
  init: 'Initialisation Striart',
  config: 'Configuration',
  branch: 'Branche cible',
  llm: 'LLM (Router/Merger)',
  network: 'Réseau',
  secrets: 'Secrets historiques',
  lock: 'Verrou principal',
  'state-lock': "Verrou d'état",
  'main-session': 'Repo principal',
  agents: 'Agents',
  tickets: 'Tickets de conflit',
  manual: 'Fusion sémantique',
  protected: 'Chemins protégés',
  mcp: 'Serveur MCP',
  profiles: "Profils d'agents",
  tokens: 'Tokens et coûts',
  orchestration: 'Orchestration',
  idle: "GC d'inactivité",
  dashboard: 'Dashboard (hôtes)',
  'state-privacy': 'Données locales (.striart/)',
  'gate-env': 'Environnement du Test Gate',
  delivery: 'Livraison',
  performance: 'Performance',
  relaxations: 'Protections relâchées',
};

/**
 * État RÉEL du verrou principal (src/lock.js, lecture seule) : un main.lock
 * présent n'est « orphelin » que si son détenteur est mort ou étranger — un
 * détenteur qui bat est une opération en cours, un détenteur vivant figé
 * n'est jamais cassé (PID à arrêter), un merge tiers signalé bloque toute
 * opération. Le relâchement `lock.breakFrozenHolderAfterMs` est toujours
 * affiché.
 * @param {(id: keyof typeof LABELS, level: DoctorLevel, key: string, params: Record<string, unknown>, detail: string, hint?: string|null) => unknown} add
 * @param {string} root
 */
async function addLockCheck(add, root) {
  let status;
  try {
    status = await readMainLockStatus(root);
  } catch (error) {
    add(
      'lock',
      'warn',
      'lock.unreadable',
      { cause: error.code ?? error.message },
      `état du verrou illisible : ${error.message}`,
    );
    return;
  }
  const policy = status.breakFrozenHolderAfterMs;
  const params = { ...status, recoveryBlocked: status.recoveryBlocked !== null };
  const relaxed =
    policy === null
      ? ''
      : ` — protection RELÂCHÉE : un détenteur figé est cassé après ${Math.round(policy / 1000)} s (lock.breakFrozenHolderAfterMs)`;
  const relaxedLevel = policy === null ? 'ok' : 'warn';
  const queue = status.queued > 0 ? `, ${status.queued} en file` : '';
  if (status.recoveryBlocked) {
    add(
      'lock',
      'fail',
      'lock.recoveryBlocked',
      { ...params, operation: status.recoveryBlocked.operation },
      `merge tiers ouvert dans le principal, signalé par ${status.recoveryBlocked.operation ?? 'une opération'} (MERGE_STATE_CHANGED) : ` +
        `toute opération refuse (MERGE_RECOVERY_BLOCKED) tant qu'il est ouvert${relaxed}`,
      'git merge --abort',
    );
    return;
  }
  const beat =
    status.heartbeatAgeMs === null
      ? ''
      : `, dernier battement il y a ${Math.round(status.heartbeatAgeMs / 1000)} s`;
  switch (status.state) {
    case 'free':
      add('lock', relaxedLevel, 'lock.free', params, `libre${queue}${relaxed}`);
      return;
    case 'held':
      add(
        'lock',
        relaxedLevel,
        'lock.held',
        params,
        `opération en cours : « ${status.holder} » (pid ${status.pid}) depuis ${status.startedAt}${beat}${queue}${relaxed}`,
      );
      return;
    case 'frozen':
      add(
        'lock',
        'warn',
        'lock.frozen',
        params,
        `détenteur VIVANT mais figé : « ${status.holder} » (pid ${status.pid})${beat}${queue} — jamais cassé ` +
          `par défaut, toutes les opérations attendent${relaxed}`,
        stopHolderCommand(status.pid),
      );
      return;
    case 'stale':
      add(
        'lock',
        'warn',
        'lock.stale',
        params,
        `verrou orphelin (${status.staleReason}) de « ${status.holder ?? 'inconnu'} » : cassé par la prochaine opération${relaxed}`,
      );
      return;
    default:
      add(
        'lock',
        'warn',
        'lock.unreadable',
        { ...params, cause: status.state },
        `main.lock ${status.state === 'invalid' ? 'au contenu invalide (création interrompue ?)' : 'illisible'} : jamais cassé à l'aveugle${relaxed}`,
      );
  }
}

/**
 * Verrou d'état des fichiers `.striart/*.json` (state-lock.js), en lecture
 * seule. Tenu quelques millisecondes : présent et vivant = écriture en
 * cours ; PID mort ou contenu illisible = débris, cassé automatiquement à la
 * prochaine écriture d'état ; vivant et vieux de plus de STATE_LOCK_SLOW_MS
 * = détenteur bloqué — chaque écriture d'état attend puis échoue
 * (STATE_LOCK_TIMEOUT) tant qu'il vit.
 * @param {(id: keyof typeof LABELS, level: DoctorLevel, key: string, params: Record<string, unknown>, detail: string, hint?: string|null) => unknown} add
 * @param {string} root
 */
async function addStateLockCheck(add, root) {
  const status = await readStateLockStatus(striartDir(root)).catch((error) => ({
    error: /** @type {Error} */ error,
  }));
  if ('error' in status) {
    add(
      'state-lock',
      'warn',
      'stateLock.unreadable',
      { cause: status.error.message },
      `état illisible : ${status.error.message}`,
    );
    return;
  }
  if (!status.present) {
    add('state-lock', 'ok', 'stateLock.free', {}, 'libre');
    return;
  }
  const params = { pid: status.pid, ageMs: status.ageMs, alive: status.alive };
  if (!status.alive || !status.readable) {
    add(
      'state-lock',
      'warn',
      'stateLock.orphan',
      params,
      `orphelin (PID ${status.pid ?? '?'}${status.readable ? ' mort' : ', contenu illisible'}) : cassé automatiquement à la prochaine écriture d'état`,
    );
    return;
  }
  if (status.ageMs > STATE_LOCK_SLOW_MS) {
    add(
      'state-lock',
      'warn',
      'stateLock.stuck',
      params,
      `tenu par le PID ${status.pid} depuis ${Math.round(status.ageMs / 1000)} s : les écritures d'état attendent puis échouent (STATE_LOCK_TIMEOUT)`,
      status.pid === null ? 'striart status' : stopHolderCommand(status.pid),
    );
    return;
  }
  add('state-lock', 'ok', 'stateLock.held', params, `écriture en cours (PID ${status.pid})`);
}

/**
 * Couche réseau d'entreprise (src/net.ts), lue depuis l'environnement du shell et
 * la config UTILISATEUR — jamais depuis le dépôt. Une config utilisateur illisible
 * n'est jamais rendue « réseau sain » : les appels distants sont refusés (fail closed).
 * @param {(id: keyof typeof LABELS, level: DoctorLevel, key: string, params: Record<string, unknown>, detail: string, hint?: string|null) => unknown} add
 */
async function addNetworkCheck(add) {
  // `ALL_PROXY` n'est pas lue (src/net.ts : HTTP_PROXY, HTTPS_PROXY, NO_PROXY seulement) : la
  // laisser passer en silence ferait croire à un proxy actif. Jamais de valeur affichée (identifiants).
  if ((process.env.ALL_PROXY ?? '').trim() !== '' || (process.env.all_proxy ?? '').trim() !== '') {
    add(
      'network',
      'warn',
      'network.allProxyIgnored',
      {},
      "ALL_PROXY n'est pas supporté : la variable est ignorée (Striart ne lit que HTTPS_PROXY, HTTP_PROXY et NO_PROXY), les connexions ne passeront PAS par ce proxy",
      'définis HTTPS_PROXY / HTTP_PROXY (ou network.proxy dans la config utilisateur) ; les proxys SOCKS ne sont pas supportés',
    );
  }
  let user;
  try {
    user = (await readUserConfig()).network;
  } catch (error) {
    add(
      'network',
      'warn',
      'network.userConfigUnreadable',
      { code: error.code ?? 'USER_CONFIG_INVALID' },
      `config utilisateur illisible (${error.code ?? 'erreur'}) : politique réseau non évaluable, les appels sortants non locaux sont refusés`,
      error.hint ?? 'corrige la config utilisateur',
    );
    return;
  }
  let report;
  try {
    report = inspectNetwork(user);
  } catch (error) {
    add(
      'network',
      'fail',
      'network.envInvalid',
      { message: error.message },
      error.message,
      error.hint ?? null,
    );
    return;
  }
  const { policy, proxy } = report;

  if (policy.offline || policy.allowLists.length > 0) {
    const parts = [
      policy.offline ? 'hors ligne (aucun appel non local : NET_OFFLINE)' : null,
      policy.allowLists.length > 0
        ? `hôtes autorisés : ${policy.allowLists.map((l) => l.join(', ')).join(' ∩ ')}`
        : null,
    ].filter(Boolean);
    add(
      'network',
      'ok',
      'network.policy',
      { offline: policy.offline, allowedHosts: policy.allowLists },
      parts.join(' ; '),
    );
  }

  if (!proxy.configured) {
    add('network', 'ok', 'network.direct', {}, 'aucun proxy configuré : connexions directes');
  } else {
    const shown = [policy.proxy.display.https, policy.proxy.display.http]
      .filter((v, i, all) => v && all.indexOf(v) === i)
      .join(', ');
    const params = {
      source: policy.proxy.source,
      proxy: shown,
      noProxy: policy.proxy.noProxy,
      problem: proxy.problem,
    };
    if (proxy.active) {
      const bypass = policy.proxy.noProxy ? ` ; hors proxy : ${policy.proxy.noProxy}` : '';
      add(
        'network',
        'ok',
        'network.proxyActive',
        params,
        `proxy actif (${policy.proxy.source}, dispatcher undici par requête) : ${shown}${bypass}`,
      );
    } else {
      add(
        'network',
        'warn',
        'network.proxyInactive',
        params,
        `proxy configuré (${shown}) mais INACTIF (${proxy.problem}) : les appels distants sont refusés (NET_PROXY_UNSUPPORTED)`,
        'utilise une URL de proxy http:// ou https:// (les proxys SOCKS ne sont pas supportés)',
      );
    }
  }

  const tlsParts = [];
  /** @type {DoctorLevel} */
  let tlsLevel = 'ok';
  let tlsHint = null;
  if (policy.tlsMinVersion) tlsParts.push(`version minimale ${policy.tlsMinVersion}`);
  if (policy.caFile) {
    try {
      const certs = await readCaFile(policy.caFile);
      tlsParts.push(
        `CA d'entreprise network.caFile ${policy.caFile} (${certs.length} certificat(s))`,
      );
    } catch (error) {
      tlsLevel = 'warn';
      tlsParts.push(
        `network.caFile ${policy.caFile} inutilisable (${error.details?.reason ?? error.message})`,
      );
      tlsHint = error.hint ?? null;
    }
  }
  if (report.extraCaCerts) tlsParts.push(`NODE_EXTRA_CA_CERTS ${report.extraCaCerts}`);
  if (report.systemCa) tlsParts.push('CA du système (--use-system-ca)');
  if (tlsParts.length > 0) {
    add(
      'network',
      tlsLevel,
      'network.tls',
      {
        tlsMinVersion: policy.tlsMinVersion,
        caFile: policy.caFile,
        extraCaCerts: report.extraCaCerts,
        systemCa: report.systemCa,
      },
      tlsParts.join(' ; '),
      tlsHint,
    );
  }

  const insecure = [
    policy.allowInsecureHosts.length > 0
      ? `HTTP en clair autorisé vers : ${policy.allowInsecureHosts.join(', ')} (network.allowInsecureHosts)`
      : null,
    policy.tlsVerificationDisabled
      ? 'vérification TLS coupée (NODE_TLS_REJECT_UNAUTHORIZED=0) : les appels distants sont refusés'
      : null,
  ].filter(Boolean);
  if (insecure.length > 0) {
    add(
      'network',
      'warn',
      'network.insecure',
      {
        allowInsecureHosts: policy.allowInsecureHosts,
        tlsVerificationDisabled: policy.tlsVerificationDisabled,
      },
      `protection RELÂCHÉE : ${insecure.join(' ; ')}`,
      'retire network.allowInsecureHosts / NODE_TLS_REJECT_UNAUTHORIZED si ce n’est pas voulu',
    );
  }
}

/** Verrou d'état tenu plus longtemps que ça : détenteur bloqué (contrat : quelques ms). */
const STATE_LOCK_SLOW_MS = 5_000;

/**
 * Constat du binaire natif : chemin, version, plateforme, source, schéma de
 * signature et état de la vérification.
 * @param {(id: keyof typeof LABELS, level: DoctorLevel, key: string, params: Record<string, unknown>, detail: string, hint?: string|null) => unknown} add
 */
async function addNativeCheck(add) {
  const { binary, error, platform } = await nativeDiagnostic();
  // Clés de confiance : la clé ÉPINGLÉE dans le code et celles que l'UTILISATEUR a
  // ajoutées (native.trustedKeyIds, config utilisateur — jamais celle du dépôt).
  // Illisible : jamais comptée comme « aucune » en silence.
  let trustedKeyIds = [];
  let trustedKeyIdsUnreadable = false;
  try {
    trustedKeyIds = (await readUserConfig()).native.trustedKeyIds;
  } catch {
    trustedKeyIdsUnreadable = true;
  }
  const pinnedKeyIds = [...PINNED_NATIVE_KEY_IDS];
  const keysFact = `clés de confiance : épinglée(s) ${pinnedKeyIds.join(', ')} ; utilisateur (native.trustedKeyIds) ${
    trustedKeyIdsUnreadable
      ? 'illisible'
      : trustedKeyIds.length > 0
        ? trustedKeyIds.join(', ')
        : 'aucune'
  }`;
  if (!binary) {
    const code = error?.code ?? 'NATIVE_UNAVAILABLE';
    add(
      'native',
      'fail',
      'native.failed',
      { ...error?.details, code, platform, pinnedKeyIds, trustedKeyIds },
      `${code} : ${error?.message ?? 'binaire natif inutilisable'}`,
      error?.hint ?? 'npm install',
    );
    return;
  }
  const params = {
    path: binary.path,
    version: binary.version,
    platform: binary.platform,
    source: binary.source,
    scheme: binary.verification.scheme,
    keyId: binary.verification.keyId,
    sha256: binary.verification.sha256,
    verification: binary.verification.status,
    pinnedKeyIds,
    trustedKeyIds,
    trustedKeyIdsUnreadable,
  };
  const facts = `v${binary.version} ${binary.platform} — ${binary.path} — ${keysFact}`;
  if (binary.verification.status === 'verified') {
    add(
      'native',
      'ok',
      'native.ok',
      params,
      `vérifié (${binary.verification.scheme}, clé ${binary.verification.keyId}, SHA-256 conforme) — ${facts}`,
    );
  } else if (binary.verification.status === 'dev-build') {
    add('native', 'ok', 'native.devBuild', params, `build de développement non signé — ${facts}`);
  } else {
    add(
      'native',
      'warn',
      'native.explicit',
      params,
      `désigné par ${NATIVE_BIN_ENV}, intégrité NON vérifiée — ${facts}`,
      `retirer ${NATIVE_BIN_ENV} pour utiliser le binaire signé du paquet`,
    );
  }
}

/**
 * Hôte de pty : implémentation utilisée (le binaire natif `striart-native
 * pty-host`), shell effectif (`pty.shell`/`pty.shellArgs`, sinon 'auto') et
 * avertissement si Windows PowerShell 5.1 démarre avec les profils
 * utilisateur (lent, et en échec sous une politique d'exécution restrictive).
 * Un `pty.shell` choisi dans la config est un relâchement (exécutable désigné
 * par la config du dépôt) : signalé dans le constat.
 * @param {(id: keyof typeof LABELS, level: DoctorLevel, key: string, params: Record<string, unknown>, detail: string, hint?: string|null) => unknown} add
 * @param {string} root
 * @param {unknown} config
 */
async function addPtyCheck(add, root, config) {
  const { binary, error } = await nativeDiagnostic();
  if (!binary) {
    const code = error?.code ?? 'NATIVE_UNAVAILABLE';
    add(
      'pty',
      'fail',
      'pty.native',
      { code },
      `hôte natif indisponible : ${code}`,
      'striart doctor --json',
    );
    return;
  }
  let resolved;
  try {
    resolved = await resolvePtyShell(root, { config });
  } catch (error) {
    add(
      'pty',
      'fail',
      'pty.invalid',
      { message: error.message, reason: error.details?.reason },
      `pty.shell inutilisable : ${error.message}`,
      'corrige pty.shell dans striart.config, ou remets "auto"',
    );
    return;
  }
  const params: {
    implementation: string;
    binary: string;
    shell: string;
    shellArgs: string[];
    source: string;
    profileFiles?: number;
  } = {
    implementation: 'native',
    binary: binary.path,
    shell: resolved.shell,
    shellArgs: resolved.args,
    source: resolved.source,
  };
  const origin =
    resolved.source === 'config'
      ? 'pty.shell de la config (exécutable choisi par le dépôt)'
      : 'auto';
  const facts = `implémentation native (${binary.path}) — shell ${resolved.shell}${
    resolved.args.length ? ` ${resolved.args.join(' ')}` : ''
  } [${origin}]`;
  const profiles = windowsPowerShellProfileRisk(resolved.shell, resolved.args)
    ? await windowsPowerShellProfiles()
    : [];
  if (profiles.length > 0) {
    params.profileFiles = profiles.length;
    add(
      'pty',
      'warn',
      'pty.profileRisk',
      params,
      `${facts} : Windows PowerShell 5.1 charge vos ${profiles.length} profil(s) à chaque démarrage (lent, en échec sous une politique d'exécution restrictive)`,
      'pty.shellArgs: ["-NoLogo", "-NoProfile"], ou pty.shell: "pwsh" (PowerShell 7)',
    );
    return;
  }
  add('pty', 'ok', 'pty.ok', params, facts);
}

/** Un verrou tenu plus longtemps que ça est signalé (Test Gate ou LLM long, ou détenteur figé). */
const LOCK_AGE_WARN_MS = 5 * 60_000;

/**
 * Section « performance » (L8, lecture seule du point de vue de l'utilisateur, chaque mesure bornée
 * dans le temps) : latence réelle du verrou d'état, durée d'un `git status` du principal, taille
 * cumulée de `.striart/`, nombre d'agents, âge du plus vieux verrou tenu. Budgets : voir
 * doctor-perf.ts. Un constat de performance n'est JAMAIS un `fail` : Striart fonctionne, plus
 * lentement.
 * @param {(id: keyof typeof LABELS, level: DoctorLevel, key: string, params: Record<string, unknown>, detail: string, hint?: string|null) => unknown} add
 * @param {string} root
 * @param {number | null} agentCount `null` quand le registre n'a pas pu être lu
 */
async function addPerformanceCheck(add, root, agentCount) {
  const stateDir = striartDir(root);
  const [latency, gitStatus, size, mainLock, stateLock] = await Promise.all([
    measureStateLockLatency(stateDir).catch((error) => ({ error })),
    measureGitStatus(root),
    boundedDirSize(stateDir),
    readMainLockStatus(root).catch(() => null),
    readStateLockStatus(stateDir).catch(() => null),
  ]);

  if ('error' in latency) {
    add(
      'performance',
      'warn',
      'performance.stateLock',
      { samples: 0, failed: true, cause: latency.error?.code ?? latency.error?.message },
      `latence du verrou d'état non mesurable : ${latency.error?.message ?? 'erreur'}`,
      'vérifie les permissions de .striart/ puis relance striart doctor',
    );
  } else if (latency.samples.length === 0) {
    add(
      'performance',
      'warn',
      'performance.stateLock',
      {
        samples: 0,
        medianMs: 0,
        maxMs: 0,
        budgetMs: STATE_LOCK_BUDGET_MS,
        alertMs: STATE_LOCK_ALERT_MS,
        level: 'alert',
        timedOut: latency.timedOut,
      },
      "verrou d'état non obtenu pendant la mesure : un autre process le tient ou le disque ne répond pas",
      'striart status ; relance au repos',
    );
  } else {
    const level = latencyLevel(latency);
    const params = {
      samples: latency.samples.length,
      medianMs: latency.medianMs,
      maxMs: latency.maxMs,
      budgetMs: STATE_LOCK_BUDGET_MS,
      alertMs: STATE_LOCK_ALERT_MS,
      level,
      timedOut: latency.timedOut,
    };
    const base = `écriture atomique sous verrou d'état : médiane ${latency.medianMs} ms, pire ${latency.maxMs} ms (${latency.samples.length} mesure(s))`;
    if (level === 'ok') {
      add(
        'performance',
        'ok',
        'performance.stateLock',
        params,
        `${base} — dans le budget de ${STATE_LOCK_BUDGET_MS} ms`,
      );
    } else {
      add(
        'performance',
        'warn',
        'performance.stateLock',
        params,
        level === 'alert'
          ? `${base} — au-delà de ${STATE_LOCK_ALERT_MS / 1000} s : les opérations qui écrivent l'état s'empilent derrière`
          : `${base} — au-dessus du budget de ${STATE_LOCK_BUDGET_MS} ms`,
        "machine chargée ? exclus .striart/ de l'antivirus et de l'indexation, puis relance au repos",
      );
    }
  }

  const gitSlow = gitStatus.timedOut || gitStatus.failed || gitStatus.ms > GIT_STATUS_WARN_MS;
  let gitDetail = `git status du dépôt principal : ${gitStatus.ms} ms`;
  if (gitStatus.timedOut) {
    gitDetail = 'git status du dépôt principal sans réponse dans le délai de la mesure';
  } else if (gitStatus.failed) {
    gitDetail = 'git status du dépôt principal en échec';
  } else if (gitSlow) {
    gitDetail += ` (au-delà de ${GIT_STATUS_WARN_MS} ms : status, dashboard et gardes de merge en pâtissent)`;
  }
  add(
    'performance',
    gitSlow ? 'warn' : 'ok',
    'performance.gitStatus',
    { ...gitStatus, warnMs: GIT_STATUS_WARN_MS },
    gitDetail,
    gitSlow ? "git gc ; vérifie core.fsmonitor, l'antivirus et la taille du dépôt" : null,
  );

  add(
    'performance',
    'ok',
    'performance.stateDirSize',
    { sizeBytes: size.sizeBytes, complete: size.complete },
    `.striart/ : ${formatBytes(size.sizeBytes)} sur disque${size.complete ? '' : ' (parcours interrompu au délai : taille partielle)'}`,
  );

  if (agentCount !== null) {
    add(
      'performance',
      'ok',
      'performance.agentCount',
      { count: agentCount },
      `${agentCount} agent(s) enregistré(s)`,
    );
  }

  // Plus vieux verrou tenu : le verrou principal (opération en cours) ou d'état (écriture en cours).
  /** @type {Array<{kind: 'main'|'state', ageMs: number, holder: string|null}>} */
  const held = [];
  if (mainLock && (mainLock.state === 'held' || mainLock.state === 'frozen')) {
    const since = Date.parse(mainLock.startedAt ?? '');
    if (Number.isFinite(since)) {
      held.push({
        kind: 'main',
        ageMs: Math.max(0, Date.now() - since),
        holder: mainLock.holder ?? null,
      });
    }
  }
  if (stateLock?.present && stateLock.alive && Number.isFinite(stateLock.ageMs)) {
    held.push({ kind: 'state', ageMs: stateLock.ageMs, holder: null });
  }
  const oldest = held.sort((a, b) => b.ageMs - a.ageMs)[0] ?? null;
  if (oldest === null) {
    add('performance', 'ok', 'performance.oldestLock', { ageMs: null }, 'aucun verrou tenu');
    return;
  }
  const long = oldest.ageMs > LOCK_AGE_WARN_MS;
  add(
    'performance',
    long ? 'warn' : 'ok',
    'performance.oldestLock',
    { ageMs: Math.round(oldest.ageMs), kind: oldest.kind, holder: oldest.holder },
    `verrou ${oldest.kind === 'main' ? 'principal' : "d'état"} tenu depuis ${Math.round(oldest.ageMs / 1000)} s${oldest.holder ? ` par « ${oldest.holder} »` : ''}${long ? ' : tout le reste attend (Test Gate ou appel LLM long, ou détenteur figé)' : ''}`,
    long ? 'striart lock' : null,
  );
}

function compareVersion(actual, wanted) {
  for (let i = 0; i < wanted.length; i += 1) {
    const a = actual[i] ?? 0;
    if (a !== wanted[i]) return a - wanted[i];
  }
  return 0;
}

/**
 * Enregistre un constat de `hardening-checks.ts` : l'identifiant du constat est
 * la `key` i18n ; le texte français de référence est composé ici.
 * @param {(id: keyof typeof LABELS, level: DoctorLevel, key: string, params: Record<string, unknown>, detail: string, hint?: string|null) => unknown} add
 * @param {'state-privacy'|'gate-env'} id
 * @param {import('./hardening-checks.ts').HardeningCheck} check
 */
function addHardening(add, id, check) {
  const p = /** @type {any} */ check.params;
  /** @type {Record<string, [string, string|null]>} */
  const text = {
    'state-privacy.ok': [`${p.inspected} élément(s) de .striart/ réservé(s) à l'utilisateur`, null],
    'state-privacy.open': [
      `${p.count} élément(s) de .striart/ lisible(s) par d'autres comptes : ${(p.examples ?? []).map((/** @type {any} */ e) => e.path).join(', ')}`,
      'striart init (resserre l’existant)',
    ],
    'state-privacy.relaxed': [
      'protection RELÂCHÉE : .striart/ n’est pas réservé à l’utilisateur (privateStateDir: false)',
      'retire privateStateDir: false de striart.config, puis striart init',
    ],
    'state-privacy.unreadable': [
      `permissions de .striart/ non évaluables (${p.cause})`,
      'striart init',
    ],
    'gate-env.filtered': [
      `environnement filtré : ${p.passed} variable(s) transmise(s), ${p.removedSecrets} secret(s) retiré(s), ${p.requested} variable(s) demandée(s) par le dépôt`,
      null,
    ],
    'gate-env.inherit': [
      'protection RELÂCHÉE : le Test Gate reçoit TOUT l’environnement de l’orchestrateur, clés d’API comprises (gateEnv: "inherit")',
      'retire gateEnv: "inherit" de striart.config si ce n’est pas voulu',
    ],
    'gate-env.refused': [
      `variables demandées par le dépôt (gateEnv) mais non autorisées par la config utilisateur : ${(p.names ?? []).join(', ')}`,
      'ajoute-les à gate.envAllow dans la config utilisateur si elles sont voulues, sinon retire-les de gateEnv',
    ],
  };
  const [detail, hint] = text[check.id] ?? [check.id, null];
  add(id, check.status, check.id, check.params, detail, hint);
}

/**
 * Exécute tous les diagnostics. Ne throw jamais.
 *
 * `healthy` reste « aucun fail » (code de sortie de `striart doctor`) ;
 * `summary` compte chaque niveau, pour qu'aucun affichage ne puisse
 * conclure « tout va bien » en présence d'avertissements.
 * @param {string} [cwd]
 * @returns {Promise<DoctorReport>}
 */
export async function runDoctor(cwd = process.cwd()) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  /**
   * @param {keyof typeof LABELS} id @param {DoctorLevel} level @param {string} key
   * @param {Record<string, unknown>} params @param {string} detail @param {string|null} [hint]
   */
  const add = (id, level, key, params, detail, hint = null) =>
    checks.push({ id, label: LABELS[id], level, detail, hint, key, params });

  // 1. git présent + version.
  let gitOk = false;
  try {
    const raw = (await simpleGit().raw(['--version'])).trim();
    const version = (raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/) ?? []).slice(1).map(Number);
    gitOk = true;
    if (compareVersion(version, GIT_MINIMUM) < 0) {
      const min = GIT_MINIMUM.join('.');
      add(
        'git',
        'fail',
        'git.tooOld',
        { raw, min },
        `${raw} : minimum requis ${min}`,
        'mets git à jour',
      );
    } else if (compareVersion(version, GIT_RECOMMENDED) < 0) {
      const recommended = GIT_RECOMMENDED.join('.');
      add(
        'git',
        'warn',
        'git.old',
        { raw, recommended },
        `${raw} : ${recommended}+ recommandé (nettoyage des secrets au clonage)`,
        'mets git à jour',
      );
    } else {
      add('git', 'ok', 'git.ok', { raw }, raw);
    }
  } catch {
    add('git', 'fail', 'git.missing', {}, 'git introuvable dans le PATH', 'installe git');
  }

  // 1bis. Binaire natif (identité et arbre de process, conteneur du Test
  //       Gate) : sans lui, status, lock, stop et le kill d'arbre échouent.
  await addNativeCheck(add);

  // 2. Repo git + au moins un commit (sans commit, `start` refuse : EMPTY_REPO).
  let root = null;
  let hasCommit = false;
  if (gitOk) {
    try {
      root = path.resolve((await simpleGit(cwd).revparse(['--show-toplevel'])).trim());
      try {
        await simpleGit(root).revparse(['--verify', 'HEAD']);
        hasCommit = true;
        add('repo', 'ok', 'repo.ok', { root }, root);
      } catch {
        add(
          'repo',
          'fail',
          'repo.noCommit',
          { root },
          `${root} : aucun commit, aucun agent ne peut être cloné`,
          'git commit --allow-empty -m "chore: initial commit"',
        );
      }
    } catch {
      add('repo', 'fail', 'repo.none', { cwd }, `aucun dépôt Git depuis ${cwd}`, 'git init');
    }
  } else {
    add('repo', 'skip', 'skip.noGit', {}, 'git indisponible');
  }

  // 3. Initialisation .striart/.
  let initialized = false;
  if (root) {
    initialized = Boolean(await stat(striartDir(root)).catch(() => null));
    if (initialized) {
      add('init', 'ok', 'init.ok', { dir: striartDir(root) }, striartDir(root));
    } else {
      add('init', 'fail', 'init.missing', {}, '.striart/ absent', 'striart init');
    }
  } else {
    add('init', 'skip', 'skip.noRepo', {}, 'pas de dépôt');
  }

  // 4. Config chargeable + validée.
  let config = null;
  if (root) {
    try {
      config = await loadConfig(root);
      // Clés inconnues : tolérées au chargement (compatibilité), jamais en silence.
      // Les noms viennent d'un fichier modifiable : forme bornée, sinon masqués.
      const unknown = listUnknownConfigKeys(config).map((key) =>
        /^[\w.-]{1,64}$/.test(key) ? key : '(nom illisible)',
      );
      if (unknown.length > 0) {
        add(
          'config',
          'warn',
          'config.unknownKeys',
          { path: config.configPath ?? null, keys: unknown },
          `clé(s) de premier niveau inconnue(s), ignorée(s) : ${unknown.join(', ')}`,
          'vérifie l’orthographe (docs : configuration) ; une faute de frappe laisse un réglage inactif',
        );
      } else {
        add(
          'config',
          'ok',
          'config.ok',
          { path: config.configPath ?? null },
          config.configPath ? config.configPath : 'aucun fichier trouvé, valeurs par défaut',
        );
      }
    } catch (error) {
      add(
        'config',
        'fail',
        'config.invalid',
        { message: error.message },
        error.message,
        'corrige striart.config (docs : configuration)',
      );
    }
  } else {
    add('config', 'skip', 'skip.noRepo', {}, 'pas de dépôt');
  }

  // 4bis. Hôte de pty : implémentation, shell effectif (config validée ci-dessus).
  if (root && config) await addPtyCheck(add, root, config);

  // 5. Branche cible : doit exister (sinon merge, sync, watch, rollback
  //    échouent tous), et le repo doit être dessus pour merger.
  if (root && config && hasCommit) {
    try {
      const git = simpleGit(root);
      const targetSha = await git
        .revparse(['--verify', '--quiet', `refs/heads/${config.targetBranch}^{commit}`])
        .then((out) => out.trim())
        .catch(() => '');
      const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      const target = config.targetBranch;
      if (!/^[0-9a-f]{40,64}$/.test(targetSha)) {
        add(
          'branch',
          'fail',
          'branch.missing',
          { target },
          `targetBranch = « ${target} » n'existe pas : merge, sync, watch et rollback échoueront`,
          'corrige targetBranch dans striart.config (branches existantes : git branch --list)',
        );
      } else if (branch !== target) {
        add(
          'branch',
          'warn',
          'branch.mismatch',
          { branch, target },
          `sur « ${branch} » mais targetBranch = « ${target} » : merge et watch refuseront`,
          `git switch ${target}`,
        );
      } else {
        add('branch', 'ok', 'branch.ok', { branch }, branch);
      }
    } catch {
      add('branch', 'skip', 'branch.unreadable', {}, 'HEAD illisible');
    }
  } else if (hasCommit) {
    add('branch', 'skip', 'skip.noConfig', {}, 'config indisponible');
  } else {
    add('branch', 'skip', 'skip.noCommit', {}, 'aucun commit');
  }

  // 6. LLM : config résolue + joignabilité (ollama) ou clé API (cloud).
  //    `warn` et non `fail` : le mode supervisé (`striart start`) n'en a pas
  //    besoin ; seuls le Router (`run`) et la fusion sémantique en dépendent.
  let llmUsable = false;
  if (config) {
    try {
      const resolved = resolveLlmConfig(config);
      const { provider, model, baseUrl: url } = resolved;
      if (provider === 'ollama') {
        const probe = await probeOllama(url);
        llmUsable = probe.ok;
        if (llmUsable) {
          add('llm', 'ok', 'llm.ok', { provider, model, url }, `ollama:${model} @ ${url}`);
        } else if (probe.error) {
          // Refus de la politique réseau (HTTPS exigé, hors ligne, liste blanche…) : le dire,
          // plutôt qu'un « injoignable » trompeur.
          add(
            'llm',
            'warn',
            'llm.networkRefused',
            { url, code: probe.error.code, message: probe.error.message },
            `ollama sur ${url} : ${probe.error.code} — ${probe.error.message}`,
            probe.error.hint,
          );
        } else {
          add(
            'llm',
            'warn',
            'llm.ollamaDown',
            { url },
            `ollama injoignable sur ${url} : striart run (Router) et la fusion sémantique sont indisponibles`,
            'ollama serve',
          );
        }
      } else if (!resolved.apiKey) {
        add(
          'llm',
          'warn',
          'llm.noKey',
          { provider, model, env: resolved.apiKeyEnv },
          `${provider}:${model} : variable ${resolved.apiKeyEnv} absente de l'environnement`,
          `définis ${resolved.apiKeyEnv} (shell ou fichier .env)`,
        );
      } else {
        llmUsable = true;
        add('llm', 'ok', 'llm.ok', { provider, model, url }, `${provider}:${model} @ ${url}`);
      }
    } catch (error) {
      add(
        'llm',
        'fail',
        'llm.invalid',
        { message: error.message },
        error.message,
        'corrige llm dans striart.config',
      );
    }
  } else {
    add('llm', 'skip', 'skip.noConfig', {}, 'config indisponible');
  }

  // 6ter. Réseau d'entreprise : proxy, CA, hôtes autorisés, hors ligne (src/net.ts).
  await addNetworkCheck(add);

  // 6bis. Secrets historiques : `start`/`run` refusent de cloner tant qu'un
  //       secret a existé dans l'historique (HISTORICAL_SECRETS_FOUND).
  if (root && config && hasCommit) {
    const patterns = config.secretPatterns ?? [];
    try {
      const historical = await scanHistoricalSecrets(root, patterns);
      if (patterns.length === 0) {
        // Relâchement explicite de config-as-code : ni exclusion des secrets des
        // clones ni scan historique. Jamais un « ignoré » neutre.
        add(
          'secrets',
          'warn',
          'secrets.disabled',
          {},
          'exclusion des secrets et scan historique désactivés (secretPatterns: [])',
          'retire secretPatterns: [] (ou liste tes propres motifs) pour rétablir la protection',
        );
      } else if (historical.length === 0) {
        add('secrets', 'ok', 'secrets.ok', {}, 'aucun');
      } else {
        add(
          'secrets',
          'warn',
          'secrets.found',
          { files: historical },
          `${historical.join(', ')} présent(s) dans l'historique : un agent pourrait les lire, start et run refuseront de cloner`,
          'révoque ces secrets, puis relance avec --allow-historical-secrets',
        );
      }
    } catch (error) {
      add(
        'secrets',
        'warn',
        'secrets.unreadable',
        { message: error.message },
        `historique illisible : ${error.message}`,
      );
    }
  }

  // 6ter. Chemins protégés (garde I2) : tout relâchement (allow, matchCase
  //       'platform') est affiché ici, en plus d'être journalisé à chaque merge.
  if (config) {
    try {
      const policy = resolveProtectedPathsPolicy(config);
      const { allow, caseSensitive } = policy.relaxed;
      if (allow.length > 0 || caseSensitive) {
        add(
          'protected',
          'warn',
          'protected.relaxed',
          { allow, caseSensitive },
          `protection RELÂCHÉE par la config :${allow.length > 0 ? ` allow ${allow.join(', ')}` : ''}${caseSensitive ? ' — comparaison sensible à la casse (matchCase: platform)' : ''}. Journalisé à chaque merge.`,
          "retire protectedAgentPaths.allow / matchCase de striart.config si ce n'est pas voulu",
        );
      } else {
        add(
          'protected',
          'ok',
          'protected.ok',
          policy.counts,
          `${policy.counts.defaults} motifs par défaut${policy.counts.extend > 0 ? ` + ${policy.counts.extend} ajoutés (extend)` : ''}, sans casse : un agent qui les change voit son merge refusé (ticket)`,
        );
      }
    } catch {
      add(
        'protected',
        'fail',
        'protected.invalid',
        {},
        'protectedAgentPaths invalide : chaque merge échouera',
        'corrige protectedAgentPaths dans striart.config',
      );
    }
  }

  // 6quater. Serveur MCP (décision D6) : le niveau orchestrateur est un
  //          relâchement, affiché ici en plus d'être journalisé au démarrage.
  if (config) {
    const relaxations = mcpRelaxations(resolveMcpSettings(config));
    if (relaxations.length > 0) {
      add(
        'mcp',
        'warn',
        'mcp.relaxed',
        { keys: relaxations.map((r) => r.key) },
        "niveau ORCHESTRATEUR (mcp.scope: 'orchestrator') : hors clone, un serveur MCP peut lancer des tâches, merger tout agent et appliquer toute résolution (jamais fermer un ticket sans Test Gate ni arbitrer une permission). Journalisé au démarrage.",
        "retire mcp.scope de striart.config si ce n'est pas voulu",
      );
    } else {
      add(
        'mcp',
        'ok',
        'mcp.scoped',
        {},
        "outils MCP bornés à l'agent appelant (clone ou --agent) ; lecture seule hors clone",
      );
    }
  }

  // 6quater-bis. Modes d'orchestration (lot O) : relâchements explicites —
  //             perdants de course supprimés, écritures d'un relecteur
  //             jetées. Toujours affichés.
  if (config) {
    const relaxations = orchestrationRelaxations(config);
    if (relaxations.length > 0) {
      add(
        'orchestration',
        'warn',
        'orchestration.relaxed',
        { keys: relaxations.map((r) => r.key) },
        `protection RELÂCHÉE : ${relaxations.map((r) => r.key).join(', ')} — ${relaxations.map((r) => r.summary).join(' ')}`,
        "retire ces réglages de striart.config si ce n'est pas voulu",
      );
    } else {
      add(
        'orchestration',
        'ok',
        'orchestration.ok',
        {},
        "modes orchestrés aux défauts sûrs : perdants d'une course conservés, relecteur en lecture seule vérifiée, après un échec plus rien ne démarre",
      );
    }
  }

  // 6quater-bis-bis. GC d'inactivité (src/idle/) : détection et rapport par défaut ; la
  //                  fermeture automatique est une politique OPT-IN qui exige AUSSI l'autorisation
  //                  de la config utilisateur (idle.closeRoots). Toujours affiché.
  if (config && root) {
    const settings = resolveIdleSettings(config);
    const relaxed = idleRelaxations(config);
    if (relaxed.length > 0) {
      add(
        'idle',
        'warn',
        'idle.relaxed',
        { keys: relaxed.map((r) => r.key) },
        `protection RELÂCHÉE : ${relaxed.map((r) => r.key).join(', ')} — ${relaxed.map((r) => r.summary).join(' ')}`,
        "retire ces réglages de striart.config si ce n'est pas voulu",
      );
    }
    if (settings.enabled && settings.action === 'close') {
      const auth = await closeAuthorization(root);
      if (auth.authorized) {
        add(
          'idle',
          'ok',
          'idle.closeAuthorized',
          {
            warnAfterMs: settings.warnAfterMs,
            closeAfterMs: settings.closeAfterMs,
            graceMs: settings.graceMs,
          },
          'fermeture automatique des sessions inactives ACTIVE et autorisée par la config utilisateur (avertissement, délai de grâce ; clone et travail toujours conservés)',
        );
      } else {
        add(
          'idle',
          'warn',
          'idle.closeUnauthorized',
          { error: auth.error },
          auth.error
            ? `idle.action: 'close' demandé mais la config utilisateur est illisible (${auth.error}) : aucune session ne sera fermée`
            : "idle.action: 'close' demandé mais ce dépôt n'est pas dans idle.closeRoots de la config utilisateur : aucune session ne sera fermée (avertissement seulement)",
          'striart doctor',
        );
      }
    } else if (settings.enabled) {
      add(
        'idle',
        'ok',
        'idle.ok',
        {
          action: settings.action,
          warnAfterMs: settings.warnAfterMs,
          closeAfterMs: settings.closeAfterMs,
        },
        `agents inactifs détectés et rapportés (action: ${settings.action}) ; aucune session fermée automatiquement`,
      );
    }
  }

  // 6quater-ter. Tokens et coûts (lot T) : comptabilité active, plafonds,
  //              relâchements (accounting coupé, plafonds en alerte seule),
  //              prix périmés, consignes compactes. Toujours affichés.
  if (config && root) {
    try {
      const summary = await usageSummary(root, config);
      const llmDown = llmResilienceRelaxations(config);
      const relaxed = [...summary.relaxations, ...llmDown];
      const exceeded = summary.budgets.filter((b) => b.level === 'exceeded');
      const warnBudgets = summary.budgets.filter((b) => b.level === 'warn');
      const footprint = instructionsFootprint(config);
      const params = {
        tokens: summary.today.tokens,
        costUsd: summary.today.costUsd,
        budgets: summary.budgets.length,
        enforcement: summary.enforcement,
        instructions: summary.instructionsMode,
        instructionsTokens:
          summary.instructionsMode === 'compact' ? footprint.compactTokens : footprint.fullTokens,
        keys: relaxed.map((r) => r.key),
        stale: summary.stalePrices.map((p) => p.key),
        exceeded: exceeded.map((b) => `${b.scope}.${b.metric}`),
      };
      if (relaxed.length > 0) {
        add(
          'tokens',
          'warn',
          'tokens.relaxed',
          params,
          `protection RELÂCHÉE : ${relaxed.map((r) => r.key).join(', ')} — ${relaxed.map((r) => r.summary).join(' ')}`,
          "retire ces réglages de striart.config si ce n'est pas voulu",
        );
      }
      if (exceeded.length > 0) {
        add(
          'tokens',
          'warn',
          'tokens.exceeded',
          params,
          `plafond de tokens atteint : ${params.exceeded.join(', ')} — les appels LLM et sessions concernés sont refusés`,
          'striart usage',
        );
      } else if (warnBudgets.length > 0) {
        add(
          'tokens',
          'warn',
          'tokens.warn',
          params,
          `plafond de tokens bientôt atteint (${warnBudgets.map((b) => `${b.scope}.${b.metric} ${(b.ratio * 100).toFixed(0)} %`).join(', ')})`,
          'striart usage',
        );
      }
      if (summary.stalePrices.length > 0) {
        add(
          'tokens',
          'warn',
          'tokens.stalePrices',
          params,
          `prix périmés dans tokens.pricing : ${params.stale.join(', ')} — les coûts affichés peuvent être faux`,
          'mets à jour tokens.pricing (champ asOf)',
        );
      }
      if (relaxed.length === 0 && exceeded.length === 0 && summary.stalePrices.length === 0) {
        add(
          'tokens',
          'ok',
          'tokens.ok',
          params,
          `comptabilité active (aujourd'hui ${summary.today.tokens} tokens), ${summary.budgets.length} plafond(s) posé(s), consignes ${summary.instructionsMode} (~${params.instructionsTokens} tokens)`,
        );
      }
    } catch (error) {
      add(
        'tokens',
        'warn',
        'tokens.unreadable',
        { cause: error.code ?? error.message },
        `registre d'usage illisible : ${error.message}`,
      );
    }
  }

  // 6quinquies. Profils d'agents (lots I4/I5) : relâchements explicites —
  //             téléchargement de binaires ACP, consignes désactivées,
  //             presets expérimentaux déclarés — toujours affichés.
  if (config) {
    const profiles: Record<string, AgentProfile> = config.agentProfiles ?? {};
    const experimental = Object.entries(profiles)
      .filter(([, p]) => p.experimental === true)
      .map(([key]) => key)
      .sort();
    const download = config.acpRegistry?.allowBinaryDownload === true;
    const noInstructions = config.agentInstructions?.enabled === false;
    if (download || noInstructions || experimental.length > 0) {
      add(
        'profiles',
        'warn',
        'profiles.relaxed',
        { download, noInstructions, experimental },
        [
          download
            ? 'acpRegistry.allowBinaryDownload : --import-acp peut TÉLÉCHARGER un binaire (épinglé, sha256 vérifié, journalisé)'
            : null,
          noInstructions
            ? 'agentInstructions.enabled: false : les agents ne reçoivent aucune consigne Striart'
            : null,
          experimental.length > 0
            ? `presets expérimentaux déclarés (non vérifiés en doc officielle) : ${experimental.join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join(' ; '),
        "retire ces réglages de striart.config si ce n'est pas voulu",
      );
    } else {
      add(
        'profiles',
        'ok',
        'profiles.ok',
        { count: Object.keys(config.agentProfiles ?? {}).length },
        `${Object.keys(config.agentProfiles ?? {}).length} profils (presets vérifiés), consignes Striart actives, import ACP en métadonnées seules`,
      );
    }
  }

  // 6sexies. Dashboard : hôtes admis en plus de la boucle locale
  //          (dashboardAllowedHosts) — relâchement explicite du seul contrôle
  //          Host, affiché ici et journalisé à chaque démarrage du dashboard.
  if (config) {
    if (config.dashboardHostname === 'localhost') {
      add(
        'dashboard',
        'warn',
        'dashboard.hostnameLocalhost',
        {},
        'dashboardHostname vaut "localhost" : le navigateur envoie le cookie de session à tout serveur localhost:* (RFC 6265 §8.5), par exemple le serveur de dev d’un agent qui pourrait le rejouer. Journalisé à chaque démarrage.',
        'retire dashboardHostname de striart.config (défaut "instance") sauf si ton navigateur ne résout pas *.localhost',
      );
    }
    const hosts = Array.isArray(config.dashboardAllowedHosts) ? config.dashboardAllowedHosts : [];
    if (hosts.length > 0) {
      add(
        'dashboard',
        'warn',
        'dashboard.hostsRelaxed',
        { hosts },
        `contrôle Host RELÂCHÉ : ${hosts.join(', ')} admis en plus de la boucle locale (dashboardAllowedHosts). Le jeton, le cookie SameSite=Strict, Sec-Fetch-Site, Origin et l'anti-CSRF restent exigés. Journalisé à chaque démarrage.`,
        "retire dashboardAllowedHosts de striart.config si ce n'est pas voulu",
      );
    } else {
      add(
        'dashboard',
        'ok',
        'dashboard.hostsStrict',
        {},
        'Host limité à la boucle locale (127.0.0.1, localhost, [::1])',
      );
    }
  }

  // 6sexies-bis. Durcissement : données locales réservées à l'utilisateur
  //          (.striart/) et environnement filtré du Test Gate. La config
  //          UTILISATEUR (gate.envAllow) est lue UNE fois, ici, et réutilisée
  //          par la synthèse des relâchements ci-dessous.
  let userConfig = null;
  let userConfigUnreadable = false;
  try {
    userConfig = await readUserConfig();
  } catch {
    userConfigUnreadable = true;
  }
  if (root && config && initialized) {
    const privacy = await checkStateDirPrivacy(root, config).catch(
      (error) => /** @type {import('./hardening-checks.ts').HardeningCheck} */ ({
        status: 'warn',
        id: 'state-privacy.unreadable',
        params: { cause: error?.code ?? error?.message ?? 'erreur' },
      }),
    );
    addHardening(add, 'state-privacy', privacy);
  }
  if (config) {
    addHardening(
      add,
      'gate-env',
      checkGateEnv(config, userConfig?.gate.envAllow ?? [], process.env),
    );
  }

  // 6septies. Synthèse : toutes les protections relâchées, en une ligne
  //           (src/doctor-relaxations.ts). Les lignes dédiées ci-dessus
  //           gardent leur détail ; celle-ci donne la vue d'ensemble.
  // 4ter. Conteneur du Test Gate : 'native' (défaut, fail closed si le binaire
  //       natif manque, orphelins détectés) ou 'process' (relâchement explicite).
  if (config) {
    const container = config.gateContainer;
    const gateParams = {
      container,
      orphanGraceMs: config.gateOrphanGraceMs,
      maxOutputBytes: config.gateMaxOutputBytes,
    };
    if (container === 'process') {
      add(
        'gate',
        'warn',
        'gate.process',
        gateParams,
        "conteneur « process » (gateContainer) : arbre tué au délai seulement, AUCUNE détection d'orphelins",
        'gateContainer: "native" (défaut) pour la détection d\'orphelins',
      );
    } else {
      add(
        'gate',
        'ok',
        'gate.native',
        gateParams,
        `conteneur natif (gateContainer) — grâce des orphelins ${config.gateOrphanGraceMs} ms, journal plafonné à ${config.gateMaxOutputBytes} octets`,
      );
    }
  }
  // Politique de livraison (information, pas relâchement) : mode, et délais bornant le push et le
  // commit de merge (hooks de la cible compris).
  if (config) {
    const delivery = config.delivery === 'branch' ? 'branch' : 'push';
    const params = {
      delivery,
      autoPush: config.autoPush === true,
      pushTimeoutMs: config.pushTimeoutMs,
      commitTimeoutMs: config.commitTimeoutMs,
    };
    const seconds = (/** @type {number} */ ms) => `${Math.round(ms / 1000)} s`;
    let mode = 'autoPush désactivé : aucune livraison vers origin';
    if (params.autoPush) {
      mode =
        delivery === 'branch'
          ? 'livraison par BRANCHE : le commit testé part sur une branche de revue (PR/MR), jamais sur la cible'
          : 'livraison par push de la branche cible';
    }
    add(
      'delivery',
      'ok',
      `delivery.${delivery}`,
      params,
      `${mode} ; délai du push ${seconds(params.pushTimeoutMs)} (pushTimeoutMs), délai du commit de merge ${seconds(params.commitTimeoutMs)} (commitTimeoutMs)`,
    );
  }
  {
    let protectedRelaxed = null;
    if (config) {
      try {
        protectedRelaxed = resolveProtectedPathsPolicy(config).relaxed;
      } catch {
        // protectedAgentPaths invalide : déjà un échec dédié (protected.invalid).
      }
    }
    let userTrustedRoots = [];
    let userEnvAllow = [];
    let userNetwork;
    let userGateEnvAllow = [];
    if (userConfig) {
      userTrustedRoots = userConfig.hooks.trustedRoots;
      userEnvAllow = userConfig.env.allow;
      userNetwork = userConfig.network;
      userGateEnvAllow = userConfig.gate.envAllow;
    }
    const {
      names,
      policies,
      unreadable: unevaluated,
    } = collectRelaxations({
      config,
      protectedRelaxed,
      userTrustedRoots,
      userEnvAllow,
      userGateEnvAllow,
      userNetwork,
      userNetworkUnreadable: userConfigUnreadable,
      tlsVerificationDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0',
    });
    const unreadable = userConfigUnreadable
      ? [...unevaluated, 'hooks.trustedRoots'].sort()
      : unevaluated;
    if (names.length > 0 || unreadable.length > 0) {
      add(
        'relaxations',
        'warn',
        'relaxations.some',
        { names, count: names.length, unreadable, policies },
        [
          names.length > 0
            ? `${names.length} protection(s) relâchée(s) : ${names.join(', ')}`
            : null,
          unreadable.length > 0 ? `non évaluable(s) : ${unreadable.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join(' ; '),
        "chaque ligne dédiée détaille son relâchement ; retire le réglage correspondant si ce n'est pas voulu",
      );
    } else {
      add(
        'relaxations',
        'ok',
        'relaxations.none',
        { names: [], count: 0, unreadable: [], policies },
        'aucune protection relâchée : défauts sûrs partout',
      );
    }
  }

  // 7. Verrou inter-processus.
  if (root && initialized) {
    await addLockCheck(add, root);
    await addStateLockCheck(add, root);
  }

  // 7bis. Session principale déclarée (édition directe / agent hors clone).
  if (root && initialized) {
    const session = await readMainSessionStatus(root).catch(() => null);
    if (!session) {
      add('main-session', 'ok', 'mainSession.free', {}, 'libre');
    } else if (session.alive) {
      add(
        'main-session',
        'warn',
        'mainSession.busy',
        { reason: session.reason, pid: session.pid, startedAt: session.startedAt },
        `occupé par « ${session.reason} » (pid ${session.pid}) depuis ${session.startedAt} : ` +
          'merge, sync, promote et resolve --apply refusent tant que ce process vit',
        'striart lock --stop',
      );
    } else {
      add(
        'main-session',
        'ok',
        'mainSession.dead',
        { pid: session.pid },
        `session déclarée mais PID ${session.pid} mort : se libère à la prochaine opération`,
      );
    }
  }

  // 8. Agents, file d'attente, espace disque.
  /** @type {number | null} */
  let agentCount = null;
  if (root && initialized) {
    try {
      const [agents, queue] = await Promise.all([listAgents(root), readQueue(root)]);
      agentCount = agents.length;
      const broken = agents.filter((a) => a.status !== 'ACTIVE');
      const { sizeBytes } = await dirStats(path.join(striartDir(root), 'agents')).catch(() => ({
        sizeBytes: 0,
      }));
      const params = { active: agents.length, queued: queue.length, sizeBytes };
      const facts = `${agents.length} ACTIVE, ${queue.length} en file, ${formatBytes(sizeBytes)} sur disque`;
      if (broken.length > 0) {
        const states = broken.map((b) => b.status);
        add(
          'agents',
          'warn',
          'agents.broken',
          { ...params, broken: broken.length, states },
          `${facts} ; ${broken.length} clone(s) en état ${states.join('/')}`,
          'striart status',
        );
      } else {
        add('agents', 'ok', 'agents.ok', params, facts);
      }
    } catch (error) {
      add(
        'agents',
        'warn',
        'agents.unreadable',
        { message: error.message },
        `état illisible : ${error.message}`,
      );
    }
  }

  // 8bis. Performance (L8) : mesures bornées, jamais bloquantes pour le reste du diagnostic.
  if (root && initialized) {
    try {
      await addPerformanceCheck(add, root, agentCount);
    } catch (error) {
      add(
        'performance',
        'warn',
        'performance.unreadable',
        { message: error.message },
        `mesures de performance impossibles : ${error.message}`,
      );
    }
  }

  // 9. Tickets ouverts + fusion sémantique (config, mode manuel, LLM).
  if (root && initialized) {
    try {
      const [tickets, state] = await Promise.all([listConflictTickets(root), readState(root)]);
      if (tickets.length > 0) {
        add(
          'tickets',
          'warn',
          'tickets.open',
          { count: tickets.length },
          `${tickets.length} ouvert(s), résolution humaine attendue`,
          'striart resolve',
        );
      } else {
        add('tickets', 'ok', 'tickets.none', {}, 'aucun ticket ouvert');
      }

      const streak = state.semanticFailureStreak;
      if (config && !config.semanticMerge) {
        add('manual', 'skip', 'semantic.disabled', {}, 'désactivée (semanticMerge: false)');
      } else if (state.manualMode) {
        add(
          'manual',
          'warn',
          'semantic.manual',
          { streak },
          `mode manuel actif (${streak} échecs consécutifs) : chaque conflit devient un ticket`,
          'striart resolve --unlock',
        );
      } else if (!llmUsable) {
        add(
          'manual',
          'warn',
          'semantic.noLlm',
          {},
          'indisponible tant que le LLM ne répond pas : chaque conflit devient un ticket',
        );
      } else {
        add(
          'manual',
          'ok',
          'semantic.ok',
          { streak },
          streak > 0 ? `opérationnelle (${streak} échec(s) consécutif(s))` : 'opérationnelle',
        );
      }
    } catch (error) {
      add(
        'tickets',
        'warn',
        'tickets.unreadable',
        { message: error.message },
        `état illisible : ${error.message}`,
      );
    }
  }

  /** @type {Record<DoctorLevel, number>} */
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.level] += 1;
  return { checks, healthy: summary.fail === 0, summary };
}
