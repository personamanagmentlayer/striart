/**
 * Client navigateur du dashboard (client du Striart Control Protocol v1).
 *
 * Ce module est du TypeScript ordinaire — vérifié par `tsc` et ESLint — dont
 * la SOURCE (`Function.prototype.toString`) est embarquée telle quelle dans
 * l'unique `<script>` de la page, identifié par son empreinte dans la CSP.
 * Conséquence : `dashboardClient` doit être AUTONOME (aucune référence à un
 * identifiant du module, seulement à ses paramètres et aux globales du
 * navigateur) et n'utiliser ni style en ligne ni gestionnaire `on*=`.
 *
 * Règles de sécurité (SECURITY.md) : tout contenu venant des agents, des
 * tickets, des logs ou du LLM est NON FIABLE. Il n'entre dans le DOM que par
 * (1) `h` — gabarit étiqueté qui ÉCHAPPE chaque valeur interpolée, sauf un
 * fragment déjà `Safe` ; (2) `textContent`. Aucune concaténation de chaîne ne
 * fabrique du HTML. Une URL proposée par un agent est affichée, jamais ouverte.
 *
 * Mises à jour : le serveur pousse l'état complet (SSE) ; le client ne retouche
 * que ce qui a changé (sections comparées, lignes indexées par clé), pas de
 * re-rendu global, un seul écouteur délégué pour toutes les actions.
 *
 * Confirmations proportionnées : une action bénigne ou protégée par le Test Gate
 * (merger, synchroniser, relancer la file) part directement ; une action
 * modérée ouvre un dialogue qui écrit la CONSÉQUENCE ; une action sévère ou
 * irréversible (arrêt forcé, rollback, libérer le principal, clore à la main)
 * exige en plus de SAISIR le nom de la cible. L'interface n'invente aucune option.
 */
import { DASHBOARD_MESSAGES } from './dashboard-messages.ts';

