/**
 * striart doctor — diagnostic complet de l'environnement.
 *
 * Répond en une commande à "pourquoi ça ne marche pas ?" : version de git,
 * état du repo, initialisation, config, LLM joignable, verrou, tickets,
 * espace disque. Chaque check est indépendant et ne throw jamais — le
 * résultat est une liste de constats ok/warn/fail/skip, affichable en
 * table humaine ou en JSON (CI).
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { loadConfig } from './config.js';
import { resolveLlmConfig } from './llm.js';
import { pingOllama } from './ollama.js';
import { dirStats, formatBytes, listAgents, striartDir } from './clone.js';
import { listConflictTickets } from './conflicts.js';
import { readState } from './state.js';
import { readQueue } from './queue.js';

/** Version minimale pour sparse-checkout --no-cone (nettoyage des secrets). */
const GIT_RECOMMENDED = [2, 35];
/** Version minimale absolue pour les opérations Striart. */
const GIT_MINIMUM = [2, 25];

/**
 * @typedef {{id: string, label: string, level: 'ok'|'warn'|'fail'|'skip', detail: string}} DoctorCheck
 */

function compareVersion(actual, wanted) {
  for (let i = 0; i < wanted.length; i += 1) {
    const a = actual[i] ?? 0;
    if (a !== wanted[i]) return a - wanted[i];
  }
  return 0;
}

/**
 * Exécute tous les diagnostics. Ne throw jamais.
 * @param {string} [cwd]
 * @returns {Promise<{checks: DoctorCheck[], healthy: boolean}>}
 */
