/**
 * Feuille de style du dashboard (un seul bloc `<style>`, identifié par son
 * empreinte dans la CSP : aucun style en ligne, aucune ressource externe).
 *
 * Jetons définis une fois (couleur, espace sur grille 4/8 px, rayon, ombre,
 * échelle typographique) ; thème clair ET sombre selon `prefers-color-scheme`,
 * forçable par `data-theme` (bouton de l'en-tête). Palette restreinte : un neutre,
 * un accent, et rouge / ambre / vert RÉSERVÉS à l'état. Les couleurs sont choisies
 * pour le contraste WCAG 2.2 AA (4,5:1 le texte, 3:1 les composants), vérifié par
 * l'audit axe-core de `tests/e2e/a11y.spec.ts`. Un statut n'est jamais porté par la
 * couleur seule : libellé ET icône de forme distincte (coche, croix, triangle,
 * horloge). Les transitions (120–180 ms) disparaissent sous `prefers-reduced-motion`.
 */

const DARK_TOKENS = `
      --bg: #0d1117; --card: #161b22; --card-2: #1c2128; --hover: #262c36;
      --border: #30363d; --border-strong: #7d8590;
      --text: #e6edf3; --muted: #9198a1; --link: #79c0ff; --focus: #79c0ff;
      --accent: #1f6feb; --on-accent: #ffffff;
      --ok: #56d364; --ok-bg: #0f2d1a; --ok-bd: #1f5a2c;
      --warn: #e3b341; --warn-bg: #2b2108; --warn-bd: #5a4410;
      --ko: #ff7b72; --ko-bg: #3a1618; --ko-bd: #6b2428;
      --info: #79c0ff; --info-bg: #0c2d4f; --info-bd: #1f4f85;
      --auto: #d2a8ff; --auto-bg: #2a1c47; --auto-bd: #4c3585;
      --neutral: #c9d1d9; --neutral-bg: #21262d; --neutral-bd: #3d444d;
      --shadow: 0 0 0 1px rgba(0,0,0,.2); --shadow-pop: 0 8px 24px rgba(1,4,9,.7);
`;

