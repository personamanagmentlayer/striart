import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { cleanClones, formatBytes, listAgents, readRegistry, validateAgentName } from './clone.js';
import { watchAgents } from './watcher.js';
import { onStriartEvent } from './events.js';
import { striartDir } from './paths.js';
import { logger } from './logger.js';
import { watchDaemonStatus } from './daemon.js';
import { DEFAULT_PROFILE, listProfiles, resolveAgentProfile, sessionLogPath } from './session.js';
import {
  getQueueDashboard,
  mergeAgentCommit,
  promoteStaging,
  reconcile,
  retryQueue,
  rollbackLastMerge,
  runAutonomousTask,
  runTask,
  stopAgent,
} from './orchestrator.js';
import { closeConflictTicket, listConflictTickets, readTicketDetail } from './conflicts.js';
import { readState, resetManualMode } from './state.js';
import { answerPermissionRequest, listPendingPermissions } from './permissions.ts';
import { loadConfig } from './config.js';
import { readLocks } from './locks.js';
import { readQueue } from './queue.js';
import { listMergeHistory } from './history.js';
import { syncAgentWithMain, syncAllAgents } from './sync.js';
import { pruneWorkspace } from './prune.js';
import { runDoctor } from './doctor.js';
import { StriartError } from './errors.js';

const SESSION_LOG_TAIL = 64_000;
const HEATMAP_TOP = 30;
const HISTORY_LIMIT = 30;

/**
 * Fichiers les plus disputés : croise les verrous actifs, les prédictions
 * des tâches en attente et l'historique des tickets (résolus inclus).
 * Le lead voit en un coup d'œil où le couloir est étroit — AVANT que les
 * collisions ne deviennent des conflits.
 * @returns {Promise<Array<{file: string, agents: string[], queued: string[], conflicts: number, score: number}>>}
 */
