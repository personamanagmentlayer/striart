/**
 * Squelette HTML du dashboard, rendu CÔTÉ SERVEUR dans la langue de l'instance
 * (texte statique uniquement : tout le contenu variable est écrit par le client
 * via `textContent` ou le gabarit échappant `h`, jamais ici).
 *
 * Structure (lecteurs d'écran et clavier) : lien d'évitement → en-tête (marque,
 * dépôt, état de la liaison, thème) → `main` avec, DANS L'ORDRE, le résumé chiffré,
 * « À traiter » (ce qui attend une décision : cartes d'alerte avec leur action
 * directe), puis les agents (avec « Nouvelle tâche » et « Maintenance »), les
 * conflits, l'orchestration, la colonne latérale (file, fichiers disputés,
 * historique) et la zone d'actions risquées. L'ordre du DOM est l'ordre de
 * tabulation : le plus actionnable vient en premier. Les dialogues (nouvelle
 * tâche, confirmation, détail d'un agent, diagnostic, aide) sont des `<dialog>`
 * natifs : focus piégé et Échap gérés par le navigateur.
 *
 * Icônes : sprite SVG inline (aucune image ni police externe, CSP stricte).
 */
import { DASHBOARD_MESSAGES, type MessageKey } from './dashboard-messages.ts';
import { clientScript } from './dashboard-client.ts';
import { STYLE } from './dashboard-style.ts';