export async function runDoctor(cwd = process.cwd()) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  const add = (id, label, level, detail) => checks.push({ id, label, level, detail });

  // 1. git présent + version.
  let gitOk = false;
  try {
    const raw = (await simpleGit().raw(['--version'])).trim();
    const version = (raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/) ?? []).slice(1).map(Number);
    gitOk = true;
    if (compareVersion(version, GIT_MINIMUM) < 0) {
      add('git', 'Version de git', 'fail', `${raw} — minimum requis : ${GIT_MINIMUM.join('.')}`);
    } else if (compareVersion(version, GIT_RECOMMENDED) < 0) {
      add(
        'git',
        'Version de git',
        'warn',
        `${raw} — ${GIT_RECOMMENDED.join('.')}+ recommandé (nettoyage des secrets au clonage)`,
      );
    } else {
      add('git', 'Version de git', 'ok', raw);
    }
  } catch {
    add('git', 'Version de git', 'fail', 'git introuvable dans le PATH');
  }

  // 2. Repo git + au moins un commit.
  let root = null;
  if (gitOk) {
    try {
      root = path.resolve((await simpleGit(cwd).revparse(['--show-toplevel'])).trim());
      try {
        await simpleGit(root).revparse(['HEAD']);
        add('repo', 'Dépôt Git', 'ok', root);
      } catch {
        add(
          'repo',
          'Dépôt Git',
          'warn',
          `${root} — aucun commit (crée un premier commit avant striart start)`,
        );
      }
    } catch {
      add(
        'repo',
        'Dépôt Git',
        'fail',
        `aucun dépôt Git depuis ${cwd} ("git init" pour en créer un)`,
      );
    }
  } else {
    add('repo', 'Dépôt Git', 'skip', 'git indisponible');
  }

  // 3. Initialisation .striart/.
  let initialized = false;
  if (root) {
    initialized = Boolean(await stat(striartDir(root)).catch(() => null));
    add(
      'init',
      'Initialisation Striart',
      initialized ? 'ok' : 'fail',
      initialized ? striartDir(root) : '.striart/ absent — lance "striart init"',
    );
  } else {
    add('init', 'Initialisation Striart', 'skip', 'pas de dépôt');
  }

  // 4. Config chargeable + validée.
  let config = null;
  if (root) {
    try {
      config = await loadConfig(root);
      add(
        'config',
        'Configuration',
        'ok',
        config.configPath ? config.configPath : 'aucun fichier trouvé — valeurs par défaut',
      );
    } catch (error) {
      add('config', 'Configuration', 'fail', error.message);
    }
  } else {
    add('config', 'Configuration', 'skip', 'pas de dépôt');
  }

  // 5. Branche courante vs branche cible.
  if (root && config) {
    try {
      const branch = (await simpleGit(root).revparse(['--abbrev-ref', 'HEAD'])).trim();
      add(
        'branch',
        'Branche cible',
        branch === config.targetBranch ? 'ok' : 'warn',
        branch === config.targetBranch
          ? branch
          : `sur "${branch}" mais targetBranch = "${config.targetBranch}" — merge/watch refuseront`,
      );
    } catch {
      add('branch', 'Branche cible', 'skip', 'HEAD illisible');
    }
  }

  // 6. LLM : config résolue + joignabilité (ollama) ou clé API (cloud).
  if (config) {
    try {
      const resolved = resolveLlmConfig(config);
      if (resolved.provider === 'ollama') {
        const up = await pingOllama(resolved.baseUrl);
        add(
          'llm',
          'LLM (Router/Merger)',
          up ? 'ok' : 'warn',
          up
            ? `ollama:${resolved.model} @ ${resolved.baseUrl}`
            : `ollama injoignable sur ${resolved.baseUrl} — lance "ollama serve" (Router et fusion sémantique indisponibles)`,
        );
      } else if (!resolved.apiKey) {
        add(
          'llm',
          'LLM (Router/Merger)',
          'warn',
          `${resolved.provider}:${resolved.model} — variable ${resolved.apiKeyEnv} absente de l'environnement`,
        );
      } else {
        add(
          'llm',
          'LLM (Router/Merger)',
          'ok',
          `${resolved.provider}:${resolved.model} @ ${resolved.baseUrl}`,
        );
      }
    } catch (error) {
      add('llm', 'LLM (Router/Merger)', 'fail', error.message);
    }
  } else {
    add('llm', 'LLM (Router/Merger)', 'skip', 'config indisponible');
  }

  // 7. Verrou inter-processus.
  if (root && initialized) {
    const lockExists = await stat(path.join(striartDir(root), 'main.lock')).catch(() => null);
    add(
      'lock',
      'Verrou principal',
      lockExists ? 'warn' : 'ok',
      lockExists
        ? 'main.lock présent — opération en cours, ou verrou orphelin (récupéré automatiquement au prochain run)'
        : 'libre',
    );
  }

  // 8. Agents, file d'attente, espace disque.
  if (root && initialized) {
    try {
      const [agents, queue] = await Promise.all([listAgents(root), readQueue(root)]);
      const broken = agents.filter((a) => a.status !== 'ACTIVE');
      const { sizeBytes } = await dirStats(path.join(striartDir(root), 'agents')).catch(() => ({
        sizeBytes: 0,
      }));
      add(
        'agents',
        'Agents',
        broken.length > 0 ? 'warn' : 'ok',
        `${agents.length} actif(s), ${queue.length} en file, ${formatBytes(sizeBytes)} sur disque` +
          (broken.length > 0
            ? ` — ${broken.length} clone(s) en état ${broken.map((b) => b.status).join('/')}`
            : ''),
      );
    } catch (error) {
      add('agents', 'Agents', 'warn', `état illisible : ${error.message}`);
    }
  }

  // 9. Tickets ouverts + mode manuel.
  if (root && initialized) {
    try {
      const [tickets, state] = await Promise.all([listConflictTickets(root), readState(root)]);
      add(
        'tickets',
        'Tickets de conflit',
        tickets.length > 0 ? 'warn' : 'ok',
        tickets.length > 0
          ? `${tickets.length} ouvert(s) — "striart resolve" pour les traiter`
          : 'aucun ticket ouvert',
      );
      if (state.manualMode) {
        add(
          'manual',
          'Fusion sémantique',
          'warn',
          'mode manuel actif (3 échecs consécutifs) — "striart resolve --unlock" pour réactiver',
        );
      } else {
        add(
          'manual',
          'Fusion sémantique',
          'ok',
          state.semanticFailureStreak > 0
            ? `${state.semanticFailureStreak} échec(s) consécutif(s)`
            : 'opérationnelle',
        );
      }
    } catch (error) {
      add('tickets', 'Tickets de conflit', 'warn', `état illisible : ${error.message}`);
    }
  }

  return { checks, healthy: checks.every((c) => c.level !== 'fail') };
}