async function collectHeatmap(root, allTickets) {
  const [locks, queue] = await Promise.all([readLocks(root), readQueue(root)]);

  /** @type {Map<string, {agents: Set<string>, queued: Set<string>, conflicts: number}>} */
  const byFile = new Map();
  const entry = (file) => {
    const key = file.replaceAll('\\', '/');
    if (!byFile.has(key)) byFile.set(key, { agents: new Set(), queued: new Set(), conflicts: 0 });
    return byFile.get(key);
  };

  for (const [file, agent] of Object.entries(locks)) entry(file).agents.add(agent);
  for (const task of queue)
    for (const file of task.predictedFiles ?? []) entry(file).queued.add(task.agent);
  for (const ticket of allTickets)
    for (const file of ticket.conflictedFiles ?? []) entry(file).conflicts += 1;

  return [...byFile.entries()]
    .map(([file, data]) => ({
      file,
      agents: [...data.agents],
      queued: [...data.queued],
      conflicts: data.conflicts,
      // Un conflit avéré pèse plus lourd qu'une simple prédiction.
      score: data.agents.size + data.queued.size + data.conflicts * 2,
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, HEATMAP_TOP);
}

/** Agrège l'état complet pour l'API du dashboard. */
export async function collectDashboardState(root) {
  const [agents, tasks, tickets, allTickets, state, config, history, daemon, permissions] =
    await Promise.all([
      listAgents(root),
      getQueueDashboard({ root }),
      listConflictTickets(root),
      listConflictTickets(root, { includeResolved: true }),
      readState(root),
      loadConfig(root),
      listMergeHistory({ root, limit: HISTORY_LIMIT }),
      // Le watcher n'est jamais lancé automatiquement : sans lui, les commits
      // des agents supervisés ne sont pas mergés. Le dashboard doit donc dire
      // s'il tourne, sinon l'utilisateur attend un merge qui ne viendra pas.
      watchDaemonStatus({ root }),
      // Demandes d'arbitrage des sessions semi-autonomes (ACP, politique 'ask').
      listPendingPermissions(root),
    ]);
  const heatmap = await collectHeatmap(root, allTickets);

  // Le log du Test Gate n'est PAS embarqué dans l'état de liste : le client
  // ne l'y affiche jamais (le détail d'un ticket passe par /api/ticket, qui
  // le sert à la demande). L'embarquer relirait chaque log sur disque et le
  // sérialiserait dans CHAQUE push SSE, pour des octets que le navigateur
  // jette.
  return {
    agents: agents.map((a) => ({
      ...a,
      sizeHuman: a.sizeBytes != null ? formatBytes(a.sizeBytes) : null,
      // Registres antérieurs au mode autonome : pas de champ `mode` → supervisé.
      mode: a.mode ?? 'attended',
      profile: a.profile ?? null,
    })),
    tasks,
    tickets,
    heatmap,
    history,
    state,
    daemon,
    permissions,
    // Profils du mode autonome : clés d'env uniquement, jamais les valeurs
    // (même contrat que `striart profiles`).
    profiles: listProfiles(config),
    config: {
      testCommand: config.testCommand,
      targetBranch: config.targetBranch,
      semanticMerge: config.semanticMerge,
      autoRebase: config.autoRebase,
      autoPush: config.autoPush,
    },
    generatedAt: new Date().toISOString(),
  };
}

// Exportée pour le test de cohérence du client (compilation du script +
// correspondance des ids) : le JS navigateur vit dans cette template string,
// hors de portée d'ESLint et de tsc — sans ce test, une erreur de syntaxe
// cliente passerait la CI.
export const PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Striart — Dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 2rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 2rem; color: #58a6ff; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .35rem .75rem; border-bottom: 1px solid #21262d; font-size: .85rem; }
  th { color: #8b949e; font-weight: normal; }
  .badge { padding: .1rem .5rem; border-radius: 1rem; font-size: .75rem; }
  .RUNNING, .ACTIVE, .ok { background: #1f6feb33; color: #58a6ff; }
  .WAITING { background: #d2992233; color: #d29922; }
  .MISSING, .BROKEN, .ko { background: #da363333; color: #f85149; }
  .manual { background: #da363333; color: #f85149; padding: .5rem 1rem; border-radius: .5rem; margin-top: 1rem; display: inline-block; }
  pre { background: #161b22; padding: .75rem; border-radius: .5rem; overflow-x: auto; max-height: 14rem; font-size: .75rem; }
  .muted { color: #8b949e; } .empty { color: #484f58; font-style: italic; }
  .detail { border: 1px solid #21262d; border-radius: .5rem; padding: 1rem 1.5rem; margin-top: 1.5rem; }
  .heat-row { display: grid; grid-template-columns: minmax(12rem, max-content) 1fr max-content; gap: 1rem; align-items: center; margin: .25rem 0; font-size: .85rem; }
  .heat-bar { display: inline-block; height: .8rem; background: linear-gradient(90deg, #1f6feb, #f85149); border-radius: .25rem; }
  .versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: .75rem; }
  .version pre { max-height: 22rem; }
  h3 { font-size: .9rem; color: #8b949e; margin: 1.25rem 0 .25rem; }
  code { background: #161b22; padding: .1rem .35rem; border-radius: .25rem; }
  a { color: #58a6ff; }
  button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: .35rem; padding: .25rem .7rem; font: inherit; font-size: .8rem; cursor: pointer; }
  button:hover { background: #30363d; }
  button.danger { color: #f85149; border-color: #f8514966; }
  #toolbar, #toolbar2 { margin: .75rem 0 0; display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  #toolbar2 { margin-top: .5rem; }
  #toolbar input, #toolbar select { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: .35rem; padding: .25rem .6rem; font: inherit; font-size: .85rem; }
  #toast { min-height: 1.2rem; font-size: .85rem; color: #d29922; margin: .25rem 0; }
  .warn { border: 1px solid #d2992255; background: #d2992211; border-radius: .5rem; padding: .5rem .9rem; font-size: .85rem; color: #d29922; margin: .5rem 0; }
  .auto { color: #a371f7; }
  #topbar { position: fixed; top: 1rem; right: 2rem; color: #484f58; font-size: .75rem; background: #0d1117cc; padding: .15rem .5rem; border-radius: .35rem; }
  button.armed { background: #d2992233; border-color: #d29922; color: #d29922; }
  /* Les tableaux larges défilent dans leur section, jamais la page. */
  #agents, #queue, #tickets, #history { overflow-x: auto; }
  @media (max-width: 900px) {
    body { margin: 1rem; }
    #topbar { position: static; margin-bottom: .5rem; }
    #toolbar input { flex: 1; min-width: 12rem; }
  }
</style>
</head>
<body>
<h1>⚡ Striart <span class="muted" style="font-size:.8rem">— pilotage local</span></h1>
<div id="topbar"><span id="live">⏳</span> · <span id="meta"></span></div>
<div id="toolbar">
  <input id="task-prompt" type="text" placeholder="Nouvelle tâche — ex : Corrige le bug du panier" size="40">
  <input id="task-agent" type="text" placeholder="agent (optionnel)" size="14">
  <select id="task-mode" title="Mode d'exécution">
    <option value="attended">👤 supervisé</option>
    <option value="autonomous">🤖 autonome</option>
  </select>
  <select id="task-profile" hidden title="Profil d'agent (mode autonome)"></select>
  <button id="task-start">🚀 Lancer (Router)</button>
</div>
<div id="toolbar2">
  <button data-act="queue-retry" data-confirm="Relancer les tâches débloquées de la file d'attente ?">🔄 Relancer la file</button>
  <button data-act="sync" data-confirm="Rebaser tous les agents sur la branche cible ?">🔁 Sync agents</button>
  <button data-act="reconcile" data-confirm="Neutraliser les sessions mortes et débloquer la file ?">🩹 Réconcilier</button>
  <button data-act="promote" data-confirm="Promouvoir staging → main (Test Gate global) ?">🚦 Promote</button>
  <button data-act="clean" data-confirm="Supprimer les clones des agents arrêtés ?">🧹 Clean</button>
  <button data-act="prune" data-confirm="Élaguer les clones inactifs et les tickets résolus (rétention config) ?">🗑️ Prune</button>
  <button id="doctor-btn">🩺 Doctor</button>
  <button data-act="rollback" data-confirm="Défaire le DERNIER merge Striart de la branche cible ?" class="danger">↩️ Rollback dernier merge</button>
</div>
<div id="toast"></div>
<div id="doctor-detail"></div>
<div id="watcher"></div>
<div id="manual"></div>
<div id="permissions"></div>
<h2>Agents actifs</h2><div id="agents" class="empty">chargement…</div>
<div id="session-log"></div>
<h2>File d'attente</h2><div id="queue" class="empty">chargement…</div>
<h2>Heatmap — fichiers disputés</h2><div id="heatmap" class="empty">chargement…</div>
<h2>Conflits en attente de résolution humaine</h2><div id="tickets" class="empty">chargement…</div>
<div id="ticket-detail"></div>
<h2>Historique (${HISTORY_LIMIT} derniers merges)</h2><div id="history" class="empty">chargement…</div>
<script>
const esc = (s) => String(s ?? '—').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function table(rows, cols) {
  if (!rows.length) return '<div class="empty">aucun</div>';
  const head = cols.map((c) => '<th>' + esc(c.label) + '</th>').join('');
  const body = rows.map((r) => '<tr>' + cols.map((c) => '<td>' + c.render(r) + '</td>').join('') + '</tr>').join('');
  return '<table><tr>' + head + '</tr>' + body + '</table>';
}
const badge = (v) => '<span class="badge ' + esc(v) + '">' + esc(v) + '</span>';
// Re-render ciblé : une section dont le HTML n'a pas changé n'est pas
// retouchée — pas de sélection perdue, pas de reflow, sur AUCUN push SSE.
const lastHtml = {};
function setSection(id, html) {
  if (lastHtml[id] === html) return;
  lastHtml[id] = html;
  document.getElementById(id).innerHTML = html;
}
let live = false;
function setLive(ok) {
  live = ok;
  document.getElementById('live').textContent = ok ? '🟢 direct' : '🔴 reconnexion…';
}
function render(s) {
    document.getElementById('meta').textContent =
      s.config.targetBranch + ' · ' + s.config.testCommand + ' · maj ' + new Date(s.generatedAt).toLocaleTimeString();
    setSection('manual', s.state.manualMode
      ? '<div class="manual">🔒 Mode manuel actif — fusion sémantique désactivée '
        + '<button data-act="unlock" data-confirm="Réactiver la fusion sémantique (compteur d\\'échecs remis à zéro) ?">🔓 Déverrouiller</button></div>'
      : (s.state.semanticFailureStreak > 0
        ? '<div class="muted">⚠️ ' + s.state.semanticFailureStreak + ' échec(s) sémantique(s) consécutif(s)</div>' : ''));
    // Le remplacement d'innerHTML d'un <select> ramène la sélection à la
    // première option : on restaure le choix de l'utilisateur tant que le
    // profil existe encore — sinon une session autonome partirait sous le
    // mauvais outil après un simple push SSE.
    const profileSel = document.getElementById('task-profile');
    const prevProfile = profileSel.value;
    setSection('task-profile', s.profiles.length
      ? s.profiles.map((p) => '<option value="' + esc(p.name) + '">' + esc(p.name) + (p.acp ? ' · ACP' : '') + '</option>').join('')
      : '<option value="">(aucun profil configuré)</option>');
    if (prevProfile && [...profileSel.options].some((o) => o.value === prevProfile)) {
      profileSel.value = prevProfile;
    }
    // Semi-autonome (ACP 'ask') : chaque demande attend UN humain — la
    // section est proéminente, avec un bouton par option proposée par l'agent.
    setSection('permissions', (s.permissions ?? []).length === 0 ? '' :
      '<div class="warn">🖐️ ' + s.permissions.length + ' demande(s) de permission en attente d\\'arbitrage :</div>'
      + table(s.permissions, [
        { label: 'Agent', render: (p) => esc(p.agent) },
        { label: 'Action demandée', render: (p) => esc(p.title) },
        { label: 'Expire', render: (p) => esc(new Date(p.expiresAt).toLocaleTimeString()) },
        { label: 'Décision', render: (p) => p.options.map((o) =>
            '<button data-act="permission" data-perm="' + esc(p.id) + '" data-option="' + esc(o.optionId) + '"'
            + ((o.kind || '').startsWith('reject') ? ' class="danger"' : '') + '>'
            + esc(o.name || o.kind || o.optionId) + '</button>').join(' ') },
      ]));
    setSection('watcher', s.daemon.running
      ? '<div class="muted">👁️ Watcher daemon actif (PID ' + esc(s.daemon.pid) + ') — les commits des agents sont mergés en continu.</div>'
      : '<div class="warn">⚠️ Aucun watcher en cours'
        + (s.daemon.stale ? ' (PID file orphelin détecté)' : '')
        + ' — les commits des agents supervisés ne seront pas mergés automatiquement.'
        + ' Lance <code>striart watch --daemon</code>, ou merge à la main ci-dessous.</div>');
    setSection('agents', table(s.agents, [
      { label: 'Agent', render: (a) => esc(a.name) },
      { label: 'Statut', render: (a) => badge(a.status) },
      { label: 'Mode', render: (a) => a.mode === 'autonomous'
        ? '<span class="auto">🤖 autonome</span>' + (a.profile ? ' <span class="muted">' + esc(a.profile) + '</span>' : '')
        : '<span class="muted">👤 supervisé</span>' },
      { label: 'Session', render: (a) => a.sessionActive ? '🟢 en cours' : '<span class="muted">⚪ inactive</span>' },
      { label: 'Branche', render: (a) => esc(a.currentBranch ?? a.branch) },
      { label: 'Outil', render: (a) => esc(a.command) },
      { label: 'Taille', render: (a) => esc(a.sizeHuman) },
      { label: 'En attente', render: (a) => esc(a.pendingCommits) },
      { label: 'Dernier commit', render: (a) => esc(a.lastMessage) },
      { label: 'Actions', render: (a) =>
        '<button data-act="merge" data-agent="' + esc(a.name) + '"'
        + ' data-confirm="Merger le dernier commit de ' + esc(a.name) + ' (Test Gate inclus) ?">Merger</button> '
        + '<button data-act="sync" data-agent="' + esc(a.name) + '"'
        + ' data-confirm="Rebaser ' + esc(a.name) + ' sur la branche cible ?">Sync</button> '
        + '<button data-act="stop" data-agent="' + esc(a.name) + '" class="danger"'
        + ' data-confirm="Arrêter ' + esc(a.name) + ' ? (refusé s\\'il reste des commits non mergés)">Stop</button> '
        + '<button data-act="stop" data-agent="' + esc(a.name) + '" data-force="1" class="danger"'
        + ' data-confirm="Arrêter ' + esc(a.name) + ' en ABANDONNANT ses commits non mergés ?">Stop ⚠</button>'
        + (a.mode === 'autonomous'
          ? ' <button data-log="' + esc(a.name) + '">📄 Log</button>'
          : '') },
    ]));
    bindSessionLogs();
    setSection('history', table(s.history, [
      { label: 'Quand', render: (h) => esc(new Date(h.date).toLocaleString()) },
      { label: 'Type', render: (h) => h.type === 'rollback' ? '↩️ rollback' : '✅ merge' },
      { label: 'Agent', render: (h) => esc(h.agent) },
      { label: 'Commit', render: (h) => esc((h.sha || '').slice(0, 8)) },
      { label: 'Fusion sémantique', render: (h) => h.semantic ? '🧬 ' + esc(h.semanticFiles.join(', ')) : '<span class="muted">—</span>' },
    ]));
    bindActions();
    setSection('queue', table(s.tasks.filter((t) => t.status === 'WAITING'), [
      { label: 'ID', render: (t) => esc(t.id) },
      { label: 'Agent', render: (t) => esc(t.agent) },
      { label: 'Fichiers prédits', render: (t) => esc(t.files.join(', ')) },
      { label: 'Bloqué par', render: (t) => esc(t.blockedBy.map((b) => b.agent + ' (' + b.files.join(', ') + ')').join(' ; ')) },
      { label: 'Après', render: (t) => t.after ? '⏳ ' + esc(t.after) : '<span class="muted">—</span>' },
    ]));
    const maxScore = Math.max(1, ...s.heatmap.map((h) => h.score));
    setSection('heatmap', s.heatmap.length === 0
      ? '<div class="empty">aucun fichier disputé</div>'
      : s.heatmap.map((h) => {
          const width = Math.max(2, Math.round((h.score / maxScore) * 100));
          const who = [
            h.agents.length ? '🔒 ' + h.agents.join(', ') : '',
            h.queued.length ? '⏳ ' + h.queued.join(', ') : '',
            h.conflicts ? '⛔ ' + h.conflicts + ' conflit(s)' : '',
          ].filter(Boolean).join(' · ');
          return '<div class="heat-row"><span class="heat-file">' + esc(h.file) + '</span>'
            + '<span class="heat-bar" style="width:' + width + '%" title="score ' + h.score + '"></span>'
            + '<span class="muted">' + esc(who) + '</span></div>';
        }).join(''));
    setSection('tickets', table(s.tickets, [
      { label: 'Ticket', render: (t) => esc(t.id) },
      { label: 'Raison', render: (t) => badge(t.reason) },
      { label: 'Agent', render: (t) => esc(t.agent) },
      { label: 'Fichiers', render: (t) => esc(t.conflictedFiles.join(', ')) },
      { label: 'Créé', render: (t) => esc(new Date(t.createdAt).toLocaleString()) },
      { label: '', render: (t) => '<a href="#" class="open-ticket" data-id="' + esc(t.id) + '">détail ▸</a>' },
    ]));
    for (const link of document.querySelectorAll('.open-ticket')) {
      if (link.dataset.bound) continue;
      link.dataset.bound = '1';
      link.addEventListener('click', (e) => { e.preventDefault(); showTicket(link.dataset.id); });
    }
}
// Fallback sans SSE : un fetch ponctuel (premier rendu, reprise après coupure).
async function refresh() {
  try {
    render(await (await fetch('/api/state')).json());
  } catch (e) {
    document.getElementById('meta').textContent = 'connexion perdue…';
  }
}
let busy = false;
// Renvoie true UNIQUEMENT si l'action a été envoyée ET a réussi : les
// appelants qui détruisent un état local (vider le champ de prompt) ne
// doivent le faire que sur ce true — jamais sur un refus, une erreur, ou
// une requête silencieusement sautée par le garde busy.
async function runAction(action, body) {
  if (busy) { toast('⏳ Une action est déjà en cours — réessaie dans un instant.', true); return false; }
  busy = true;
  toast('⏳ ' + action + ' en cours…');
  let ok = false;
  try {
    const r = await fetch('/api/action/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json();
    if (data.ok) {
      ok = true;
      const st = data.result && data.result.status ? ' → ' + data.result.status : '';
      toast('✅ ' + action + st, true);
    } else {
      toast('⛔ ' + action + ' : ' + data.error, true);
    }
  } catch (e) {
    toast('⛔ ' + action + ' : ' + e.message, true);
  } finally {
    busy = false;
    refresh();
  }
  return ok;
}
let toastTimer = null;
function toast(msg, sticky) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'visible';
  clearTimeout(toastTimer);
  if (sticky) toastTimer = setTimeout(() => { el.className = ''; el.textContent = ''; }, 8000);
}
// Confirmation inline en deux temps, sans modale : le premier clic arme le
// bouton (libellé + intitulé de l'action), le second exécute, 4 s sans suite
// désarme. Pas de window.confirm : une modale bloque la page entière — y
// compris les mises à jour SSE — pour une décision qui ne concerne qu'un bouton.
function bindActions() {
  for (const btn of document.querySelectorAll('button[data-act]')) {
    if (btn.dataset.bound) continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      if (btn.dataset.confirm && btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.dataset.label = btn.textContent;
        btn.textContent = '⚠ ' + btn.dataset.confirm;
        btn.classList.add('armed');
        setTimeout(() => {
          if (btn.isConnected && btn.dataset.armed === '1') {
            btn.dataset.armed = '';
            btn.textContent = btn.dataset.label;
            btn.classList.remove('armed');
          }
        }, 4000);
        return;
      }
      if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = btn.dataset.label;
        btn.classList.remove('armed');
      }
      const body = {};
      if (btn.dataset.agent) body.agent = btn.dataset.agent;
      if (btn.dataset.ticket) body.id = btn.dataset.ticket;
      if (btn.dataset.perm) { body.id = btn.dataset.perm; body.option = btn.dataset.option; }
      if (btn.dataset.force === '1') body.force = true;
      runAction(btn.dataset.act, body);
    });
  }
}
function bindSessionLogs() {
  for (const btn of document.querySelectorAll('button[data-log]')) {
    if (btn.dataset.bound) continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => showSessionLog(btn.dataset.log));
  }
}
async function showSessionLog(agent) {
  const el = document.getElementById('session-log');
  const r = await fetch('/api/session-log/' + encodeURIComponent(agent));
  if (!r.ok) {
    el.innerHTML = '<div class="detail"><div class="empty">Aucun log de session pour ' + esc(agent)
      + ' — la session n\\'a peut-être pas encore démarré.</div></div>';
    return;
  }
  const d = await r.json();
  el.innerHTML = '<div class="detail"><h3>Session autonome — ' + esc(agent) + '</h3>'
    + '<div class="muted">' + esc(d.path) + '</div>'
    + '<pre>' + esc(d.log || '(log vide)') + '</pre></div>';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function showTicket(id) {
  const el = document.getElementById('ticket-detail');
  const r = await fetch('/api/ticket/' + encodeURIComponent(id));
  if (!r.ok) { el.innerHTML = '<div class="empty">ticket introuvable</div>'; return; }
  const t = await r.json();
  const unmergeable = (t.unmergeable ?? []).map((u) =>
    '<li>' + esc(u.path) + ' — <b>' + esc(u.kind) + '</b>' + (u.deletedBy ? ' (supprimé côté ' + (u.deletedBy === 'ours' ? 'main' : 'agent') + ')' : '') + '</li>').join('');
  const versions = (t.resolutions ?? []).map((res) => {
    const col = (label, content) => content == null ? ''
      : '<div class="version"><div class="muted">' + esc(label) + '</div><pre>' + esc(content) + '</pre></div>';
    return '<h3>' + esc(res.path) + '</h3><div class="versions">'
      + col('BASE (ancêtre commun)', res.base)
      + col('OURS (branche cible)', res.ours)
      + col('THEIRS (agent)', res.theirs)
      + col('Tentative LLM', res.llmAttempt)
      + '</div>';
  }).join('');
  el.innerHTML =
    '<div class="detail">'
    + '<h2>🎫 ' + esc(t.id) + ' — ' + badge(t.reason) + (t.resolved ? ' <span class="badge ok">RESOLVED</span>' : '') + '</h2>'
    + '<div class="muted">Agent ' + esc(t.agent) + ' · branche ' + esc(t.branch) + ' · commit ' + esc((t.sha || '').slice(0, 8))
    + ' · prompt : ' + esc(t.prompt) + '</div>'
    + '<div class="muted">Dossier : <code>' + esc(t.dir) + '</code> — ouvrir dans l\\'éditeur : <code>code "' + esc(t.dir) + '"</code>'
    + (t.resolved ? '' : ' <button data-act="ticket-close" data-ticket="' + esc(t.id) + '"'
      + ' data-confirm="Marquer le ticket ' + esc(t.id) + ' comme résolu ?">✓ Clore le ticket</button>')
    + '</div>'
    + (unmergeable ? '<h3>Hors de portée du Merger</h3><ul>' + unmergeable + '</ul>' : '')
    + versions
    + (t.log ? '<h3>Log du Test Gate</h3><pre>' + esc(t.log) + '</pre>' : '')
    + '</div>';
  bindActions();
  el.scrollIntoView({ behavior: 'smooth' });
}
async function showDoctor() {
  const el = document.getElementById('doctor-detail');
  el.innerHTML = '<div class="detail"><div class="empty">diagnostic en cours…</div></div>';
  try {
    const d = await (await fetch('/api/doctor')).json();
    const ICONS = { ok: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' };
    el.innerHTML = '<div class="detail"><h3>🩺 Doctor — '
      + (d.healthy ? '<span class="badge ok">opérationnel</span>' : '<span class="badge ko">prérequis manquants</span>') + '</h3>'
      + '<table>' + d.checks.map((c) =>
        '<tr><td>' + (ICONS[c.level] || '') + '</td><td>' + esc(c.label) + '</td><td class="muted">' + esc(c.detail) + '</td></tr>'
      ).join('') + '</table></div>';
  } catch (e) {
    el.innerHTML = '<div class="detail"><div class="empty">diagnostic indisponible : ' + esc(e.message) + '</div></div>';
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
document.getElementById('doctor-btn').addEventListener('click', showDoctor);
document.getElementById('task-mode').addEventListener('change', () => {
  const mode = document.getElementById('task-mode').value;
  document.getElementById('task-profile').hidden = mode !== 'autonomous';
});
document.getElementById('task-start').addEventListener('click', () => {
  const input = document.getElementById('task-prompt');
  const prompt = input.value.trim();
  if (!prompt) { toast('⛔ Décris la tâche avant de lancer.', true); return; }
  const body = { prompt };
  const agent = document.getElementById('task-agent').value.trim();
  if (agent) body.agent = agent;
  if (document.getElementById('task-mode').value === 'autonomous') {
    body.mode = 'autonomous';
    body.profile = document.getElementById('task-profile').value || null;
  }
  runAction('run', body).then((ok) => { if (ok) input.value = ''; });
});
document.getElementById('task-prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('task-start').click();
});

// ── Temps réel ───────────────────────────────────────────────────────────
// SSE : le serveur pousse l'état à chaque changement (fichiers d'état, refs
// des agents, actions du dashboard). Plus aucun polling tant que le flux vit ;
// s'il tombe, EventSource retente seul (retry: 3000) et un polling de secours
// à 5 s prend le relais entre-temps.
let pollTimer = null;
function startPolling() {
  if (!pollTimer) pollTimer = setInterval(refresh, 5000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
const events = new EventSource('/api/events');
events.addEventListener('state', (e) => {
  setLive(true);
  stopPolling();
  render(JSON.parse(e.data));
});
events.addEventListener('notice', (e) => {
  const n = JSON.parse(e.data);
  toast(n.message, true);
});
events.onerror = () => {
  setLive(false);
  startPolling();
};
refresh(); // premier rendu immédiat, sans attendre le flux
</script>
</body>
</html>
`;

/** Corps JSON d'une requête (limité à 64 Ko — les actions sont minuscules). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) reject(new Error('corps trop volumineux'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Lancement autonome depuis le dashboard. Une session dure des minutes voire
 * des heures : la réponse HTTP ne peut pas l'attendre, et tenir la requête
 * ouverte ne surveillerait rien de plus. Le profil — et, en amont dans
 * ACTIONS.run, le nom d'agent — sont donc validés AVANT de répondre (un
 * profil inconnu ou un nom invalide échoue dans la requête, pas en tâche de
 * fond),
 * puis le cycle vit en arrière-plan : ses échecs remontent par le bus
 * d'événements (session:failed, merge:*…) et ses épilogues muets (MERGED,
 * QUEUED, MERGE_BLOCKED) par le notice de synthèse ci-dessous. La session
 * meurt avec le process du dashboard — exactement comme avec le CLI qui
 * l'aurait lancée.
 */
async function launchAutonomous({ root, prompt, agent, profile, notice }) {
  const config = await loadConfig(root);
  const profileKey = profile ?? DEFAULT_PROFILE;
  resolveAgentProfile(config, profileKey);
  void runAutonomousTask({ root, agent, prompt, profile: profileKey })
    .then((result) => {
      if (result.status === 'MERGED') {
        notice(
          `✅ Session autonome ${result.agent} : travail mergé` +
            (result.cleaned ? ', clone nettoyé.' : ` — ${result.keptReason}`),
        );
      } else if (result.status === 'QUEUED') {
        notice(`⏳ Tâche autonome de ${result.agent} mise en file (collision Router).`);
      } else if (result.status === 'MERGE_BLOCKED') {
        notice(`⛔ Session autonome ${result.agent} : ${result.keptReason}`);
      }
    })
    .catch((error) => {
      // Trace persistante AVANT le toast : le notice SSE est perdu s'il n'y a
      // plus de client connecté, et le bus d'événements n'accepte jamais les
      // erreurs (events.js). Sans ce log, un MERGE_ABORT_FAILED qui laisse le
      // repo principal en état « merging » ne laisserait aucune trace.
      logger.error(
        { err: error, agent, profile: profileKey, code: error.code ?? null },
        'Tâche autonome lancée depuis le dashboard échouée',
      );
      notice(`⛔ Session autonome : ${error.message}`);
    });
  return { status: 'AUTONOMOUS_LAUNCHED', profile: profileKey, agent };
}

/**
 * Synthèses lisibles dans le toast (`→ status`) pour les actions en lot.
 * Les conflits (REBASE_CONFLICT, STASH_CONFLICT) exigent une intervention
 * humaine dans le clone : ils sont nommés distinctement, agents à l'appui —
 * les ranger parmi les « reportés » (bénins, rattrapés au prochain cycle)
 * masquerait un état qui ne se résorbera jamais tout seul.
 */
function summarizeSync(results) {
  const of = (...statuses) => results.filter((r) => statuses.includes(r.status));
  const deferred = of('SKIPPED_DIRTY', 'SKIPPED_SESSION');
  const conflicts = of('REBASE_CONFLICT', 'STASH_CONFLICT');
  const parts = [`${of('REBASED').length} rebasé(s)`, `${of('UP_TO_DATE').length} à jour`];
  if (deferred.length > 0) parts.push(`${deferred.length} reporté(s)`);
  if (conflicts.length > 0) {
    parts.push(
      `⚠️ ${conflicts.length} en conflit (${conflicts.map((r) => r.agent).join(', ')}) — résolution manuelle requise dans le clone`,
    );
  }
  return { status: parts.join(', '), results };
}

function summarizeClean({ removed, skipped }) {
  const freed = removed.reduce((sum, r) => sum + r.freedBytes, 0);
  return {
    status: `${removed.length} clone(s) supprimé(s) (${formatBytes(freed)}), ${skipped.length} conservé(s)`,
    removed,
    skipped,
  };
}

/**
 * Actions de pilotage exposées par le dashboard. Chaque action réutilise
 * les fonctions de l'orchestrateur — mêmes verrous, mêmes garde-fous que
 * le CLI, aucune logique métier ici.
 */
const ACTIONS = {
  run: (root, body, ctx) => {
    if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
      throw new StriartError('Le prompt de la tâche est vide.', { code: 'EMPTY_PROMPT' });
    }
    const agent = optionalAgent(body);
    if (body.mode === 'autonomous') {
      return launchAutonomous({
        root,
        prompt: body.prompt,
        agent,
        profile: typeof body.profile === 'string' && body.profile ? body.profile : null,
        notice: ctx.notice,
      });
    }
    return runTask({ root, prompt: body.prompt, agent });
  },
  merge: (root, body) => mergeAgentCommit({ root, agent: requireAgent(body) }),
  stop: (root, body) => stopAgent({ root, agent: requireAgent(body), force: Boolean(body.force) }),
  sync: (root, body) => {
    const agent = optionalAgent(body);
    return agent ? syncAgentWithMain({ root, agent }) : syncAllAgents({ root }).then(summarizeSync);
  },
  reconcile: (root) =>
    reconcile({ root }).then((r) => ({
      status: `${r.sessionPidsCleared.length} session(s) neutralisée(s), ${r.started.length} tâche(s) relancée(s), ${r.stillWaiting.length} en attente`,
      ...r,
    })),
  promote: (root, body) => promoteStaging({ root, rollback: Boolean(body.rollback) }),
  unlock: (root) => resetManualMode(root).then(() => ({ status: 'fusion sémantique réactivée' })),
  // Garde-fous de cleanClones inchangés : jamais all/force depuis le dashboard,
  // seuls les clones d'agents arrêtés sans travail en attente partent.
  clean: (root, body) =>
    cleanClones({
      root,
      agent: optionalAgent(body),
      all: false,
      force: false,
    }).then(summarizeClean),
  prune: (root) =>
    pruneWorkspace({ root, days: null, dryRun: false }).then((result) => ({
      status: `${result.clones.removed.length} clone(s) et ${result.tickets.removed.length} ticket(s) élagués — ${formatBytes(result.freedBytes)}`,
      ...result,
    })),
  'queue-retry': (root) => retryQueue({ root }),
  // Arbitrage semi-autonome (ACP 'ask') : la validation de fond (demande
  // PENDING, option PROPOSÉE par l'agent) vit dans permissions.ts — ici on
  // ne vérifie que la forme, comme partout.
  permission: (root, body) => {
    if (typeof body.id !== 'string' || typeof body.option !== 'string' || !body.option) {
      throw new StriartError('Réponse de permission invalide : id et option requis.', {
        code: 'PERMISSION_ID_INVALID',
      });
    }
    return answerPermissionRequest(root, body.id, body.option).then((r) => ({
      status: `décision transmise à la session de ${r.agent}`,
      ...r,
    }));
  },
  'ticket-close': (root, body) => {
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.id)) {
      throw new StriartError('Id de ticket invalide.', { code: 'TICKET_UNKNOWN' });
    }
    return closeConflictTicket(root, body.id);
  },
  rollback: (root) => rollbackLastMerge({ root }),
};

/**
 * Champ `agent` optionnel d'une action : absent ou vide → null (portée « tous
 * les agents » ou nom auto selon l'action), présent → chaîne validée par
 * validateAgentName, obligatoirement. Un type inattendu ({agent: 0}, un
 * tableau…) est REFUSÉ : le laisser retomber sur null escaladerait en silence
 * une requête ciblée vers la portée globale.
 */
function optionalAgent(body) {
  if (body.agent == null || body.agent === '') return null;
  if (typeof body.agent !== 'string') {
    throw new StriartError('Champ « agent » invalide : chaîne attendue.', {
      code: 'INVALID_AGENT_NAME',
      details: { agent: body.agent },
    });
  }
  return validateAgentName(body.agent.trim());
}

function requireAgent(body) {
  const agent = optionalAgent(body);
  if (!agent) {
    throw new StriartError("Nom d'agent manquant.", { code: 'AGENT_UNKNOWN' });
  }
  return agent;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * L'en-tête Host désigne-t-il bien la boucle locale ?
 *
 * Défense contre le DNS rebinding : le serveur est lié à 127.0.0.1, mais un
 * site malveillant peut faire pointer son propre domaine (evil.example) vers
 * 127.0.0.1 le temps d'une requête. Le navigateur envoie alors des requêtes
 * au dashboard AVEC l'en-tête `Host: evil.example` — le binding local ne
 * protège pas, le navigateur est le député confus. Seul l'en-tête Host
 * distingue une vraie visite locale (Host = 127.0.0.1/localhost) d'une
 * requête pilotée par un domaine tiers. À appliquer à TOUTE requête, pas
 * seulement aux actions : les lectures exposent l'état du repo, le contenu
 * des tickets (code source) et les logs de session.
 */
function isLocalHost(req) {
  const raw = req.headers.host ?? '';
  // IPv6 littéral « [::1]:3456 » : ne pas couper sur « : » naïvement.
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return LOCAL_HOSTS.has(host);
}

/**
 * Garde anti-CSRF des ACTIONS : en-tête custom (X-Striart) EN PLUS de l'hôte
 * local. Sous DNS rebinding l'origine devient same-origin (le domaine tiers
 * résout vers 127.0.0.1), donc l'en-tête custom pourrait être forgé — c'est
 * le contrôle d'hôte qui reste la vraie barrière ; X-Striart couvre le CSRF
 * classique cross-origin (preflight requis, jamais validé ici).
 */
function isActionAllowed(req) {
  return req.headers['x-striart'] === '1' && isLocalHost(req);
}

/** Intervalle du battement de cœur SSE (commentaire, maintient le socket). */
const SSE_HEARTBEAT_MS = 25_000;
/** Fenêtre de coalescence des changements disque avant recalcul d'état. */
const SSE_DEBOUNCE_MS = 300;

/**
 * Démarre le dashboard local (Phase 5). Lié à 127.0.0.1 uniquement :
 * l'état du repo n'est jamais exposé sur le réseau.
 *
 * Temps réel : les clients s'abonnent à /api/events (SSE) et reçoivent un
 * événement `state` complet à chaque changement. Le dashboard étant un
 * process distinct de `watch` et des CLI, le bus in-process ne voit que ses
 * propres actions — la source de vérité inter-process reste le DISQUE :
 * fichiers d'état de .striart/ (chokidar) et refs des agents (watchAgents,
 * réutilisé — jamais les worktrees). Aucun journal d'événements : pas
 * d'état parallèle, décision existante.
 */
export function startDashboard({ root, port = 3456 }) {
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let refreshTimer = null;

  const broadcast = (event, data) => {
    if (sseClients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(frame);
  };

  // Recalcul débouncé : une rafale d'écritures (merge = registre + locks +
  // historique) ne déclenche qu'un seul collectDashboardState.
  const scheduleStatePush = () => {
    if (sseClients.size === 0) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        broadcast('state', await collectDashboardState(root));
      } catch (error) {
        // Best-effort : un état illisible pendant une écriture concurrente
        // sera repoussé au prochain changement, le client garde le précédent.
        logger.warn({ err: error.message }, 'Push SSE du dashboard échoué');
      }
    }, SSE_DEBOUNCE_MS);
  };

  // Fichiers d'état de .striart/ — en EXCLUANT agents/ (des clones entiers,
  // les refs sont couvertes par watchAgents ci-dessous), logs/ (le daemon y
  // écrit en continu), le verrou transitoire et les .tmp d'écriture atomique.
  const dir = striartDir(root);
  const stateWatcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 2,
    ignored: (p) => {
      const rel = path.relative(dir, p);
      if (rel === '' || rel.startsWith('..')) return false;
      const [head] = rel.split(path.sep);
      return head === 'agents' || head === 'logs' || rel === 'main.lock' || rel.endsWith('.tmp');
    },
  });
  stateWatcher.on('all', scheduleStatePush);
  stateWatcher.on('error', (error) => logger.warn({ err: error }, 'Watcher du dashboard'));
  // Refs des agents : « en attente » et « dernier commit » bougent ici.
  const refsWatcher = watchAgents({ root, onCommit: scheduleStatePush });
  // Bus in-process : actions lancées PAR le dashboard — toast typé instantané.
  const offBus = onStriartEvent((_config, event) => {
    if (event.message) broadcast('notice', { type: event.type, message: event.message });
    scheduleStatePush();
  });

  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(':ping\n\n');
  }, SSE_HEARTBEAT_MS);

  const server = http.createServer(async (req, res) => {
    try {
      // Barrière anti-DNS-rebinding, AVANT tout routage : aucune donnée du
      // repo ne sort si l'en-tête Host ne désigne pas la boucle locale. Une
      // vraie visite (navigateur sur 127.0.0.1/localhost) passe ; une requête
      // pilotée par un domaine tiers est refusée sèchement.
      if (!isLocalHost(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Host non local refusé (protection contre le DNS rebinding).');
        return;
      }
      if (req.url === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        // État initial dans le flux : le client rend sans requête séparée.
        try {
          res.write(`event: state\ndata: ${JSON.stringify(await collectDashboardState(root))}\n\n`);
        } catch (error) {
          logger.warn({ err: error.message }, 'État SSE initial illisible');
        }
        return;
      }
      const actionMatch = req.url?.match(/^\/api\/action\/([a-z-]+)$/);
      if (actionMatch) {
        const action = ACTIONS[actionMatch[1]];
        if (req.method !== 'POST' || !action) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'action inconnue' }));
          return;
        }
        if (!isActionAllowed(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'en-tête X-Striart requis (protection CSRF)' }));
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await action(root, body, {
            notice: (message) => broadcast('notice', { type: 'dashboard', message }),
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(error instanceof StriartError ? 409 : 400, {
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(JSON.stringify({ ok: false, error: error.message, code: error.code ?? null }));
        }
        return;
      }
      if (req.url === '/api/doctor') {
        const report = await runDoctor(root);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(report));
        return;
      }
      if (req.url === '/api/state') {
        const state = await collectDashboardState(root);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(state));
        return;
      }
      // Détail d'un ticket (id validé strictement : pas de traversée de chemin).
      const ticketMatch = req.url?.match(/^\/api\/ticket\/([A-Za-z0-9_-]+)$/);
      if (ticketMatch) {
        try {
          const detail = await readTicketDetail(root, ticketMatch[1]);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(detail));
        } catch {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'ticket inconnu' }));
        }
        return;
      }
      // Log d'une session autonome. Le nom d'agent est validé par le motif de
      // la route ET le chemin est reconstruit depuis le registre (jamais depuis
      // l'URL) : aucune traversée de chemin possible.
      const sessionMatch = req.url?.match(/^\/api\/session-log\/([A-Za-z0-9_-]+)$/);
      if (sessionMatch) {
        try {
          const meta = (await readRegistry(root))[sessionMatch[1]];
          if (!meta) throw new StriartError('Agent inconnu.', { code: 'AGENT_UNKNOWN' });
          const logPath = sessionLogPath(root, sessionMatch[1], meta.taskId);
          const log = (await readFile(logPath, 'utf8')).slice(-SESSION_LOG_TAIL);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ agent: sessionMatch[1], path: logPath, log }));
        } catch {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'log de session introuvable' }));
        }
        return;
      }
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Erreur dashboard : ${error.message}`);
    }
  });

  // server.close doit AUSSI démonter flux SSE et watchers : sans ça, les
  // sockets event-stream ouverts empêchent close() d'aboutir (les tests
  // l'attendent) et les watchers chokidar survivraient au serveur.
  const teardown = () => {
    clearInterval(heartbeat);
    if (refreshTimer) clearTimeout(refreshTimer);
    offBus();
    for (const client of sseClients) client.end();
    sseClients.clear();
    void stateWatcher.close().catch(() => {});
    void refsWatcher.close().catch(() => {});
  };
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    teardown();
    return originalClose(callback);
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
