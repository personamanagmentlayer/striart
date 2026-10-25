import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { hostAllowed, parseAllowedHosts } from './control/hosts.ts';
import { logger } from './logger.js';
import { StriartError } from './errors.js';
import { detectLocale, loadMessages } from './cli/i18n/index.ts';
import {
  SessionStore,
  SignInVerifier,
  generateInstanceHostname,
  generateToken,
  mintSignInCode,
  parseCookies,
  removeTokenFile,
  sessionCookie,
  sessionCookieName,
  writeTokenFile,
} from './control/auth.ts';
import { MAX_MESSAGE_BYTES } from './control/framing.ts';
import { assertHumanPlane } from './control/guard.ts';
import { ControlHub } from './control/hub.ts';
import { afterWrite, errorResponse, handleMessage, parseError } from './control/rpc.ts';
import { collectControlState, HISTORY_LIMIT } from './control/state.ts';

/**
 * Dashboard local = client navigateur du Striart Control Protocol v1,
 * transport HTTP loopback.
 *
 * Surface HTTP (et RIEN d'autre) :
 *  - GET  /auth?code=…  lien de connexion à usage unique → cookie de session ;
 *  - GET  /             la page (exige la session) ;
 *  - POST /rpc          JSON-RPC 2.0 du protocole (session + Origin + X-Striart) ;
 *  - GET  /events       Server-Sent Events : `state.changed`, `control.notice`.
 * Les routes historiques /api/* répondent 410 (rupture assumée de la 0.11).
 *
 * Barrières, dans l'ordre, sur TOUTE requête (lectures comprises) :
 *  1. Host local (anti-DNS-rebinding), ou listé dans `dashboardAllowedHosts`
 *     (relâchement explicite, journalisé, affiché par doctor — il ne touche
 *     QUE ce contrôle) — 403 ;
 *  2. Sec-Fetch-Site ni cross-site ni same-site (un autre port local est
 *     « same-site » : SameSite=Strict ne l'arrête pas) — 403 ;
 *  3. session valide (cookie HttpOnly obtenu par le lien) — 401, sans
 *     aucune donnée du dépôt dans la réponse ;
 *  4. sur /rpc : Origin = ce serveur, X-Striart: 1, Content-Type JSON — 403.
 */

/** Intervalle du battement de cœur SSE (commentaire, maintient le socket). */
const SSE_HEARTBEAT_MS = 25_000;

/** Ré-export historique (tests, consommateurs) : l'état vit dans control/state.ts. */
export const collectDashboardState = collectControlState;

const VERSION = /** @type {{version: string}} */ (createRequire(import.meta.url)('../package.json'))
  .version;

/** Classes de largeur de la heatmap (pas de 5 %) : aucune règle de style en ligne (CSP). */
const HEAT_CLASSES = Array.from({ length: 20 }, (_, i) => `.w${i + 1}{width:${(i + 1) * 5}%}`).join(
  ' ',
);

const STYLE = `
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Consolas, monospace; background: #0d1117; color: #c9d1d9; margin: 2rem; }
  h1 { font-size: 1.3rem; } h1 .sub { font-size: .8rem; } h2 { font-size: 1rem; margin-top: 2rem; color: #58a6ff; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .35rem .75rem; border-bottom: 1px solid #21262d; font-size: .85rem; }
  th { color: #8b949e; font-weight: normal; }
  .badge { padding: .1rem .5rem; border-radius: 1rem; font-size: .75rem; }
  .RUNNING, .ACTIVE, .ok { background: #1f6feb33; color: #58a6ff; }
  .WAITING, .REMOVING, .warn { background: #d2992233; color: #d29922; }
  tr.lvl-warn td:first-child { color: #d29922; } tr.lvl-fail td:first-child { color: #f85149; font-weight: 600; }
  .MISSING, .BROKEN, .CORRUPT, .ko { background: #da363333; color: #f85149; }
  .manual { background: #da363333; color: #f85149; padding: .5rem 1rem; border-radius: .5rem; margin-top: 1rem; display: inline-block; }
  pre { background: #161b22; padding: .75rem; border-radius: .5rem; overflow-x: auto; max-height: 14rem; font-size: .75rem; }
  .muted { color: #8b949e; } .empty { color: #8b949e; font-style: italic; }
  .detail { border: 1px solid #21262d; border-radius: .5rem; padding: 1rem 1.5rem; margin-top: 1.5rem; }
  .heat-row { display: grid; grid-template-columns: minmax(12rem, max-content) 1fr max-content; gap: 1rem; align-items: center; margin: .25rem 0; font-size: .85rem; }
  .heat-bar { display: inline-block; height: .8rem; background: linear-gradient(90deg, #1f6feb, #f85149); border-radius: .25rem; }
  ${HEAT_CLASSES}
  .versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: .75rem; }
  .version pre { max-height: 22rem; }
  h3 { font-size: .9rem; color: #8b949e; margin: 1.25rem 0 .25rem; }
  code { background: #161b22; padding: .1rem .35rem; border-radius: .25rem; }
  a { color: #58a6ff; }
  button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: .35rem; padding: .25rem .7rem; font: inherit; font-size: .8rem; cursor: pointer; }
  button:hover { background: #30363d; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
  button.danger { color: #f85149; border-color: #f8514966; }
  #toolbar, #toolbar2 { margin: .75rem 0 0; display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  #toolbar2 { margin-top: .5rem; }
  #toolbar input, #toolbar select { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: .35rem; padding: .25rem .6rem; font: inherit; font-size: .85rem; }
  #toast { min-height: 1.2rem; font-size: .85rem; color: #d29922; margin: .25rem 0; }
  .warn { border: 1px solid #d2992255; background: #d2992211; border-radius: .5rem; padding: .5rem .9rem; font-size: .85rem; color: #d29922; margin: .5rem 0; }
  .auto { color: #a371f7; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .field { margin: .5rem 0; } .field label { margin-right: .5rem; }
  .field input, .field select { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: .35rem; padding: .25rem .6rem; font: inherit; font-size: .85rem; }
  fieldset.field { border: 1px solid #30363d; border-radius: .35rem; }
  .elic-error, .review-error { color: #f85149; min-height: 1rem; }
  .field textarea { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: .35rem; padding: .35rem .6rem; font: inherit; font-size: .85rem; width: min(100%, 48rem); }
  textarea:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
  .badge.interrompu, .badge.interrupted { background: #da363333; color: #f85149; }
  .untrusted pre { border-left: 3px solid #d29922; }
  #topbar { position: fixed; top: 1rem; right: 2rem; color: #8b949e; font-size: .75rem; background: #0d1117cc; padding: .15rem .5rem; border-radius: .35rem; }
  button.armed { background: #d2992233; border-color: #d29922; color: #d29922; }
  #agents, #queue, #tickets, #history { overflow-x: auto; }
  @media (max-width: 900px) {
    body { margin: 1rem; }
    #topbar { position: static; margin-bottom: .5rem; }
    #toolbar input { flex: 1; min-width: 12rem; }
  }
`;