export function dashboardClient(MSG: typeof DASHBOARD_MESSAGES): void {
  // ── Langue et messages ───────────────────────────────────────────────────
  const LANG: 'fr' | 'en' = document.documentElement.lang === 'en' ? 'en' : 'fr';
  const dict: Record<string, string> = MSG[LANG];
  const base: Record<string, string> = MSG.fr;
  const fmt = (s: string, p?: Record<string, unknown>) =>
    s.replace(/\{(\w+)\}/g, (_m, k) => (p && p[k] != null ? String(p[k]) : ''));
  const t = (key: string, p?: Record<string, unknown>) => fmt(dict[key] ?? base[key] ?? key, p);
  const tn = (key: string, n: number, p?: Record<string, unknown>) =>
    t(key + (n === 1 ? '.one' : '.other'), { n, ...p });
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Échappement : la seule porte d'entrée du HTML ────────────────────────
  class Safe {
    v: string;
    constructor(v: string) {
      this.v = v;
    }
  }
  const ESC: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  const esc = (s: unknown) => String(s ?? '—').replace(/[&<>"']/g, (c) => ESC[c]);
  const part = (v: unknown): string =>
    v instanceof Safe ? v.v : Array.isArray(v) ? v.map(part).join('') : esc(v);
  /** Gabarit étiqueté : chaque valeur interpolée est échappée, sauf un `Safe`. */
  const h = (strings: TemplateStringsArray, ...values: unknown[]): Safe =>
    new Safe(
      strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ''), ''),
    );
  /** Message avec ‹fragments de code› : le texte est échappé, seuls ‹ › deviennent <code>. */
  const th = (key: string, p?: Record<string, unknown>): Safe => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p ?? {})) clean[k] = String(v ?? '').replace(/[‹›]/g, '');
    return new Safe(
      esc(fmt(dict[key] ?? base[key] ?? key, clean))
        .replace(/‹/g, '<code>')
        .replace(/›/g, '</code>'),
    );
  };
  const text = (v: unknown) => String(v ?? '');
  const $ = (id: string) => document.getElementById(id) as any;
  const ic = (name: string, cls = ''): Safe =>
    new Safe(
      '<svg class="ic' +
        (cls ? ' ' + cls : '') +
        '" aria-hidden="true" focusable="false"><use href="#i-' +
        name +
        '"/></svg>',
    );

  // ── Formats localisés (Intl) : tailles, heures, durées relatives ─────────
  const time = (iso: unknown) => new Date(String(iso)).toLocaleTimeString(LANG);
  const dtf = new Intl.DateTimeFormat(LANG, { dateStyle: 'medium', timeStyle: 'short' });
  const rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' });
  function rel(iso: unknown): string {
    const ts = Date.parse(String(iso));
    if (!Number.isFinite(ts)) return '—';
    const s = Math.round((ts - Date.now()) / 1000);
    const a = Math.abs(s);
    if (a < 45) return rtf.format(0, 'second');
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    if (a < 7 * 86400) return rtf.format(Math.round(s / 86400), 'day');
    return dtf.format(ts);
  }
  /** Durée relative lisible + `<time datetime>` ; la date complète en info-bulle. */
  function timeEl(iso: unknown): Safe {
    const ts = Date.parse(String(iso));
    if (!Number.isFinite(ts)) return new Safe('—');
    return h`<time datetime="${new Date(ts).toISOString()}" data-rel="1" title="${dtf.format(ts)}">${rel(iso)}</time>`;
  }
  const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  const sizeFormats: Record<string, Intl.NumberFormat> = {};
  function formatBytes(bytes: number): string {
    let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    let unit = 0;
    while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
      value /= 1000;
      unit += 1;
    }
    const name = SIZE_UNITS[unit];
    sizeFormats[name] ??= new Intl.NumberFormat(LANG, {
      style: 'unit',
      unit: name,
      unitDisplay: 'short',
      maximumFractionDigits: unit === 0 ? 0 : 1,
    });
    return sizeFormats[name].format(value);
  }

  const durationFormats: Record<string, Intl.NumberFormat> = {};
  /** Durée écoulée lisible (« 42 min », « 3 h », « 2 j ») — jamais une date absolue. */
  function formatDuration(ms: number): string {
    const minutes = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 60000));
    const [value, unit] =
      minutes < 60
        ? [minutes, 'minute']
        : minutes < 24 * 60
          ? [Math.round(minutes / 60), 'hour']
          : [Math.round(minutes / (24 * 60)), 'day'];
    durationFormats[unit] ??= new Intl.NumberFormat(LANG, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    });
    return durationFormats[unit].format(value);
  }
  /**
   * Verdict du GC d'inactivité pour un agent (champ additif `idle` de l'état) : seulement les
   * étages qui méritent un signe (idle, averti, fermable) ; null sinon — dont GC indisponible.
   */
  function idleVerdict(s: any, name: string): any {
    const idle = s?.idle;
    if (!idle || idle.available !== true || idle.enabled === false) return null;
    const v = (idle.agents ?? []).find((x: any) => x.agent === name);
    if (!v || typeof v.idleMs !== 'number') return null;
    return v.stage === 'idle' || v.stage === 'warned' || v.stage === 'closable' ? v : null;
  }
  /** Texte de la carte « À traiter » d'un agent averti ou fermable. */
  function idleCardText(s: any, v: any): string {
    const dur = formatDuration(v.idleMs);
    if (v.stage === 'closable') return t('alert.idle.closable', { for: dur });
    const closing = s.idle.action === 'close' && s.idle.closeAuthorized === true;
    return v.closeNotBefore && closing
      ? t('alert.idle.warnedUntil', { for: dur, time: time(v.closeNotBefore) })
      : t('alert.idle.warned', { for: dur });
  }
  /** Ligne « Inactivité » du détail d'un agent (vide = rien à signaler). */
  function idleDetail(s: any, name: string): string {
    const v = idleVerdict(s, name);
    return v ? t('idle.detail.' + v.stage, { for: formatDuration(v.idleMs) }) : '';
  }
  function idleBadge(s: any, name: string): Safe | string {
    const v = idleVerdict(s, name);
    if (!v) return '';
    return badge(
      t('idle.badge', { for: formatDuration(v.idleMs) }),
      v.stage === 'idle' ? 'info' : 'warn',
      'clock',
    );
  }

  // ── Sections : on ne retouche que ce qui a changé ────────────────────────
  const lastHtml: Record<string, string> = {};
  function setSection(id: string, content: Safe | string): void {
    const html = content instanceof Safe ? content.v : content;
    if (lastHtml[id] === html) return;
    lastHtml[id] = html;
    $(id).innerHTML = html;
  }
  function setText(id: string, value: string): void {
    const el = $(id);
    if (el.textContent !== value) el.textContent = value;
  }

  const roleAttr = (r: string) => new Safe(` role="${r}"`);
  interface Col {
    label: string;
    render: (r: any) => unknown;
    mono?: boolean;
    cls?: string;
  }
  function rowHtml(r: any, cols: Col[]): Safe {
    return h`<tr${roleAttr('row')}>${cols.map((c) => {
      const value = c.render(r);
      // Un identifiant COURT ne se coupe pas (« agent-00 » reste d’un bloc) ; un long reste coupable.
      const short = c.mono && typeof value === 'string' && value.length <= 24;
      const cls = c.mono ? (short ? ' class="mono nowrap"' : ' class="mono"') : '';
      return h`<td${roleAttr('cell')} data-label="${c.label}"${new Safe(cls)}>${value}</td>`;
    })}</tr>`;
  }
  function headHtml(cols: Col[]): Safe {
    return h`<thead${roleAttr('rowgroup')}><tr${roleAttr('row')}>${cols.map(
      (c) => h`<th${roleAttr('columnheader')} scope="col">${c.label}</th>`,
    )}</tr></thead>`;
  }
  /** Petit tableau, re-rendu d'un bloc (diagnostic, orchestration). */
  function tableHtml(
    caption: string,
    rows: any[],
    cols: Col[],
    rowClass?: (r: any) => string,
  ): Safe {
    const body = rows.map((r) => {
      const cls = rowClass ? rowClass(r) : '';
      const html = rowHtml(r, cols).v;
      return new Safe(cls ? html.replace('<tr', '<tr class="' + esc(cls) + '"') : html);
    });
    return h`<div class="table-wrap"><table class="stack"${roleAttr('table')}><caption class="sr">${caption}</caption>${headHtml(cols)}<tbody${roleAttr('rowgroup')}>${body}</tbody></table></div>`;
  }

  /**
   * Liste à lignes indexées par clé (tableau de conflits, liste d'agents) : une
   * ligne dont le HTML n'a pas changé n'est PAS touchée (focus, menu ouvert et
   * sélection survivent à un push) ; seules les lignes nouvelles ou modifiées
   * sont recréées, les disparues retirées, l'ordre rétabli sans tout reposer.
   */
  interface Keyed {
    sig: string;
    body: any;
    rows: Map<string, { html: string; el: any }>;
  }
  const keyedLists: Record<string, Keyed> = {};
  const tpl = document.createElement('template');
  function syncKeyed(st: Keyed, items: Array<{ key: string; html: string }>): void {
    const next = new Map<string, { html: string; el: any }>();
    const wanted: any[] = [];
    for (const { key, html } of items) {
      const prev = st.rows.get(key);
      if (prev && prev.html === html) {
        next.set(key, prev);
        wanted.push(prev.el);
        continue;
      }
      tpl.innerHTML = html;
      const el = tpl.content.firstElementChild;
      next.set(key, { html, el });
      wanted.push(el);
    }
    for (const [key, prev] of st.rows) if (next.get(key)?.el !== prev.el) prev.el.remove();
    wanted.forEach((el, i) => {
      if (st.body.children[i] !== el) st.body.insertBefore(el, st.body.children[i] ?? null);
    });
    st.rows = next;
  }
  function ensureKeyed(id: string, sig: string, shell: Safe, bodySelector: string): Keyed {
    const host = $(id);
    let st = keyedLists[id];
    if (!st || st.sig !== sig || !host.contains(st.body)) {
      lastHtml[id] = shell.v;
      host.innerHTML = shell.v;
      st = { sig, body: host.querySelector(bodySelector), rows: new Map() };
      keyedLists[id] = st;
    }
    return st;
  }
  function setTable(
    id: string,
    caption: string,
    rows: any[],
    cols: Col[],
    keyOf: (r: any) => string,
    emptyHtml: Safe,
  ): void {
    if (rows.length === 0) {
      delete keyedLists[id];
      setSection(id, emptyHtml);
      return;
    }
    const sig = caption + '|' + cols.map((c) => c.label).join('|');
    const shell = h`<div class="table-wrap"><table class="stack"${roleAttr('table')}><caption class="sr">${caption}</caption>${headHtml(cols)}<tbody${roleAttr('rowgroup')}></tbody></table></div>`;
    const st = ensureKeyed(id, sig, shell, 'tbody');
    syncKeyed(
      st,
      rows.map((r) => ({ key: keyOf(r), html: rowHtml(r, cols).v })),
    );
  }
  function setItems(
    id: string,
    listClass: string,
    label: string,
    items: Array<{ key: string; html: Safe }>,
    emptyHtml: Safe,
  ): void {
    if (items.length === 0) {
      delete keyedLists[id];
      setSection(id, emptyHtml);
      return;
    }
    // Une liste qui défile doit être atteignable au clavier (et nommée).
    const shell = h`<ul class="${listClass}"${roleAttr('list')}${new Safe(listClass.includes('scroll') ? ' tabindex="0" aria-label="' + esc(label) + '"' : '')}></ul>`;
    const st = ensureKeyed(id, listClass, shell, 'ul');
    syncKeyed(
      st,
      items.map((i) => ({ key: i.key, html: i.html.v })),
    );
  }
  /** Section vide : titre discret et une ligne utile, jamais un grand bloc pour rien. */
  function markEmpty(id: string, empty: boolean): void {
    $(id).classList.toggle('is-empty', empty);
  }

  /** Liste courte (3 noms) et un compteur du reste : une ligne, jamais un mur de texte. */
  const listOf = (names: string[]): string => {
    const unique = [...new Set(names)];
    return unique.slice(0, 3).join(', ') + (unique.length > 3 ? ' +' + (unique.length - 3) : '');
  };

  // ── Statuts : libellé + forme + couleur (jamais la couleur seule) ─────────
  const KO = new Set(['MISSING', 'BROKEN', 'CORRUPT', 'interrupted', 'failed']);
  const WARN = new Set(['WAITING', 'REMOVING', 'PENDING']);
  const OK = new Set(['ACTIVE', 'RUNNING', 'running', 'done', 'RESOLVED']);
  const KIND_ICON: Record<string, string> = {
    ok: 'check',
    warn: 'warn',
    ko: 'x',
    info: 'info',
    auto: 'bolt',
  };
  function badge(value: unknown, kind?: string, icon?: string): Safe {
    const v = text(value);
    const k = kind ?? (KO.has(v) ? 'ko' : WARN.has(v) ? 'warn' : OK.has(v) ? 'ok' : '');
    const name = icon ?? (WARN.has(v) ? 'clock' : (KIND_ICON[k] ?? ''));
    return h`<span class="badge${new Safe(k ? ' is-' + k : '')}">${name ? ic(name, 'sm') : ''}${v}</span>`;
  }

  // ── Annonces (lecteur d'écran) : polies, seulement sur changement réel ───
  let announceTimer: any = null;
  function announce(messages: string[]): void {
    if (messages.length === 0) return;
    const el = $('announcer');
    // Une seule phrase par lot : jamais un défilé d'annonces à chaque push.
    el.textContent = messages.join(' ');
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      el.textContent = '';
    }, 12000);
  }

  let toastTimer: any = null;
  /** Retour non bloquant ; dans un dialogue modal (le toast serait inerte), `sink` reçoit le message. */
  function toast(msg: string, sticky?: boolean, sink?: any): void {
    const el = sink || $('toast');
    el.textContent = msg;
    if (sink) {
      sink.classList.remove('is-error');
      return;
    }
    clearTimeout(toastTimer);
    if (sticky)
      toastTimer = setTimeout(() => {
        el.textContent = '';
      }, 10000);
  }

  // ── Alertes : icône de gravité (forme + couleur), titre, une ligne, action ─
  const SEV_ICON: Record<string, string> = { error: 'x', warn: 'warn', info: 'info' };
  function alertCard(sev: string, title: string, body: unknown, actions: unknown = ''): Safe {
    return h`<div class="card sev-${sev}" role="group" aria-label="${title}"><span class="sev">${ic(SEV_ICON[sev])}</span><div class="card-body"><p class="card-title"><span class="sr">${t('sev.' + sev)} : </span>${title}</p><p class="card-text">${body}</p></div><div class="card-actions">${actions}</div></div>`;
  }

  // ── État de la liaison : direct / hors ligne / obsolète ──────────────────
  let live: 'connecting' | 'live' | 'offline' = 'connecting';
  let lastUpdateAt: number | null = null;
  // Le bandeau cumule deux informations indépendantes : l'échec du premier
  // chargement (alerte) et l'obsolescence de l'affichage (flux coupé).
  let loadError: string | null = null;
  function paintBanner(): void {
    const failed =
      loadError == null
        ? ''
        : h`<div class="card sev-error" role="alert"><span class="sev">${ic('x')}</span><div class="card-body"><p class="card-title">${t('banner.loadError', { message: loadError })}</p></div><div class="card-actions"><button type="button" data-retry="1">${t('banner.retry')}</button></div></div>`;
    const stale =
      live === 'offline' && !signedOut
        ? h`<div class="card sev-warn" role="status"><span class="sev">${ic('warn')}</span><div class="card-body"><p class="card-text">${
            lastUpdateAt == null
              ? t('banner.offline.never')
              : t('banner.offline', { time: new Date(lastUpdateAt).toLocaleTimeString(LANG) })
          }</p></div></div>`
        : '';
    setSection('banner', h`${failed}${stale}`);
  }
  function setLive(next: 'connecting' | 'live' | 'offline'): void {
    const previous = live;
    live = next;
    const el = $('live');
    el.className =
      'live' + (next === 'live' ? ' is-live' : next === 'offline' ? ' is-offline' : '');
    el.textContent = t(
      'live.' + (next === 'connecting' ? 'connecting' : next === 'live' ? 'live' : 'offline'),
    );
    paintBanner();
    // Seules les TRANSITIONS réelles s'annoncent : perte du flux, puis rétablissement
    // (jamais « connexion rétablie » à la première connexion).
    if (signedOut || previous === next || next === 'connecting') return;
    if (next === 'offline' && rendered.revision > 0) announce([t('announce.offline')]);
    else if (next === 'live' && previous === 'offline') announce([t('announce.online')]);
  }

  // ── Striart Control Protocol v1 (JSON-RPC 2.0 sur POST /rpc) ─────────────
  let rpcId = 0;
  let signedOut = false;
  function showSignedOut(): void {
    if (signedOut) return;
    signedOut = true;
    stopPolling();
    events.close();
    setLive('offline');
    setSection('banner', '');
    setSection(
      'auth',
      h`<div class="card sev-error" role="alert"><span class="sev">${ic('x')}</span><div class="card-body"><p class="card-text">${th('auth.expired')}</p></div></div>`,
    );
  }
  async function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    if (signedOut) throw new Error(t('toast.sessionExpired'));
    const r = await fetch('/rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params || {} }),
    });
    if (r.status === 401) {
      showSignedOut();
      throw new Error(t('toast.sessionExpired'));
    }
    const msg = await r.json();
    if (msg.error) {
      const doc = (msg.error.data && msg.error.data.error) || {};
      const e: any = new Error(doc.message || msg.error.message);
      e.code = doc.code || null;
      e.hint = doc.hint || null;
      e.details = doc.details || null;
      throw e;
    }
    return msg.result;
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  function summarizeSync(results: any[]): string {
    const of = (...st: string[]) => results.filter((r) => st.includes(r.status));
    const deferred = of('SKIPPED_DIRTY', 'SKIPPED_SESSION');
    const conflicts = of('REBASE_CONFLICT', 'STASH_CONFLICT');
    const parts = [
      t('sum.sync.rebased', { n: of('REBASED').length }),
      t('sum.sync.upToDate', { n: of('UP_TO_DATE').length }),
    ];
    if (deferred.length > 0) parts.push(t('sum.sync.deferred', { n: deferred.length }));
    if (conflicts.length > 0)
      parts.push(
        t('sum.sync.conflicts', {
          n: conflicts.length,
          agents: conflicts.map((r) => r.agent).join(', '),
        }),
      );
    return parts.join(', ');
  }
  /** Dit l'état RÉSULTANT de l'action (pas seulement « fait »). */
  function summarize(method: string, d: any, params: Record<string, unknown>): string {
    switch (method) {
      case 'task.run':
        return d.mode === 'autonomous'
          ? t('sum.autonomousStarted', { profile: d.profile })
          : text(d.run.status);
      case 'agent.merge': {
        const key = MERGE_SUMMARY[text(d.status)];
        return key
          ? t(key, { agent: text(params.agent), branch: state?.config.targetBranch })
          : text(d.status);
      }
      case 'agent.sync':
        return summarizeSync(d.results);
      case 'agent.stop':
        return t('sum.stopped');
      case 'clones.clean':
        return t('sum.clean', {
          n: d.removed.length,
          size: formatBytes(d.removed.reduce((n: number, r: any) => n + r.freedBytes, 0)),
          kept: d.skipped.length,
        });
      case 'workspace.prune':
        return t('sum.prune', {
          clones: d.clones.removed.length,
          tickets: d.tickets.removed.length,
          size: formatBytes(d.freedBytes),
        });
      case 'workspace.gc': {
        const verdicts = (d.agents ?? []).filter((x: any) =>
          ['idle', 'warned', 'closable'].includes(x.stage),
        );
        return t(d.dryRun ? 'sum.gc.dry' : 'sum.gc', {
          idle: verdicts.length,
          closable: verdicts.filter((x: any) => x.closable).length,
          closed: (d.closed ?? []).length,
        });
      }
      case 'reconcile.run':
        return t('sum.reconcile', {
          sessions: d.sessionPidsCleared.length,
          started: d.started.length,
          waiting: d.stillWaiting.length,
        });
      case 'queue.retry':
        return t('sum.retry', { started: d.started.length, waiting: d.stillWaiting.length });
      case 'ticket.prepare':
        return t('sum.prepare', { n: d.files.filter((f: any) => f.created).length });
      case 'ticket.apply':
        return text(d.result.status);
      case 'ticket.close':
        return t('sum.closed');
      case 'permission.answer':
        return t('sum.permission', { agent: d.agent });
      case 'mainSession.release':
        return t('sum.released');
      case 'semantic.unlock':
        return t('sum.unlocked');
      default:
        return d && d.status ? text(d.status) : t('sum.done');
    }
  }
  const MERGE_SUMMARY: Record<string, string> = {
    MERGED: 'sum.merged',
    UP_TO_DATE: 'sum.upToDate',
    CONFLICT: 'sum.mergeConflict',
    GATE_FAILED: 'sum.gateFailed',
  };
  let busy = false;
  const actionLabel = (method: string) => t('act.' + method);
  // `ok` n'est vrai QUE si l'action a été envoyée ET a abouti nominalement : les
  // appelants qui détruisent un état local (fermer le dialogue, vider le champ)
  // ne le font que sur ce true — jamais sur un refus, une erreur, ou une requête
  // sautée par le garde busy.
  async function runAction(
    method: string,
    params: Record<string, unknown>,
    sink?: any,
  ): Promise<{ ok: boolean; message: string }> {
    if (busy) {
      toast(t('toast.busy'), true, sink);
      return { ok: false, message: t('toast.busy') };
    }
    busy = true;
    document.body.setAttribute('aria-busy', 'true');
    toast(t('toast.running', { action: actionLabel(method) }), false, sink);
    let ok = false;
    let message = '';
    try {
      const doc = await rpc(method, params);
      ok = doc.ok;
      const warnings = (doc.warnings || []).map((w: any) => ' ⚠ ' + w.message).join('');
      const summary = summarize(method, doc.data, params) + warnings;
      message = doc.ok
        ? t('toast.ok', { action: actionLabel(method), summary })
        : t('toast.fail', { action: actionLabel(method), message: summary });
    } catch (e: any) {
      message = t('toast.fail', {
        action: actionLabel(method),
        message: e.message + (e.code ? ' [' + e.code + ']' : '') + (e.hint ? ' — ' + e.hint : ''),
      });
    } finally {
      busy = false;
      document.body.removeAttribute('aria-busy');
      refresh();
    }
    toast(message, true, sink);
    if (sink && !ok) sink.classList.add('is-error');
    return { ok, message };
  }
  function actionButton(
    act: string,
    label: string,
    confirm: string,
    extra: Record<string, string> = {},
    cls = '',
    ariaLabel = '',
  ): Safe {
    const attrs = Object.entries(extra)
      .map(([k, v]) => ' data-' + k + '="' + esc(v) + '"')
      .join('');
    return h`<button type="button" data-act="${act}"${new Safe(confirm ? ' data-confirm="' + esc(confirm) + '"' : '')}${new Safe(cls.includes('danger') ? ' data-danger="1"' : '')}${new Safe(attrs)}${new Safe(cls ? ' class="' + esc(cls) + '"' : '')}${new Safe(ariaLabel ? ' aria-label="' + esc(ariaLabel) + '"' : '')}>${label}</button>`;
  }
  function menuItem(
    act: string,
    label: string,
    desc: string,
    confirm: string,
    extra: Record<string, string>,
    danger: boolean,
    ariaLabel: string,
  ): Safe {
    const attrs = Object.entries(extra)
      .map(([k, v]) => ' data-' + k + '="' + esc(v) + '"')
      .join('');
    return h`<button type="button" role="menuitem" class="menu-item${new Safe(danger ? ' danger' : '')}" data-act="${act}"${new Safe(confirm ? ' data-confirm="' + esc(confirm) + '"' : '')}${new Safe(danger ? ' data-danger="1"' : '')}${new Safe(attrs)} aria-label="${ariaLabel}"><span>${label}</span><span class="desc">${desc}</span></button>`;
  }

  // ── Dialogues natifs (focus piégé et Échap par le navigateur) ────────────
  function openDialog(id: string): any {
    const dlg = $(id);
    if (!dlg.open) dlg.showModal();
    return dlg;
  }
  function closeDialog(id: string): void {
    const dlg = $(id);
    if (dlg.open) dlg.close();
  }

  // Confirmation proportionnée : la conséquence est écrite AVANT d'agir ; une action
  // sévère exige de saisir le nom de la cible. Le chemin sûr (Annuler) a le focus
  // quand l'action est destructrice : le dangereux n'est jamais le défaut.
  interface Pending {
    act: string;
    params: Record<string, unknown>;
    ticket: string;
    word: string;
  }
  let pending: Pending | null = null;
  function paramsOf(ds: Record<string, string>): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    if (ds.agent) params.agent = ds.agent;
    if (ds.ticket) params.id = ds.ticket;
    if (ds.perm) {
      params.id = ds.perm;
      params.option = ds.option;
    }
    if (ds.force === '1') params.force = true;
    if (ds.dryrun === '1') params.dryRun = true;
    return params;
  }
  function askConfirm(ds: Record<string, string>): void {
    const word = ds.type || '';
    pending = { act: ds.act, params: paramsOf(ds), ticket: ds.ticket || '', word };
    const danger = ds.danger === '1';
    const title =
      ds.title ||
      actionLabel(ds.act) + (ds.agent ? ' — ' + ds.agent : ds.ticket ? ' — ' + ds.ticket : '');
    setText('confirm-title', title);
    const note = $('confirm-text');
    note.textContent = ds.confirm;
    note.classList.toggle('danger', danger);
    const ok = $('confirm-ok');
    ok.className = danger ? 'danger solid' : 'primary';
    $('confirm-typed').hidden = !word;
    const input = $('confirm-input');
    input.value = '';
    if (word) setSection('confirm-label', th('confirm.type', { word }));
    ok.disabled = !!word;
    openDialog('dlg-confirm');
    (word ? input : danger ? $('confirm-cancel') : ok).focus();
  }
  $('confirm-input').addEventListener('input', () => {
    $('confirm-ok').disabled = !pending || $('confirm-input').value.trim() !== pending.word;
  });
  $('confirm-form').addEventListener('submit', (e: Event) => {
    e.preventDefault();
    const p = pending;
    if (!p || (p.word && $('confirm-input').value.trim() !== p.word)) return;
    pending = null;
    closeDialog('dlg-confirm');
    void execute(p.act, p.params, p.ticket);
  });
  $('dlg-confirm').addEventListener('close', () => {
    pending = null;
  });
  async function execute(
    act: string,
    params: Record<string, unknown>,
    ticket: string,
  ): Promise<void> {
    const r = await runAction(act, params);
    // Le détail d'un ticket n'est pas dans l'état poussé (lu à la demande) :
    // on le relit après une action qui le concerne.
    if (r.ok && ticket) void showTicket(ticket);
  }

  // ── Menus et disclosures : flèches, Début/Fin, Échap, focus géré ─────────
  let openTrigger: any = null;
  let menuSeq = 0;
  function panelOf(trigger: any): any {
    return document.getElementById(trigger.getAttribute('aria-controls') || '');
  }
  function agentMenuHtml(a: any): Safe {
    const name = a.name;
    const n = Number(a.pendingCommits) || 0;
    const forceKey =
      n === 0
        ? 'confirm.forceStop.zero'
        : n === 1
          ? 'confirm.forceStop.one'
          : 'confirm.forceStop.other';
    const label = (key: string) => t(key).replace(/…$/, '') + ' — ' + name;
    return h`<button type="button" role="menuitem" class="menu-item" data-agent-open="${name}" aria-label="${t('btn.details') + ' — ' + name}"><span>${t('btn.details')}</span></button>${
      n > 0
        ? menuItem(
            'agent.sync',
            t('btn.sync1'),
            t('confirm.agentSync', { agent: name }),
            '',
            { agent: name },
            false,
            label('btn.sync1'),
          )
        : ''
    }${
      a.mode === 'autonomous'
        ? h`<button type="button" role="menuitem" class="menu-item" data-log="${name}" aria-label="${label('btn.log')}"><span>${t('btn.log')}</span></button>`
        : ''
    }<div class="menu-sep" role="separator"></div>${menuItem('agent.stop', t('btn.stop'), t('confirm.stop', { agent: name }), t('confirm.stop', { agent: name }), { agent: name, title: label('btn.stop') }, true, label('btn.stop'))}${menuItem('agent.stop', t('btn.forceStop'), t(forceKey, { agent: name, n }), t(forceKey, { agent: name, n }), { agent: name, force: '1', type: name, title: label('btn.forceStop') }, true, label('btn.forceStop'))}`;
  }
  function setMenu(trigger: any, open: boolean, focusFirst: boolean): void {
    let panel = panelOf(trigger);
    if (!panel && trigger.dataset.agentMenu) {
      const a = agentsByName.get(trigger.dataset.agentMenu);
      if (!a) return;
      panel = document.createElement('div');
      panel.className = 'menu-panel';
      panel.id = 'am-' + ++menuSeq;
      panel.setAttribute('role', 'menu');
      panel.setAttribute('aria-label', trigger.getAttribute('aria-label') || '');
      panel.hidden = true;
      panel.innerHTML = agentMenuHtml(a).v;
      trigger.parentElement.appendChild(panel);
      trigger.setAttribute('aria-controls', panel.id);
    }
    if (!panel) return;
    if (open && openTrigger && openTrigger !== trigger) setMenu(openTrigger, false, false);
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) openTrigger = trigger;
    else if (openTrigger === trigger) openTrigger = null;
    if (open && focusFirst) {
      const first = panel.querySelector('[role="menuitem"]');
      if (first) first.focus();
    }
  }
  const menuItems = (panel: any): any[] => [...panel.querySelectorAll('[role="menuitem"]')];

  // ── Thème : automatique (système) → clair → sombre, mémorisé ─────────────
  let themeMode: 'auto' | 'light' | 'dark' = 'auto';
  try {
    const saved = window.localStorage.getItem('striart-theme');
    if (saved === 'light' || saved === 'dark') themeMode = saved;
  } catch (_e) {
    themeMode = 'auto';
  }
  function applyTheme(): void {
    const root = document.documentElement;
    if (themeMode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', themeMode);
    setSection(
      'theme-ic',
      ic(themeMode === 'auto' ? 'auto' : themeMode === 'light' ? 'sun' : 'moon'),
    );
    $('theme-btn').setAttribute('aria-label', t('theme.btn', { mode: t('theme.' + themeMode) }));
    $('theme-btn').setAttribute('title', t('theme.btn', { mode: t('theme.' + themeMode) }));
  }
  applyTheme();
  $('theme-btn').addEventListener('click', () => {
    themeMode = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
    try {
      if (themeMode === 'auto') window.localStorage.removeItem('striart-theme');
      else window.localStorage.setItem('striart-theme', themeMode);
    } catch (_e) {
      // Stockage indisponible : le thème reste appliqué pour cette page seulement.
    }
    applyTheme();
  });

  // ── Rendu de l'état ──────────────────────────────────────────────────────
  let rendered = { instance: null as string | null, revision: 0 };
  let firstRender = true;
  let state: any = null;
  const agentsByName = new Map<string, any>();
  const seen = {
    perm: new Set<string>(),
    elic: new Set<string>(),
    review: new Set<string>(),
    tickets: 0,
    main: false,
  };
  let agentFilter = 'all';
  let agentQuery = '';
  const TICKET_CARDS = 3;

  function render(s: any): void {
    if (s.instanceId === rendered.instance && s.revision <= rendered.revision) return;
    rendered = { instance: s.instanceId, revision: s.revision };
    state = s;
    lastUpdateAt = Date.now();
    setText('meta', t('live.updated', { time: time(s.generatedAt) }));
    loadError = null;
    if (live !== 'live') setLive('live');
    paintBanner();
    if (openTrigger && !openTrigger.isConnected) openTrigger = null;
    const permissions: any[] = s.permissions ?? [];
    const elicitations: any[] = s.elicitations ?? [];
    const reviews: any[] = s.reviews ?? [];
    const pendingReviews = reviews.filter((r) => r.status === 'PENDING' && r.alive);
    const brokenAgents = s.agents.filter(
      (a: any) => a.status === 'BROKEN' || a.status === 'MISSING',
    );
    const mainAlive = !!(s.mainSession && s.mainSession.alive);
    // Inactivité signalée (avertie ou fermable) : une carte « À traiter » par agent concerné.
    const idleCards = (s.agents as any[])
      .map((a: any) => idleVerdict(s, text(a.name)))
      .filter((v: any) => v && (v.stage === 'warned' || v.stage === 'closable'));

    // — Annonces : seulement ce qui est NOUVEAU depuis le rendu précédent.
    const news: string[] = [];
    if (!firstRender) {
      for (const p of permissions)
        if (!seen.perm.has(p.id)) news.push(t('announce.perm', { agent: p.agent, title: p.title }));
      for (const e of elicitations)
        if (!seen.elic.has(e.id)) news.push(t('announce.elic', { agent: e.agent }));
      for (const r of pendingReviews)
        if (!seen.review.has(r.id)) news.push(t('announce.review', { agent: r.agent }));
      if (mainAlive && !seen.main) news.push(t('announce.main'));
      if (s.tickets.length > seen.tickets)
        news.push(tn('announce.ticket', s.tickets.length - seen.tickets));
    }
    seen.perm = new Set(permissions.map((p) => p.id));
    seen.elic = new Set(elicitations.map((e) => e.id));
    seen.review = new Set(pendingReviews.map((r) => r.id));
    seen.tickets = s.tickets.length;
    seen.main = mainAlive;
    firstRender = false;
    announce(news);

    // — En-tête : dépôt, branche cible, détails (la commande de test y est rangée).
    setText('branch-name', s.config.targetBranch);
    $('chip-branch').hidden = false;
    setSection(
      'info-body',
      h`<dt>${t('repo.target')}</dt><dd><code>${s.config.targetBranch}</code></dd><dt>${t('repo.test')}</dt><dd><code>${s.config.testCommand}</code></dd><dt>${t('repo.options')}</dt><dd>${t('repo.semantic')} : ${s.config.semanticMerge ? t('repo.on') : t('repo.off')}<br>${t('repo.rebase')} : ${s.config.autoRebase ? t('repo.on') : t('repo.off')}<br>${t('repo.push')} : ${s.config.autoPush ? t('repo.on') : t('repo.off')}</dd><dt>${t('repo.watcher')}</dt><dd>${s.daemon.running ? t('watcher.on', { pid: s.daemon.pid }) : th('watcher.off')}</dd>`,
    );
    $('rollback-btn').dataset.type = s.config.targetBranch;

    // — Résumé chiffré.
    const activeAgents = s.agents.filter((a: any) => a.status === 'ACTIVE').length;
    const pendingTotal = s.agents.reduce(
      (n: number, a: any) => n + (Number(a.pendingCommits) || 0),
      0,
    );
    const queued = s.tasks.filter((x: any) => x.status === 'WAITING');
    setText('n-agents', String(activeAgents));
    setText('n-pending', String(pendingTotal));
    setText('n-conflicts', String(s.tickets.length));
    setText('n-queue', String(queued.length));
    $('stat-pending').classList.toggle('is-info', pendingTotal > 0);
    $('stat-conflicts').classList.toggle('is-ko', s.tickets.length > 0);

    // — Zone « À traiter » : cartes d'alerte, chacune avec son action directe.
    setSection(
      'main-session',
      !s.mainSession
        ? ''
        : s.mainSession.alive
          ? alertCard(
              'error',
              t('alert.main.title'),
              t('alert.main.text', { reason: s.mainSession.reason, pid: s.mainSession.pid }),
              actionButton(
                'mainSession.release',
                t('btn.release'),
                t('confirm.release'),
                { type: String(s.mainSession.pid), title: t('act.mainSession.release') },
                'danger',
              ),
            )
          : alertCard(
              'warn',
              t('alert.main.dead.title'),
              t('alert.main.dead.text', { pid: s.mainSession.pid }),
            ),
    );
    setSection(
      'manual',
      s.state.manualMode
        ? alertCard(
            'error',
            t('alert.manual.title'),
            t('alert.manual.text'),
            actionButton('semantic.unlock', t('btn.unlock'), t('confirm.unlock'), {}, 'primary'),
          )
        : '',
    );
    const reasonLabel = (code: unknown) =>
      dict['reason.' + code] ?? base['reason.' + code] ?? text(code);
    const ticketCards = s.tickets
      .slice(0, TICKET_CARDS)
      .map((x: any) =>
        x.status === 'CORRUPT'
          ? alertCard(
              'error',
              t('alert.ticket.title', { agent: x.id }),
              h`${t('ticket.corrupt')} — ${x.cause}`,
              actionButton(
                'ticket.close',
                t('btn.close'),
                t('confirm.closeCorrupt', { id: x.id }),
                { ticket: x.id },
                'danger',
                t('btn.close') + ' ' + x.id,
              ),
            )
          : alertCard(
              'error',
              t('alert.ticket.title', { agent: x.agent ?? '—' }),
              tn('alert.ticket.text', x.conflictedFiles.length, { reason: reasonLabel(x.reason) }),
              h`<button type="button" class="primary open-ticket" data-ticket-open="${x.id}" aria-label="${t('btn.resolve') + ' ' + x.id}">${t('btn.resolve')}</button>`,
            ),
      );
    const moreTickets = s.tickets.length - TICKET_CARDS;
    setSection(
      'attention-summary',
      h`${ticketCards}${
        moreTickets > 0
          ? h`<p class="hint">${tn('attention.more', moreTickets)} <a class="btn" href="#sec-tickets">${t('btn.seeAll')}</a></p>`
          : ''
      }${brokenAgents.map((a: any) =>
        alertCard(
          'error',
          t('alert.broken.title', { agent: a.name }),
          t('alert.broken.text', { status: a.status }),
          h`<button type="button" data-agent-open="${a.name}" aria-label="${t('btn.seeAgent') + ' ' + a.name}">${t('btn.seeAgent')}</button>`,
        ),
      )}${idleCards.map((v: any) =>
        alertCard(
          'warn',
          t('alert.idle.title', { agent: v.agent }),
          idleCardText(s, v),
          h`${actionButton('workspace.gc', t('btn.gcDry'), '', { agent: v.agent, dryrun: '1' }, '', t('btn.gcDry') + ' — ' + v.agent)}<button type="button" data-agent-open="${v.agent}" aria-label="${t('btn.seeAgent') + ' ' + v.agent}">${t('btn.seeAgent')}</button>`,
        ),
      )}`,
    );
    // Profils : le remplacement d'un <select> ramène la sélection à la première
    // option ; on restaure le choix de l'utilisateur tant que le profil existe.
    const profileSel = $('task-profile');
    const prevProfile = profileSel.value;
    setSection(
      'task-profile',
      s.profiles.length
        ? h`${s.profiles.map((p: any) => h`<option value="${p.name}">${p.name}${p.acp ? ' · ACP' : ''}</option>`)}`
        : h`<option value="">${t('task.profile.none')}</option>`,
    );
    if (prevProfile && [...profileSel.options].some((o: any) => o.value === prevProfile))
      profileSel.value = prevProfile;

    // Semi-autonome (ACP 'ask') : chaque demande attend UN humain.
    setSection(
      'permissions',
      h`${permissions.map((p: any) =>
        alertCard(
          'warn',
          t('alert.perm.title', { agent: p.agent }),
          t('alert.perm.text', { title: p.title, time: time(p.expiresAt) }),
          h`${(p.options as any[]).map((o) => {
            const kind = text(o.kind);
            const label = o.name || o.kind || o.optionId;
            const always = kind === 'allow_always';
            const reject = kind.startsWith('reject');
            return actionButton(
              'permission.answer',
              label,
              always ? t('confirm.allowAlways') : '',
              { perm: p.id, option: o.optionId, title: label + ' — ' + p.agent },
              reject ? 'danger' : always ? 'danger' : '',
              label + ' — ' + p.agent + ' : ' + p.title,
            );
          })}`,
        ),
      )}`,
    );
    syncElicitations(elicitations);
    syncReviews(reviews);
    renderOrchestration(s.orchestration, reviews);

    // Watcher arrêté : l'action directe est la commande à copier (aucune duplication).
    setSection(
      'watcher',
      s.daemon.running
        ? ''
        : alertCard(
            'warn',
            t('alert.watcher.title'),
            h`${t('alert.watcher.text')}${s.daemon.stale ? t('alert.watcher.stale') : ''} <code>striart watch --daemon</code>`,
            h`<button type="button" data-copy="striart watch --daemon">${ic('copy')}${t('btn.copyCmd')}</button>`,
          ),
    );

    const count =
      permissions.length +
      elicitations.length +
      pendingReviews.length +
      (mainAlive ? 1 : 0) +
      (s.state.manualMode ? 1 : 0) +
      s.tickets.length +
      brokenAgents.length +
      idleCards.length;
    const anyCard = count > 0 || !s.daemon.running || (!!s.mainSession && !mainAlive);
    setText('attention-count', count > 0 ? String(count) : '');
    $('sec-attention').hidden = !anyCard;
    $('all-clear').hidden = anyCard;
    document.title = count > 0 ? t('title.attention', { n: count }) : t('title.idle');

    // — Agents, conflits, colonne latérale.
    agentsByName.clear();
    for (const a of s.agents) agentsByName.set(a.name, a);
    renderAgents(s);
    setTable(
      'tickets',
      t('sec.tickets'),
      s.tickets,
      [
        { label: t('col.ticket'), render: (x) => x.id, mono: true },
        {
          label: t('col.reason'),
          render: (x) =>
            x.status === 'CORRUPT'
              ? h`${badge('CORRUPT', 'ko')} <span class="muted">${x.cause}</span>`
              : h`<div class="reason"><span>${reasonLabel(x.reason)}</span><span class="code">${x.reason}</span></div>`,
        },
        {
          label: t('col.agent'),
          render: (x) => (x.agent == null ? h`<span class="muted">—</span>` : x.agent),
          mono: true,
        },
        {
          label: t('col.files'),
          render: (x) =>
            x.conflictedFiles.length === 0
              ? h`<span class="muted">—</span>`
              : h`<span class="mono">${x.conflictedFiles[0]}</span>${x.conflictedFiles.length > 1 ? h` <span class="muted">+${x.conflictedFiles.length - 1}</span>` : ''}`,
        },
        { label: t('col.created'), render: (x) => timeEl(x.createdAt) },
        { label: t('col.actions'), render: ticketRowAction },
      ],
      (x) => x.id,
      h`<p class="quiet">${t('none.tickets')}</p>`,
    );
    markEmpty('sec-tickets', s.tickets.length === 0);
    setText('tickets-count', s.tickets.length > 0 ? String(s.tickets.length) : '');

    setItems(
      'queue',
      'rows',
      t('sec.queue'),
      queued.map((x: any) => ({
        key: x.id,
        html: h`<li><div class="row-top"><span class="mono">${x.agent}</span><span class="muted mono">${x.id}</span></div><div class="row-sub">${
          x.blockedBy.length > 0
            ? t('queue.blocked', {
                who:
                  listOf(x.blockedBy.map((b: any) => b.agent)) +
                  ' · ' +
                  listOf(x.blockedBy.flatMap((b: any) => b.files)),
              })
            : t('queue.ready')
        }${x.after ? ' · ' + t('queue.after', { id: x.after }) : ''}</div></li>`,
      })),
      h`<p class="quiet">${t('none.queue')}</p>`,
    );
    markEmpty('sec-queue', queued.length === 0);
    setText('queue-count', queued.length > 0 ? String(queued.length) : '');

    setItems(
      'heatmap',
      'rows scroll',
      t('sec.heat'),
      s.heatmap.map((x: any) => {
        const level =
          x.conflicts > 0 ? 'high' : x.agents.length + x.queued.length >= 2 ? 'mid' : 'low';
        const who = [
          x.agents.length ? t('heat.agents') + ' ' + x.agents.join(', ') : '',
          x.queued.length ? t('heat.queued') + ' ' + x.queued.join(', ') : '',
          x.conflicts ? t('heat.conflicts', { n: x.conflicts }) : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          key: x.file,
          html: h`<li><div class="row-top"><span class="mono">${x.file}</span>${badge(
            t('heat.level.' + level),
            level === 'high' ? 'ko' : level === 'mid' ? 'warn' : '',
            level === 'high' ? 'x' : level === 'mid' ? 'warn' : '',
          )}</div><div class="row-sub">${t('heat.score', { score: x.score })}${who ? ' · ' + who : ''}</div></li>`,
        };
      }),
      h`<p class="quiet">${t('none.heat')}</p>`,
    );
    markEmpty('sec-heat', s.heatmap.length === 0);

    setItems(
      'history',
      'rows scroll',
      t('sec.history'),
      s.history.map((x: any) => ({
        key: x.sha + '|' + x.date + '|' + x.type,
        html: h`<li><div class="row-top"><span class="mono">${x.agent}</span>${timeEl(x.date)}</div><div class="row-sub">${x.type === 'rollback' ? badge(t('type.rollback'), 'warn', 'rollback') : badge(t('type.merge'), 'ok', 'check')} <span class="mono">${(x.sha || '').slice(0, 8)}</span>${x.semantic ? h` · ${t('history.semantic')} ${x.semanticFiles.join(', ')}` : ''}</div></li>`,
      })),
      h`<p class="quiet">${t('none.history')}</p>`,
    );
    markEmpty('sec-history', s.history.length === 0);
    if (agentDlgFor) renderAgentDetail();
  }

  // ── Agents : regroupés par état (« À traiter · En cours · Inactifs ») ────
  type Group = 'attention' | 'running' | 'idle';
  function agentGroup(a: any, withRequest: Set<string>, withTicket: Set<string>): Group {
    if (a.status === 'BROKEN' || a.status === 'MISSING') return 'attention';
    if ((Number(a.pendingCommits) || 0) > 0 || withRequest.has(a.name) || withTicket.has(a.name))
      return 'attention';
    if (a.status === 'REMOVING') return 'idle';
    if (a.session && (a.session.state === 'running' || a.session.state === 'recent-activity'))
      return 'running';
    if (a.acpHost && a.acpHost.running) return 'running';
    return 'idle';
  }
  function sessionLabel(a: any): string {
    const s = a.session;
    if (!s || s.state === 'idle') return '';
    if (s.state === 'running') return s.via === 'pty' ? t('session.pty') : t('session.auto');
    return t('session.recent');
  }
  const shortBranch = (a: any): string => {
    const b = text(a.currentBranch ?? a.branch);
    const prefix = 'striart/' + a.name + '/';
    return b.startsWith(prefix) ? b.slice(prefix.length) : b;
  };
  function agentRow(a: any): Safe {
    const name = text(a.name);
    const n = Number(a.pendingCommits) || 0;
    if (a.status === 'REMOVING')
      return h`<li class="agent" data-name="${name}"><div class="agent-main"><div class="agent-title"><span class="agent-name trunc" title="${name}">${name}</span>${badge('REMOVING')}</div><div class="agent-sub">${t('agent.removing')}</div></div></li>`;
    const sess = sessionLabel(a);
    const sessFull =
      a.session && a.session.state === 'running'
        ? t('session.pid', { label: sess, pid: a.session.pid })
        : sess;
    const tool = a.command ? text(a.command) : '';
    const size = a.sizeBytes != null ? formatBytes(a.sizeBytes) : '';
    const broken = a.status === 'BROKEN' || a.status === 'MISSING';
    const primary = broken
      ? h`<button type="button" data-agent-open="${name}" aria-label="${t('btn.details') + ' ' + name}">${t('btn.details')}</button>`
      : n > 0
        ? actionButton(
            'agent.merge',
            t('btn.merge'),
            '',
            { agent: name },
            'primary',
            t('btn.merge') + ' ' + name,
          )
        : actionButton(
            'agent.sync',
            t('btn.sync1'),
            '',
            { agent: name },
            '',
            t('btn.sync1') + ' ' + name,
          );
    return h`<li class="agent" data-name="${name}"><div class="agent-main"><div class="agent-title"><span class="agent-name trunc" title="${name}">${name}</span>${badge(a.status)}${n > 0 ? badge(tn('agent.pending', n), 'info', 'commit') : ''}${a.mode === 'autonomous' ? badge(t('mode.autonomous') + (a.profile ? ' · ' + a.profile : ''), 'auto', 'bolt') : ''}${idleBadge(state, name)}</div><div class="agent-sub"><span class="branch" title="${text(a.currentBranch ?? a.branch)}">${ic('branch', 'sm')}<span class="trunc">${shortBranch(a)}</span></span><span class="msg trunc" title="${text(a.lastMessage ?? '')}">${a.lastMessage ?? t('agent.noCommit')}</span></div></div><div class="agent-meta">${sess ? h`<span title="${sessFull}">${ic('terminal', 'sm')}${sess}<span class="sr"> ${a.session.state === 'running' ? 'PID ' + a.session.pid : ''}</span></span>` : ''}${size || tool ? h`<span>${[size, tool].filter(Boolean).join(' · ')}</span>` : ''}</div><div class="agent-actions">${primary}<div class="menu end"><button type="button" class="ghost icon" data-agent-menu="${name}" aria-haspopup="menu" aria-expanded="false" aria-label="${t('btn.more') + ' — ' + name}" title="${t('btn.more')}">${ic('dots')}</button></div></div></li>`;
  }
  const GROUPS: Group[] = ['attention', 'running', 'idle'];
  const segBuilt: { done: boolean } = { done: false };
  function renderAgents(s: any): void {
    const withRequest = new Set<string>(
      [...(s.permissions ?? []), ...(s.elicitations ?? [])].map((r: any) => text(r.agent)),
    );
    for (const r of s.reviews ?? [])
      if (r.status === 'PENDING' && r.alive) withRequest.add(text(r.agent));
    const withTicket = new Set<string>(s.tickets.map((x: any) => text(x.agent)));
    const groups: Record<Group, any[]> = { attention: [], running: [], idle: [] };
    for (const a of s.agents) groups[agentGroup(a, withRequest, withTicket)].push(a);
    for (const g of GROUPS)
      groups[g].sort((x, y) => text(x.name).localeCompare(text(y.name), LANG, { numeric: true }));
    setText('agents-count', s.agents.length > 0 ? String(s.agents.length) : '');

    // Filtre : visible dès qu'il y a de quoi filtrer ; compteurs mis à jour en place
    // (le focus d'un bouton de filtre ne doit jamais être perdu par un push).
    const showFilters = s.agents.length >= 4;
    $('agent-filters').hidden = !showFilters;
    if (showFilters) {
      if (!segBuilt.done) {
        const seg = $('agent-seg');
        const defs: Array<[string, string]> = [
          ['all', t('filter.all')],
          ['attention', t('agents.group.attention')],
          ['running', t('agents.group.running')],
          ['idle', t('agents.group.idle')],
        ];
        for (const [key, label] of defs) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.filter = key;
          b.setAttribute('aria-pressed', String(key === agentFilter));
          const l = document.createElement('span');
          l.textContent = label + ' ';
          const c = document.createElement('span');
          c.className = 'muted';
          b.append(l, c);
          seg.appendChild(b);
        }
        segBuilt.done = true;
      }
      for (const b of $('agent-seg').children) {
        const key = b.dataset.filter;
        const c = key === 'all' ? s.agents.length : groups[key as Group].length;
        if (b.lastChild.textContent !== String(c)) b.lastChild.textContent = String(c);
        b.setAttribute('aria-pressed', String(key === agentFilter));
      }
    } else if (agentFilter !== 'all' || agentQuery) {
      agentFilter = 'all';
      agentQuery = '';
    }

    if (s.agents.length === 0) {
      delete keyedLists.agents;
      setSection(
        'agents',
        h`<div class="empty-state"><h3>${t('empty.agents.title')}</h3><p>${t('empty.agents.text')}</p><button type="button" class="primary" data-new-task="1">${ic('plus')}${t('btn.newTask')}</button></div>`,
      );
      return;
    }
    const q = agentQuery.trim().toLowerCase();
    const matches = (a: any) =>
      !q ||
      [a.name, a.branch, a.currentBranch, a.lastMessage].some((v) =>
        text(v).toLowerCase().includes(q),
      );
    const items: Array<{ key: string; html: Safe }> = [];
    for (const g of GROUPS) {
      if (agentFilter !== 'all' && agentFilter !== g) continue;
      const list = groups[g].filter(matches);
      if (list.length === 0) continue;
      if (agentFilter === 'all')
        items.push({
          key: 'g:' + g,
          html: h`<li class="grp"><h3>${t('agents.group.' + g)}</h3><span class="count">${list.length}</span></li>`,
        });
      for (const a of list) items.push({ key: a.name, html: agentRow(a) });
    }
    setItems(
      'agents',
      'list',
      t('sec.agents'),
      items,
      h`<p class="empty-state">${t('none.match')}</p>`,
    );
  }

  function ticketRowAction(x: any): Safe {
    return x.status === 'CORRUPT'
      ? h`<span class="muted">${t('ticket.corrupt')}</span> ${actionButton('ticket.close', t('btn.close'), t('confirm.closeCorrupt', { id: x.id }), { ticket: x.id }, 'danger', t('btn.close') + ' ' + x.id)}`
      : h`<button type="button" class="open-ticket" data-ticket-open="${x.id}" aria-label="${t('btn.open') + ' ' + x.id}">${t('btn.open')}</button>`;
  }

  // ── Détail d'un agent (ce que l'état expose, AVANT de proposer « Merger ») ─
  let agentDlgFor: string | null = null;
  function renderAgentDetail(): void {
    const a = agentDlgFor ? agentsByName.get(agentDlgFor) : null;
    if (!a || !state) {
      setSection(
        'agent-dlg-body',
        h`<h2 id="agent-dlg-title">${t('agent.detail.title', { agent: agentDlgFor })}</h2><p class="muted">${t('agent.detail.gone')}</p><div class="dlg-actions"><button type="button" data-close-dlg class="primary">${t('btn.closeDetail')}</button></div>`,
      );
      return;
    }
    const name = text(a.name);
    const n = Number(a.pendingCommits) || 0;
    const sess = sessionLabel(a);
    const locks = state.heatmap.filter((x: any) => x.agents.includes(name));
    const tickets = state.tickets.filter((x: any) => x.agent === name);
    const blocked = state.tasks.filter(
      (x: any) => x.status === 'WAITING' && x.blockedBy.some((b: any) => b.agent === name),
    );
    const none = h`<span class="muted">${t('d.none')}</span>`;
    const broken = a.status === 'BROKEN' || a.status === 'MISSING';
    setSection(
      'agent-dlg-body',
      h`<h2 id="agent-dlg-title">${t('agent.detail.title', { agent: name })}</h2><div class="agent-title">${badge(a.status)}${n > 0 ? badge(tn('agent.pending', n), 'info', 'commit') : ''}${a.mode === 'autonomous' ? badge(t('mode.autonomous'), 'auto', 'bolt') : ''}${idleBadge(state, name)}</div><dl class="kv"><dt>${t('d.branch')}</dt><dd class="mono">${a.currentBranch ?? a.branch}</dd><dt>${t('d.last')}</dt><dd>${a.lastMessage ?? t('agent.noCommit')}</dd><dt>${t('d.pending')}</dt><dd>${n}</dd><dt>${t('d.mode')}</dt><dd>${a.mode === 'autonomous' ? t('mode.autonomous') : t('mode.attended')}${a.profile ? ' · ' + a.profile : ''}${a.acpHost && a.acpHost.running ? ' · ' + t('host.acp', { state: a.acpHost.listening ? t('host.listening') : t('host.starting'), pid: a.acpHost.pid }) : ''}</dd><dt>${t('d.tool')}</dt><dd>${a.command ? a.command : none}</dd><dt>${t('d.session')}</dt><dd>${sess ? (a.session.state === 'running' ? t('session.pid', { label: sess, pid: a.session.pid }) : sess) : none}</dd><dt>${t('d.size')}</dt><dd>${a.sizeBytes != null ? formatBytes(a.sizeBytes) : none}</dd><dt>${t('d.idle')}</dt><dd>${idleDetail(state, name) || none}</dd><dt>${t('d.locks')}</dt><dd>${locks.length ? h`<ul>${locks.map((x: any) => h`<li class="mono">${x.file}</li>`)}</ul>` : none}</dd><dt>${t('d.tickets')}</dt><dd>${tickets.length ? h`<ul>${tickets.map((x: any) => h`<li><button type="button" class="linklike" data-ticket-open="${x.id}">${x.id}</button> — ${dict['reason.' + x.reason] ?? x.reason}</li>`)}</ul>` : none}</dd><dt>${t('d.queued')}</dt><dd>${blocked.length ? h`<ul>${blocked.map((x: any) => h`<li class="mono">${x.agent}</li>`)}</ul>` : none}</dd></dl><div class="dlg-actions">${a.mode === 'autonomous' ? h`<button type="button" data-log="${name}" aria-label="${t('btn.log') + ' — ' + name}">${t('btn.log')}</button>` : ''}${broken ? '' : actionButton('agent.sync', t('btn.sync1'), '', { agent: name }, '', t('btn.sync1') + ' ' + name)}${!broken && n > 0 ? actionButton('agent.merge', t('btn.merge'), '', { agent: name }, 'primary', t('btn.merge') + ' ' + name) : ''}<button type="button" data-close-dlg>${t('btn.closeDetail')}</button></div>`,
    );
  }
  function openAgentDetail(name: string): void {
    agentDlgFor = name;
    renderAgentDetail();
    openDialog('dlg-agent');
  }
  $('dlg-agent').addEventListener('close', () => {
    agentDlgFor = null;
  });

  // Repli sans flux : un appel ponctuel (premier rendu, reprise après coupure).
  async function refresh(): Promise<void> {
    try {
      render((await rpc('state.get')).data);
    } catch (e: any) {
      if (signedOut) return;
      if (rendered.revision === 0) loadFailed(e);
      else if (live !== 'offline') setLive('offline');
    }
  }
  /** Échec du premier chargement : jamais un « chargement… » sans fin. */
  function loadFailed(e: any): void {
    for (const id of ['agents', 'queue', 'heatmap', 'tickets', 'orchestration', 'history'])
      setSection(id, h`<p class="quiet">${t('unavailable')}</p>`);
    loadError = e.message;
    setLive('offline');
  }

  // ── Questions structurées des agents (élicitations ACP) ──────────────────
  // Le message, l'URL et le schéma viennent de l'AGENT : contenu non fiable,
  // toujours échappé, jamais interprété ; une URL est affichée, jamais ouverte.
  // Une carte par demande, créée une fois : un push d'état ne réécrit jamais
  // un formulaire en cours de saisie.
  const ELIC_INPUT_TYPES: Record<string, string> = { email: 'email', uri: 'url', date: 'date' };
  const elicCards: Record<string, any> = {};
  function enumOptions(p: any): Array<{ value: any; label: string }> | null {
    if (!p) return null;
    if (Array.isArray(p.enum))
      return p.enum.map((v: any, i: number) => ({
        value: v,
        label: (Array.isArray(p.enumNames) && p.enumNames[i]) || String(v),
      }));
    for (const key of ['oneOf', 'anyOf'])
      if (Array.isArray(p[key]))
        return p[key].map((o: any) => ({ value: o.const, label: o.title || String(o.const) }));
    return null;
  }
  function elicField(eid: string, index: number, name: string, p: any, required: boolean): Safe {
    const id = 'f-' + eid + '-' + index;
    const helpId = id + '-h';
    const help = p.description ? h`<div class="muted" id="${helpId}">${p.description}</div>` : '';
    const described = new Safe(p.description ? ' aria-describedby="' + esc(helpId) + '"' : '');
    const label = h`${p.title || name}${required ? h` <span aria-hidden="true">*</span><span class="sr"> ${t('elic.required')}</span>` : ''}`;
    const req = new Safe(required ? ' required' : '');
    if (p.type === 'boolean')
      return h`<div class="field"><div><input type="checkbox" id="${id}" data-field="${index}"${described}${new Safe(p.default === true ? ' checked' : '')}> <label for="${id}">${label}</label></div>${help}</div>`;
    if (p.type === 'array') {
      const opts = enumOptions(p.items) || [];
      return h`<fieldset class="field"${described}><legend>${label}</legend>${opts.map(
        (o, j) =>
          h`<label><input type="checkbox" data-field="${index}" data-multi="${j}"> ${o.label}</label>`,
      )}${help}</fieldset>`;
    }
    const opts = enumOptions(p);
    if (opts)
      return h`<div class="field"><label for="${id}">${label}</label><select id="${id}" data-field="${index}"${req}${described}>${required ? '' : h`<option value="">—</option>`}${opts.map((o, j) => h`<option value="${j}">${o.label}</option>`)}</select>${help}</div>`;
    const numeric = p.type === 'number' || p.type === 'integer';
    const bounds = numeric
      ? (p.minimum != null ? ' min="' + esc(p.minimum) + '"' : '') +
        (p.maximum != null ? ' max="' + esc(p.maximum) + '"' : '') +
        ' step="' +
        (p.type === 'integer' ? '1' : 'any') +
        '"'
      : (p.minLength != null ? ' minlength="' + esc(p.minLength) + '"' : '') +
        (p.maxLength != null ? ' maxlength="' + esc(p.maxLength) + '"' : '');
    const type = numeric ? 'number' : ELIC_INPUT_TYPES[p.format] || 'text';
    return h`<div class="field"><label for="${id}">${label}</label><input type="${type}" id="${id}" data-field="${index}"${req}${described}${new Safe(bounds)}${new Safe(p.format === 'date-time' ? ' placeholder="AAAA-MM-JJTHH:MM:SSZ"' : '')}>${help}</div>`;
  }
  function elicProperties(r: any): Array<{ name: string; p: any; required: boolean }> {
    const schema = r.requestedSchema || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.entries(schema.properties || {}).map(([name, p]) => ({
      name,
      p: p || {},
      required: required.has(name),
    }));
  }
  function elicContent(card: any, r: any): Record<string, unknown> {
    const content: Record<string, unknown> = {};
    elicProperties(r).forEach(({ name, p, required }, i) => {
      const els: any[] = [...card.querySelectorAll('[data-field="' + i + '"]')];
      if (p.type === 'boolean') {
        content[name] = els[0].checked;
        return;
      }
      if (p.type === 'array') {
        const opts = enumOptions(p.items) || [];
        const picked = els.filter((e) => e.checked).map((e) => opts[Number(e.dataset.multi)].value);
        if (picked.length > 0 || required) content[name] = picked;
        return;
      }
      const el = els[0];
      if (!el || el.value === '') return;
      const opts = enumOptions(p);
      if (opts) {
        content[name] = opts[Number(el.value)].value;
        return;
      }
      content[name] = p.type === 'number' || p.type === 'integer' ? Number(el.value) : el.value;
    });
    return content;
  }
  function elicCardHtml(r: any): Safe {
    const head = h`<h3 id="el-${r.id}" tabindex="-1">${t('elic.title', { agent: r.agent })}</h3><div class="untrusted"><span class="muted">${t('elic.message')}</span><pre tabindex="0" aria-label="${t('elic.message')}">${r.message}</pre></div><p class="muted">${t('elic.expires', { time: time(r.expiresAt) })}</p>`;
    const actions = h`<div class="elic-error" role="alert"></div><div class="actions"><button type="button" data-elic-action="decline" class="danger">${t('btn.decline')}</button> <button type="button" data-elic-action="cancel">${t('btn.cancel')}</button></div>`;
    if (r.mode === 'url')
      return h`${head}<p>${t('elic.url')} <code>${r.url}</code></p><div class="actions"><button type="button" data-elic-action="accept" class="primary">${t('btn.done')}</button></div>${actions}`;
    const fields = elicProperties(r).map(({ name, p, required }, i) =>
      elicField(text(r.id), i, name, p, required),
    );
    return h`${head}<form data-elic-form>${fields}<div class="actions"><button type="submit" class="primary">${t('btn.send')}</button></div>${actions}</form>`;
  }
  async function answerElicitation(card: any, r: any, action: string): Promise<void> {
    const err = card.querySelector('.elic-error');
    err.textContent = '';
    const params: Record<string, unknown> = { id: r.id, action };
    if (action === 'accept' && r.mode === 'form') {
      // Validation native (requis, bornes, formats) d'abord : messages du
      // navigateur, lisibles au lecteur d'écran ; le serveur revalide.
      const form = card.querySelector('form');
      if (!form.reportValidity()) return;
      params.content = elicContent(card, r);
    }
    try {
      await rpc('elicitation.answer', params);
      toast(t('elic.sent', { agent: r.agent }), true);
      card.remove();
      delete elicCards[r.id];
    } catch (e: any) {
      const field = e.details && e.details.field ? e.details.field : null;
      err.textContent =
        t('elic.fail', { message: e.message }) +
        (field ? ' ' + t('elic.field', { field }) : '') +
        (e.hint ? ' — ' + e.hint : '');
      if (e.code === 'ELICITATION_CONTENT_INVALID' && field) {
        const index = elicProperties(r).findIndex((f) => f.name === field);
        const target = index === -1 ? null : card.querySelector('[data-field="' + index + '"]');
        if (target) target.focus();
      }
    }
  }
  function syncElicitations(list: any[]): void {
    const host = $('elicitations');
    const ids = new Set(list.map((r) => r.id));
    for (const id of Object.keys(elicCards))
      if (!ids.has(id)) {
        elicCards[id].remove();
        delete elicCards[id];
      }
    for (const r of list) {
      if (elicCards[r.id]) continue;
      const card = document.createElement('section');
      card.className = 'card sev-warn';
      card.setAttribute('aria-labelledby', 'el-' + r.id);
      card.innerHTML =
        h`<span class="sev">${ic('info')}</span><div class="card-body">${elicCardHtml(r)}</div>`.v;
      host.appendChild(card);
      elicCards[r.id] = card;
      const form = card.querySelector('form');
      if (form)
        form.addEventListener('submit', (e: Event) => {
          e.preventDefault();
          void answerElicitation(card, r, 'accept');
        });
      for (const btn of card.querySelectorAll('button[data-elic-action]'))
        btn.addEventListener(
          'click',
          () => void answerElicitation(card, r, (btn as any).dataset.elicAction),
        );
    }
  }

  // ── Revues humaines (mode review) ────────────────────────────────────────
  // Le diffstat (sortie git), le résumé et les remarques du verdict viennent
  // d'AGENTS ou de noms de fichiers arbitraires : contenu non fiable. Une carte
  // par demande EN ATTENTE dont l'orchestrateur vit encore, créée une fois.
  const reviewCards: Record<string, any> = {};
  const REVIEW_CHOICES = [
    { verdict: 'approve', label: 'review.approve', needsComment: false, cls: 'primary' },
    { verdict: 'request-changes', label: 'review.request', needsComment: true, cls: '' },
    { verdict: 'reject', label: 'review.reject', needsComment: true, cls: 'danger' },
  ];
  function reviewCardHtml(r: any): Safe {
    const cid = 'rv-' + r.id;
    return h`<h3 id="${cid}-t" tabindex="-1">${t('review.title', { agent: r.agent, round: r.round })}</h3><p class="muted">${t('review.meta', { reviewer: r.reviewer, branch: r.branch, sha: (r.sha || '').slice(0, 8), time: time(r.expiresAt) })}</p><div class="untrusted"><span class="muted">${t('review.diffstat')}</span><pre tabindex="0" aria-label="${t('review.diffstat')}">${r.diffstat}</pre></div><form data-review-form aria-labelledby="${cid}-t"><div class="field"><label for="${cid}-c">${t('review.comment')}</label><textarea id="${cid}-c" rows="3" maxlength="16000" aria-describedby="${cid}-h"></textarea><div class="muted" id="${cid}-h">${t('review.commentHelp')}</div></div><div class="review-error" role="alert"></div><div class="actions">${REVIEW_CHOICES.map((c) => h`<button type="submit" data-verdict="${c.verdict}"${new Safe(c.cls ? ' class="' + c.cls + '"' : '')}>${t(c.label)}</button>`)}</div></form>`;
  }
  async function answerReview(
    card: any,
    r: any,
    choice: (typeof REVIEW_CHOICES)[number],
  ): Promise<void> {
    const err = card.querySelector('.review-error');
    const area = card.querySelector('textarea');
    err.textContent = '';
    const summary = area.value.trim();
    if (choice.needsComment && summary === '') {
      err.textContent = t('review.needComment');
      area.focus();
      return;
    }
    const params: Record<string, unknown> = { id: r.id, verdict: choice.verdict };
    if (summary !== '') params.summary = summary;
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    try {
      await rpc('review.answer', params);
      toast(t('review.sent', { verdict: choice.verdict, agent: r.agent }), true);
      card.remove();
      delete reviewCards[r.id];
    } catch (e: any) {
      for (const b of card.querySelectorAll('button')) b.disabled = false;
      err.textContent = t('elic.fail', {
        message: e.message + (e.code ? ' [' + e.code + ']' : '') + (e.hint ? ' — ' + e.hint : ''),
      });
    }
  }
  function syncReviews(list: any[]): void {
    const host = $('reviews');
    const pendingList = list.filter((r) => r.status === 'PENDING' && r.alive);
    const ids = new Set(pendingList.map((r) => r.id));
    for (const id of Object.keys(reviewCards))
      if (!ids.has(id)) {
        reviewCards[id].remove();
        delete reviewCards[id];
      }
    for (const r of pendingList) {
      if (reviewCards[r.id]) continue;
      const card = document.createElement('section');
      card.className = 'card sev-warn';
      card.setAttribute('aria-labelledby', 'rv-' + r.id + '-t');
      card.innerHTML =
        h`<span class="sev">${ic('info')}</span><div class="card-body">${reviewCardHtml(r)}</div>`.v;
      host.appendChild(card);
      reviewCards[r.id] = card;
      let clicked: (typeof REVIEW_CHOICES)[number] | undefined;
      for (const btn of card.querySelectorAll('button[data-verdict]'))
        btn.addEventListener('click', () => {
          clicked = REVIEW_CHOICES.find((c) => c.verdict === (btn as any).dataset.verdict);
        });
      card.querySelector('form').addEventListener('submit', (e: Event) => {
        e.preventDefault();
        if (clicked) void answerReview(card, r, clicked);
      });
    }
  }

  function renderOrchestration(o: any, reviews: any[]): void {
    const runs: any[] = (o && o.runs) || [];
    const groups: any[] = (o && o.groups) || [];
    const stale = reviews.filter((r) => r.status === 'PENDING' && !r.alive).length;
    const status = (v: any) =>
      v.status === 'running' && !v.alive ? badge(t('orch.interrupted'), 'ko') : badge(v.status);
    const empty = runs.length === 0 && groups.length === 0 && stale === 0;
    markEmpty('sec-orch', empty);
    setSection(
      'orchestration',
      empty
        ? h`<p class="quiet">${t('none.orch')}</p>`
        : h`${stale > 0 ? alertCard('warn', tn('review.stale', stale), '') : ''}${
            runs.length === 0
              ? ''
              : h`<h3>${t('orch.plans')}</h3><div class="panel-body">${tableHtml(
                  t('orch.plans'),
                  runs,
                  [
                    { label: t('col.plan'), render: (r) => r.id, mono: true },
                    { label: t('col.status'), render: status },
                    { label: t('col.mode'), render: (r) => r.mode },
                    {
                      label: t('col.nodes'),
                      render: (r) =>
                        r.nodes.filter((n: any) => n.state === 'done').length +
                        '/' +
                        r.nodes.length,
                    },
                    { label: t('col.since'), render: (r) => timeEl(r.startedAt) },
                  ],
                )}</div>`
          }${
            groups.length === 0
              ? ''
              : h`<h3>${t('orch.groups')}</h3><div class="panel-body">${tableHtml(
                  t('orch.groups'),
                  groups,
                  [
                    { label: t('col.group'), render: (g) => g.id, mono: true },
                    { label: t('col.mode'), render: (g) => g.kind },
                    { label: t('col.status'), render: status },
                    { label: t('col.round'), render: (g) => g.round },
                    { label: t('col.agents'), render: (g) => g.agents.join(', ') },
                    { label: t('col.result'), render: (g) => g.result },
                  ],
                )}</div>`
          }`,
    );
  }

  // ── Détails à la demande : log de session, ticket, diagnostic ────────────
  // Le focus va sur le titre du détail ouvert (navigation clavier) et revient à
  // l'élément déclencheur à la fermeture.
  let opener: any = null;
  function reveal(el: any, heading: any): void {
    if (heading) heading.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
  }
  function closeDetail(id: string): void {
    setSection(id, '');
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }
  async function showSessionLog(agent: string): Promise<void> {
    const el = $('session-log');
    let d: any;
    try {
      d = (await rpc('session.log', { agent })).data;
    } catch (e: any) {
      setSection(
        'session-log',
        h`<div class="detail"><p class="muted" role="status">${t('log.none', { agent, message: e.message })}</p></div>`,
      );
      return;
    }
    setSection(
      'session-log',
      h`<section class="detail" aria-labelledby="log-h"><h3 id="log-h" tabindex="-1">${t('log.title', { agent })}</h3><p class="muted mono">${d.path}</p><pre tabindex="0" aria-label="${t('log.title', { agent })}">${d.log || t('log.empty')}</pre><div><button type="button" data-close-detail="session-log">${t('btn.closeDetail')}</button></div></section>`,
    );
    reveal(el, document.getElementById('log-h'));
  }
  async function showTicket(id: string): Promise<void> {
    const el = $('ticket-detail');
    let tk: any;
    try {
      tk = (await rpc('ticket.get', { id })).data;
    } catch (e: any) {
      setSection(
        'ticket-detail',
        h`<p class="quiet" role="status">${t('ticket.gone', { message: e.message })}</p>`,
      );
      return;
    }
    const unmergeable = (tk.unmergeable ?? []).map(
      (u: any) =>
        h`<li><span class="mono">${u.path}</span> — <strong>${u.kind}</strong>${u.deletedBy ? t('ticket.deletedBy', { side: u.deletedBy === 'ours' ? t('ticket.side.ours') : t('ticket.side.theirs') }) : ''}</li>`,
    );
    const kindLabel: Record<string, string> = {
      content: t('ticket.res.content'),
      delete: t('ticket.res.delete'),
      missing: t('ticket.res.missing'),
    };
    const resolutionStatus = tk.resolved
      ? []
      : (tk.resolutionInputs ?? []).map(
          (r: any) =>
            h`<li><span class="mono">${r.path}</span> — ${kindLabel[r.kind] || r.kind}</li>`,
        );
    const versions = (tk.resolutions ?? []).map((res: any) => {
      const col = (label: string, content: unknown): Safe =>
        content == null
          ? new Safe('')
          : h`<div class="version"><div class="muted">${label}</div><pre tabindex="0" aria-label="${label + ' — ' + res.path}">${content}</pre></div>`;
      return h`<h4 class="mono">${res.path}</h4><div class="versions">${col(t('ticket.base'), res.base)}${col(t('ticket.ours'), res.ours)}${col(t('ticket.theirs'), res.theirs)}${col(t('ticket.llm'), res.llmAttempt)}</div>`;
    });
    // Le chemin TESTÉ (Appliquer, sous Test Gate) et le chemin MANUEL (clore sans
    // Test Gate) sont visuellement et textuellement distincts ; le sûr vient en premier.
    const paths = tk.resolved
      ? ''
      : h`<div class="path-box"><h3>${t('ticket.tested')}</h3><p class="muted">${t('ticket.testedHelp')}</p><div class="actions">${actionButton('ticket.prepare', t('btn.prepare'), '', { ticket: tk.id }, '', t('btn.prepare') + ' ' + tk.id)}${actionButton('ticket.apply', t('btn.apply'), t('confirm.apply', { id: tk.id }), { ticket: tk.id }, 'primary', t('btn.apply') + ' ' + tk.id)}</div></div><div class="path-box manual"><h3>${t('ticket.manual')}</h3><p class="muted">${t('ticket.manualHelp')}</p><div class="actions">${actionButton('ticket.close', t('btn.closeManual'), t('confirm.closeManual', { id: tk.id }), { ticket: tk.id, type: tk.id }, 'danger', t('btn.closeManual') + ' ' + tk.id)}</div></div>`;
    setSection(
      'ticket-detail',
      h`<section class="detail" aria-labelledby="tk-h"><h2 id="tk-h" tabindex="-1">${t('ticket.detail', { id: tk.id })} ${badge(dict['reason.' + tk.reason] ?? tk.reason, 'warn')}${tk.resolved ? h` ${badge(t('ticket.resolved'), 'ok')}` : ''}</h2><p class="muted">${t('ticket.meta', { agent: tk.agent, branch: tk.branch, sha: (tk.sha || '').slice(0, 8), prompt: tk.prompt })}</p><p class="muted">${th('ticket.dir', { dir: tk.dir })}</p>${paths}${resolutionStatus.length ? h`<h3>${t('ticket.resolution')}</h3><ul>${resolutionStatus}</ul>` : ''}${unmergeable.length ? h`<h3>${t('ticket.unmergeable')}</h3><ul>${unmergeable}</ul>` : ''}${versions}${tk.log ? h`<h3>${t('ticket.gateLog')}</h3><pre tabindex="0" aria-label="${t('ticket.gateLog')}">${tk.log}</pre>` : ''}<div><button type="button" data-close-detail="ticket-detail">${t('btn.closeDetail')}</button></div></section>`,
    );
    reveal(el, document.getElementById('tk-h'));
  }
  async function showDoctor(): Promise<void> {
    setSection(
      'doctor-detail',
      h`<h2 id="doc-h" tabindex="-1">${t('doctor.title')}</h2><p class="muted" role="status">${t('doctor.running')}</p><div class="dlg-actions"><button type="button" data-close-dlg>${t('btn.closeDetail')}</button></div>`,
    );
    openDialog('dlg-doctor');
    try {
      const d = (await rpc('doctor.run')).data;
      // Le niveau est porté par un MOT (lisible au lecteur d'écran, en contraste
      // élevé, sans émoji) ; le bilan tient compte des avertissements.
      const s = d.summary || { fail: d.healthy ? 0 : 1, warn: 0 };
      const verdict =
        s.fail > 0
          ? badge(t('doctor.fail', { n: s.fail }), 'ko')
          : s.warn > 0
            ? badge(t('doctor.warn', { n: s.warn }), 'warn')
            : badge(t('doctor.ok'), 'ok');
      setSection(
        'doctor-detail',
        h`<h2 id="doc-h" tabindex="-1">${t('doctor.title')} ${verdict}</h2><div class="panel-body">${tableHtml(
          t('doctor.title'),
          d.checks,
          [
            { label: t('col.level'), render: (c) => t('doctor.level.' + c.level) },
            { label: t('col.check'), render: (c) => c.label },
            { label: t('col.finding'), render: (c) => h`<span class="muted">${c.detail}</span>` },
            { label: t('col.hint'), render: (c) => (c.hint ? h`<code>${c.hint}</code>` : '') },
          ],
          (c) => 'lvl-' + c.level,
        )}</div><div class="dlg-actions"><button type="button" data-close-dlg class="primary">${t('btn.closeDetail')}</button></div>`,
      );
    } catch (e: any) {
      setSection(
        'doctor-detail',
        h`<h2 id="doc-h" tabindex="-1">${t('doctor.title')}</h2><p class="muted" role="status">${t('doctor.failed', { message: e.message })}</p><div class="dlg-actions"><button type="button" data-close-dlg class="primary">${t('btn.closeDetail')}</button></div>`,
      );
    }
  }

  // ── Nouvelle tâche (dialogue) ────────────────────────────────────────────
  function openTask(): void {
    $('task-msg').textContent = '';
    $('task-msg').classList.remove('is-error');
    openDialog('dlg-task');
    $('task-prompt').focus();
  }
  $('task-mode').addEventListener('change', () => {
    $('task-profile-field').hidden = $('task-mode').value !== 'autonomous';
  });
  $('task-prompt').addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('task-form').requestSubmit();
    }
  });
  $('task-form').addEventListener('submit', (e: Event) => {
    e.preventDefault();
    const input = $('task-prompt');
    const msg = $('task-msg');
    const prompt = input.value.trim();
    if (!prompt) {
      msg.textContent = t('task.empty');
      msg.classList.add('is-error');
      input.focus();
      return;
    }
    const params: Record<string, unknown> = { prompt };
    const agent = $('task-agent').value.trim();
    if (agent) params.agent = agent;
    if ($('task-mode').value === 'autonomous') {
      params.mode = 'autonomous';
      params.profile = $('task-profile').value || null;
    }
    $('task-start').disabled = true;
    void runAction('task.run', params, msg).then((r) => {
      $('task-start').disabled = false;
      if (!r.ok) return; // le dialogue reste ouvert : la saisie et l'erreur restent visibles
      input.value = '';
      closeDialog('dlg-task');
      toast(r.message, true);
    });
  });

  // ── Écouteurs : UN seul, délégué, pour tous les boutons d'action ─────────
  document.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as Element;
    if (openTrigger && !target.closest('.menu')) setMenu(openTrigger, false, false);
    const btn: any = target.closest('button');
    if (!btn) return;
    const ds: Record<string, string> = { ...btn.dataset };
    if (ds.menu !== undefined || ds.agentMenu || ds.pop !== undefined) {
      setMenu(
        btn,
        btn.getAttribute('aria-expanded') !== 'true',
        e.detail === 0 && ds.pop === undefined,
      );
      return;
    }
    if (btn.classList.contains('menu-item') && openTrigger) {
      const trigger = openTrigger;
      setMenu(trigger, false, false);
      trigger.focus();
    }
    if (ds.closeDlg !== undefined) {
      btn.closest('dialog').close();
      return;
    }
    if (ds.newTask) {
      openTask();
      return;
    }
    const inAgentDialog = btn.closest('#dlg-agent');
    if (inAgentDialog && (ds.act || ds.log || ds.ticketOpen)) closeDialog('dlg-agent');
    if (ds.act) {
      if (ds.confirm) askConfirm(ds);
      else void execute(ds.act, paramsOf(ds), ds.ticket || '');
    } else if (ds.agentOpen) {
      openAgentDetail(ds.agentOpen);
    } else if (ds.log) {
      opener = btn;
      void showSessionLog(ds.log);
    } else if (ds.ticketOpen) {
      opener = btn;
      void showTicket(ds.ticketOpen);
    } else if (ds.closeDetail) {
      closeDetail(ds.closeDetail);
    } else if (ds.retry) {
      void refresh();
    } else if (ds.filter) {
      agentFilter = ds.filter;
      if (state) renderAgents(state);
    } else if (ds.copy) {
      const cmd = ds.copy;
      const copy = navigator.clipboard
        ? navigator.clipboard.writeText(cmd)
        : Promise.reject(new Error('clipboard'));
      copy.then(
        () => toast(t('toast.copied', { cmd }), true),
        () => toast(t('toast.copyFail', { cmd }), true),
      );
    }
  });
  $('doctor-btn').addEventListener('click', () => {
    if (openTrigger) {
      const trigger = openTrigger;
      setMenu(trigger, false, false);
      trigger.focus();
    }
    void showDoctor();
  });
  $('help-btn').addEventListener('click', () => openDialog('dlg-help'));
  $('agent-search').addEventListener('input', () => {
    agentQuery = $('agent-search').value;
    if (state) renderAgents(state);
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (openTrigger) {
      const trigger = openTrigger;
      const panel = panelOf(trigger);
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenu(trigger, false, false);
        trigger.focus();
        return;
      }
      if (panel && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const items = menuItems(panel);
        if (items.length > 0) {
          e.preventDefault();
          const i = items.indexOf(document.activeElement);
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? items.length - 1
                : e.key === 'ArrowDown'
                  ? (i + 1) % items.length
                  : (i - 1 + items.length) % items.length;
          items[next].focus();
        }
        return;
      }
      if (e.key === 'Tab') setMenu(trigger, false, false);
    } else if (
      e.key === 'ArrowDown' &&
      document.activeElement &&
      (document.activeElement as any).hasAttribute &&
      ((document.activeElement as any).hasAttribute('data-menu') ||
        (document.activeElement as any).hasAttribute('data-agent-menu'))
    ) {
      e.preventDefault();
      setMenu(document.activeElement, true, true);
      return;
    }
    // Raccourcis : jamais pendant une saisie, un dialogue ou avec un modificateur.
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'n') {
      e.preventDefault();
      openTask();
    } else if (e.key === 'm') {
      e.preventDefault();
      setMenu($('maint-btn'), true, true);
    } else if (e.key === '/' && !$('agent-filters').hidden) {
      e.preventDefault();
      $('agent-search').focus();
    } else if (e.key === '?') {
      e.preventDefault();
      openDialog('dlg-help');
    }
  });
  // Les durées relatives vieillissent : on les rafraîchit sur place, sans re-rendre.
  setInterval(() => {
    for (const el of document.querySelectorAll('time[data-rel]')) {
      const label = rel(el.getAttribute('datetime'));
      if (el.textContent !== label) el.textContent = label;
    }
  }, 30000);

  // ── Temps réel ───────────────────────────────────────────────────────────
  // SSE : le serveur pousse l'état à chaque changement (state.changed, avec
  // numéro de séquence et révision). Un client trop lent est déconnecté par le
  // serveur : EventSource se reconnecte seul (retry: 3000) et reçoit l'état
  // complet ; un sondage de secours à 5 s couvre l'intervalle.
  let pollTimer: any = null;
  function startPolling(): void {
    if (!pollTimer && !signedOut) pollTimer = setInterval(() => void refresh(), 5000);
  }
  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  const events = new EventSource('/events');
  events.addEventListener('state.changed', (e: any) => {
    stopPolling();
    render(JSON.parse(e.data).params.state);
  });
  events.addEventListener('control.notice', (e: any) => {
    toast(JSON.parse(e.data).params.message, true);
  });
  events.onerror = () => {
    if (signedOut) return;
    setLive('offline');
    startPolling();
  };
  void refresh(); // premier rendu immédiat, sans attendre le flux
}

