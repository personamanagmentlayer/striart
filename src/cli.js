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
  closeConflictTicket,
  listConflictTickets,
  prepareResolutionScaffold,
} from './conflicts.js';
import { readState, resetManualMode } from './state.js';
import { readMainSession, startMainSession, stopMainSession } from './main-session.js';
import { assertNoLiveMainSession, withMainLock } from './lock.js';
import { isProcessAlive } from './process-tree.js';
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

/**
 * Par défaut Commander sort en 1 pour TOUTE erreur — y compris une erreur
 * d'usage (flag/commande inconnue, argument manquant), qui doit sortir en 2
 * pour rester distinguable d'un échec métier par un script appelant. Le
 * callback appelle `process.exit` lui-même (jamais de `throw`) : la promesse
 * de `program.parseAsync()` en bas de fichier ne voit donc jamais cette
 * erreur, `--help`/`--version` gardent leur 0 par défaut (`err.exitCode`).
 */
const USAGE_ERROR_CODES = new Set([
  'commander.unknownOption',
  'commander.unknownCommand',
  'commander.missingArgument',
  'commander.optionMissingArgument',
  'commander.missingMandatoryOptionValue',
  'commander.excessArguments',
  'commander.conflictingOption',
  'commander.invalidArgument',
]);
program.exitOverride((err) => {
  process.exit(USAGE_ERROR_CODES.has(err.code) ? 2 : err.exitCode);
});

/**
 * `clone.js` et `orchestrator.js` importent tous deux `simple-git`, ~270 ms
 * à froid (mesuré) — en imports statiques ES, ce coût s'exécute pour TOUTE
 * invocation (tous les imports d'un module s'évaluent avant que son propre
 * code ne tourne), y compris `--version`/`--help`/une erreur d'usage qui ne
 * touchent jamais git. Chargés ici paresseusement, mémoïsés, au même titre
 * que doctor.js/mcp.js/dashboard.js plus bas — seules les actions qui en ont
 * réellement besoin paient le coût, une seule fois.
 */