const SCRIPT = `
const esc = (s) => String(s ?? '—').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function table(rows, cols) {
  if (!rows.length) return '<div class="empty">aucun</div>';
  const head = cols.map((c) => '<th scope="col">' + esc(c.label) + '</th>').join('');
  const body = rows.map((r) => '<tr>' + cols.map((c) => '<td>' + c.render(r) + '</td>').join('') + '</tr>').join('');
  return '<table><tr>' + head + '</tr>' + body + '</table>';
}
const badge = (v) => '<span class="badge ' + esc(v) + '">' + esc(v) + '</span>';
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return (bytes || 0) + ' o';
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes; let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return value.toFixed(1) + ' ' + units[unit];
}
// Re-render ciblé : une section dont le HTML n'a pas changé n'est pas
// retouchée — pas de sélection perdue, pas de reflow.
const lastHtml = {};
function setSection(id, html) {
  if (lastHtml[id] === html) return;
  lastHtml[id] = html;
  document.getElementById(id).innerHTML = html;
}
function setLive(ok) {
  document.getElementById('live').textContent = ok ? '🟢 direct' : '🔴 reconnexion…';
}

// ── Striart Control Protocol v1 (JSON-RPC 2.0 sur POST /rpc) ─────────────
let rpcId = 0;
let signedOut = false;
function showSignedOut() {
  if (signedOut) return;
  signedOut = true;
  stopPolling();
  events.close();
  setLive(false);
  document.getElementById('auth').innerHTML = '<div class="manual" role="alert">🔑 Session absente ou expirée — '
    + 'lance <code>striart dashboard --link</code> dans un terminal et ouvre le nouveau lien.</div>';
}
async function rpc(method, params) {
  if (signedOut) throw new Error('session expirée');
  const r = await fetch('/rpc', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params || {} }),
  });
  if (r.status === 401) { showSignedOut(); throw new Error('session expirée'); }
  const msg = await r.json();
  if (msg.error) {
    const doc = (msg.error.data && msg.error.data.error) || {};
    const e = new Error(doc.message || msg.error.message);
    e.code = doc.code || null;
    e.hint = doc.hint || null;
    e.details = doc.details || null;
    throw e;
  }
  return msg.result;
}

// Une révision plus ancienne que celle déjà rendue (réponse de sondage
// lente, trame retardée) n'écrase jamais l'affichage.
let rendered = { instance: null, revision: 0 };
function render(s) {
  if (s.instanceId === rendered.instance && s.revision <= rendered.revision) return;
  rendered = { instance: s.instanceId, revision: s.revision };
  document.getElementById('meta').textContent =
    s.config.targetBranch + ' · ' + s.config.testCommand + ' · maj ' + new Date(s.generatedAt).toLocaleTimeString();
  setSection('main-session', !s.mainSession ? '' : '<div class="manual">'
    + (s.mainSession.alive ? '🔒 Repo principal occupé par « ' + esc(s.mainSession.reason) + ' » (pid ' + esc(s.mainSession.pid) + ') — '
      + 'merge/sync/promote/resolve --apply refusent tant que ce process vit '
      + '<button data-act="mainSession.release" data-confirm="Libérer le repo principal MAINTENANT, même si le process tourne encore ?">🔓 Libérer</button>'
      : '⚠️ Session principale déclarée mais PID ' + esc(s.mainSession.pid) + ' mort — se libère à la prochaine opération')
    + '</div>');
  setSection('manual', s.state.manualMode
    ? '<div class="manual">🔒 Mode manuel actif — fusion sémantique désactivée '
      + '<button data-act="semantic.unlock" data-confirm="Réactiver la fusion sémantique (compteur d\\'échecs remis à zéro) ?">🔓 Déverrouiller</button></div>'
    : (s.state.semanticFailureStreak > 0
      ? '<div class="muted">⚠️ ' + s.state.semanticFailureStreak + ' échec(s) sémantique(s) consécutif(s)</div>' : ''));
  // Le remplacement d'innerHTML d'un <select> ramène la sélection à la
  // première option : on restaure le choix de l'utilisateur tant que le
  // profil existe encore — sinon une session autonome partirait sous le
  // mauvais outil après un simple push.
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
    '<div class="warn" role="status">🖐️ ' + s.permissions.length + ' demande(s) de permission en attente d\\'arbitrage :</div>'
    + table(s.permissions, [
      { label: 'Agent', render: (p) => esc(p.agent) },
      { label: 'Action demandée', render: (p) => esc(p.title) },
      { label: 'Expire', render: (p) => esc(new Date(p.expiresAt).toLocaleTimeString()) },
      { label: 'Décision', render: (p) => p.options.map((o) =>
          '<button data-act="permission.answer" data-perm="' + esc(p.id) + '" data-option="' + esc(o.optionId) + '"'
          + ((o.kind || '').startsWith('reject') ? ' class="danger"' : '') + '>'
          + esc(o.name || o.kind || o.optionId) + '</button>').join(' ') },
    ]));
  syncElicitations(s.elicitations ?? []);
  syncReviews(s.reviews ?? []);
  renderOrchestration(s.orchestration, s.reviews ?? []);
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
        + (a.acpHost && a.acpHost.running
          ? ' <span class="muted">· hôte ACP ' + (a.acpHost.listening ? 'à l\\'écoute' : 'en démarrage') + ' (PID ' + esc(a.acpHost.pid) + ')</span>'
          : '')
      : '<span class="muted">👤 supervisé</span>' },
    { label: 'Session', render: (a) => !a.session || a.session.state === 'idle'
      ? '<span class="muted">—</span>'
      : a.session.state === 'running'
        ? 'en cours (PID ' + esc(a.session.pid) + (a.session.via === 'pty' ? ', terminal ouvert)' : ', autonome)')
        : '<span class="muted">activité récente</span>' },
    { label: 'Branche', render: (a) => esc(a.currentBranch ?? a.branch) },
    { label: 'Outil', render: (a) => esc(a.command) },
    { label: 'Taille', render: (a) => esc(a.sizeHuman) },
    { label: 'En attente', render: (a) => esc(a.pendingCommits) },
    { label: 'Dernier commit', render: (a) => esc(a.lastMessage) },
    { label: 'Actions', render: (a) => a.status === 'REMOVING'
      ? '<span class="muted">suppression du clone en cours</span>'
      : '<button data-act="agent.merge" data-agent="' + esc(a.name) + '"'
      + ' data-confirm="Merger le dernier commit de ' + esc(a.name) + ' (Test Gate inclus) ?">Merger</button> '
      + '<button data-act="agent.sync" data-agent="' + esc(a.name) + '"'
      + ' data-confirm="Rebaser ' + esc(a.name) + ' sur la branche cible ?">Sync</button> '
      + '<button data-act="agent.stop" data-agent="' + esc(a.name) + '" class="danger"'
      + ' data-confirm="Arrêter ' + esc(a.name) + ' ? (refusé s\\'il reste des commits non mergés)">Stop</button> '
      + '<button data-act="agent.stop" data-agent="' + esc(a.name) + '" data-force="1" class="danger"'
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
        const step = Math.max(1, Math.min(20, Math.round((h.score / maxScore) * 20)));
        const who = [
          h.agents.length ? '🔒 ' + h.agents.join(', ') : '',
          h.queued.length ? '⏳ ' + h.queued.join(', ') : '',
          h.conflicts ? '⛔ ' + h.conflicts + ' conflit(s)' : '',
        ].filter(Boolean).join(' · ');
        return '<div class="heat-row"><span class="heat-file">' + esc(h.file) + '</span>'
          + '<span class="heat-bar w' + step + '" title="score ' + esc(h.score) + '" role="img" aria-label="score ' + esc(h.score) + '"></span>'
          + '<span class="muted">' + esc(who) + '</span></div>';
      }).join(''));
  setSection('tickets', table(s.tickets, [
    { label: 'Ticket', render: (t) => esc(t.id) },
    { label: 'Raison', render: (t) => t.status === 'CORRUPT'
      ? badge('CORRUPT') + ' <span class="muted">' + esc(t.cause) + '</span>'
      : badge(t.reason) },
    { label: 'Agent', render: (t) => t.agent == null ? '<span class="muted">—</span>' : esc(t.agent) },
    { label: 'Fichiers', render: (t) => esc(t.conflictedFiles.join(', ')) },
    { label: 'Créé', render: (t) => esc(new Date(t.createdAt).toLocaleString()) },
    { label: '', render: (t) => t.status === 'CORRUPT'
      ? '<span class="muted">illisible : ne peut qu\\'être fermé</span> <button data-act="ticket.close" data-ticket="' + esc(t.id) + '" class="danger"'
        + ' data-confirm="Fermer le ticket illisible ' + esc(t.id) + ' (son dossier est conservé pour l\\'audit) ?">✓ Fermer</button>'
      : '<a href="#" class="open-ticket" data-id="' + esc(t.id) + '">détail ▸</a>' },
  ]));
  for (const link of document.querySelectorAll('.open-ticket')) {
    if (link.dataset.bound) continue;
    link.dataset.bound = '1';
    link.addEventListener('click', (e) => { e.preventDefault(); showTicket(link.dataset.id); });
  }
  bindActions();
}
// Repli sans flux : un appel ponctuel (premier rendu, reprise après coupure).
async function refresh() {
  try {
    render((await rpc('state.get')).data);
  } catch (e) {
    if (!signedOut) document.getElementById('meta').textContent = 'connexion perdue…';
  }
}

// Synthèse lisible d'un résultat (le document du protocole porte les données
// brutes, identiques à celles de la CLI en --json).
function summarizeSync(results) {
  const of = (...st) => results.filter((r) => st.includes(r.status));
  const deferred = of('SKIPPED_DIRTY', 'SKIPPED_SESSION');
  const conflicts = of('REBASE_CONFLICT', 'STASH_CONFLICT');
  const parts = [of('REBASED').length + ' rebasé(s)', of('UP_TO_DATE').length + ' à jour'];
  if (deferred.length > 0) parts.push(deferred.length + ' reporté(s)');
  if (conflicts.length > 0) parts.push('⚠️ ' + conflicts.length + ' en conflit (' + conflicts.map((r) => r.agent).join(', ') + ') — résolution manuelle requise dans le clone');
  return parts.join(', ');
}
function summarize(method, d) {
  switch (method) {
    case 'task.run': return d.mode === 'autonomous' ? 'session autonome lancée (profil ' + d.profile + ')' : d.run.status;
    case 'agent.sync': return summarizeSync(d.results);
    case 'agent.stop': return 'arrêté';
    case 'clones.clean': return d.removed.length + ' clone(s) supprimé(s) (' + formatBytes(d.removed.reduce((n, r) => n + r.freedBytes, 0)) + '), ' + d.skipped.length + ' conservé(s)';
    case 'workspace.prune': return d.clones.removed.length + ' clone(s) et ' + d.tickets.removed.length + ' ticket(s) élagués — ' + formatBytes(d.freedBytes);
    case 'reconcile.run': return d.sessionPidsCleared.length + ' session(s) neutralisée(s), ' + d.started.length + ' tâche(s) relancée(s), ' + d.stillWaiting.length + ' en attente';
    case 'queue.retry': return d.started.length + ' tâche(s) relancée(s), ' + d.stillWaiting.length + ' en attente';
    case 'ticket.prepare': return d.files.filter((f) => f.created).length + ' fichier(s) amorcé(s) — édite-les puis « Appliquer »';
    case 'ticket.apply': return d.result.status;
    case 'ticket.close': return 'ticket clos';
    case 'permission.answer': return 'décision transmise à la session de ' + d.agent;
    case 'mainSession.release': return 'repo principal libéré';
    case 'semantic.unlock': return 'fusion sémantique réactivée';
    default: return d && d.status ? d.status : 'fait';
  }
}
let busy = false;
// Renvoie true UNIQUEMENT si l'action a été envoyée ET a abouti nominalement :
// les appelants qui détruisent un état local (vider le champ de prompt) ne
// doivent le faire que sur ce true — jamais sur un refus, une erreur, ou une
// requête sautée par le garde busy.
async function runAction(method, params) {
  if (busy) { toast('⏳ Une action est déjà en cours — réessaie dans un instant.', true); return false; }
  busy = true;
  toast('⏳ ' + method + ' en cours…');
  let ok = false;
  try {
    const doc = await rpc(method, params);
    ok = doc.ok;
    const warnings = (doc.warnings || []).map((w) => ' ⚠️ ' + w.message).join('');
    toast((doc.ok ? '✅ ' : '⛔ ') + method + ' → ' + summarize(method, doc.data) + warnings, true);
  } catch (e) {
    toast('⛔ ' + method + ' : ' + e.message + (e.code ? ' [' + e.code + ']' : '') + (e.hint ? ' — ' + e.hint : ''), true);
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
  clearTimeout(toastTimer);
  if (sticky) toastTimer = setTimeout(() => { el.textContent = ''; }, 8000);
}
// Confirmation inline en deux temps, sans modale : le premier clic arme le
// bouton, le second exécute, 4 s sans suite désarme. Pas de window.confirm :
// une modale bloque la page entière — y compris les mises à jour du flux.
function bindActions() {
  for (const btn of document.querySelectorAll('button[data-act]')) {
    if (btn.dataset.bound) continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
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
      const params = {};
      if (btn.dataset.agent) params.agent = btn.dataset.agent;
      if (btn.dataset.ticket) params.id = btn.dataset.ticket;
      if (btn.dataset.perm) { params.id = btn.dataset.perm; params.option = btn.dataset.option; }
      if (btn.dataset.force === '1') params.force = true;
      const ok = await runAction(btn.dataset.act, params);
      // Le détail d'un ticket n'est pas dans l'état poussé (lu à la demande) :
      // on le relit après une action qui le concerne.
      if (ok && btn.dataset.ticket) showTicket(btn.dataset.ticket);
    });
  }
}
// ── Questions structurées des agents (elicitations ACP) ─────────────────
// Le message, l'URL et le schéma viennent de l'AGENT : contenu non fiable,
// toujours échappé, jamais interprété ; une URL est affichée, jamais ouverte.
// Une carte par demande, créée une fois : un push d'état ne réécrit jamais
// un formulaire en cours de saisie.
const ELIC_INPUT_TYPES = { email: 'email', uri: 'url', date: 'date' };
const elicCards = {};
function enumOptions(p) {
  if (!p) return null;
  if (Array.isArray(p.enum)) return p.enum.map((v, i) => ({ value: v, label: (Array.isArray(p.enumNames) && p.enumNames[i]) || String(v) }));
  if (Array.isArray(p.oneOf)) return p.oneOf.map((o) => ({ value: o.const, label: o.title || String(o.const) }));
  if (Array.isArray(p.anyOf)) return p.anyOf.map((o) => ({ value: o.const, label: o.title || String(o.const) }));
  return null;
}
function elicField(eid, index, name, p, required) {
  const id = 'f-' + eid + '-' + index;
  const helpId = id + '-h';
  const help = p.description ? '<div class="muted" id="' + helpId + '">' + esc(p.description) + '</div>' : '';
  const described = p.description ? ' aria-describedby="' + helpId + '"' : '';
  const label = esc(p.title || name) + (required ? ' <span aria-hidden="true">*</span><span class="sr"> (requis)</span>' : '');
  const req = required ? ' required' : '';
  const data = ' data-field="' + index + '"';
  if (p.type === 'boolean') {
    return '<div class="field"><input type="checkbox" id="' + id + '"' + data + described + (p.default === true ? ' checked' : '') + '>'
      + ' <label for="' + id + '">' + label + '</label>' + help + '</div>';
  }
  if (p.type === 'array') {
    const opts = enumOptions(p.items) || [];
    return '<fieldset class="field"' + described + '><legend>' + label + '</legend>'
      + opts.map((o, j) => '<label><input type="checkbox"' + data + ' data-multi="' + j + '"> ' + esc(o.label) + '</label>').join(' ')
      + help + '</fieldset>';
  }
  const opts = enumOptions(p);
  if (opts) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><select id="' + id + '"' + data + req + described + '>'
      + (required ? '' : '<option value="">—</option>')
      + opts.map((o, j) => '<option value="' + j + '">' + esc(o.label) + '</option>').join('') + '</select>' + help + '</div>';
  }
  const numeric = p.type === 'number' || p.type === 'integer';
  const bounds = numeric
    ? (p.minimum != null ? ' min="' + esc(p.minimum) + '"' : '') + (p.maximum != null ? ' max="' + esc(p.maximum) + '"' : '')
      + ' step="' + (p.type === 'integer' ? '1' : 'any') + '"'
    : (p.minLength != null ? ' minlength="' + esc(p.minLength) + '"' : '') + (p.maxLength != null ? ' maxlength="' + esc(p.maxLength) + '"' : '');
  const type = numeric ? 'number' : (ELIC_INPUT_TYPES[p.format] || 'text');
  return '<div class="field"><label for="' + id + '">' + label + '</label><input type="' + type + '" id="' + id + '"' + data + req + described + bounds
    + (p.format === 'date-time' ? ' placeholder="AAAA-MM-JJTHH:MM:SSZ"' : '') + '>' + help + '</div>';
}
function elicProperties(r) {
  const schema = r.requestedSchema || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties || {}).map(([name, p]) => ({ name, p: p || {}, required: required.has(name) }));
}
function elicContent(card, r) {
  const content = {};
  elicProperties(r).forEach(({ name, p, required }, i) => {
    const els = card.querySelectorAll('[data-field="' + i + '"]');
    if (p.type === 'boolean') { content[name] = els[0].checked; return; }
    if (p.type === 'array') {
      const opts = enumOptions(p.items) || [];
      const picked = [...els].filter((e) => e.checked).map((e) => opts[Number(e.dataset.multi)].value);
      if (picked.length > 0 || required) content[name] = picked;
      return;
    }
    const el = els[0];
    if (!el || el.value === '') return;
    const opts = enumOptions(p);
    if (opts) { content[name] = opts[Number(el.value)].value; return; }
    content[name] = p.type === 'number' || p.type === 'integer' ? Number(el.value) : el.value;
  });
  return content;
}
function elicCardHtml(r) {
  const head = '<h3>❓ Question de l\\'agent ' + esc(r.agent) + '</h3>'
    + '<div class="untrusted"><span class="muted">Message de l\\'agent (contenu non vérifié) :</span><pre>' + esc(r.message) + '</pre></div>'
    + '<div class="muted">Expire à ' + esc(new Date(r.expiresAt).toLocaleTimeString()) + ' — sans réponse, la demande est refusée.</div>';
  const actions = '<div class="elic-error" role="alert"></div>'
    + '<button type="button" data-elic-action="decline" class="danger">Refuser</button> '
    + '<button type="button" data-elic-action="cancel">Annuler</button>';
  if (r.mode === 'url') {
    return head
      + '<div>Adresse proposée par l\\'agent — ouvre-la toi-même, seulement si tu lui fais confiance : <code>' + esc(r.url) + '</code></div>'
      + '<div><button type="button" data-elic-action="accept">✅ C\\'est fait</button> ' + actions + '</div>';
  }
  const fields = elicProperties(r).map(({ name, p, required }, i) => elicField(esc(r.id), i, name, p, required)).join('');
  return head + '<form data-elic-form>' + fields
    + '<button type="submit">✅ Envoyer</button> ' + actions + '</form>';
}
async function answerElicitation(card, r, action) {
  const err = card.querySelector('.elic-error');
  err.textContent = '';
  const params = { id: r.id, action };
  if (action === 'accept' && r.mode === 'form') {
    // Validation native (requis, bornes, formats) d'abord : messages du
    // navigateur, lisibles au lecteur d'écran ; le serveur revalide.
    const form = card.querySelector('form');
    if (!form.reportValidity()) return;
    params.content = elicContent(card, r);
  }
  try {
    await rpc('elicitation.answer', params);
    toast('✅ Réponse transmise à ' + r.agent, true);
    card.remove();
    delete elicCards[r.id];
  } catch (e) {
    const field = e.details && e.details.field ? e.details.field : null;
    err.textContent = '⛔ ' + e.message + (field ? ' (champ ' + field + ')' : '') + (e.hint ? ' — ' + e.hint : '');
    if (e.code === 'ELICITATION_CONTENT_INVALID' && field) {
      const index = elicProperties(r).findIndex((f) => f.name === field);
      const target = index === -1 ? null : card.querySelector('[data-field="' + index + '"]');
      if (target) target.focus();
    }
  }
}
function syncElicitations(list) {
  const host = document.getElementById('elicitations');
  const ids = new Set(list.map((r) => r.id));
  for (const id of Object.keys(elicCards)) {
    if (!ids.has(id)) { elicCards[id].remove(); delete elicCards[id]; }
  }
  for (const r of list) {
    if (elicCards[r.id]) continue;
    const card = document.createElement('section');
    card.className = 'detail';
    card.setAttribute('aria-label', 'Question de l\\'agent ' + r.agent);
    card.innerHTML = elicCardHtml(r);
    host.appendChild(card);
    elicCards[r.id] = card;
    const form = card.querySelector('form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); answerElicitation(card, r, 'accept'); });
    for (const btn of card.querySelectorAll('button[data-elic-action]')) {
      btn.addEventListener('click', () => answerElicitation(card, r, btn.dataset.elicAction));
    }
  }
}
// ── Revues humaines (mode review, lot O) ─────────────────────────────────
// Le diffstat (sortie git), le résumé et les remarques du verdict viennent
// d'AGENTS ou de noms de fichiers arbitraires : contenu non fiable, toujours
// échappé (esc) ou posé via textContent, jamais interprété. Une carte par
// demande EN ATTENTE dont l'orchestrateur vit encore, créée une fois : un push
// d'état ne réécrit jamais un commentaire en cours de saisie.
const reviewCards = {};
const REVIEW_CHOICES = [
  { verdict: 'approve', label: '✅ Approuver', needsComment: false },
  { verdict: 'request-changes', label: '✏️ Demander des changements', needsComment: true },
  { verdict: 'reject', label: '⛔ Rejeter', needsComment: true, danger: true },
];
function reviewCardHtml(r) {
  const cid = 'rv-' + esc(r.id);
  return '<h3 id="' + cid + '-t">👀 Revue humaine demandée — agent ' + esc(r.agent) + ' (tour ' + esc(r.round) + ')</h3>'
    + '<div class="muted">Relecteur ' + esc(r.reviewer) + ' · branche ' + esc(r.branch) + ' · commit ' + esc((r.sha || '').slice(0, 8))
    + ' · expire à ' + esc(new Date(r.expiresAt).toLocaleTimeString()) + ' — sans réponse, la demande est refusée.</div>'
    + '<div class="untrusted"><span class="muted">Résumé des changements (sortie git, contenu non vérifié) :</span><pre>' + esc(r.diffstat) + '</pre></div>'
    + '<form data-review-form aria-labelledby="' + cid + '-t">'
    + '<div class="field"><label for="' + cid + '-c">Commentaire</label> '
    + '<textarea id="' + cid + '-c" rows="3" maxlength="16000" aria-describedby="' + cid + '-h"></textarea>'
    + '<div class="muted" id="' + cid + '-h">Obligatoire pour demander des changements ou rejeter ; transmis tel quel à l’agent.</div></div>'
    + '<div class="review-error" role="alert"></div>'
    + REVIEW_CHOICES.map((c) => '<button type="submit" data-verdict="' + c.verdict + '"' + (c.danger ? ' class="danger"' : '') + '>' + c.label + '</button>').join(' ')
    + '</form>';
}
async function answerReview(card, r, choice) {
  const err = card.querySelector('.review-error');
  const area = card.querySelector('textarea');
  err.textContent = '';
  const summary = area.value.trim();
  if (choice.needsComment && summary === '') {
    err.textContent = '⛔ Un commentaire est requis pour ce verdict.';
    area.focus();
    return;
  }
  const params = { id: r.id, verdict: choice.verdict };
  if (summary !== '') params.summary = summary;
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  try {
    await rpc('review.answer', params);
    toast('✅ Verdict « ' + choice.verdict + ' » transmis pour ' + r.agent, true);
    card.remove();
    delete reviewCards[r.id];
  } catch (e) {
    for (const b of card.querySelectorAll('button')) b.disabled = false;
    err.textContent = '⛔ ' + e.message + (e.code ? ' [' + e.code + ']' : '') + (e.hint ? ' — ' + e.hint : '');
  }
}
function syncReviews(list) {
  const host = document.getElementById('reviews');
  const pending = list.filter((r) => r.status === 'PENDING' && r.alive);
  const ids = new Set(pending.map((r) => r.id));
  for (const id of Object.keys(reviewCards)) {
    if (!ids.has(id)) { reviewCards[id].remove(); delete reviewCards[id]; }
  }
  for (const r of pending) {
    if (reviewCards[r.id]) continue;
    const card = document.createElement('section');
    card.className = 'detail';
    card.innerHTML = reviewCardHtml(r);
    host.appendChild(card);
    reviewCards[r.id] = card;
    let clicked = null;
    for (const btn of card.querySelectorAll('button[data-verdict]')) {
      btn.addEventListener('click', () => { clicked = REVIEW_CHOICES.find((c) => c.verdict === btn.dataset.verdict); });
    }
    card.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (clicked) answerReview(card, r, clicked);
    });
  }
}
function renderOrchestration(o, reviews) {
  const runs = (o && o.runs) || [];
  const groups = (o && o.groups) || [];
  const stale = reviews.filter((r) => r.status === 'PENDING' && !r.alive).length;
  setSection('orchestration', runs.length === 0 && groups.length === 0 && stale === 0 ? '<div class="empty">aucune orchestration</div>'
    : (stale > 0 ? '<div class="warn" role="status">⚠️ ' + stale + ' demande(s) de revue abandonnée(s) : le process qui l’attendait n’existe plus.</div>' : '')
    + (runs.length === 0 ? '' : '<h3>Plans appliqués</h3>' + table(runs, [
      { label: 'Plan', render: (r) => esc(r.id) },
      { label: 'Statut', render: (r) => badge(r.status === 'running' && !r.alive ? 'interrompu' : r.status) },
      { label: 'Mode', render: (r) => esc(r.mode) },
      { label: 'Nœuds', render: (r) => esc(r.nodes.filter((n) => n.state === 'done').length + '/' + r.nodes.length) },
      { label: 'Depuis', render: (r) => esc(new Date(r.startedAt).toLocaleString()) },
    ]))
    + (groups.length === 0 ? '' : '<h3>Groupes de collaboration</h3>' + table(groups, [
      { label: 'Groupe', render: (g) => esc(g.id) },
      { label: 'Mode', render: (g) => esc(g.kind) },
      { label: 'Statut', render: (g) => badge(g.status === 'running' && !g.alive ? 'interrompu' : g.status) },
      { label: 'Tour', render: (g) => esc(g.round) },
      { label: 'Agents', render: (g) => esc(g.agents.join(', ')) },
      { label: 'Résultat', render: (g) => esc(g.result) },
    ])));
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
  let d;
  try {
    d = (await rpc('session.log', { agent })).data;
  } catch (e) {
    el.innerHTML = '<div class="detail"><div class="empty">Aucun log de session pour ' + esc(agent)
      + ' — ' + esc(e.message) + '</div></div>';
    return;
  }
  el.innerHTML = '<div class="detail"><h3>Session autonome — ' + esc(agent) + '</h3>'
    + '<div class="muted">' + esc(d.path) + '</div>'
    + '<pre>' + esc(d.log || '(log vide)') + '</pre></div>';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function showTicket(id) {
  const el = document.getElementById('ticket-detail');
  let t;
  try {
    t = (await rpc('ticket.get', { id })).data;
  } catch (e) {
    el.innerHTML = '<div class="empty">ticket introuvable — ' + esc(e.message) + '</div>';
    return;
  }
  const unmergeable = (t.unmergeable ?? []).map((u) =>
    '<li>' + esc(u.path) + ' — <b>' + esc(u.kind) + '</b>' + (u.deletedBy ? ' (supprimé côté ' + (u.deletedBy === 'ours' ? 'main' : 'agent') + ')' : '') + '</li>').join('');
  const kindLabel = { content: '📝 préparé', delete: '🗑️ suppression', missing: '⛔ manquant' };
  const resolutionStatus = t.resolved ? '' : (t.resolutionInputs ?? []).map((r) =>
    '<li>' + esc(r.path) + ' — ' + (kindLabel[r.kind] || esc(r.kind)) + '</li>').join('');
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
    + (t.resolved ? '' : ' <button data-act="ticket.prepare" data-ticket="' + esc(t.id) + '"'
      + ' data-confirm="Amorcer .resolved depuis la version de l\\'agent pour ' + esc(t.id) + ' ?">🧪 Préparer</button>'
      + ' <button data-act="ticket.apply" data-ticket="' + esc(t.id) + '"'
      + ' data-confirm="Rejouer le merge de ' + esc(t.id) + ' avec les résolutions préparées, sous le Test Gate ?">✅ Appliquer</button>'
      + ' <button data-act="ticket.close" data-ticket="' + esc(t.id) + '"'
      + ' data-confirm="Marquer le ticket ' + esc(t.id) + ' comme résolu (sans repasser par le Test Gate) ?">✓ Clore à la main</button>')
    + '</div>'
    + (resolutionStatus ? '<h3>Résolution</h3><ul>' + resolutionStatus + '</ul>' : '')
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
    const d = (await rpc('doctor.run')).data;
    // Le niveau est porté par un MOT (lisible au lecteur d'écran, en
    // contraste élevé, sans émoji) ; le bilan tient compte des avertissements.
    const LEVELS = { ok: 'ok', warn: 'attention', fail: 'erreur', skip: 'ignoré' };
    const s = d.summary || { fail: d.healthy ? 0 : 1, warn: 0 };
    const verdict = s.fail > 0
      ? '<span class="badge ko">prérequis manquants (' + s.fail + ')</span>'
      : s.warn > 0
        ? '<span class="badge warn">utilisable, ' + s.warn + ' point(s) d’attention</span>'
        : '<span class="badge ok">opérationnel</span>';
    el.innerHTML = '<div class="detail"><h3>🩺 Doctor — ' + verdict + '</h3>'
      + '<table><thead><tr><th scope="col">Niveau</th><th scope="col">Contrôle</th><th scope="col">Constat</th><th scope="col">Action</th></tr></thead><tbody>'
      + d.checks.map((c) =>
        '<tr class="lvl-' + esc(c.level) + '"><td>' + esc(LEVELS[c.level] || c.level) + '</td><td>' + esc(c.label) + '</td><td class="muted">' + esc(c.detail) + '</td><td>' + (c.hint ? '<code>' + esc(c.hint) + '</code>' : '') + '</td></tr>'
      ).join('') + '</tbody></table></div>';
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
  const params = { prompt };
  const agent = document.getElementById('task-agent').value.trim();
  if (agent) params.agent = agent;
  if (document.getElementById('task-mode').value === 'autonomous') {
    params.mode = 'autonomous';
    params.profile = document.getElementById('task-profile').value || null;
  }
  runAction('task.run', params).then((ok) => { if (ok) input.value = ''; });
});
document.getElementById('task-prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('task-start').click();
});

// ── Temps réel ───────────────────────────────────────────────────────────
// SSE : le serveur pousse l'état à chaque changement (state.changed, avec
// numéro de séquence et révision). Un client trop lent est déconnecté par le
// serveur : EventSource se reconnecte seul (retry: 3000) et reçoit l'état
// complet ; un sondage de secours à 5 s couvre l'intervalle.
let pollTimer = null;
function startPolling() {
  if (!pollTimer && !signedOut) pollTimer = setInterval(refresh, 5000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
const events = new EventSource('/events');
events.addEventListener('state.changed', (e) => {
  setLive(true);
  stopPolling();
  render(JSON.parse(e.data).params.state);
});
events.addEventListener('control.notice', (e) => {
  toast(JSON.parse(e.data).params.message, true);
});
events.onerror = () => {
  setLive(false);
  startPolling();
};
refresh(); // premier rendu immédiat, sans attendre le flux
`;

