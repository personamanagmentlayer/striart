import { createHash } from 'node:crypto';

/**
 * Vue MCP Apps (extension `io.modelcontextprotocol/ui`, décision D7) d'un
 * ticket de conflit 3-way — LECTURE SEULE.
 *
 * Sécurité, en profondeur :
 *  - aucune action mutante : la vue n'appelle AUCUN outil (le seul outil qui
 *    la référence, striart_ticket, est en `visibility: ['model']`, que l'hôte
 *    doit refuser à l'app) ; elle n'envoie que la poignée de main
 *    `ui/initialize` et des notifications de taille ;
 *  - contenu non fiable (code d'agent, prompt) inséré EXCLUSIVEMENT par
 *    `textContent` — jamais `innerHTML`, aucun gabarit HTML construit avec
 *    des données ; la page ne contient aucune donnée au chargement (elle
 *    arrive par `ui/notifications/tool-result`) ;
 *  - CSP stricte embarquée (meta) EN PLUS de celle de l'hôte : `default-src
 *    'none'`, script et style autorisés UNIQUEMENT par empreinte sha256 du
 *    bloc inline, aucune connexion, aucune image, aucun cadre, aucun
 *    formulaire ; `_meta.ui.csp` ne déclare aucun domaine (défaut restrictif
 *    imposé à l'hôte par la spec) ;
 *  - messages entrants acceptés seulement de `window.parent`, au format
 *    JSON-RPC attendu ; tout le reste est ignoré.
 */

