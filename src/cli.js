#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Command } from 'commander';

// Version unique : celle du package.json (plus de numéro codé en dur).
const { version } = createRequire(import.meta.url)('../package.json');

// Charge un éventuel .env du dossier courant (clés API des providers cloud).
try {
  process.loadEnvFile();
} catch {
  // Pas de .env : les variables d'environnement du shell suffisent.
}
import { StriartError } from './errors.js';
import { initStriart } from './init.js';
import { loadConfig } from './config.js';
import {
  assertInitialized,
  cleanClones,
  createAgent,
  findRepoRoot,
  formatBytes,
  listAgents,
  reuseAgent,
} from './clone.js';
import {
  applyPlan,
  checkAgentsBehind,
  getQueueDashboard,
  mergeAgentCommit,
  promoteStaging,
  reconcile,
  retryQueue,
  rollbackLastMerge,
  runAutonomousTask,
  runTask,
  shouldWatcherMerge,
  stopAgent,
  syncAgentWithMain,
  syncAllAgents,
} from './orchestrator.js';
import { closeConflictTicket, listConflictTickets } from './conflicts.js';
import { readState, resetManualMode } from './state.js';
import { DEFAULT_PROFILE, listProfiles } from './session.js';
import { openAgentTerminal } from './terminal.js';
import { watchAgents } from './watcher.js';
import { logger } from './logger.js';

const program = new Command();

program
  .name('striart')
  .description(
    'Orchestrateur Git multi-agents pour Claude Code, Aider, Cursor et tout agent de coding IA',
  )
  .version(version);

function fail(error) {
  if (error instanceof StriartError) {
    console.error(`❌ ${error.message} [${error.code}]`);
  } else {
    console.error(`❌ Erreur inattendue : ${error.message}`);
    logger.debug({ err: error }, 'Stack complète');
  }
  process.exitCode = 1;
}