// Exportée pour le test de cohérence du client (compilation du script +
// correspondance des ids et des méthodes) : le JS navigateur vit dans cette
// template string, hors de portée d'ESLint et de tsc.
export const PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Striart — Dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<h1>⚡ Striart <span class="muted sub">— pilotage local</span></h1>
<div id="topbar"><span id="live" role="status">⏳</span> · <span id="meta"></span></div>
<div id="auth"></div>
<div id="toolbar">
  <input id="task-prompt" type="text" placeholder="Nouvelle tâche — ex : Corrige le bug du panier" size="40" aria-label="Prompt de la nouvelle tâche">
  <input id="task-agent" type="text" placeholder="agent (optionnel)" size="14" aria-label="Nom de l'agent (optionnel)">
  <select id="task-mode" title="Mode d'exécution" aria-label="Mode d'exécution">
    <option value="attended">👤 supervisé</option>
    <option value="autonomous">🤖 autonome</option>
  </select>
  <select id="task-profile" hidden title="Profil d'agent (mode autonome)" aria-label="Profil d'agent"></select>
  <button id="task-start">🚀 Lancer (Router)</button>
</div>
<div id="toolbar2">
  <button data-act="queue.retry" data-confirm="Relancer les tâches débloquées de la file d'attente ?">🔄 Relancer la file</button>
  <button data-act="agent.sync" data-confirm="Rebaser tous les agents sur la branche cible ?">🔁 Sync agents</button>
  <button data-act="reconcile.run" data-confirm="Neutraliser les sessions mortes et débloquer la file ?">🩹 Réconcilier</button>
  <button data-act="staging.promote" data-confirm="Promouvoir staging → main (Test Gate global) ?">🚦 Promote</button>
  <button data-act="clones.clean" data-confirm="Supprimer les clones des agents arrêtés ?">🧹 Clean</button>
  <button data-act="workspace.prune" data-confirm="Élaguer les clones inactifs et les tickets résolus (rétention config) ?">🗑️ Prune</button>
  <button id="doctor-btn">🩺 Doctor</button>
  <button data-act="merge.rollback" data-confirm="Défaire le DERNIER merge Striart de la branche cible ?" class="danger">↩️ Rollback dernier merge</button>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<div id="doctor-detail"></div>