/**
 * Retire de la source les lignes de pur commentaire et l'indentation (hors
 * littéraux gabarit multilignes, où l'espace peut compter). Fonction pure sur
 * du texte ; la sémantique du code ne change pas.
 */
export function compact(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  let inTemplate = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (!inTemplate) {
      if (trimmed === '') continue;
      if (trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlock = true;
        continue;
      }
    }
    out.push(inTemplate ? line : trimmed);
    // Un nombre impair de backticks non échappés change l'état « dans un gabarit ».
    const ticks = (line.match(/(?<!\\)`/g) ?? []).length;
    if (ticks % 2 === 1) inTemplate = !inTemplate;
  }
  return out.join('\n');
}

const scripts = new Map<string, string>();
/**
 * Le `<script>` unique de la page, pour UNE langue : le catalogue de cette
 * langue (le français sert de repli côté client, et les deux catalogues ont les
 * mêmes clés : test d'alignement) + la source compactée de `dashboardClient`.
 * `<` est échappé dans le JSON (jamais de `</script>` dans une donnée). Deux
 * langues = deux scripts, donc deux empreintes CSP, calculées par l'appelant
 * sur ce texte exact.
 */
export function clientScript(locale: 'fr' | 'en'): string {
  let script = scripts.get(locale);
  if (script === undefined) {
    const payload =
      locale === 'en'
        ? { fr: {}, en: DASHBOARD_MESSAGES.en }
        : { fr: DASHBOARD_MESSAGES.fr, en: {} };
    script =
      'const MSG = ' +
      JSON.stringify(payload).replace(/</g, String.fromCharCode(92) + 'u003c') +
      ';\n(' +
      compact(dashboardClient.toString()) +
      ')(MSG);\n';
    scripts.set(locale, script);
  }
  return script;
}