program
  .command('init')
  .description('Initialise Striart dans le repo courant (.striart/, config, diagnostic du LLM)')
  .action(async () => {
    try {
      console.log('🔧 Initialisation de .striart/...');
      const { root, config, llmReady, llmDetail, created } = await initStriart();
      for (const item of created) console.log(`   ➕ ${item}`);
      console.log(`✅ .striart/ prêt dans ${root}`);
      console.log(`   Config : ${config.configPath ?? 'valeurs par défaut'}`);
      if (llmReady) {
        console.log(`   LLM : ${llmDetail}`);
      } else {
        console.log(
          `   ⚠️ LLM : ${llmDetail} — requis pour striart run (Router) et la fusion sémantique.`,
        );
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('start <agent>')
  .description('Clone le repo pour un nouvel agent isolé et crée sa branche de tâche')
  .option(
    '--command <cmd>',
    "Outil de coding propre à cet agent (claude, 'aider --model gpt-4o', ...)",
  )
  .option('--open', "Ouvre un onglet terminal dans le clone et y lance l'outil")
  .option(
    '--reuse',
    "Réhabilite le clone conservé d'un agent arrêté (resync sur main, nouvelle branche)",
  )
  .option(
    '--force',
    'Avec --reuse : passe outre une archive récemment active ou du travail non commité/non mergé (PERDU)',
  )
  .action(async (agent, { command, open, reuse, force }) => {
    try {
      console.log(`🚀 ${reuse ? 'Réutilisation du clone de' : "Démarrage de l'agent"} ${agent}...`);
      const root = await findRepoRoot();
      const config = await loadConfig(root);
      const info = reuse
        ? await reuseAgent({
            root,
            name: agent,
            command: command ?? null,
            secretPatterns: config.secretPatterns,
            force: Boolean(force),
          })
        : await createAgent({
            root,
            name: agent,
            command: command ?? null,
            cloneFilter: config.cloneFilter,
            secretPatterns: config.secretPatterns,
          });
      await announceAgent(root, info, { open });
    } catch (error) {
      fail(error);
    }
  });

function printAgentStarted(info, agentCommand) {
  console.log(`✅ Clone créé : ${info.path}`);
  console.log(`   Branche : ${info.branch}`);
  console.log('');
  console.log('👉 Lance ton agent de coding dans ce dossier, par exemple :');
  console.log(`   cd "${info.path}" && ${agentCommand ?? 'claude'}`);
}

/** Commande de l'agent : par-agent (registre) > config globale > 'claude'. */
async function resolveAgentCommand(root, info) {
  return info.command ?? (await loadConfig(root)).agentCommand ?? 'claude';
}

async function announceAgent(root, info, { open = false } = {}) {
  const agentCmd = await resolveAgentCommand(root, info);
  printAgentStarted(info, agentCmd);
  if (!open) return;
  const result = await openAgentTerminal({
    cwd: info.path,
    title: `STRIART: ${info.name}`,
    command: agentCmd,
  });
  if (result.launched) {
    console.log(`🖥️ Onglet ouvert pour ${info.name} (${agentCmd}).`);
  } else {
    console.log(
      `⚠️ Ouverture du terminal impossible (${result.error}). Lance la commande ci-dessus manuellement.`,
    );
  }
}

/**
 * Mode autonome : Striart lance l'agent, le supervise, merge et nettoie.
 * Affichage seul — toute la logique est dans orchestrator.runAutonomousTask.
 */
async function runAutonomousCli({ root, agent, prompt, profile, timeout, after, reuse }) {
  let timeoutMs = null;
  if (timeout !== undefined) {
    timeoutMs = Number.parseInt(timeout, 10);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
      throw new StriartError('--timeout doit être un entier de millisecondes >= 1000.', {
        code: 'INVALID_TIMEOUT',
        details: { timeout },
      });
    }
  }

  console.log(
    `🤖 [AUTONOME] Profil ${profile ?? DEFAULT_PROFILE} — Striart pilote la session de bout en bout.`,
  );
  console.log('   Le Test Gate est le seul juge : aucun humain ne relira avant le merge.');

  const result = await runAutonomousTask({
    root,
    agent: agent ?? null,
    prompt,
    profile: profile ?? null,
    timeoutMs,
    after: after ?? null,
    reuse: Boolean(reuse),
  });

  if (result.status === 'QUEUED') {
    console.log(
      `⛔ [ROUTER] Collision — aucune session lancée, tâche ${result.task.id} mise en file d'attente.`,
    );
    console.log('   Relance-la avec "striart queue --retry" (elle repartira en mode supervisé).');
    return;
  }

  const { session } = result;
  const seconds = Math.round(session.durationMs / 1000);
  console.log(
    `   Session terminée en ${seconds}s — statut ${session.status}, code de sortie ${session.exitCode ?? 'n/a'}.`,
  );
  console.log(`   Log : ${session.logPath}`);

  if (result.status === 'MERGED') {
    console.log(`✅ [AUTONOME] Merge réussi (${result.merge.sha.slice(0, 8)}), Test Gate vert.`);
    console.log(
      result.cleaned
        ? `🧹 Clone supprimé — cycle complet, rien à conserver.`
        : `📦 ${result.keptReason}`,
    );
    return;
  }

  // Tous les autres chemins conservent le clone : on dit lequel, et pourquoi.
  console.log(`⚠️ [AUTONOME] ${result.status} — ${result.keptReason}`);
  console.log(`   Clone conservé : ${result.clonePath}`);
  if (result.merge && 'ticket' in result.merge) {
    console.log(`   Ticket de conflit : ${result.merge.ticket.id}`);
  }
  process.exitCode = 1;
}

program
  .command('run [prompt]')
  .description('Router préventif : prédit les fichiers touchés puis lance ou met en attente')
  .option('--agent <name>', "Nom de l'agent (défaut : dérivé du prompt)")
  .option('--prompt <prompt>', 'Tâche à confier à l’agent (équivalent au positionnel)')
  .option('--command <cmd>', 'Outil de coding propre à cet agent')
  .option('--open', "Ouvre un onglet terminal dans le clone et y lance l'outil")
  .option('--autonomous', 'Striart lance et supervise l’agent lui-même, puis nettoie le clone')
  .option(
    '--profile <name>',
    'Avec --autonomous : profil d’invocation (claude, codex, aider, ollama...)',
  )
  .option(
    '--timeout <ms>',
    'Avec --autonomous : délai max de la session (défaut : config autonomousTimeoutMs)',
  )
  .option(
    '--after <tâche|agent>',
    "N'exécute la tâche qu'une fois ce travail terminé (id de tâche en file ou nom d'agent actif)",
  )
  .option(
    '--reuse',
    'Réhabilite le clone conservé de --agent au lieu de cloner (refuse une archive sale ou active)',
  )
  .action(
    async (
      promptArg,
      { agent, prompt: promptOpt, command, open, autonomous, profile, timeout, after, reuse },
    ) => {
      try {
        const root = await findRepoRoot();
        const prompt = promptArg ?? promptOpt;
        if (autonomous) {
          await runAutonomousCli({ root, agent, prompt, profile, timeout, after, reuse });
          return;
        }
        console.log(`🧭 [ROUTER] Analyse de la tâche${agent ? ` de l'agent ${agent}` : ''}...`);
        const result = await runTask({
          root,
          agent: agent ?? null,
          prompt,
          command: command ?? null,
          after: after ?? null,
          reuse: Boolean(reuse),
        });
        const chosenAgent = result.status === 'STARTED' ? result.info.name : result.task.agent;
        if (!agent) console.log(`   Agent : ${chosenAgent} (nom dérivé du prompt)`);
        agent = chosenAgent;
        console.log(`   Fichiers prédits : ${result.predictedFiles.join(', ') || '(aucun)'}`);
        if (result.status === 'QUEUED') {
          for (const c of result.collisions) {
            console.log(
              `⛔ [ROUTER] Conflit détecté : Agent ${c.agent} et Agent ${agent} vont toucher ${c.files.join(', ')}.`,
            );
          }
          if (result.task.after) {
            console.log(`⏳ Dépendance déclarée : attend la fin de ${result.task.after}.`);
          }
          console.log(
            `   Lancement séquentiel forcé. Agent ${agent} mis en file d'attente (${result.task.id}).`,
          );
          console.log(
            '   La tâche repartira via "striart queue --retry" une fois l\'agent bloquant mergé.',
          );
          return;
        }
        console.log('✅ [ROUTER] Aucune collision.');
        for (const w of result.semanticWarnings ?? []) {
          const detail = w.links.map((l) => `${l.importedBy} importe ${l.file}`).join(' ; ');
          console.log(`⚠️ [ROUTER] Lien sémantique avec l'agent ${w.agent} : ${detail}.`);
          console.log(
            '   Pas de conflit Git attendu — mais leurs changements peuvent se casser mutuellement (le Test Gate tranchera).',
          );
        }
        for (const w of result.workspaceWarnings ?? []) {
          const detail = w.links
            .map((l) =>
              l.direction === 'depends-on'
                ? `${l.mine} dépend de ${l.theirs}`
                : `${l.theirs} dépend de ${l.mine}`,
            )
            .join(' ; ');
          console.log(`⚠️ [ROUTER] Packages liés avec l'agent ${w.agent} : ${detail}.`);
        }
        await announceAgent(root, result.info, { open });
      } catch (error) {
        fail(error);
      }
    },
  );

program
  .command('profiles')
  .description('Liste les profils d’agents configurés (mode autonome) : outil, env, timeout')
  .option('--json', 'Sortie JSON (CI/scripts)')
  .action(async ({ json }) => {
    try {
      const root = await findRepoRoot();
      const config = await loadConfig(root);
      const rows = listProfiles(config);
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log('Aucun profil configuré (agentProfiles vide).');
        return;
      }
      console.log(`${rows.length} profil(s) — utilisables via --profile ou dans un plan :`);
      for (const p of rows) {
        console.log(`\n  ${p.name}`);
        console.log(`    invocation : ${p.invocation}`);
        if (p.acp) console.log('    transport  : ACP (Agent Client Protocol)');
        if (p.envKeys.length > 0) console.log(`    env        : ${p.envKeys.join(', ')}`);
        if (p.timeout != null) console.log(`    timeout    : ${p.timeout} ms`);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('plan <file>')
  .description(
    'Applique un plan « tâches-as-code » (YAML) : un graphe de tâches et leurs dépendances, versionné dans le repo',
  )
  .option('--dry-run', 'Valide et affiche le plan sans rien lancer (revue avant exécution)')
  .action(async (file, { dryRun }) => {
    try {
      const root = await findRepoRoot();
      const planText = await readFile(file, 'utf8');
      const result = await applyPlan({ root, planText, dryRun: Boolean(dryRun) });

      if (result.dryRun) {
        console.log(`🔎 Plan valide : ${result.tasks.length} tâche(s). Rien n'a été lancé.`);
        for (const t of result.tasks) {
          const icon = t.mode === 'autonomous' ? '🤖' : '👤';
          const dep = t.after ? ` (après ${t.after})` : '';
          console.log(`   ${icon} ${t.id ?? t.agent ?? '(nom dérivé)'}${dep}`);
        }
        console.log('   Relance sans --dry-run pour appliquer.');
        return;
      }

      console.log(`📋 Plan appliqué : ${result.results.length} tâche(s).`);
      for (const r of result.results) {
        if (r.mode === 'autonomous') {
          console.log(`   🤖 ${r.agent} → ${r.status}`);
        } else if (r.status === 'STARTED') {
          console.log(`   👤 ${r.agent} → démarré`);
          await announceAgent(root, r.info);
        } else {
          console.log(`   👤 ${r.agent} → en file d'attente`);
        }
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('queue')
  .description(
    'Scheduler : agents RUNNING, tâches WAITING et blocages ; --retry relance les débloquées',
  )
  .option('--retry', 'Relance les tâches dont les collisions ont disparu')
  .action(async ({ retry }) => {
    try {
      const root = await findRepoRoot();
      await assertInitialized(root);
      if (retry) {
        const { started, stillWaiting } = await retryQueue({ root });
        for (const { task, info } of started) {
          console.log(`🚀 Tâche ${task.id} débloquée : agent ${task.agent}`);
          await announceAgent(root, info);
        }
        if (started.length === 0) console.log('Aucune tâche débloquée.');
        if (stillWaiting.length > 0)
          console.log(`${stillWaiting.length} tâche(s) toujours en attente.`);
        return;
      }
      const rows = await getQueueDashboard({ root });
      if (rows.length === 0) {
        console.log(
          'Aucune tâche. Lance "striart run --agent <nom> --prompt \'...\'" pour en créer une.',
        );
        return;
      }
      const table = rows.map((r) => ({
        ID: r.id,
        AGENT: r.agent,
        STATUT: r.status,
        'FICHIERS PRÉDITS': r.files.join(', ') || '—',
      }));
      const cols = Object.keys(table[0]);
      const widths = cols.map((c, i) => Math.max(c.length, ...table.map((r) => r[cols[i]].length)));
      console.log(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
      for (let i = 0; i < table.length; i += 1) {
        console.log(cols.map((c, j) => table[i][c].padEnd(widths[j])).join('  '));
        for (const b of rows[i].blockedBy) {
          console.log(
            `${' '.repeat(widths[0] + 2)}└─ bloqué par ${b.agent} sur ${b.files.join(', ')}`,
          );
        }
        if (rows[i].after) {
          console.log(`${' '.repeat(widths[0] + 2)}└─ attend la fin de ${rows[i].after}`);
        }
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('reconcile')
  .description(
    "Réconciliation : neutralise les sessions mortes, débloque la file, répare les verrous — converge l'état sur le réel",
  )
  .action(async () => {
    try {
      const root = await findRepoRoot();
      const { sessionPidsCleared, started, stillWaiting } = await reconcile({ root });
      if (sessionPidsCleared.length > 0) {
        console.log(`🧹 Sessions mortes neutralisées : ${sessionPidsCleared.join(', ')}.`);
      }
      for (const { task, info } of started) {
        console.log(`🚀 Tâche ${task.id} débloquée : agent ${task.agent}`);
        await announceAgent(root, info);
      }
      if (stillWaiting.length > 0) {
        console.log(`⏳ ${stillWaiting.length} tâche(s) toujours en attente.`);
      }
      if (sessionPidsCleared.length === 0 && started.length === 0) {
        console.log('✅ Rien à réconcilier — l’état est déjà cohérent.');
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('status')
  .description('Liste les agents actifs, leurs branches et commits en attente')
  .option('--json', 'Sortie JSON (CI/scripts)')
  .action(async ({ json }) => {
    try {
      const root = await findRepoRoot();
      const agents = await listAgents(root);
      if (json) {
        console.log(JSON.stringify({ agents }, null, 2));
        return;
      }
      if (agents.length === 0) {
        console.log('Aucun agent. Lance "striart start <nom>" pour en créer un.');
        return;
      }
      const rows = agents.map((a) => ({
        AGENT: a.name,
        STATUT: a.status,
        SESSION: a.sessionActive ? '🟢 en cours' : '⚪ inactive',
        // Sans cette colonne, un agent piloté par Striart est indiscernable
        // d'un agent piloté par un humain — deux régimes de surveillance
        // très différents.
        MODE: a.mode === 'autonomous' ? `🤖 auto (${a.profile ?? '?'})` : '👤 supervisé',
        BRANCHE: a.currentBranch ?? a.branch,
        OUTIL: a.command ?? '—',
        TAILLE: a.sizeBytes != null ? formatBytes(a.sizeBytes) : '—',
        'EN ATTENTE': String(a.pendingCommits),
        'DERNIER COMMIT': a.lastMessage ? a.lastMessage.slice(0, 60) : '—',
      }));
      const cols = Object.keys(rows[0]);
      const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c].length)));
      console.log(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
      for (const row of rows) {
        console.log(cols.map((c, i) => row[c].padEnd(widths[i])).join('  '));
      }
    } catch (error) {
      fail(error);
    }
  });

function printMergeResult(result) {
  switch (result.status) {
    case 'UP_TO_DATE':
      console.log(`✅ Agent ${result.agent} : rien à merger (déjà à jour).`);
      break;
    case 'MERGED':
      console.log(`✅ Agent ${result.agent} mergé (${result.sha.slice(0, 8)}) — Test Gate vert.`);
      if (result.semantic) {
        console.log(
          `   🧬 Conflits résolus par fusion sémantique : ${result.resolvedFiles.join(', ')}`,
        );
        if (result.gateRetries > 0) {
          console.log(
            `   🔁 Fusion corrigée par le Merger après ${result.gateRetries} retry (feedback du Test Gate).`,
          );
        }
      }
      if (result.pushError) console.log(`   ⚠️ Push échoué : ${result.pushError}`);
      if (result.memory) {
        console.log(
          result.memory.updated
            ? '   🧠 Mémoire partagée mise à jour et diffusée aux agents.'
            : `   ⚠️ Mémoire partagée non mise à jour : ${result.memory.error}`,
        );
      }
      for (const hazard of result.renameHazards ?? []) {
        console.log(
          `   ⚠️ ${hazard.source} supprimé des deux côtés, contenu retrouvé sous DEUX noms (main: ${hazard.ours}, agent: ${hazard.theirs}) — probable double-renommage, vérifier le doublon.`,
        );
      }
      break;
    case 'CONFLICT':
      console.log(
        `⛔ Conflit de merge avec ${result.agent} : ${result.conflictedFiles.join(', ')}`,
      );
      if (result.reason === 'SEMANTIC_MERGE_FAILED') {
        console.log(`   La fusion sémantique a échoué : ${result.error}`);
      }
      if (result.reason === 'UNMERGEABLE_CONFLICT') {
        const LABELS = {
          delete: 'suppression/modification',
          path: 'conflit de chemin (renommage)',
          binary: 'fichier binaire',
          lockfile: 'lockfile généré (à régénérer)',
          oversized: 'trop volumineux pour le LLM',
          submodule: 'sous-module Git',
          symlink: 'lien symbolique',
          mode: 'bit exécutable divergent',
          opaque: 'non lisible',
        };
        console.log('   Conflit hors de portée de la fusion sémantique :');
        for (const c of result.unmergeable ?? []) {
          const who = c.deletedBy
            ? ` — supprimé côté ${c.deletedBy === 'ours' ? 'main' : 'agent'}`
            : '';
          console.log(`   - ${c.path} : ${LABELS[c.kind] ?? c.kind}${who}`);
        }
      }
      console.log(`   Merge annulé. Ticket : ${result.ticket.dir}`);
      if (result.manualMode) {
        console.log(
          '   🔒 Mode manuel actif (3 échecs sémantiques d\'affilée). "striart resolve --unlock" pour réactiver.',
        );
      }
      break;
    case 'GATE_FAILED':
      console.log(
        `⛔ Test Gate rouge pour ${result.agent} (exit ${result.gate.exitCode}). Merge annulé.`,
      );
      if (result.semantic)
        console.log('   (Le code fusionné par le LLM ne passait pas les tests.)');
      console.log(`   Ticket : ${result.ticket.dir}`);
      if (result.manualMode) {
        console.log(
          '   🔒 Mode manuel actif (3 échecs sémantiques d\'affilée). "striart resolve --unlock" pour réactiver.',
        );
      }
      break;
    default:
      console.log(`Résultat inattendu : ${result.status}`);
  }
}

program
  .command('merge <agent>')
  .description("Merge le dernier commit d'un agent derrière le Test Gate")
  .action(async (agent) => {
    try {
      const root = await findRepoRoot();
      console.log(`🔀 Merge de l'agent ${agent}...`);
      printMergeResult(await mergeAgentCommit({ root, agent }));
    } catch (error) {
      fail(error);
    }
  });

program
  .command('stop <agent>')
  .description(
    "Marque un agent comme terminé et débloque la file d'attente (le clone reste sur disque)",
  )
  .option('--force', 'Abandonne les commits non mergés')
  .action(async (agent, { force }) => {
    try {
      const root = await findRepoRoot();
      const result = await stopAgent({ root, agent, force });
      console.log(`🛑 Agent ${agent} retiré du registre. Clone conservé : ${result.clonePath}`);
      for (const { task, info } of result.started) {
        console.log(`🚀 Tâche ${task.id} débloquée : agent ${task.agent}`);
        await announceAgent(root, info);
      }
      if (result.stillWaiting.length > 0) {
        console.log(`${result.stillWaiting.length} tâche(s) toujours en attente.`);
      }
    } catch (error) {
      fail(error);
    }
  });

function printSyncResult(result) {
  switch (result.status) {
    case 'REBASED':
      console.log(
        `🔁 Agent ${result.agent} rebasé sur ${result.mainHead.slice(0, 8)} (${result.rebasedCommits} commit(s) de retard rattrapés).`,
      );
      if (result.stashed)
        console.log('   📦 Travail en cours stashé puis restauré (fichiers disjoints vérifiés).');
      break;
    case 'UP_TO_DATE':
      console.log(`✅ Agent ${result.agent} déjà à jour.`);
      break;
    case 'SKIPPED_DIRTY':
      if (result.overlap) {
        console.log(
          `⏭️ Agent ${result.agent} : travail en cours sur ${result.overlap.join(', ')} — également touché par les commits entrants, rebase reporté (sécurité).`,
        );
      } else {
        console.log(
          `⏭️ Agent ${result.agent} : travail en cours (${result.files.length} fichier(s) modifié(s)), rebase reporté.`,
        );
      }
      break;
    case 'SKIPPED_SESSION':
      console.log(
        `🤖 Agent ${result.agent} : session autonome en cours (PID ${result.pid ?? '?'}) — rebase ajourné à sa fin de cycle.`,
      );
      break;
    case 'REBASE_CONFLICT':
      console.log(
        `⚠️ Agent ${result.agent} : rebase en conflit, annulé. Le conflit sera traité au merge.`,
      );
      if (result.stashKept) console.log('   📦 Travail en cours conservé dans le stash du clone.');
      break;
    case 'STASH_CONFLICT':
      console.log(
        `🔒 Agent ${result.agent} : stash pop en conflit après rebase — travail en sécurité dans le stash, résolution manuelle dans le clone.`,
      );
      break;
    default:
      console.log(`Résultat inattendu : ${result.status}`);
  }
}

program
  .command('sync [agent]')
  .description('Rebase un agent (ou tous) sur la branche cible du repo principal')
  .action(async (agent) => {
    try {
      const root = await findRepoRoot();
      if (agent) {
        printSyncResult(await syncAgentWithMain({ root, agent }));
        return;
      }
      const results = await syncAllAgents({ root });
      if (results.length === 0) console.log('Aucun agent actif.');
      for (const result of results) printSyncResult(result);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('clean [agent]')
  .description(
    'Supprime des clones pour libérer le disque (par défaut : agents arrêtés uniquement)',
  )
  .option(
    '--stopped',
    'Uniquement les clones des agents arrêtés (comportement par défaut, explicite)',
  )
  .option('--all', '⚠️ Aussi les agents actifs SANS travail en attente (arrêtés puis supprimés)')
  .option('--force', 'Avec --all : abandonne aussi le travail non mergé des agents actifs')
  .action(async (agent, { all, force }) => {
    try {
      const root = await findRepoRoot();
      const { removed, skipped } = await cleanClones({ root, agent: agent ?? null, all, force });
      for (const r of removed) {
        console.log(
          `🧹 ${r.name}${r.wasActive ? ' (agent actif arrêté)' : ''} supprimé — ${formatBytes(r.freedBytes)} libérés.`,
        );
      }
      for (const s of skipped) {
        if (s.reason === 'SESSION_LIVE') {
          console.log(
            `🤖 ${s.name} : session autonome EN COURS — conservé, y compris avec --force. Attends sa fin de cycle.`,
          );
        } else if (s.reason === 'ACTIVE') {
          console.log(
            `⏭️ ${s.name} : agent actif, conservé ("striart clean --all" pour l'inclure).`,
          );
        } else if (s.reason === 'PENDING') {
          console.log(
            `⏭️ ${s.name} : travail non mergé, conservé (merge d'abord, ou "--all --force" pour abandonner).`,
          );
        } else if (s.reason === 'IN_USE') {
          console.log(
            `⏭️ ${s.name} : activité disque récente — une session travaille peut-être encore dedans (attendre, ou --force en connaissance de cause).`,
          );
        } else {
          console.log(
            `⏭️ ${s.name} : dossier verrouillé par un process (session ouverte ?), conservé.`,
          );
        }
      }
      if (removed.length === 0 && skipped.length === 0) console.log('Aucun clone à nettoyer. ✨');
      const total = removed.reduce((sum, r) => sum + r.freedBytes, 0);
      if (removed.length > 1) console.log(`Total libéré : ${formatBytes(total)}.`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('prune')
  .description(
    'Rétention : supprime les clones arrêtés inactifs et les tickets résolus depuis N jours',
  )
  .option('--days <n>', 'Période de rétention en jours (défaut : config pruneDays, 14)')
  .option('--dry-run', 'Affiche ce qui serait supprimé, sans rien supprimer')
  .action(async ({ days, dryRun }) => {
    try {
      const root = await findRepoRoot();
      const { pruneWorkspace } = await import('./prune.js');
      const result = await pruneWorkspace({
        root,
        days: days != null ? Number.parseInt(days, 10) : null,
        dryRun: Boolean(dryRun),
      });
      const verb = result.dryRun ? 'serait supprimé' : 'supprimé';
      for (const c of result.clones.removed) {
        console.log(
          `🧹 Clone ${c.name} ${verb} — inactif depuis ${c.lastActivity.slice(0, 10)}, ${formatBytes(c.freedBytes)}.`,
        );
      }
      for (const c of result.clones.kept) {
        console.log(
          `⏳ Clone ${c.name} conservé (activité récente : ${c.lastActivity.slice(0, 10)}).`,
        );
      }
      for (const t of result.tickets.removed) {
        console.log(`🧹 Ticket ${t.id} ${verb} (résolu le ${t.resolvedAt.slice(0, 10)}).`);
      }
      if (result.clones.removed.length === 0 && result.tickets.removed.length === 0) {
        console.log(`Rien à élaguer (rétention : ${result.retentionDays} jour(s)). ✨`);
      } else {
        console.log(
          `${result.dryRun ? 'Espace récupérable' : 'Espace libéré'} : ${formatBytes(result.freedBytes)} (rétention : ${result.retentionDays} jour(s)).`,
        );
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('history')
  .description('Historique des merges et rollbacks Striart (reconstruit depuis le graphe Git)')
  .option('--limit <n>', "Nombre d'entrées (défaut 30)")
  .option('--json', 'Sortie JSON (CI/scripts)')
  .action(async ({ limit, json }) => {
    try {
      const root = await findRepoRoot();
      const { listMergeHistory } = await import('./history.js');
      const entries = await listMergeHistory({
        root,
        limit: limit ? Number.parseInt(limit, 10) : 30,
      });
      if (json) {
        console.log(JSON.stringify({ history: entries }, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log("Aucun merge Striart dans l'historique.");
        return;
      }
      for (const e of entries) {
        const when = new Date(e.date).toLocaleString();
        if (e.type === 'rollback') {
          console.log(`↩️ ${when}  rollback  agent ${e.agent} (revert ${e.sha.slice(0, 8)})`);
        } else {
          const semantic = e.semantic ? ` 🧬 ${e.semanticFiles.join(', ')}` : '';
          console.log(
            `✅ ${when}  merge     agent ${e.agent} (${e.agentSha} → ${e.sha.slice(0, 8)})${semantic}`,
          );
        }
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('doctor')
  .description(
    "Diagnostic complet : git, repo, config, LLM, verrous, tickets — répond à 'pourquoi ça ne marche pas ?'",
  )
  .option('--json', 'Sortie JSON (CI/scripts)')
  .action(async ({ json }) => {
    const { runDoctor } = await import('./doctor.js');
    const result = await runDoctor();
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const ICONS = { ok: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' };
      const width = Math.max(...result.checks.map((c) => c.label.length));
      for (const check of result.checks) {
        console.log(`${ICONS[check.level]} ${check.label.padEnd(width)}  ${check.detail}`);
      }
      console.log('');
      console.log(
        result.healthy
          ? '✨ Environnement opérationnel.'
          : '💥 Des prérequis manquent — corrige les ❌ ci-dessus avant de continuer.',
      );
    }
    if (!result.healthy) process.exitCode = 1;
  });

program
  .command('rollback')
  .description(
    'Défait le dernier merge Striart de la branche cible (reset local, ou revert si déjà poussé)',
  )
  .action(async () => {
    try {
      const root = await findRepoRoot();
      const result = await rollbackLastMerge({ root });
      if (result.mode === 'reset') {
        console.log(
          `↩️ Merge de ${result.agent} défait (${result.undoneSha.slice(0, 8)}) — branche revenue sur ${result.newHead.slice(0, 8)}.`,
        );
        console.log(
          result.agentResynced
            ? `   Les commits de l'agent ${result.agent} redeviennent "en attente" et pourront être re-mergés.`
            : `   Agent ${result.agent} non recalé (arrêté ou clone absent) — re-merge manuel si besoin.`,
        );
        console.log('   (Récupérable via le reflog si besoin : git reflog.)');
      } else {
        console.log(
          `↩️ Merge de ${result.agent} annulé par revert (${result.newHead.slice(0, 8)}) — l'historique poussé est conservé.`,
        );
        console.log(
          `   ⚠️ Ne re-merge pas l'agent ${result.agent} tel quel : le même commit reproduirait l'état annulé.`,
        );
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('mcp')
  .description(
    'Serveur MCP sur stdio : expose run/status/queue/merge/resolve à tout hôte MCP (Claude Code, Cursor…)',
  )
  .action(async () => {
    try {
      const root = await findRepoRoot();
      const { startMcpServer } = await import('./mcp.js');
      // Pas de console.log ici : stdout est le canal du protocole.
      await startMcpServer({ root });
    } catch (error) {
      fail(error);
    }
  });

program
  .command('promote')
  .description('Promotion staging → main : Test Gate global puis fast-forward de mainBranch')
  .option(
    '--rollback',
    'Si le gate global échoue : reset --hard du staging sur mainBranch (destructif)',
  )
  .action(async ({ rollback }) => {
    try {
      const root = await findRepoRoot();
      console.log('🚦 Promotion : Test Gate global en cours...');
      const result = await promoteStaging({ root, rollback: Boolean(rollback) });
      switch (result.status) {
        case 'UP_TO_DATE':
          console.log('✅ Rien à promouvoir : main est déjà au niveau du staging.');
          break;
        case 'PROMOTED':
          console.log(
            `🎉 ${result.commits} commit(s) promus — main avancé en fast-forward sur ${result.sha.slice(0, 8)}.`,
          );
          if (result.pushError) console.log(`   ⚠️ Push origin échoué : ${result.pushError}`);
          break;
        case 'GATE_FAILED':
          console.log(
            `⛔ Test Gate global rouge (exit ${result.gate.exitCode}). Promotion refusée, main intact.`,
          );
          console.log(`   Ticket : ${result.ticket.dir}`);
          console.log(
            result.rolledBack
              ? '   ↩️ Staging remis au niveau de main (--rollback).'
              : '   Le staging est conservé pour analyse ("striart promote --rollback" pour le réinitialiser).',
          );
          break;
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('resolve')
  .description('Liste les tickets de conflit en attente de résolution humaine')
  .option('--unlock', 'Réactive la fusion sémantique après passage en mode manuel')
  .option('--close <id>', 'Marque un ticket comme résolu (fichier RESOLVED, dossier conservé)')
  .option('--all', 'Inclut les tickets déjà résolus')
  .action(async ({ unlock, close, all }) => {
    try {
      const root = await findRepoRoot();
      await assertInitialized(root);
      if (unlock) {
        await resetManualMode(root);
        console.log("🔓 Fusion sémantique réactivée (compteur d'échecs remis à zéro).");
        return;
      }
      if (close) {
        const ticket = await closeConflictTicket(root, close);
        console.log(`✅ Ticket ${ticket.id} marqué résolu (${ticket.dir}).`);
        return;
      }
      const state = await readState(root);
      if (state.manualMode) {
        console.log(
          '🔒 Mode manuel actif : la fusion sémantique est désactivée jusqu\'à "striart resolve --unlock".',
        );
      } else if (state.semanticFailureStreak > 0) {
        console.log(`⚠️ ${state.semanticFailureStreak} échec(s) sémantique(s) consécutif(s).`);
      }
      const tickets = await listConflictTickets(root, { includeResolved: Boolean(all) });
      if (tickets.length === 0) {
        console.log(
          all
            ? 'Aucun ticket de conflit. ✨'
            : 'Aucun ticket ouvert. ✨ ("--all" pour inclure les résolus)',
        );
        return;
      }
      for (const ticket of tickets) {
        const mark = ticket.resolved ? '✅' : '⛔';
        console.log(
          `${mark} ${ticket.id}  ${ticket.reason}  agent=${ticket.agent}  sha=${ticket.sha.slice(0, 8)}`,
        );
        if (ticket.conflictedFiles.length > 0)
          console.log(`   fichiers : ${ticket.conflictedFiles.join(', ')}`);
        console.log(`   dossier  : ${ticket.dir}`);
      }
      const open = tickets.filter((t) => !t.resolved).length;
      if (open > 0)
        console.log(
          `\n${open} ticket(s) ouvert(s). "striart resolve --close <id>" après correction.`,
        );
    } catch (error) {
      fail(error);
    }
  });

program
  .command('dashboard')
  .description("Dashboard web local : agents, file d'attente, conflits, logs du Test Gate")
  .option('--port <port>', 'Port d’écoute (défaut : config dashboardPort, 3456)')
  .action(async ({ port }) => {
    try {
      const root = await findRepoRoot();
      await assertInitialized(root);
      const { startDashboard } = await import('./dashboard.js');
      const config = await loadConfig(root);
      const chosenPort = port ? Number.parseInt(port, 10) : config.dashboardPort;
      const server = await startDashboard({ root, port: chosenPort });
      const { port: actualPort } = server.address();
      console.log(`📊 Dashboard Striart : http://localhost:${actualPort} (Ctrl+C pour quitter)`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('watch')
  .description(
    'Surveille les commits des agents et les merge automatiquement (foreground, ou --daemon)',
  )
  .option('--no-merge', 'Logge les commits sans déclencher de merge')
  .option('--daemon', 'Lance le watcher en arrière-plan (PID + logs dans .striart/)')
  .option('--stop', 'Arrête le watcher daemon')
  .option('--status', 'État du watcher daemon')
  .action(async ({ merge, daemon, stop, status }) => {
    try {
      const root = await findRepoRoot();
      await assertInitialized(root);
      if (stop || status || daemon) {
        const { startWatchDaemon, stopWatchDaemon, watchDaemonStatus } =
          await import('./daemon.js');
        if (stop) {
          const r = await stopWatchDaemon({ root });
          if (r.stopped) console.log(`🛑 Watcher daemon arrêté (PID ${r.pid}).`);
          else if (r.wasStale)
            console.log(`🧹 PID file orphelin nettoyé (PID ${r.pid} déjà mort).`);
          else console.log('Aucun watcher daemon en cours.');
          return;
        }
        if (status) {
          const s = await watchDaemonStatus({ root });
          if (s.running)
            console.log(
              `🟢 Watcher daemon actif (PID ${s.pid}, démarré ${s.startedAt}). Logs : ${s.logPath}`,
            );
          else if (s.stale)
            console.log(
              `⚪ Watcher daemon mort (PID file orphelin ${s.pid}) — "striart watch --daemon" pour relancer.`,
            );
          else console.log('⚪ Aucun watcher daemon. "striart watch --daemon" pour en lancer un.');
          return;
        }
        const r = await startWatchDaemon({ root, noMerge: !merge });
        console.log(`🚀 Watcher daemon lancé (PID ${r.pid}). Logs : ${r.logPath}`);
        console.log(
          '   "striart watch --status" pour vérifier, "striart watch --stop" pour arrêter.',
        );
        console.log(
          '   Reprise au boot : enregistre "striart watch --daemon" dans le planificateur de ton OS.',
        );
        return;
      }
      const config = await loadConfig(root);
      console.log(
        `👀 Watcher actif sur ${path.join(root, '.striart', 'agents')} (Ctrl+C pour quitter)`,
      );
      if (merge) console.log('   Auto-merge activé : chaque commit passera par le Test Gate.');

      // Fetch silencieux périodique : visibilité sur le retard des agents,
      // sans jamais toucher leurs working trees. Le rebase reste fait au merge.
      if (config.fetchIntervalMs > 0) {
        let checking = false;
        const lastBehind = new Map(); // on ne logge que les CHANGEMENTS d'état
        setInterval(async () => {
          if (checking) return; // pas de chevauchement si un check traîne
          checking = true;
          try {
            for (const { agent, behind, error } of await checkAgentsBehind({ root, config })) {
              if (error) {
                logger.warn({ agent, err: error }, 'Fetch silencieux échoué');
                continue;
              }
              const previous = lastBehind.get(agent) ?? 0;
              if (behind === previous) continue;
              lastBehind.set(agent, behind);
              if (behind > 0) {
                logger.info(
                  { agent, behind },
                  `Agent ${agent} en retard de ${behind} commit(s) sur ${config.targetBranch} - rebase au prochain merge`,
                );
              } else {
                logger.info(
                  { agent },
                  `Agent ${agent} de nouveau à jour sur ${config.targetBranch}`,
                );
              }
            }
          } catch (error) {
            logger.warn({ err: error.message }, 'Fetch silencieux échoué');
          } finally {
            checking = false;
          }
        }, config.fetchIntervalMs);
      }

      // Un seul merge à la fois : le repo principal est une ressource partagée.
      let mergeChain = Promise.resolve();

      // Réconciliation périodique : le déblocage de la file devient
      // level-triggered. Le watcher réagit déjà aux commits (edge) ; ce tick
      // rattrape les changements d'état qui n'émettent aucun commit — un
      // `striart clean` du bloqueur d'une tâche `--after`, une session
      // autonome morte.
      //
      // ENFILÉE SUR LA CHAÎNE DE MERGE, pas lancée libre : le verrou
      // principal est réentrant par compteur (il sérialise le nesting
      // synchrone stop→retryQueue), mais NE sérialise PAS deux tâches async
      // top-level. Une réconciliation sur un setInterval indépendant
      // s'interlacerait donc avec un merge en cours. La faire passer par
      // `mergeChain` la range dans la même file FIFO que les merges — jamais
      // concurrente. Un garde `pending` évite d'empiler plusieurs
      // réconciliations si les merges traînent.
      if (merge && config.fetchIntervalMs > 0) {
        let reconcilePending = false;
        setInterval(() => {
          if (reconcilePending) return;
          reconcilePending = true;
          mergeChain = mergeChain
            .then(() => reconcile({ root }))
            .then(({ sessionPidsCleared, started }) => {
              for (const { task } of started) {
                console.log(`🚀 [RECONCILE] Tâche ${task.id} débloquée : agent ${task.agent}.`);
              }
              if (sessionPidsCleared.length > 0) {
                logger.info(
                  { sessionPidsCleared },
                  'Réconciliation : sessions mortes neutralisées',
                );
              }
            })
            .catch((error) =>
              logger.warn({ err: error.message }, 'Réconciliation périodique échouée'),
            )
            .finally(() => {
              reconcilePending = false;
            });
        }, config.fetchIntervalMs);
      }
      watchAgents({
        root,
        onCommit: ({ agent, branch, sha }) => {
          logger.info(
            { agent, branch, sha: sha.slice(0, 8) },
            `Nouveau commit de ${agent} sur ${branch}`,
          );
          if (!merge) return;
          // Seule la branche de tâche déclenche un merge : les refs annexes du
          // clone (ex: son main local touché par l'agent) ne sont que du bruit.
          if (!branch.startsWith('striart/')) return;
          mergeChain = mergeChain.then(async () => {
            try {
              // Un agent autonome gère son propre merge, en fin de session.
              if (!(await shouldWatcherMerge({ root, agent }))) {
                logger.info(
                  { agent },
                  `Agent ${agent} en mode autonome — merge laissé à sa fin de session`,
                );
                return;
              }
              const result = await mergeAgentCommit({ root, agent });
              printMergeResult(result);
              if (result.status === 'MERGED') {
                // Tous les agents repartent du code le plus récent — Y COMPRIS
                // celui qu'on vient de merger : le commit de merge --no-ff
                // n'existe que dans main, sans ça il resterait "behind 1".
                for (const sync of await syncAllAgents({ root })) {
                  if (sync.status !== 'UP_TO_DATE') printSyncResult(sync);
                }
              }
            } catch (error) {
              if (error instanceof StriartError && error.code === 'AGENT_UNKNOWN') return; // agent stoppé entre-temps
              console.error(`❌ Merge de ${agent} impossible : ${error.message}`);
            }
          });
        },
      });
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync().catch(fail);