let cloneModule;
async function loadClone() {
  return (cloneModule ??= await import('./clone.js'));
}
let orchestratorModule;
async function loadOrchestrator() {
  return (orchestratorModule ??= await import('./orchestrator.js'));
}

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
    'Avec --reuse : passe outre une archive récemment active ou du travail non commité/non mergé (PERDU). ' +
      "Sans --reuse : clone quand même malgré des secrets détectés dans l'historique du repo (voir secretPatterns)",
  )
  .action(async (agent, { command, open, reuse, force }) => {
    try {
      const { findRepoRoot, reuseAgent, createAgent } = await loadClone();
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
            force: Boolean(force),
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

/**
 * `--open` ouvre toujours un onglet natif (UX inchangée), mais ce qui y
 * tourne n'est plus l'outil directement : c'est `striart attach`, un client
 * léger du pty possédé par un process hôte détaché (`pty-host.ts`). Sans ce
 * détour, le pty mourrait avec le process CLI éphémère qui a demandé
 * l'ouverture — avant même que l'onglet soit utilisable — et rien d'autre
 * (le bus `@agent` de `striart watch --ui`) ne pourrait jamais rejoindre
 * cette même session.
 */
async function announceAgent(root, info, { open = false } = {}) {
  const { ensurePtyHost, defaultShell, resolveAttendedCommand } = await import('./pty-host.ts');
  const agentCmd = await resolveAttendedCommand(root, info);
  printAgentStarted(info, agentCmd);
  if (!open) return;

  await ensurePtyHost(root, info.name, {
    shell: defaultShell(),
    cwd: info.path,
    initialCommand: agentCmd,
  });

  const result = await openAgentTerminal({
    cwd: info.path,
    title: `STRIART: ${info.name}`,
    command: `striart attach ${info.name}`,
  });
  if (result.launched) {
    console.log(`🖥️ Onglet ouvert pour ${info.name} (${agentCmd}, pilotable via le pty possédé).`);
  } else {
    console.log(
      `⚠️ Ouverture du terminal impossible (${result.error}). ` +
        `L'hôte de pty tourne : "striart attach ${info.name}" pour t'y attacher manuellement, ` +
        `ou lance "${agentCmd}" directement dans ${info.path}.`,
    );
  }
}

/** @param {string|undefined} timeout @returns {number|null} */
function parseTimeoutMs(timeout) {
  if (timeout === undefined) return null;
  const timeoutMs = Number.parseInt(timeout, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new StriartError('--timeout doit être un entier de millisecondes >= 1000.', {
      code: 'INVALID_TIMEOUT',
      details: { timeout },
    });
  }
  return timeoutMs;
}

/**
 * Agent lancé DIRECTEMENT dans le worktree du repo principal (pas un clone) —
 * supervisé et protégé par une session principale (main-session.js) : toute
 * autre opération mutante (merge, sync, promote, resolve --apply, l'auto-merge
 * de watch) est refusée tant que le PID vit. Pas de merge de fin de cycle :
 * l'agent travaille déjà sur la cible, il n'y a rien à fusionner.
 */
async function runMainSessionCli({ root, prompt, profile, timeout, reason }) {
  const { runMainSession } = await loadOrchestrator();
  const timeoutMs = parseTimeoutMs(timeout);
  console.log(
    `🤖 [SUR PRINCIPAL] Profil ${profile ?? DEFAULT_PROFILE} — travaille directement dans le repo principal.`,
  );
  console.log(
    '   Toute autre opération Striart (merge, sync, promote, resolve --apply) est bloquée le temps de la session.',
  );

  const session = await runMainSession({
    root,
    prompt,
    profile: profile ?? null,
    timeoutMs,
    reason,
  });
  const seconds = Math.round(session.durationMs / 1000);
  console.log(
    `   Session terminée en ${seconds}s — statut ${session.status}, code de sortie ${session.exitCode ?? 'n/a'}.`,
  );
  console.log(`   Log : ${session.logPath}`);
  if (session.status !== 'COMPLETED') process.exitCode = 1;
}

/**
 * Mode autonome : Striart lance l'agent, le supervise, merge et nettoie.
 * Affichage seul — toute la logique est dans orchestrator.runAutonomousTask.
 */
async function runAutonomousCli({ root, agent, prompt, profile, timeout, after, reuse, force }) {
  const { runAutonomousTask } = await loadOrchestrator();
  const timeoutMs = parseTimeoutMs(timeout);

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
    force: Boolean(force),
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
    '--on-main',
    'Lance l’agent DIRECTEMENT dans le repo principal (pas un clone) : session protégée, ' +
      'toute opération mutante Striart est bloquée le temps de la session — pas de merge de fin de cycle',
  )
  .option(
    '--profile <name>',
    'Avec --autonomous/--on-main : profil d’invocation (claude, codex, aider, ollama...)',
  )
  .option(
    '--timeout <ms>',
    'Avec --autonomous/--on-main : délai max de la session (défaut : config autonomousTimeoutMs)',
  )
  .option(
    '--after <tâche|agent>',
    "N'exécute la tâche qu'une fois ce travail terminé (id de tâche en file ou nom d'agent actif)",
  )
  .option(
    '--reuse',
    'Réhabilite le clone conservé de --agent au lieu de cloner (refuse une archive sale ou active)',
  )
  .option(
    '--force',
    'Clone/réhabilite quand même malgré des secrets détectés dans l’historique du repo (voir secretPatterns)',
  )
  .action(
    async (
      promptArg,
      {
        agent,
        prompt: promptOpt,
        command,
        open,
        autonomous,
        onMain,
        profile,
        timeout,
        after,
        reuse,
        force,
      },
    ) => {
      try {
        const { findRepoRoot } = await loadClone();
        const { runTask } = await loadOrchestrator();
        const root = await findRepoRoot();
        const prompt = promptArg ?? promptOpt;
        if (onMain) {
          if (!prompt) {
            throw new StriartError('--on-main requiert un prompt.', { code: 'EMPTY_PROMPT' });
          }
          await runMainSessionCli({ root, prompt, profile, timeout, reason: prompt });
          return;
        }
        if (autonomous) {
          await runAutonomousCli({ root, agent, prompt, profile, timeout, after, reuse, force });
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
          force: Boolean(force),
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
      const { findRepoRoot } = await loadClone();
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
      const { findRepoRoot } = await loadClone();
      const { applyPlan } = await loadOrchestrator();
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
      const { findRepoRoot, assertInitialized } = await loadClone();
      const { retryQueue, getQueueDashboard } = await loadOrchestrator();
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
      const { findRepoRoot } = await loadClone();
      const { reconcile } = await loadOrchestrator();
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
      const { findRepoRoot, listAgents, formatBytes } = await loadClone();
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
      const { findRepoRoot } = await loadClone();
      const { mergeAgentCommit } = await loadOrchestrator();
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
      const { findRepoRoot } = await loadClone();
      const { stopAgent } = await loadOrchestrator();
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
      const { findRepoRoot } = await loadClone();
      const { syncAgentWithMain, syncAllAgents } = await loadOrchestrator();
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
      const { findRepoRoot, cleanClones, formatBytes } = await loadClone();
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
      const { findRepoRoot, formatBytes } = await loadClone();
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
      const { findRepoRoot } = await loadClone();
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
      const { findRepoRoot } = await loadClone();
      const { rollbackLastMerge } = await loadOrchestrator();
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
      const { findRepoRoot } = await loadClone();
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
      const { findRepoRoot } = await loadClone();
      const { promoteStaging } = await loadOrchestrator();
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
  .command('lock')
  .description(
    'Réserve/libère le repo principal pour une intervention directe (édition manuelle sans ' +
      'commit, résolution git à la main…) — bloque toute opération Striart mutante tant que ' +
      'la session déclarée vit',
  )
  .option(
    '--start <raison>',
    'Déclare une occupation du repo principal, surveillée via le PID du shell courant (sauf --pid)',
  )
  .option(
    '--stop',
    'Libère le repo principal — sortie de secours, même si le PID déclaré vit encore',
  )
  .option('--pid <n>', 'Avec --start : PID à surveiller au lieu du shell appelant')
  .action(async ({ start, stop, pid }) => {
    try {
      const { findRepoRoot, assertInitialized } = await loadClone();
      const root = await findRepoRoot();
      await assertInitialized(root);
      if (stop) {
        await stopMainSession(root);
        console.log('🔓 Repo principal libéré.');
        return;
      }
      if (start) {
        // process.ppid par défaut : le shell qui a lancé cette commande —
        // tant qu'il vit (le terminal reste ouvert), le repo principal reste
        // réservé ; il se libère de lui-même à sa fermeture (contrôle de
        // vitalité, pas de ménage actif requis).
        const targetPid = pid !== undefined ? Number.parseInt(pid, 10) : process.ppid;
        if (!Number.isInteger(targetPid) || targetPid <= 0) {
          throw new StriartError('--pid doit être un entier positif.', {
            code: 'INVALID_PID',
            details: { pid },
          });
        }
        if (!isProcessAlive(targetPid)) {
          console.log(
            `⚠️ PID ${targetPid} ne correspond à aucun process vivant — la réservation sera ` +
              'immédiatement inopérante (un PID mort ne bloque rien).',
          );
        }
        // Vérification ET publication sous le même verrou que les opérations
        // mutantes : empêche deux "lock --start" concurrents de passer tous
        // les deux le contrôle, et empêche de réserver PENDANT qu'un
        // merge/sync/promote tient déjà le verrou (withMainLock attend sa
        // fin avant de nous laisser passer). Réutilise assertNoLiveMainSession
        // (lock.js) — seule implémentation de ce contrôle, jamais recopiée.
        await withMainLock(root, 'lock:start', async () => {
          await assertNoLiveMainSession(root);
          await startMainSession(root, { pid: targetPid, reason: start });
        });
        console.log(`🔒 Repo principal réservé pour "${start}" (pid ${targetPid}).`);
        console.log('   Toute opération Striart mutante (merge, sync, promote, resolve --apply,');
        console.log("   l'auto-merge de watch) est bloquée tant que ce process vit.");
        console.log(
          `   "striart lock stop" pour libérer manuellement, ou ferme simplement le process ${targetPid}.`,
        );
        return;
      }
      const session = await readMainSession(root);
      if (!session) {
        console.log('🔓 Repo principal libre.');
        return;
      }
      const alive = isProcessAlive(session.pid);
      console.log(
        `${alive ? '🔒' : '⚠️'} Repo principal ${alive ? 'occupé' : 'marqué occupé (PID mort)'} ` +
          `par "${session.reason}" (pid ${session.pid}) depuis ${session.startedAt}.`,
      );
      if (!alive) {
        console.log(
          '   Le PID est mort — se libère tout seul à la prochaine opération Striart, ou via "striart lock --stop".',
        );
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
  .option(
    '--prepare <id>',
    "Amorce <fichier>.resolved pour chaque fichier en conflit du ticket (repli sur la version de l'agent, à éditer)",
  )
  .option(
    '--apply <id>',
    'Rejoue le merge du ticket avec les résolutions préparées (*.resolved/*.delete), sous le Test Gate — commit et ferme le ticket si vert',
  )
  .option('--all', 'Inclut les tickets déjà résolus')
  .action(async ({ unlock, close, prepare, apply, all }) => {
    try {
      const { findRepoRoot, assertInitialized } = await loadClone();
      const { applyTicketResolution } = await loadOrchestrator();
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
      if (prepare) {
        const scaffold = await prepareResolutionScaffold(root, prepare);
        for (const entry of scaffold) {
          console.log(
            entry.created
              ? `📝 ${entry.path} — amorcé depuis .${entry.source} (à éditer avant --apply)`
              : `⏭️  ${entry.path} — déjà préparé, inchangé`,
          );
        }
        console.log(`\nÉdite les fichiers ci-dessus puis "striart resolve --apply ${prepare}".`);
        return;
      }
      if (apply) {
        const result = await applyTicketResolution({ root, ticketId: apply });
        if (result.status === 'MERGED') {
          console.log(`✅ Ticket ${apply} résolu et mergé (${result.sha.slice(0, 8)}).`);
          console.log(`   fichiers : ${result.resolvedFiles.join(', ')}`);
          if (result.closedTickets.length > 1) {
            console.log(
              `   tickets fermés (doublons du même conflit) : ${result.closedTickets.join(', ')}`,
            );
          }
          if (result.pushError) console.log(`   ⚠️ Push échoué : ${result.pushError}`);
          console.log(`   pense à "striart sync ${result.agent}" pour rebaser son clone.`);
        } else if (result.status === 'ALREADY_CLEAN') {
          console.log(`✅ Ticket ${apply} : plus de conflit à ce jour, rien à appliquer.`);
        } else if (result.status === 'GATE_FAILED') {
          console.log(
            `⛔ Test Gate rouge après application de la résolution du ticket ${apply}. ` +
              'Le ticket reste ouvert — ajuste les fichiers .resolved et relance --apply.',
          );
        }
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
          `\n${open} ticket(s) ouvert(s). "striart resolve --prepare <id>" puis "--apply <id>" ` +
            'pour résoudre sous le Test Gate, ou "--close <id>" si déjà corrigé à la main.',
        );
    } catch (error) {
      fail(error);
    }
  });

program
  .command('dashboard')
  .description(
    "Dashboard web local : agents, file d'attente, conflits, logs du Test Gate (foreground, ou --daemon)",
  )
  .option('--port <port>', 'Port d’écoute (défaut : config dashboardPort, 3456)')
  .option('--daemon', 'Lance le dashboard en arrière-plan (PID + logs dans .striart/)')
  .option('--stop', 'Arrête le dashboard daemon')
  .option('--status', 'État du dashboard daemon')
  .action(async ({ port, daemon, stop, status }) => {
    try {
      const { findRepoRoot, assertInitialized } = await loadClone();
      const root = await findRepoRoot();
      await assertInitialized(root);
      if (stop || status || daemon) {
        const { startDashboardDaemon, stopDashboardDaemon, dashboardDaemonStatus } =
          await import('./daemon.js');
        if (stop) {
          const r = await stopDashboardDaemon({ root });
          if (r.stopped) console.log(`🛑 Dashboard daemon arrêté (PID ${r.pid}).`);
          else if (r.wasStale)
            console.log(`🧹 PID file orphelin nettoyé (PID ${r.pid} déjà mort).`);
          else console.log('Aucun dashboard daemon en cours.');
          return;
        }
        if (status) {
          const s = await dashboardDaemonStatus({ root });
          if (s.running)
            console.log(
              `🟢 Dashboard daemon actif (PID ${s.pid}, démarré ${s.startedAt}). Logs : ${s.logPath}`,
            );
          else if (s.stale)
            console.log(
              `⚪ Dashboard daemon mort (PID file orphelin ${s.pid}) — "striart dashboard --daemon" pour relancer.`,
            );
          else console.log('⚪ Aucun dashboard daemon. "striart dashboard --daemon" pour en lancer un.');
          return;
        }
        const chosenPort = port ? Number.parseInt(port, 10) : null;
        const r = await startDashboardDaemon({ root, port: chosenPort });
        console.log(`🚀 Dashboard daemon lancé (PID ${r.pid}). Logs : ${r.logPath}`);
        console.log(
          '   "striart dashboard --status" pour vérifier, "striart dashboard --stop" pour arrêter.',
        );
        return;
      }
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
  .option(
    '--ui',
    "UI interactive (Ink) en plus du watcher habituel : panneau d'agents, bus de messages " +
      '"@agent message" vers les sessions supervisées. Incompatible avec --daemon.',
  )
  .action(async ({ merge, daemon, stop, status, ui }) => {
    try {
      const { findRepoRoot, assertInitialized } = await loadClone();
      const { reconcile, checkAgentsBehind, shouldWatcherMerge, mergeAgentCommit, syncAllAgents } =
        await loadOrchestrator();
      const root = await findRepoRoot();
      await assertInitialized(root);
      if (ui && daemon) {
        throw new StriartError(
          '--ui est incompatible avec --daemon (UI interactive = foreground).',
          {
            code: 'UI_DAEMON_CONFLICT',
          },
        );
      }
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

      if (ui) {
        // La même boucle (merges, fetch, réconciliation) tourne toujours en
        // fond — l'UI Ink s'ajoute, elle ne remplace rien. `patch-console`
        // (dépendance d'Ink) route les logger.info/console.log ci-dessus
        // au-dessus du panneau au lieu de corrompre son rendu. Résout au
        // Ctrl+C de l'UI, qui termine tout le process (cf. watch-ui.ts).
        const { runWatchUi } = await import('./watch-ui.ts');
        await runWatchUi(root);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('pty-host-run <agent>')
  .description(
    "Interne — process hôte détaché d'un pty possédé (lancé par --open via ensurePtyHost, jamais directement)",
  )
  .option('--root <path>', 'Racine du repo principal (jamais dérivée de cwd : cwd est le clone)')
  .option('--shell <path>', 'Shell/outil à héberger dans le pty')
  .option('--shell-arg <arg>', 'Argument du shell (répétable)', (val, prev) => [...prev, val], [])
  .option('--cwd <path>', 'Répertoire de travail du pty (le clone de l’agent)')
  .option(
    '--initial <cmd>',
    "Commande écrite dans le pty juste après démarrage (l'outil de l'agent)",
  )
  .action(async (agent, { root, shell, shellArg, cwd, initial }) => {
    try {
      const { startOwnedSession, stopOwnedSession, waitForSessionExit, writeToOwnedSession } =
        await import('./pty-attach.ts');
      await startOwnedSession(root, agent, { shell, args: shellArg, cwd });
      if (initial) writeToOwnedSession(agent, initial);

      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await stopOwnedSession(agent).catch(() => {});
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);

      await waitForSessionExit(agent); // le pty EST la seule raison de vivre de ce process
      process.exit(0);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('attach <agent>')
  .description(
    "Attache un terminal interactif au pty possédé d'un agent (lancé en interne par --open, invocable directement pour rejoindre une session déjà ouverte)",
  )
  .action(async (agent) => {
    try {
      // `root` n'est jamais passé en argument (chemin potentiellement à
      // espaces, dans une commande interpolée dans une ligne de shell par
      // terminal.js — voir isShellSafe) : dérivé de la structure connue
      // agentsDir = root/.striart/agents/<agent>, avec vérification stricte.
      const cwd = path.resolve(process.cwd());
      const root = path.resolve(cwd, '..', '..', '..');
      if (path.join(root, '.striart', 'agents', agent) !== cwd) {
        throw new StriartError(
          `"striart attach" doit être lancé depuis le clone de l'agent (généré par --open). Répertoire courant inattendu : ${cwd}`,
          { code: 'ATTACH_WRONG_CWD', details: { cwd } },
        );
      }
      const { connectAttachClient } = await import('./pty-attach.ts');

      const wasRaw = process.stdin.isTTY && process.stdin.isRaw;
      const restoreTerminal = () => {
        if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      };

      const conn = connectAttachClient(root, agent, {
        cols: process.stdout.columns,
        rows: process.stdout.rows,
        onData: (text) => process.stdout.write(text),
        onExit: () => {
          console.log('\n🔌 Session terminée côté agent.');
          restoreTerminal();
          process.exit(0);
        },
        onError: (error) => {
          restoreTerminal();
          console.error(
            `❌ Impossible de rejoindre l'agent "${agent}" : ${error.message}. ` +
              "L'hôte de pty tourne-t-il encore ? (relancé automatiquement par --open)",
          );
          process.exit(1);
        },
      });

      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (chunk) => conn.sendRaw(chunk.toString('utf8')));
      process.stdout.on('resize', () => conn.resize(process.stdout.columns, process.stdout.rows));
      process.on('exit', restoreTerminal);
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync().catch(fail);