export const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f6f8fa; --card: #ffffff; --card-2: #f6f8fa; --hover: #eaeef2;
    --border: #d8dee4; --border-strong: #818b98;
    --text: #1f2328; --muted: #59636e; --link: #0550ae; --focus: #0969da;
    --accent: #0969da; --on-accent: #ffffff;
    --ok: #116329; --ok-bg: #dafbe1; --ok-bd: #aceebb;
    --warn: #7d4e00; --warn-bg: #fff8c5; --warn-bd: #e5c64f;
    --ko: #a40e26; --ko-bg: #ffebe9; --ko-bd: #ffb8b0;
    --info: #0550ae; --info-bg: #ddf4ff; --info-bd: #a5d6ff;
    --auto: #6639ba; --auto-bg: #fbefff; --auto-bd: #e0c3fb;
    --neutral: #424a53; --neutral-bg: #eaeef2; --neutral-bd: #d0d7de;
    --shadow: 0 1px 2px rgba(31,35,40,.06); --shadow-pop: 0 8px 24px rgba(31,35,40,.18);
    --s1: .25rem; --s2: .5rem; --s3: .75rem; --s4: 1rem; --s5: 1.5rem; --s6: 2rem;
    --r1: .375rem; --r2: .625rem; --r3: .875rem;
    --t-xs: .75rem; --t-sm: .8125rem; --t-base: .875rem; --t-lg: 1rem; --t-xl: 1.25rem; --t-2xl: 1.75rem;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --ease: 150ms ease;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK_TOKENS}}
  }
  :root[data-theme="dark"] { color-scheme: dark;${DARK_TOKENS}}
  :root[data-theme="light"] { color-scheme: light; }

  [hidden] { display: none !important; }
  *, *::before, *::after { box-sizing: border-box; }
  html { scroll-padding-top: var(--s4); -webkit-text-size-adjust: 100%; }
  body { font-family: var(--sans); font-size: var(--t-base); line-height: 1.5; background: var(--bg); color: var(--text); margin: 0; font-variant-numeric: tabular-nums; }
  .wrap { max-width: 76rem; margin: 0 auto; padding: var(--s5) clamp(.75rem, 3vw, 2rem) var(--s6); }
  .skip { position: absolute; left: var(--s2); top: -4rem; z-index: 60; background: var(--card); color: var(--text); border: 2px solid var(--focus); border-radius: var(--r1); padding: var(--s2) var(--s4); }
  .skip:focus { top: var(--s2); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  main:focus { outline: none; }
  h1, h2, h3, h4 { margin: 0; line-height: 1.3; }
  h1 { font-size: var(--t-lg); font-weight: 650; letter-spacing: -.01em; }
  h2 { font-size: var(--t-lg); font-weight: 650; }
  h3 { font-size: var(--t-base); font-weight: 600; }
  h2:focus, h3:focus, .detail:focus { outline: none; }
  .muted { color: var(--muted); }
  .hint { color: var(--muted); font-size: var(--t-sm); margin: var(--s1) 0 var(--s3); }
  p { margin: 0; }
  a { color: var(--link); }
  code, .mono { font-family: var(--mono); font-size: .92em; }
  code { background: var(--hover); padding: .05rem .35rem; border-radius: var(--r1); overflow-wrap: anywhere; }
  .mono { overflow-wrap: anywhere; }
  .nowrap, time { white-space: nowrap; }
  .trunc { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  .ic { width: 1rem; height: 1rem; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .ic.sm { width: .8125rem; height: .8125rem; }
  .sprite { position: absolute; width: 0; height: 0; overflow: hidden; }

  /* En-tête : marque, dépôt, état de la liaison, thème. */
  .top { background: var(--card); border-bottom: 1px solid var(--border); }
  .bar { max-width: 76rem; margin: 0 auto; padding: var(--s3) clamp(.75rem, 3vw, 2rem); display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); }
  .brand { display: flex; align-items: center; gap: var(--s2); }
  .logo { width: 1.5rem; height: 1.5rem; color: var(--accent); }
  .logo path { stroke: var(--card); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .chips { display: flex; flex-wrap: wrap; gap: var(--s2); min-width: 0; }
  .chip { display: inline-flex; align-items: center; gap: .35rem; max-width: 100%; padding: .125rem var(--s2); border: 1px solid var(--border); border-radius: var(--r1); font-size: var(--t-sm); color: var(--muted); background: var(--card-2); }
  .chip .trunc { max-width: 14rem; }
  .bar-end { margin-left: auto; display: flex; align-items: center; gap: var(--s2); }
  .live { display: inline-flex; align-items: center; gap: .4rem; font-size: var(--t-sm); font-weight: 600; padding: .125rem var(--s3) .125rem var(--s2); border-radius: 999px; white-space: nowrap; border: 1px solid var(--neutral-bd); background: var(--neutral-bg); color: var(--neutral); }
  .live::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; }
  .live.is-live { background: var(--ok-bg); border-color: var(--ok-bd); color: var(--ok); }
  .live.is-offline { background: var(--ko-bg); border-color: var(--ko-bd); color: var(--ko); }
  .live.is-offline::before { border-radius: 1px; transform: rotate(45deg); }
  #meta { font-size: var(--t-sm); color: var(--muted); }

  /* Boutons. */
  button, .btn { font: inherit; font-size: var(--t-base); font-weight: 500; line-height: 1.25; display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); background: var(--card); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r1); padding: .3125rem var(--s3); min-height: 2rem; cursor: pointer; text-decoration: none; transition: background-color var(--ease), border-color var(--ease), box-shadow var(--ease); box-shadow: var(--shadow); }
  button:hover:not(:disabled), .btn:hover { background: var(--hover); }
  button:disabled, button[aria-disabled="true"] { cursor: not-allowed; opacity: .6; }
  button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600; }
  button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.1); }
  button.danger { color: var(--ko); border-color: var(--ko); }
  button.danger.solid { background: var(--ko); color: var(--card); }
  button.danger.solid:hover:not(:disabled) { background: var(--ko); filter: brightness(1.1); }
  button.ghost { border-color: transparent; background: transparent; box-shadow: none; }
  button.ghost:hover:not(:disabled) { background: var(--hover); }
  button.icon { padding: 0; width: 2rem; }
  button.linklike { border: 0; background: none; box-shadow: none; color: var(--link); text-decoration: underline; padding: var(--s1) var(--s2); min-height: 1.5rem; }
  kbd { font-family: var(--mono); font-size: var(--t-xs); padding: 0 .35rem; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: var(--r1); color: var(--muted); background: var(--card-2); }
  button.primary kbd { color: var(--on-accent); background: transparent; border-color: currentColor; opacity: .9; }

  /* Champs. */
  .field { display: flex; flex-direction: column; gap: var(--s1); margin: 0 0 var(--s4); }
  .field label, fieldset.field legend { font-size: var(--t-sm); font-weight: 600; }
  .field .muted { font-size: var(--t-sm); }
  fieldset.field { border: 1px solid var(--border); border-radius: var(--r1); flex-direction: row; flex-wrap: wrap; gap: var(--s2) var(--s4); }
  input, select, textarea { font: inherit; font-size: var(--t-base); background: var(--card); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r1); padding: .3125rem var(--s3); min-height: 2rem; max-width: 100%; transition: border-color var(--ease), box-shadow var(--ease); }
  textarea { width: 100%; resize: vertical; }
  input[type="checkbox"] { min-height: 0; width: 1.1rem; height: 1.1rem; }
  input[type="search"] { width: 12rem; }

  /* Toast : retour non bloquant d'une action. */
  #toast { position: fixed; z-index: 70; left: 50%; bottom: var(--s5); transform: translateX(-50%); width: max-content; max-width: min(40rem, calc(100vw - 2rem)); padding: var(--s3) var(--s4); background: var(--text); color: var(--bg); border-radius: var(--r2); box-shadow: var(--shadow-pop); font-size: var(--t-base); overflow-wrap: anywhere; }
  #toast:empty { display: none; }

  /* Pastilles de statut : libellé + icône, couleur en renfort. */
  .badge { display: inline-flex; gap: .3rem; align-items: center; padding: .0625rem var(--s2); border-radius: 999px; font-size: var(--t-xs); font-weight: 600; border: 1px solid var(--neutral-bd); background: var(--neutral-bg); color: var(--neutral); white-space: nowrap; line-height: 1.4; }
  .badge.is-ok { background: var(--ok-bg); border-color: var(--ok-bd); color: var(--ok); }
  .badge.is-warn { background: var(--warn-bg); border-color: var(--warn-bd); color: var(--warn); }
  .badge.is-ko { background: var(--ko-bg); border-color: var(--ko-bd); color: var(--ko); }
  .badge.is-info { background: var(--info-bg); border-color: var(--info-bd); color: var(--info); }
  .badge.is-auto { background: var(--auto-bg); border-color: var(--auto-bd); color: var(--auto); }

  /* Résumé chiffré. */
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s3); margin: 0 0 var(--s5); padding: 0; list-style: none; }
  .stat { display: flex; flex-direction: column; gap: 2px; padding: var(--s3) var(--s4); background: var(--card); border: 1px solid var(--border); border-radius: var(--r2); box-shadow: var(--shadow); color: inherit; text-decoration: none; transition: border-color var(--ease), background-color var(--ease); min-height: 4.5rem; }
  .stat:hover { border-color: var(--border-strong); background: var(--card-2); }
  .stat-n { font-size: var(--t-2xl); font-weight: 650; line-height: 1.15; letter-spacing: -.02em; }
  .stat-l { font-size: var(--t-sm); color: var(--muted); }
  .stat.is-ko { border-color: var(--ko-bd); background: var(--ko-bg); }
  .stat.is-ko .stat-n { color: var(--ko); }
  .stat.is-info .stat-n { color: var(--info); }

  /* À traiter : cartes d'alerte empilées. */
  .attention { margin: 0 0 var(--s5); }
  .sec-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); margin: 0 0 var(--s3); }
  .sec-head h2 { display: flex; align-items: baseline; gap: var(--s2); }
  .count { font-size: var(--t-sm); font-weight: 600; color: var(--muted); padding: 0 var(--s2); border-radius: 999px; background: var(--hover); }
  .count:empty { display: none; }
  .stack-list { display: grid; gap: var(--s2); }
  .card { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--s3) var(--s4); padding: var(--s3) var(--s4); background: var(--card); border: 1px solid var(--border); border-radius: var(--r2); box-shadow: var(--shadow); }
  .card + .card { margin-top: var(--s2); }
  .card.sev-error { background: var(--ko-bg); border-color: var(--ko-bd); }
  .card.sev-warn { background: var(--warn-bg); border-color: var(--warn-bd); }
  .card.sev-info { background: var(--info-bg); border-color: var(--info-bd); }
  .sev { display: inline-flex; margin-top: 2px; }
  .sev-error .sev { color: var(--ko); } .sev-warn .sev { color: var(--warn); } .sev-info .sev { color: var(--info); }
  .sev .ic { width: 1.25rem; height: 1.25rem; stroke-width: 1.75; }
  .card-body { flex: 1 1 16rem; min-width: 0; }
  .card-title { font-weight: 650; font-size: var(--t-lg); line-height: 1.35; overflow-wrap: anywhere; }
  .card-text { color: var(--text); margin-top: 2px; overflow-wrap: anywhere; }
  .card-text .muted { color: var(--muted); }
  .card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
  .card h3 { font-size: var(--t-lg); }
  .card-form { flex: 1 1 100%; }
  .cmd { display: inline-flex; align-items: center; gap: var(--s2); margin-top: var(--s2); }
  .allclear { display: flex; align-items: center; gap: var(--s2); margin: 0 0 var(--s5); padding: var(--s2) var(--s3); color: var(--ok); font-weight: 600; }
  .allclear .muted { font-weight: 400; }

  /* Mise en page à deux zones. */
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s5); align-items: start; }
  .col { display: grid; gap: var(--s5); min-width: 0; align-content: start; }
  .panel { min-width: 0; }
  .panel-body { background: var(--card); border: 1px solid var(--border); border-radius: var(--r2); box-shadow: var(--shadow); }
  .panel.is-empty { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s1) var(--s3); padding: var(--s2) 0; border-top: 1px solid var(--border); }
  .panel.is-empty .sec-head { margin: 0; }
  .panel.is-empty h2 { font-size: var(--t-base); color: var(--muted); }
  .panel.is-empty .hint, .panel.is-empty .panel-body { border: 0; background: none; box-shadow: none; }
  .quiet { color: var(--muted); font-size: var(--t-base); }
  .panel.is-empty .hint { display: none; }

  /* Agents : liste dense, regroupée par état. */
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin-left: auto; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s3); margin: 0 0 var(--s3); }
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--r1); overflow: hidden; background: var(--card); }
  .seg button { border: 0; border-radius: 0; box-shadow: none; min-height: 1.875rem; background: transparent; }
  .seg button:focus-visible { outline-offset: -2px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button[aria-pressed="true"] { background: var(--text); color: var(--bg); }
  .list { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--border); border-radius: var(--r2); box-shadow: var(--shadow); }
  .grp { padding: var(--s2) var(--s4); background: var(--card-2); border-top: 1px solid var(--border); font-size: var(--t-sm); font-weight: 600; color: var(--muted); display: flex; align-items: center; gap: var(--s2); }
  .grp:first-child { border-top: 0; border-radius: var(--r2) var(--r2) 0 0; }
  .agent { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--s2) var(--s4); align-items: center; padding: var(--s3) var(--s4); border-top: 1px solid var(--border); transition: background-color var(--ease); }
  .grp + .agent, .list > .agent:first-child { border-top: 0; }
  .agent:hover { background: var(--card-2); }
  .agent-main { min-width: 0; display: grid; gap: 2px; }
  .agent-title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); min-width: 0; }
  .agent-name { font-weight: 650; font-size: var(--t-lg); max-width: 100%; }
  .agent-sub { display: flex; align-items: center; gap: var(--s2); min-width: 0; color: var(--muted); font-size: var(--t-sm); }
  .agent-sub .branch { display: inline-flex; align-items: center; gap: .25rem; flex: 0 1 auto; min-width: 0; max-width: 45%; font-family: var(--mono); }
  .agent-sub .msg { flex: 1 1 0; min-width: 0; }
  .agent-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: var(--t-sm); color: var(--muted); white-space: nowrap; }
  .agent-meta span { display: inline-flex; align-items: center; gap: .3rem; }
  .agent-actions { display: flex; align-items: center; gap: var(--s2); }
  .skel { display: block; height: .75rem; border-radius: 4px; background: var(--border); animation: pulse 1.4s ease-in-out infinite; }
  .skel.w30 { width: 30%; } .skel.w50 { width: 50%; } .skel.w70 { width: 70%; } .skel.h-lg { height: 1.25rem; }
  .skel-row { padding: var(--s3) var(--s4); display: grid; gap: var(--s2); border-top: 1px solid var(--border); }
  .skel-row:first-child { border-top: 0; }
  @keyframes pulse { 50% { opacity: .45; } }
  .empty-state { padding: var(--s5); display: grid; gap: var(--s2); justify-items: start; background: var(--card); border: 1px dashed var(--border-strong); border-radius: var(--r2); }
  .empty-state h3 { font-size: var(--t-lg); }
  .empty-state p { color: var(--muted); max-width: 38rem; }

  /* Menus (clavier : flèches, Début/Fin, Échap). */
  .menu { position: relative; display: inline-block; }
  .menu-panel { position: absolute; z-index: 40; top: calc(100% + 4px); left: 0; min-width: 16rem; max-width: min(24rem, calc(100vw - 2rem)); padding: var(--s1); background: var(--card); border: 1px solid var(--border); border-radius: var(--r2); box-shadow: var(--shadow-pop); }
  .menu.end .menu-panel { left: auto; right: 0; }
  .menu-item { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; padding: var(--s2) var(--s3); border: 0; border-radius: var(--r1); background: transparent; box-shadow: none; text-align: left; font-weight: 500; min-height: 2.25rem; justify-content: center; }
  .menu-item:hover, .menu-item:focus-visible { background: var(--hover); }
  .menu-item:focus-visible { outline-offset: -2px; }
  .menu-item .desc { font-size: var(--t-xs); font-weight: 400; color: var(--muted); }
  .menu-item.danger { color: var(--ko); }
  .menu-sep { height: 1px; margin: var(--s1) 0; background: var(--border); }
  .menu-panel .kv { padding: var(--s2) var(--s3); }

  /* Dialogues natifs : focus piégé et Échap fournis par le navigateur. */
  dialog.dlg { padding: 0; border: 1px solid var(--border); border-radius: var(--r3); background: var(--card); color: var(--text); width: min(34rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 2rem); overflow: auto; box-shadow: var(--shadow-pop); }
  dialog.dlg.wide { width: min(52rem, calc(100vw - 1.5rem)); }
  dialog.dlg::backdrop { background: rgba(1, 4, 9, .6); }
  .dlg-body { padding: var(--s5); }
  .dlg-body > h2 { margin-bottom: var(--s3); font-size: var(--t-xl); }
  .dlg-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--s2); margin-top: var(--s4); }
  .conseq { display: block; margin: 0 0 var(--s4); padding: var(--s2) var(--s3); border-left: 4px solid var(--warn); background: var(--warn-bg); border-radius: 0 var(--r1) var(--r1) 0; }
  .conseq.danger { border-left-color: var(--ko); background: var(--ko-bg); }
  .dlg-msg { min-height: 1.25rem; margin-top: var(--s2); font-size: var(--t-sm); overflow-wrap: anywhere; }
  .dlg-msg.is-error { color: var(--ko); font-weight: 600; }
  dl.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s2) var(--s4); margin: var(--s3) 0 0; }
  dl.kv dt { color: var(--muted); }
  dl.kv dd { margin: 0; overflow-wrap: anywhere; }
  dl.kv ul { margin: 0; padding-left: var(--s4); }
  table.shortcuts { border-collapse: collapse; width: 100%; }
  table.shortcuts td { padding: var(--s2) 0; border-bottom: 1px solid var(--border); }
  table.shortcuts td:first-child { width: 8rem; }

  /* Tableaux (conflits, diagnostic, orchestration). */
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: middle; padding: var(--s3) var(--s4); border-top: 1px solid var(--border); font-size: var(--t-base); }
  thead th { border-top: 0; color: var(--muted); font-size: var(--t-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; background: var(--card-2); padding-block: var(--s2); }
  tbody tr:hover { background: var(--card-2); }
  td .cell-actions { display: flex; flex-wrap: wrap; gap: var(--s2); }
  tr.lvl-warn td:first-child { color: var(--warn); font-weight: 600; }
  tr.lvl-fail td:first-child { color: var(--ko); font-weight: 700; }
  .reason { display: grid; gap: 1px; }
  .reason .code { font-family: var(--mono); font-size: var(--t-xs); color: var(--muted); }

  /* Listes compactes (file, fichiers disputés, historique). */
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows > li { display: grid; gap: 2px var(--s3); padding: var(--s3) var(--s4); border-top: 1px solid var(--border); min-width: 0; }
  .rows > li:first-child { border-top: 0; }
  .row-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s1) var(--s2); min-width: 0; }
  .row-top .mono { min-width: 0; flex: 1 1 8rem; }
  .row-sub { color: var(--muted); font-size: var(--t-sm); overflow-wrap: anywhere; }
  .rows.scroll { max-height: 24rem; overflow-y: auto; }

  /* Détails à la demande, blocs de code, formulaires des agents. */
  pre { background: var(--card-2); border: 1px solid var(--border); padding: var(--s3); border-radius: var(--r1); overflow: auto; max-height: 14rem; font-family: var(--mono); font-size: var(--t-sm); white-space: pre-wrap; overflow-wrap: anywhere; margin: var(--s2) 0; }
  .untrusted pre { border-left: 4px solid var(--warn); }
  .detail { background: var(--card); border: 1px solid var(--border); border-radius: var(--r2); box-shadow: var(--shadow); padding: var(--s4) var(--s5); margin: var(--s4) 0; display: grid; gap: var(--s3); }
  .detail h2 { font-size: var(--t-xl); }
  .detail h3 { color: var(--muted); }
  .versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: var(--s3); }
  .version pre { max-height: 22rem; }
  .path-box { border: 1px solid var(--border); border-radius: var(--r2); padding: var(--s3) var(--s4); display: grid; gap: var(--s2); }
  .path-box.manual { border-style: dashed; border-color: var(--ko); }
  .path-box h3 { color: var(--text); }
  .path-box .actions, .card .actions { display: flex; flex-wrap: wrap; gap: var(--s2); }
  .elic-error, .review-error { color: var(--ko); min-height: 1.25rem; font-weight: 600; }
  .danger-zone { border: 1px solid var(--border); border-radius: var(--r2); padding: 0 var(--s4); background: var(--card); }
  .danger-zone > summary { cursor: pointer; padding: var(--s3) 0; font-weight: 600; display: flex; align-items: center; gap: var(--s2); min-height: 2.5rem; }
  .danger-zone > summary .ic { color: var(--ko); }
  .danger-zone[open] > summary { border-bottom: 1px solid var(--border); }
  .danger-zone .zone-body { display: grid; gap: var(--s3); padding: var(--s4) 0; justify-items: start; }
  .heat-who { display: flex; flex-wrap: wrap; gap: var(--s1); }

  #banner:empty, #auth:empty, #announcer:empty { display: none; }
  #banner, #auth { display: grid; gap: var(--s2); margin-bottom: var(--s4); }

  @media (min-width: 1100px) {
    .cols.two { grid-template-columns: minmax(0, 1fr) 21rem; }
  }
  @media (max-width: 1099px) {
    .agent { grid-template-columns: minmax(0, 1fr) auto; }
    .agent-meta { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s4); order: 3; }
  }

  /* Petits écrans (reflow, zoom 200–400 %) : tableaux en cartes, cibles de 44 px. */
  @media (max-width: 760px) {
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    button, .btn, input, select, textarea, .menu-item { min-height: 2.75rem; }
    button.icon { width: 2.75rem; }
    .seg button { min-height: 2.75rem; }
    .danger-zone > summary { min-height: 2.75rem; }
    .agent { grid-template-columns: minmax(0, 1fr); }
    .agent-actions { order: 4; flex-wrap: wrap; }
    .agent-sub { flex-wrap: wrap; }
    .agent-sub .branch { max-width: 100%; }
    .agent-sub .msg { flex-basis: 100%; }
    .menu.end .menu-panel { right: auto; left: 0; }
    .toolbar { margin-left: 0; width: 100%; }
    .bar-end { margin-left: 0; width: 100%; justify-content: space-between; }
    input[type="search"] { width: 100%; }
    .filters { align-items: stretch; }
    .seg { flex-wrap: wrap; }
    dl.kv { grid-template-columns: minmax(0, 1fr); gap: 0; }
    dl.kv dd { margin-bottom: var(--s2); }
    table.stack, table.stack tbody, table.stack tr, table.stack td, table.stack caption { display: block; }
    table.stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    table.stack tr { border: 1px solid var(--border); border-radius: var(--r2); margin: var(--s3) 0; padding: var(--s2) var(--s3); background: var(--card); }
    table.stack td { display: grid; grid-template-columns: minmax(5rem, 34%) minmax(0, 1fr); gap: var(--s2); border: 0; padding: var(--s1) 0; }
    table.stack td::before { content: attr(data-label); color: var(--muted); font-weight: 600; overflow-wrap: anywhere; }
    table.stack td[data-label=""] { display: block; }
    table.stack td[data-label=""]::before { content: none; }
    #toast { left: var(--s4); right: var(--s4); transform: none; width: auto; max-width: none; }
    .kbd-hint, #meta { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
  @media (forced-colors: active) {
    .badge, .card, button, .stat, .live, .chip, .panel-body, .list { border: 1px solid CanvasText; }
    .conseq { border: 1px solid CanvasText; border-left-width: 4px; }
  }
`;

/** Pages sans script (connexion requise, lien refusé) : même thème, aucune donnée. */
export const INFO_STYLE = `
  :root { color-scheme: light dark; --bg: #ffffff; --text: #1f2328; --surface: #eaeef2; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --text: #e6edf3; --surface: #21262d; } }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; line-height: 1.5; }
  main { max-width: 48rem; padding: 2rem clamp(.75rem, 3vw, 2rem); }
  h1 { font-size: 1.4rem; }
  code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; background: var(--surface); padding: .1rem .35rem; border-radius: .25rem; overflow-wrap: anywhere; }
`;