<div id="watcher"></div>
<div id="main-session"></div>
<div id="manual"></div>
<div id="permissions"></div>
<div id="elicitations" aria-live="polite"></div>
<div id="reviews" aria-live="polite"></div>
<h2>Agents actifs</h2><div id="agents" class="empty">chargement…</div>
<div id="session-log"></div>
<h2>File d'attente</h2><div id="queue" class="empty">chargement…</div>
<h2>Heatmap — fichiers disputés</h2><div id="heatmap" class="empty">chargement…</div>
<h2>Conflits en attente de résolution humaine</h2><div id="tickets" class="empty">chargement…</div>
<div id="ticket-detail"></div>
<h2>Orchestration</h2><div id="orchestration" class="empty">chargement…</div>
<h2>Historique (${HISTORY_LIMIT} derniers merges)</h2><div id="history" class="empty">chargement…</div>
<script>${SCRIPT}</script>
</body>
</html>
`;

const hashOf = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * CSP stricte : aucun script ni style en ligne hors des deux blocs de la
 * page, identifiés par empreinte — ni `unsafe-inline`, ni source externe.
 */
const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${hashOf(SCRIPT)}`,
  `style-src ${hashOf(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Page sans script (connexion requise, lien refusé) : aucune donnée du dépôt. */
function infoPage(title, lines) {
  const body = lines.map((line) => `<p>${line}</p>`).join('\n');
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>Striart — ${title}</title>
<style>${INFO_STYLE}</style></head>
<body><h1>⚡ Striart — ${title}</h1>
${body}
</body></html>
`;
}
const INFO_STYLE =
  'body{font-family:ui-monospace,Consolas,monospace;background:#0d1117;color:#c9d1d9;margin:2rem;max-width:48rem}code{background:#161b22;padding:.1rem .35rem;border-radius:.25rem}';
