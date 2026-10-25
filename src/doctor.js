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
import { loadConfig, listUnknownConfigKeys } from './config.js';
import { resolveLlmConfig } from './llm.js';
import { pingOllama } from './ollama.js';
import { dirStats, formatBytes, listAgents, scanHistoricalSecrets, striartDir } from './clone.js';
import { listConflictTickets } from './conflicts.js';
import { readState } from './state.js';
import { readMainSessionStatus } from './main-session.js';
import { readMainLockStatus, stopHolderCommand } from './lock.js';
import { readStateLockStatus } from './state-lock.ts';
import { readQueue } from './queue.js';
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
import { readUserConfig } from './user-config.ts';

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
  dashboard: 'Dashboard (hôtes)',
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
    error: /** @type {Error} */ (error),
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
  const params = {
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

function compareVersion(actual, wanted) {
  for (let i = 0; i < wanted.length; i += 1) {
    const a = actual[i] ?? 0;
    if (a !== wanted[i]) return a - wanted[i];
  }
  return 0;
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
        llmUsable = await pingOllama(url);
        if (llmUsable) {
          add('llm', 'ok', 'llm.ok', { provider, model, url }, `ollama:${model} @ ${url}`);
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
    const experimental = Object.entries(config.agentProfiles ?? {})
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
    let userConfigUnreadable = false;
    try {
      const userConfig = await readUserConfig();
      userTrustedRoots = userConfig.hooks.trustedRoots;
      userEnvAllow = userConfig.env.allow;
    } catch {
      userConfigUnreadable = true;
    }
    const { names, unreadable: unevaluated } = collectRelaxations({
      config,
      protectedRelaxed,
      userTrustedRoots,
      userEnvAllow,
    });
    const unreadable = userConfigUnreadable
      ? [...unevaluated, 'hooks.trustedRoots'].sort()
      : unevaluated;
    if (names.length > 0 || unreadable.length > 0) {
      add(
        'relaxations',
        'warn',
        'relaxations.some',
        { names, count: names.length, unreadable },
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
        { names: [], count: 0, unreadable: [] },
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
  if (root && initialized) {
    try {
      const [agents, queue] = await Promise.all([listAgents(root), readQueue(root)]);
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