const HISTORY_LIMIT = 30;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** Sprite d'icônes (viewBox 16×16, trait). Référencé par `<use href="#i-nom">`. */
const SPRITE = [
  ['check', '<circle cx="8" cy="8" r="6.25"/><path d="M5.2 8.2l2 2 3.6-4"/>'],
  ['x', '<circle cx="8" cy="8" r="6.25"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>'],
  ['warn', '<path d="M8 2.2l6.1 10.6H1.9z"/><path d="M8 6.4v3M8 11.2v.1"/>'],
  ['info', '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.2v3.6M8 5v.1"/>'],
  ['clock', '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.3 1.5"/>'],
  [
    'branch',
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4.5"/>',
  ],
  [
    'folder',
    '<path d="M1.75 4.5c0-.7.55-1.25 1.25-1.25h3l1.5 1.75h5.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z"/>',
  ],
  ['plus', '<path d="M8 3v10M3 8h10"/>'],
  [
    'dots',
    '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>',
  ],
  ['chev', '<path d="M4 6l4 4 4-4"/>'],
  [
    'sun',
    '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  ],
  ['moon', '<path d="M13.5 9.5A5.75 5.75 0 016.5 2.5a5.75 5.75 0 107 7z"/>'],
  [
    'auto',
    '<circle cx="8" cy="8" r="6.25"/><path d="M8 1.75a6.25 6.25 0 010 12.5z" fill="currentColor"/>',
  ],
  [
    'copy',
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5"/>',
  ],
  [
    'terminal',
    '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>',
  ],
  ['bolt', '<path d="M9 1.75L3.5 9h4l-.5 5.25L12.5 7h-4z"/>'],
  ['commit', '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>'],
  ['search', '<circle cx="7" cy="7" r="4.25"/><path d="M10.3 10.3l3.2 3.2"/>'],
  [
    'wrench',
    '<path d="M10.5 2.5a3.25 3.25 0 00-3.1 4.2L2.6 11.5a1.4 1.4 0 002 2l4.8-4.8a3.25 3.25 0 004.2-3.1l-2 2-1.7-.4-.4-1.7z"/>',
  ],
  [
    'help',
    '<circle cx="8" cy="8" r="6.25"/><path d="M6.2 6.2a1.9 1.9 0 113 1.5c-.7.5-1.2.9-1.2 1.6M8 11.4v.1"/>',
  ],
  ['shield', '<path d="M8 1.75l5 1.9v3.7c0 3-2.1 5.2-5 6.9-2.9-1.7-5-3.9-5-6.9V3.65z"/>'],
  ['rollback', '<path d="M3 6.5h6.25a3.25 3.25 0 010 6.5H6M5.5 4L3 6.5 5.5 9"/>'],
]
  .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 16 16">${body}</symbol>`)
  .join('');

export interface PageOptions {
  /** Nom du dépôt (dossier racine) : donnée de l'instance, échappée ici. */
  repo?: string;
}

export function renderPage(locale: 'fr' | 'en', options: PageOptions = {}): string {
  const dict: Record<string, string> = DASHBOARD_MESSAGES[locale];
  const m = (key: MessageKey, params: Record<string, string | number> = {}) =>
    escapeHtml((dict[key] ?? key).replace(/\{(\w+)\}/g, (_x, k) => String(params[k] ?? '')));
  const ic = (name: string, cls = '') =>
    `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
  const item = (
    act: string,
    label: MessageKey,
    desc: MessageKey,
    opts: { confirm?: boolean; danger?: boolean } = {},
  ) =>
    `<button type="button" role="menuitem" class="menu-item${opts.danger ? ' danger' : ''}" data-act="${act}"${opts.confirm ? ` data-confirm="${m(desc)}"` : ''}${opts.danger ? ' data-danger="1"' : ''}><span>${m(label)}</span><span class="desc">${m(desc)}</span></button>`;
  const repo = options.repo ? escapeHtml(options.repo) : '';
  const skel = (rows = 3) =>
    `<span class="sr">${m('loading')}</span>` +
    Array.from(
      { length: rows },
      () =>
        `<div class="skel-row" aria-hidden="true"><span class="skel w30 h-lg"></span><span class="skel w70"></span></div>`,
    ).join('');

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${m('page.title')}</title>
<link rel="icon" href="/favicon.ico">
<style>${STYLE}</style>
</head>
<body>
<svg class="sprite" aria-hidden="true" focusable="false">${SPRITE}</svg>
<a class="skip" href="#main">${m('skip')}</a>
<header class="top">
<div class="bar">
  <div class="brand"><svg class="logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect width="24" height="24" rx="6" fill="currentColor"/><path d="M8.5 17.5V8.5M8.5 8.5a2 2 0 100-4 2 2 0 000 4zM15.5 19a2 2 0 100-4 2 2 0 000 4zM15.5 15V11a2.5 2.5 0 00-2.5-2.5h-1.5"/></svg><h1>Striart</h1></div>
  <div class="chips">
    <span class="chip"${repo ? '' : ' hidden'} id="chip-repo">${ic('folder')}<span class="trunc" id="repo-name">${repo}</span></span>
    <span class="chip" id="chip-branch" hidden>${ic('branch')}<span class="trunc" id="branch-name"></span></span>
  </div>
  <div class="bar-end">
    <span id="live" class="live">${m('live.connecting')}</span>
    <span id="meta"></span>
    <div class="menu end" id="info-menu">
      <button type="button" class="ghost icon" id="info-btn" data-pop aria-expanded="false" aria-controls="info-panel" aria-label="${m('repo.info')}" title="${m('repo.info')}">${ic('info')}</button>
      <div class="menu-panel" id="info-panel" role="group" aria-label="${m('repo.info')}" hidden><dl class="kv" id="info-body"></dl></div>
    </div>
    <button type="button" class="ghost icon" id="help-btn" aria-label="${m('btn.help')}" title="${m('btn.help')}" aria-keyshortcuts="?">${ic('help')}</button>
    <button type="button" class="ghost icon" id="theme-btn" aria-label="${m('theme.btn', { mode: m('theme.auto') })}"><span id="theme-ic">${ic('auto')}</span></button>
  </div>
</div>
</header>
<div class="wrap">
<main id="main" tabindex="-1">
<div id="auth"></div>
<div id="banner"></div>
<ul class="stats" aria-label="${m('stats.label')}">
  <li><a class="stat" href="#sec-agents" id="stat-agents"><span class="stat-n" id="n-agents">–</span><span class="stat-l">${m('stat.agents')}</span></a></li>
  <li><a class="stat" href="#sec-agents" id="stat-pending"><span class="stat-n" id="n-pending">–</span><span class="stat-l">${m('stat.pending')}</span></a></li>
  <li><a class="stat" href="#sec-tickets" id="stat-conflicts"><span class="stat-n" id="n-conflicts">–</span><span class="stat-l">${m('stat.conflicts')}</span></a></li>
  <li><a class="stat" href="#sec-queue" id="stat-queue"><span class="stat-n" id="n-queue">–</span><span class="stat-l">${m('stat.queue')}</span></a></li>
</ul>
<section aria-labelledby="h-attention" id="sec-attention" class="attention" hidden>
  <div class="sec-head"><h2 id="h-attention">${m('attention.title')} <span class="count" id="attention-count"></span></h2></div>
  <div id="main-session"></div>
  <div id="manual"></div>
  <div id="attention-summary"></div>
  <div id="permissions"></div>
  <div id="elicitations"></div>
  <div id="reviews"></div>
  <div id="watcher"></div>
</section>
<p class="allclear" id="all-clear" hidden>${ic('check')}${m('attention.allClear')} <span class="muted">${m('attention.allClear.sub')}</span></p>
<div class="cols two">
<div class="col">
<section aria-labelledby="sec-agents-h" id="sec-agents" class="panel">
  <div class="sec-head"><h2 id="sec-agents-h">${m('sec.agents')} <span class="count" id="agents-count"></span></h2>
    <div class="toolbar">
      <button type="button" class="primary" id="new-task-btn" data-new-task="1" aria-keyshortcuts="n">${ic('plus')}${m('btn.newTask')} <kbd class="kbd-hint" aria-hidden="true">N</kbd></button>
      <div class="menu end" id="maint-menu">
        <button type="button" id="maint-btn" data-menu aria-haspopup="menu" aria-expanded="false" aria-controls="maint-panel" aria-keyshortcuts="m">${ic('wrench')}${m('btn.maint')}${ic('chev')}</button>
        <div class="menu-panel" id="maint-panel" role="menu" aria-labelledby="maint-btn" hidden>
          ${item('queue.retry', 'btn.retry', 'confirm.retry')}
          ${item('agent.sync', 'btn.syncAll', 'confirm.sync', { confirm: true })}
          ${item('reconcile.run', 'btn.reconcile', 'confirm.reconcile', { confirm: true })}
          ${item('staging.promote', 'btn.promote', 'confirm.promote', { confirm: true })}
          <div class="menu-sep" role="separator"></div>
          ${item('clones.clean', 'btn.clean', 'confirm.clean', { confirm: true, danger: true })}
          ${item('workspace.prune', 'btn.prune', 'confirm.prune', { confirm: true, danger: true })}
          <div class="menu-sep" role="separator"></div>
          <button type="button" role="menuitem" class="menu-item" id="doctor-btn"><span>${m('btn.doctor')}</span><span class="desc">${m('confirm.doctor')}</span></button>
        </div>
      </div>
    </div>
  </div>
  <div class="filters" id="agent-filters" hidden>
    <div class="seg" role="group" aria-label="${m('filter.label')}" id="agent-seg"></div>
    <input type="search" id="agent-search" aria-label="${m('filter.search')}" placeholder="${m('filter.search.ph')}" autocomplete="off" aria-keyshortcuts="/">
  </div>
  <div id="agents">${`<div class="list">${skel(3)}</div>`}</div>
  <div id="session-log"></div>
</section>
<section aria-labelledby="sec-tickets-h" id="sec-tickets" class="panel">
  <div class="sec-head"><h2 id="sec-tickets-h">${m('sec.tickets')} <span class="count" id="tickets-count"></span></h2></div>
  <div id="tickets" class="panel-body">${skel(1)}</div>
  <div id="ticket-detail"></div>
</section>
<section aria-labelledby="sec-orch-h" id="sec-orch" class="panel">
  <div class="sec-head"><h2 id="sec-orch-h">${m('sec.orch')}</h2></div>
  <div id="orchestration">${skel(1)}</div>
</section>
</div>
<div class="col">
<section aria-labelledby="sec-queue-h" id="sec-queue" class="panel">
  <div class="sec-head"><h2 id="sec-queue-h">${m('sec.queue')} <span class="count" id="queue-count"></span></h2></div>
  <div id="queue" class="panel-body">${skel(1)}</div>
</section>
<section aria-labelledby="sec-heat-h" id="sec-heat" class="panel">
  <div class="sec-head"><h2 id="sec-heat-h">${m('sec.heat')}</h2></div>
  <p class="hint">${m('heat.help')}</p>
  <div id="heatmap" class="panel-body">${skel(1)}</div>
</section>
<section aria-labelledby="sec-history-h" id="sec-history" class="panel">
  <div class="sec-head"><h2 id="sec-history-h">${m('sec.history')}</h2></div>
  <p class="hint">${m('history.help')}</p>
  <div id="history" class="panel-body" data-limit="${HISTORY_LIMIT}">${skel(1)}</div>
</section>
</div>
</div>
<details class="danger-zone" id="sec-risk">
  <summary>${ic('shield')}${m('sec.risk')}</summary>
  <div class="zone-body">
    <p class="muted">${m('risk.intro')}</p>
    <h3>${m('risk.rollback.title')}</h3>
    <p>${m('confirm.rollback')}</p>
    <button type="button" class="danger" id="rollback-btn" data-act="merge.rollback" data-confirm="${m('confirm.rollback')}" data-danger="1">${ic('rollback')}${m('btn.rollback')}</button>
  </div>
</details>
</main>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<dialog class="dlg" id="dlg-task" aria-labelledby="dlg-task-t">
<form id="task-form" class="dlg-body" novalidate>
  <h2 id="dlg-task-t">${m('task.title')}</h2>
  <div class="field"><label for="task-prompt">${m('task.prompt')}</label><textarea id="task-prompt" rows="4" placeholder="${m('task.prompt.ph')}" aria-describedby="task-prompt-h" autocomplete="off"></textarea><span class="muted" id="task-prompt-h">${m('task.prompt.help')}</span></div>
  <div class="field"><label for="task-agent">${m('task.agent')}</label><input id="task-agent" type="text" autocomplete="off" aria-describedby="task-agent-h"><span class="muted" id="task-agent-h">${m('task.agent.help')}</span></div>
  <div class="field"><label for="task-mode">${m('task.mode')}</label><select id="task-mode"><option value="attended">${m('task.mode.attended')}</option><option value="autonomous">${m('task.mode.autonomous')}</option></select></div>
  <div class="field" id="task-profile-field" hidden><label for="task-profile">${m('task.profile')}</label><select id="task-profile"></select></div>
  <div class="dlg-msg" id="task-msg" role="status"></div>
  <div class="dlg-actions"><button type="button" data-close-dlg>${m('btn.cancel')}</button><button id="task-start" type="submit" class="primary">${m('task.start')}</button></div>
</form>
</dialog>
<dialog class="dlg" id="dlg-confirm" aria-labelledby="confirm-title" aria-describedby="confirm-text">
<form id="confirm-form" class="dlg-body" novalidate>
  <h2 id="confirm-title"></h2>
  <p class="conseq" id="confirm-text"></p>
  <div class="field" id="confirm-typed" hidden><label for="confirm-input" id="confirm-label"></label><input id="confirm-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
  <div class="dlg-actions"><button type="button" id="confirm-cancel" data-close-dlg>${m('btn.cancel')}</button><button type="submit" id="confirm-ok">${m('btn.confirm')}</button></div>
</form>
</dialog>
<dialog class="dlg wide" id="dlg-agent" aria-labelledby="agent-dlg-title">
<div class="dlg-body" id="agent-dlg-body"></div>
</dialog>
<dialog class="dlg wide" id="dlg-doctor" aria-labelledby="doc-h">
<div class="dlg-body"><div id="doctor-detail"></div></div>
</dialog>
<dialog class="dlg" id="dlg-help" aria-labelledby="help-title">
<div class="dlg-body">
  <h2 id="help-title">${m('help.title')}</h2>
  <p class="muted">${m('help.note')}</p>
  <table class="shortcuts"><caption class="sr">${m('help.title')}</caption><tbody>
    <tr><td><kbd>N</kbd></td><td>${m('help.new')}</td></tr>
    <tr><td><kbd>M</kbd></td><td>${m('help.maint')}</td></tr>
    <tr><td><kbd>/</kbd></td><td>${m('help.filter')}</td></tr>
    <tr><td><kbd>?</kbd></td><td>${m('help.help')}</td></tr>
    <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>${m('help.arrows')}</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>${m('help.esc')}</td></tr>
  </tbody></table>
  <div class="dlg-actions"><button type="button" data-close-dlg class="primary">${m('btn.closeDetail')}</button></div>
</div>
</dialog>
<div id="announcer" class="sr" role="status" aria-live="polite" aria-atomic="true"></div>
<script>${clientScript(locale)}</script>
</body>
</html>
`;
}

export { STYLE, clientScript, HISTORY_LIMIT };