const INFO_CSP = `default-src 'none'; style-src ${hashOf(INFO_STYLE)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const SIGN_IN_REQUIRED = infoPage('connexion requise', [
  'Ce tableau de bord exige une connexion : ouvre le <b>lien de connexion</b> affiché par <code>striart dashboard</code>, ou obtiens-en un nouveau avec <code>striart dashboard --link</code>.',
  'This dashboard requires signing in: open the <b>sign-in link</b> printed by <code>striart dashboard</code>, or get a new one with <code>striart dashboard --link</code>.',
]);
const SIGN_IN_REFUSED = infoPage('lien refusé', [
  'Ce lien de connexion est invalide, expiré ou déjà utilisé (un lien ne sert qu’une fois). Obtiens-en un nouveau : <code>striart dashboard --link</code>.',
  'This sign-in link is invalid, expired or already used (a link works once). Get a new one: <code>striart dashboard --link</code>.',
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * L'en-tête Host désigne-t-il bien la boucle locale ? Défense contre le DNS
 * rebinding : un domaine tiers résolu vers 127.0.0.1 arrive avec son propre
 * Host. À appliquer à TOUTE requête, pas seulement aux actions.
 *
 * Redirection de port (VS Code Remote, devcontainer) : le tunnel transmet
 * `Host: localhost:<port local>` — accepté (le port n'est pas comparé :
 * il peut différer du port d'écoute). Un domaine de redirection web
 * (Codespaces `*.app.github.dev`) est refusé PAR DÉFAUT, à dessein : il
 * faut le déclarer dans `dashboardAllowedHosts` (voir control/hosts.ts).
 */
function hostOf(req) {
  const raw = req.headers.host ?? '';
  // IPv6 littéral « [::1]:3456 » : ne pas couper sur « : » naïvement.
  return raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
}
function isLocalHost(req) {
  return LOCAL_HOSTS.has(hostOf(req).toLowerCase());
}

/**
 * Sec-Fetch-Site : un navigateur moderne dit d'où vient la requête. Un
 * autre port de localhost est « same-site » — SameSite=Strict ne l'arrête
 * pas, cette barrière si. Absent (client non navigateur) : rien à refuser
 * ici, le cookie et l'Origin restent exigés.
 */
function fetchSiteAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

/**
 * Origin exacte de ce serveur, telle que le navigateur la voit (Host transmis).
 * Hôte local : `http://<Host>`. Hôte admis par `dashboardAllowedHosts`
 * (tunnel web, donc souvent https) : `http://` ou `https://` suivi du Host
 * REÇU — jamais le loopback, jamais un autre hôte de la liste.
 */