export const TICKET_VIEW_URI = 'ui://striart/ticket-view';

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, light-dark(#ffffff, #16181d));
  --bg2: var(--color-background-secondary, light-dark(#f4f5f7, #20232a));
  --fg: var(--color-text-primary, light-dark(#16181d, #f2f3f5));
  --muted: var(--color-text-secondary, light-dark(#4a4f59, #b8bcc6));
  --line: var(--color-border-primary, light-dark(#c9ccd3, #3a3f4a));
  --accent: light-dark(#0b57d0, #8ab4f8);
  --warn: light-dark(#8a4b00, #ffc46b);
  --font: var(--font-sans, system-ui, sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
}
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--font); }
h1 { font-size: 16px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 16px 0 6px; word-break: break-all; }
.meta { color: var(--muted); margin: 0 0 8px; }
.meta dt { font-weight: 600; display: inline; }
.meta dd { display: inline; margin: 0 12px 0 4px; }
.badge { display: inline-block; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; }
.note { color: var(--warn); }
[role="tablist"] { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
[role="tab"] { font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; padding: 4px 10px; cursor: pointer; min-height: 32px; }
[role="tab"][aria-selected="true"] { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: -2px; }
[role="tab"]:focus-visible, pre:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
pre { margin: 0; padding: 8px; background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; overflow: auto; max-height: 420px; font: 12px/1.4 var(--mono); white-space: pre; tab-size: 4; }
.empty { color: var(--muted); font-style: italic; }
`;

const SCRIPT = `
(() => {
  'use strict';
  const root = document.getElementById('app');
  const VERSIONS = [
    ['theirs', 'THEIRS (agent)'],
    ['ours', 'OURS (target branch)'],
    ['base', 'BASE (common ancestor)'],
    ['llmAttempt', 'LLM attempt'],
  ];
  let nextId = 1;
  const el = (tag, attrs, text) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  const post = (message) => window.parent.postMessage(message, '*');

  function renderStatus(text) {
    root.replaceChildren(el('p', { class: 'empty', role: 'status' }, text));
  }

  function renderFile(file, index) {
    const section = el('section', { 'aria-labelledby': 'f' + index });
    section.append(el('h2', { id: 'f' + index }, str(file.path)));
    if (file.truncated) section.append(el('p', { class: 'note' }, 'Content truncated (size cap).'));
    const tablist = el('div', { role: 'tablist', 'aria-label': 'Versions of ' + str(file.path) });
    const panel = el('pre', { role: 'tabpanel', tabindex: '0', id: 'p' + index });
    const tabs = [];
    const select = (i, focus) => {
      tabs.forEach((tab, j) => {
        tab.setAttribute('aria-selected', String(i === j));
        tab.tabIndex = i === j ? 0 : -1;
      });
      const value = file[VERSIONS[i][0]];
      panel.setAttribute('aria-labelledby', tabs[i].id);
      panel.textContent = typeof value === 'string' ? value : '(absent)';
      if (focus) tabs[i].focus();
    };
    VERSIONS.forEach(([, label], i) => {
      const tab = el('button', { role: 'tab', type: 'button', id: 't' + index + '-' + i, 'aria-controls': 'p' + index }, label);
      tab.addEventListener('click', () => select(i, false));
      tab.addEventListener('keydown', (event) => {
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (event.key === 'Home') { event.preventDefault(); select(0, true); }
        else if (event.key === 'End') { event.preventDefault(); select(tabs.length - 1, true); }
        else if (delta) { event.preventDefault(); select((tabs.indexOf(tab) + delta + tabs.length) % tabs.length, true); }
      });
      tabs.push(tab);
      tablist.append(tab);
    });
    section.append(tablist, panel);
    select(0, false);
    return section;
  }

  function render(ticket) {
    if (!ticket || typeof ticket !== 'object' || !Array.isArray(ticket.files)) {
      renderStatus('No ticket data in this result.');
      return;
    }
    const main = el('main', { 'aria-label': 'Conflict ticket ' + str(ticket.id) });
    main.append(el('h1', {}, 'Conflict ticket ' + str(ticket.id)));
    const meta = el('dl', { class: 'meta' });
    for (const [label, value] of [
      ['Agent', ticket.agent],
      ['Reason', ticket.reason],
      ['Commit', str(ticket.sha).slice(0, 12)],
      ['Created', ticket.createdAt],
      ['State', ticket.resolved ? 'resolved' : 'open'],
    ]) {
      meta.append(el('dt', {}, label), el('dd', {}, str(value)));
    }
    main.append(meta);
    main.append(el('p', { class: 'badge' }, 'Read-only view — resolve with striart resolve --prepare / --apply.'));
    if (ticket.prompt) main.append(el('p', { class: 'meta' }, 'Task: ' + str(ticket.prompt)));
    if (ticket.status === 'CORRUPT') main.append(el('p', { class: 'note' }, 'Unreadable ticket (' + str(ticket.cause) + '): its content is not shown. Close it with striart resolve --close ' + str(ticket.id) + '.'));
    else if (ticket.files.length === 0) main.append(el('p', { class: 'empty' }, 'No conflicted file (Test Gate failure).'));
    ticket.files.forEach((file, i) => main.append(renderFile(file, i)));
    if (ticket.omittedFiles > 0) main.append(el('p', { class: 'note' }, ticket.omittedFiles + ' more file(s) not shown.'));
    if (typeof ticket.log === 'string' && ticket.log.length > 0) {
      main.append(el('h2', { id: 'log' }, 'Test Gate log' + (ticket.logTruncated ? ' (tail)' : '')));
      main.append(el('pre', { tabindex: '0', 'aria-labelledby': 'log' }, ticket.log));
    }
    root.replaceChildren(main);
    reportSize();
  }

  function reportSize() {
    const rect = document.documentElement.getBoundingClientRect();
    post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: Math.ceil(rect.width), height: Math.ceil(rect.height) } });
  }

  function applyTheme(context) {
    if (context && (context.theme === 'light' || context.theme === 'dark')) {
      document.documentElement.style.colorScheme = context.theme;
    }
  }

  const initId = nextId++;
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
    if (data.id === initId && (data.result || data.error)) {
      if (data.result) applyTheme(data.result.hostContext);
      post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      return;
    }
    switch (data.method) {
      case 'ui/notifications/tool-result':
        render(data.params && data.params.structuredContent);
        break;
      case 'ui/notifications/tool-cancelled':
        renderStatus('The tool call was cancelled.');
        break;
      case 'ui/notifications/host-context-changed':
        applyTheme(data.params);
        break;
      case 'ui/resource-teardown':
        if (data.id !== undefined) post({ jsonrpc: '2.0', id: data.id, result: {} });
        break;
      default:
        break;
    }
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.documentElement);
  renderStatus('Waiting for the ticket…');
  post({
    jsonrpc: '2.0',
    id: initId,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'striart-ticket-view', version: '1' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    },
  });
})();
`;

const sha256 = (text: string) =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** CSP embarquée : rien n'est autorisé hors des deux blocs inline, identifiés par empreinte. */
export const TICKET_VIEW_CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "img-src 'none'",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const TICKET_VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${TICKET_VIEW_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Striart conflict ticket</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;

/** Pour les tests : les blocs dont la CSP porte l'empreinte. */
export const TICKET_VIEW_BLOCKS = { script: SCRIPT, style: STYLE } as const;