function originMatches(req, relaxedHost) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  const host = String(req.headers.host).toLowerCase();
  const lower = origin.toLowerCase();
  return lower === `http://${host}` || (relaxedHost && lower === `https://${host}`);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, contentType, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType, ...headers });
  res.end(body);
}
const sendText = (res, status, text) => send(res, status, 'text/plain; charset=utf-8', text);
const sendJson = (res, status, value) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
const sendHtml = (res, status, html, csp) =>
  send(res, status, 'text/html; charset=utf-8', html, { 'Content-Security-Policy': csp });

/** Corps borné : au-delà de MAX_MESSAGE_BYTES, la lecture s'arrête (null). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Démarre le dashboard local, lié à 127.0.0.1 uniquement. Rend le serveur
 * http, enrichi de `server.striart` :
 *  - `signInUrl({ttlMs?})` → `{url, expiresAt}` : lien de connexion à usage
 *    unique (à afficher à l'utilisateur, jamais à journaliser) ;
 *  - `baseUrl` : adresse sans secret ;
 *  - `stats()` : abonnés, collectes, déconnexions de clients lents.
 * Le jeton de l'instance est écrit dans `.striart/control/dashboard-<port>.json`
 * (utilisateur seul) pour `striart dashboard --link` ; retiré à l'arrêt.
 */
/**
 * @typedef {object} DashboardControl
 * @property {string} baseUrl
 * @property {(options?: {ttlMs?: number}) => {url: string, expiresAt: string}} signInUrl
 * @property {() => {subscribers: number, collections: number, slowDisconnects: number, revision: number, sessions: number}} stats
 */
/**
 * @param {{root: string, port?: number|null}} params
 * @returns {Promise<http.Server & {striart: DashboardControl}>}
 */
export async function startDashboard({ root, port = null }) {
  // Validations AVANT toute mise en place (watchers, timers, fichiers) :
  // un échec plus tard laissait des handles ouverts.
  assertHumanPlane(process.env, 'striart dashboard');
  const config = await loadConfig(root);
  const listenPort = port ?? config.dashboardPort;
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new StriartError(
      `Port invalide : ${JSON.stringify(listenPort)}. Attendu : un entier entre 0 et 65535.`,
      {
        code: 'INVALID_ARGUMENT',
        details: { option: 'port', value: listenPort },
        hint: 'striart dashboard --port 3456',
      },
    );
  }

  // Hôtes relâchés (dashboardAllowedHosts) : déjà validés au chargement de la
  // config ; on re-parse ici (défense en profondeur) et on refuse de démarrer
  // sur une liste que le chargeur aurait dû écarter.
  const parsedHosts = parseAllowedHosts(config.dashboardAllowedHosts ?? []);
  if (!('rules' in parsedHosts)) {
    throw new StriartError('Valeur invalide pour "dashboardAllowedHosts" dans la config Striart', {
      code: 'CONFIG_INVALID',
      hint: 'striart doctor',
      details: {
        reason: 'HOST_PATTERN',
        key: 'dashboardAllowedHosts',
        problem: parsedHosts.problem,
      },
    });
  }
  const allowedHosts = parsedHosts.rules;

  // Nom d'hôte de l'instance (S-I4). Le cookie de session est host-only : sous
  // `localhost`, un navigateur le renvoie à TOUT serveur `localhost:*` (RFC 6265
  // §8.5) — par exemple le serveur de dev, potentiellement hostile, d'un agent —
  // qui peut le rejouer vers ce dashboard. Sous `<id-aléatoire>.localhost`
  // (résolu en boucle locale par les navigateurs), il n'est jamais envoyé
  // ailleurs, et la boucle locale « nue » n'est PLUS servie.
  const instanceHostname =
    config.dashboardHostname === 'localhost' ? null : generateInstanceHostname();
  /** Le Host désigne-t-il l'adresse locale de CE dashboard ? */
  const isServedLocal = (req) =>
    instanceHostname === null ? isLocalHost(req) : hostOf(req).toLowerCase() === instanceHostname;

  const locale = detectLocale(process.env);
  const m = await loadMessages(locale);
  const token = generateToken();
  const sessions = new SessionStore({ ttlMs: config.dashboardSessionTtlMs });
  const hub = new ControlHub({
    root,
    maxBufferedBytes: config.controlSseMaxBufferedBytes,
    maxDelayMs: config.controlStateMaxDelayMs,
  });
  /** @type {SignInVerifier | null} */
  let verifier = null;
  let actualPort = 0;
  let cookieName = '';

  /** @type {import('./control/methods.ts').MethodContext} */
  const ctx = { root, hub, m, locale, version: VERSION, transport: 'http', connection: null };

  /** @type {Map<http.ServerResponse, string>} */
  const sseClients = new Map();

  const unauthenticatedRpc = () =>
    errorResponse(
      null,
      null,
      new StriartError('Dashboard session missing or expired: sign in again.', {
        code: 'CONTROL_UNAUTHENTICATED',
        hint: 'striart dashboard --link',
      }),
      ctx,
    );

  const refusedOrigin = (reason) =>
    errorResponse(
      null,
      null,
      new StriartError(
        `Request refused by the dashboard: it does not come from the dashboard page (${reason}).`,
        {
          code: 'CONTROL_ORIGIN_REFUSED',
          details: { reason },
          hint: 'Use the dashboard page itself, or striart api --stdio for a program.',
        },
      ),
      ctx,
    );

  const refusedCsrf = () =>
    errorResponse(
      null,
      null,
      new StriartError(
        'Request refused by the dashboard: X-Striart: 1 and Content-Type: application/json are required.',
        {
          code: 'CONTROL_CSRF_REFUSED',
          hint: 'Use the dashboard page itself, or striart api --stdio for a program.',
        },
      ),
      ctx,
    );

  async function serveEvents(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let closed = false;
    let subscriptionId = null;
    req.on('close', () => {
      closed = true;
      sseClients.delete(res);
      if (subscriptionId) hub.unsubscribe(subscriptionId);
    });
    try {
      const subscription = await hub.subscribe(
        {
          policy: 'disconnect',
          write: (method, params) =>
            res.write(
              `id: ${params.seq}\nevent: ${method}\ndata: ${JSON.stringify({ jsonrpc: '2.0', method, params })}\n\n`,
            ),
          bufferedBytes: () => res.writableLength,
          // Coupure explicite : les octets en attente sont abandonnés, le
          // navigateur se reconnecte et reçoit l'état complet.
          disconnect: () => res.destroy(),
          onceDrained: (callback) => res.once('drain', callback),
        },
        { initial: 'frame' },
      );
      subscriptionId = subscription.subscriptionId;
      if (closed) hub.unsubscribe(subscriptionId);
      else sseClients.set(res, subscriptionId);
    } catch (error) {
      logger.warn({ err: error.message }, 'Initial control state unreadable for an SSE client');
    }
  }

  async function serveRpc(req, res) {
    if (req.method !== 'POST') {
      send(res, 405, 'text/plain; charset=utf-8', 'POST only.', { Allow: 'POST' });
      return;
    }
    if (!originMatches(req, !isServedLocal(req))) {
      sendJson(res, 403, refusedOrigin('origin'));
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (req.headers['x-striart'] !== '1' || contentType !== 'application/json') {
      sendJson(res, 403, refusedCsrf());
      return;
    }
    const text = await readBody(req);
    if (text === null) {
      sendJson(
        res,
        413,
        errorResponse(
          null,
          null,
          new StriartError(`Request body exceeds ${MAX_MESSAGE_BYTES} bytes: refused.`, {
            code: 'CONTROL_MESSAGE_TOO_LARGE',
            details: { limit: MAX_MESSAGE_BYTES },
          }),
          ctx,
        ),
      );
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendJson(res, 200, errorResponse(null, null, parseError(), ctx));
      return;
    }
    const response = await handleMessage(message, ctx);
    if (response === null) {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    sendJson(res, 200, response);
    afterWrite(response);
  }

  function serveSignIn(res, url) {
    const verdict = verifier ? verifier.verify(url.searchParams.get('code')) : 'invalid';
    if (verdict !== 'ok') {
      // Jamais le code lui-même dans le journal : seulement le verdict.
      logger.info({ verdict }, 'Dashboard sign-in link refused');
      sendHtml(res, 403, SIGN_IN_REFUSED, INFO_CSP);
      return;
    }
    const { id, maxAgeSeconds } = sessions.create();
    send(res, 303, 'text/plain; charset=utf-8', '', {
      Location: '/',
      'Set-Cookie': sessionCookie(cookieName, id, maxAgeSeconds),
    });
  }

  async function route(req, res) {
    // 1. Barrière anti-DNS-rebinding, AVANT tout routage.
    if (!isServedLocal(req) && !hostAllowed(req.headers.host, allowedHosts)) {
      sendText(res, 403, 'Host non local refusé (protection contre le DNS rebinding).');
      return;
    }
    // 2. Requête initiée par un autre site (ou un autre port local).
    if (!fetchSiteAllowed(req)) {
      if ((req.url ?? '').startsWith('/rpc')) sendJson(res, 403, refusedOrigin('sec-fetch-site'));
      else sendText(res, 403, 'Requête inter-site refusée.');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/auth') {
      if (req.method !== 'GET') {
        send(res, 405, 'text/plain; charset=utf-8', 'GET only.', { Allow: 'GET' });
        return;
      }
      serveSignIn(res, url);
      return;
    }
    // 3. Session obligatoire pour tout le reste — aucune donnée sans elle.
    if (!sessions.check(parseCookies(req.headers.cookie).get(cookieName))) {
      if (url.pathname === '/rpc') sendJson(res, 401, unauthenticatedRpc());
      else if (url.pathname === '/' || url.pathname === '/index.html')
        sendHtml(res, 401, SIGN_IN_REQUIRED, INFO_CSP);
      else sendText(res, 401, 'Connexion requise : striart dashboard --link');
      return;
    }
    if (url.pathname === '/rpc') return serveRpc(req, res);
    if (url.pathname === '/events') return serveEvents(req, res);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendHtml(res, 200, PAGE, PAGE_CSP);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 410, {
        error:
          'The /api/* routes were replaced by the Striart Control Protocol v1: POST /rpc (JSON-RPC 2.0) and GET /events (Server-Sent Events). See rpc.discover.',
      });
      return;
    }
    sendText(res, 404, '404');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      // Jamais le message interne au client (A10) : il est journalisé ici.
      logger.error({ err: error }, 'Dashboard request failed');
      if (!res.headersSent) sendText(res, 500, 'Erreur interne du dashboard (voir le journal).');
      else res.destroy();
    });
  });

  const heartbeat = setInterval(() => {
    for (const [client, id] of sseClients) {
      if (hub.checkPressure(id)) client.write(':ping\n\n');
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  let tornDown = false;
  // server.close doit AUSSI démonter flux SSE, hub et fichier de jeton : sans
  // ça, les sockets event-stream empêchent close() d'aboutir, les watchers
  // survivent au serveur, et un jeton mort reste sur disque.
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    clearInterval(heartbeat);
    for (const client of sseClients.keys()) client.destroy();
    sseClients.clear();
    await hub.close();
    if (actualPort) await removeTokenFile(root, actualPort, process.pid);
  };
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    void teardown().then(
      () => originalClose(callback),
      (error) => {
        logger.warn({ err: error.message }, 'Dashboard teardown incomplete');
        originalClose(callback);
      },
    );
    return server;
  };

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      void teardown();
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE') {
        reject(
          new StriartError(`Le port ${listenPort} est déjà utilisé sur 127.0.0.1.`, {
            code: 'PORT_IN_USE',
            details: { port: listenPort },
            hint: `striart dashboard --port ${listenPort + 1}`,
          }),
        );
        return;
      }
      reject(error);
    });
    server.listen(listenPort, '127.0.0.1', () => resolve(undefined));
  });

  const address = server.address();
  actualPort = typeof address === 'object' && address ? address.port : listenPort;
  cookieName = sessionCookieName(actualPort);
  verifier = new SignInVerifier(token, actualPort);
  try {
    await writeTokenFile(root, {
      port: actualPort,
      pid: process.pid,
      token,
      hostname: instanceHostname,
    });
  } catch (error) {
    // Fail closed : sans fichier protégé, pas de serveur.
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    throw error;
  }

  if (allowedHosts.length > 0) {
    // Relâchement explicite : journalisé à CHAQUE démarrage (doctor l'affiche aussi).
    logger.warn(
      { hosts: allowedHosts.map((rule) => rule.pattern), port: actualPort },
      'Dashboard Host check RELAXED by dashboardAllowedHosts: these hosts are served in addition to the loopback; token, SameSite=Strict session cookie, Sec-Fetch-Site, Origin and anti-CSRF checks still apply',
    );
  }

  if (instanceHostname === null) {
    logger.warn(
      { port: actualPort },
      'Dashboard hostname set to "localhost" (dashboardHostname): the session cookie is sent by the browser to every localhost:* server (RFC 6265 section 8.5), e.g. an agent dev server that could replay it. Use "instance" unless your browser cannot resolve *.localhost.',
    );
  }
  const baseUrl = `http://${instanceHostname ?? 'localhost'}:${actualPort}`;
  /** @type {DashboardControl} */
  const control = {
    baseUrl,
    signInUrl: ({ ttlMs = config.dashboardLinkTtlMs } = {}) => {
      const { code, expiresAt } = mintSignInCode(token, { port: actualPort, ttlMs });
      return { url: `${baseUrl}/auth?code=${code}`, expiresAt };
    },
    stats: () => ({ ...hub.stats(), sessions: sessions.size }),
  };
  return Object.assign(server, { striart: control });
}
