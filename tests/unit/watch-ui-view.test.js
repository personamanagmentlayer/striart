import { describe, expect, it } from 'vitest';
import {
  allocate,
  ageText,
  buildFrame,
  displayOrder,
  fitLine,
  frameText,
  groupAgents,
  idleLabel,
  lineText,
  MIN_COLS,
} from '../../src/watch-ui-view.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { en } from '../../src/cli/i18n/en.ts';
import { agentStateView } from '../../src/cli/render/agents.ts';
import { layoutColumns } from '../../src/cli/render/table.ts';
import { inkStyleForTone } from '../../src/cli/render/tone.ts';
import { segProps } from '../../src/watch-ui.ts';

const NOW = Date.parse('2026-10-26T14:32:07');
const ago = (ms) => new Date(NOW - ms).toISOString();

const agent = (name, over = {}) => ({
  name,
  status: 'ACTIVE',
  mode: 'attended',
  profile: null,
  session: { state: 'running', via: 'pty', pid: 4242 },
  pendingCommits: 0,
  branch: `striart/${name}/task-37478bc6`,
  lastMessage: 'chore: initial commit',
  lastCommitAt: ago(3_600_000),
  sizeBytes: 35_000,
  ticket: null,
  ...over,
});

const AGENTS = [
  agent('checkout-flow', {
    pendingCommits: 1,
    lastMessage: 'feat(checkout): cart total',
    lastCommitAt: ago(180_000),
    ticket: { id: 'f72c', reason: 'GATE_FAILED' },
  }),
  agent('pricing-fix', {
    pendingCommits: 1,
    lastMessage: 'fix(pricing): round to cents, rate 25%',
    lastCommitAt: ago(600_000),
  }),
  agent('i18n-labels', { session: { state: 'idle', via: null, pid: null } }),
  agent('search-index', { session: { state: 'idle', via: null, pid: null } }),
];

function model(over = {}) {
  return {
    cols: 100,
    rows: 30,
    now: NOW,
    root: '/work/striart-demo',
    targetBranch: 'main',
    autoMerge: true,
    loaded: true,
    refreshError: null,
    lastRefreshAt: NOW - 1000,
    agents: AGENTS,
    selected: 'checkout-flow',
    openTickets: 1,
    queueWaiting: 0,
    detail: {
      loading: false,
      commits: [{ sha: 'a1b2c3d4e5', at: ago(180_000), subject: 'feat(checkout): cart total' }],
      commitTotal: 1,
      files: [
        { status: 'M', path: 'src/cart.js' },
        { status: 'A', path: 'tests/cart.test.js' },
      ],
      fileTotal: 2,
      uncommitted: 0,
    },
    view: 'main',
    bottom: 'journal',
    unread: { journal: false, commands: false },
    journal: [
      { at: NOW - 60_000, tone: 'info', text: 'agent checkout-flow : commit a1b2c3d4' },
      { at: NOW - 50_000, tone: 'error', text: 'merge checkout-flow : Test Gate rouge (code 1)' },
      { at: NOW - 49_000, tone: 'info', text: 'ticket f72c', continuation: true },
    ],
    journalScroll: 0,
    commandLines: [],
    commandsScroll: 0,
    outputLines: [[{ text: 'claude> working…' }]],
    outputConnected: true,
    idleTool: false,
    outputScroll: 0,
    confirm: null,
    input: { focused: false, text: '', cursor: 0 },
    suggestions: [],
    activeSuggestion: 0,
    activity: [],
    ...over,
  };
}

const UNICODE = { unicode: true, colorStdout: true, plain: false };
const ASCII = { unicode: false, colorStdout: false, plain: false };
const normalize = (text) =>
  text.replace(/\d\d:\d\d:\d\d/g, 'HH:MM:SS').replace(/(?<![\d:])\d\d:\d\d(?![\d:])/g, 'HH:MM');
const render = (over, caps = UNICODE, m = fr) => buildFrame(model(over), { m, caps });

describe('buildFrame : calibrage', () => {
  const sizes = [
    [80, 24],
    [100, 30],
    [140, 40],
    [60, 20],
    [40, 10],
    [30, 8],
  ];
  for (const caps of [UNICODE, ASCII]) {
    for (const [cols, rows] of sizes) {
      it(`${cols}×${rows} (${caps.unicode ? 'Unicode' : 'ASCII'}) : exactement ${rows} lignes, jamais plus larges que ${cols}`, () => {
        for (const view of ['main', 'zoom', 'help', 'confirm']) {
          const lines = render(
            {
              cols,
              rows,
              view,
              confirm: { title: 'Fusionner « a » dans main ?', lines: ['1 commit.'] },
            },
            caps,
          );
          expect(lines).toHaveLength(rows);
          for (const line of lines) {
            const width = [...lineText(line)].length;
            expect(width).toBeLessThanOrEqual(cols);
          }
        }
      });
    }
  }

  it('la barre de touches est TOUJOURS la dernière ligne, même au plus étroit', () => {
    for (const [cols, rows] of [
      [100, 30],
      [60, 20],
      [MIN_COLS, 10],
    ]) {
      const last = lineText(render({ cols, rows }).at(-1));
      expect(last).toContain('?');
      expect(last).toContain('q');
    }
  });

  it('sous le seuil, un message clair remplace un cadre cassé (et q reste annoncé)', () => {
    const lines = render({ cols: 30, rows: 8 });
    const text = frameText(lines);
    expect(text).toMatch(/trop petit/);
    expect(lineText(lines.at(-1))).toContain('q');
  });
});

describe('buildFrame : contenu (instantané à largeur fixe)', () => {
  it('100×30 Unicode', () => {
    expect(normalize(frameText(render()))).toMatchSnapshot();
  });
  it('80×24 Unicode', () => {
    expect(normalize(frameText(render({ cols: 80, rows: 24 })))).toMatchSnapshot();
  });
  it('80×24 ASCII (STRIART_ASCII / --plain)', () => {
    expect(normalize(frameText(render({ cols: 80, rows: 24 }, ASCII)))).toMatchSnapshot();
  });
  it('60×20 étroit : les colonnes se replient, aucune ligne ne déborde', () => {
    expect(normalize(frameText(render({ cols: 60, rows: 20 })))).toMatchSnapshot();
  });
  it('140×40 large', () => {
    expect(normalize(frameText(render({ cols: 140, rows: 40 })))).toMatchSnapshot();
  });
  it('en anglais', () => {
    expect(normalize(frameText(render({ cols: 100, rows: 30 }, UNICODE, en)))).toMatchSnapshot();
  });
});

describe('buildFrame : un état = un mot + un glyphe (jamais la couleur seule)', () => {
  const text = frameText(render());
  it('chaque état porte son libellé et son glyphe', () => {
    expect(text).toMatch(/✗ TICKET/);
    expect(text).toMatch(/● ACTIVE/);
    expect(text).toMatch(/○ ACTIVE/);
  });
  it('les groupes sont nommés', () => {
    expect(text).toContain('À traiter (1)');
    expect(text).toContain('En cours (1)');
    expect(text).toContain('Inactifs (2)');
  });
  it('la sélection est un marqueur, pas seulement une teinte', () => {
    expect(text).toMatch(/▸ checkout-flow/);
    expect(frameText(render({}, ASCII))).toMatch(/> checkout-flow/);
  });
  it('le mode ASCII ne contient aucun glyphe Unicode de décor', () => {
    const ascii = frameText(render({}, ASCII));
    expect(ascii).not.toMatch(/[\u2190-\u23ff\u25a0-\u27bf\u2800-\u28ff]/u);
    expect(ascii).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it('aucun émoji dans le cockpit Unicode', () => {
    for (const view of ['main', 'zoom', 'help']) {
      expect(frameText(render({ view }))).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
  it('les groupes sont ordonnés « À traiter · En cours · Inactifs » et la sélection suit cet ordre', () => {
    const order = displayOrder(AGENTS, 'TICKET').map((a) => a.name);
    expect(order).toEqual(['checkout-flow', 'pricing-fix', 'i18n-labels', 'search-index']);
    const shuffled = [AGENTS[3], AGENTS[1], AGENTS[2], AGENTS[0]];
    expect(groupAgents(shuffled, 'TICKET').map((g) => g.group)).toEqual([
      'attention',
      'running',
      'idle',
    ]);
  });
});

describe('buildFrame : texte non fiable', () => {
  it('neutralise les séquences de contrôle venues d’un commit, d’un nom de fichier, d’un ticket', () => {
    const evil = '\u001b]0;pwned\u0007\u001b[2Jx';
    const frame = render({
      agents: [agent('a', { lastMessage: evil, branch: evil, ticket: { id: evil, reason: evil } })],
      selected: 'a',
      detail: {
        loading: false,
        commits: [{ sha: evil, at: null, subject: evil }],
        commitTotal: 1,
        files: [{ status: evil, path: evil }],
        fileTotal: 1,
        uncommitted: 0,
      },
      journal: [{ at: NOW, tone: 'error', text: evil }],
    });
    const text = frameText(frame);
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('\\x1b');
  });
});

describe('buildFrame : états complets', () => {
  it('chargement : dit qu’il charge, pas d’écran blanc', () => {
    const text = frameText(
      render({ loaded: false, agents: [], selected: null, lastRefreshAt: null }),
    );
    expect(text).toMatch(/chargement/i);
  });
  it.each([
    ['chargement', { loaded: false, lastRefreshAt: null }],
    ['vide', { loaded: true }],
  ])('%s sans agent : un seul titre « Agents », aucun « Aucun agent sélectionné »', (_n, extra) => {
    const lines = render({ agents: [], selected: null, detail: null, ...extra }).map(lineText);
    const titles = lines.filter((l) => /^\S*\s*Agents\b/.test(l.trim()));
    expect(titles).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('Aucun agent sélectionné');
    // le panneau de détail garde un titre propre, distinct de « Agents »
    expect(lines.some((l) => l.includes('Détail'))).toBe(true);
  });
  it('vide : guide vers la première commande', () => {
    const text = frameText(render({ agents: [], selected: null, detail: null, openTickets: 0 }));
    expect(text).toContain('Aucun agent pour l’instant.');
    expect(text).toContain('striart start agent-a');
  });
  it('erreur de rafraîchissement : visible et nommée', () => {
    const text = frameText(render({ refreshError: 'registre illisible' }));
    expect(text).toContain('registre illisible');
    expect(text).toMatch(/obsolètes/);
  });
  it('données obsolètes : l’âge du dernier rafraîchissement réussi est affiché', () => {
    const text = frameText(render({ lastRefreshAt: NOW - 30_000 }));
    expect(text).toMatch(/obsolètes depuis 30 s/);
  });
  it('watcher actif : mode de merge nommé', () => {
    expect(frameText(render())).toContain('watcher actif · merge auto');
    expect(frameText(render({ autoMerge: false }))).toContain('merge désactivé');
  });
  it('chiffres clés : conflits en erreur avec glyphe, zéros neutres', () => {
    const [, kpi] = render().map(lineText);
    expect(kpi).toContain('✗ conflits 1');
    expect(kpi).toContain('commits en attente 2');
    expect(kpi).toContain('file 0');
  });
  it('journal vide : explique ce qui y viendra', () => {
    expect(frameText(render({ journal: [] }))).toContain('Aucun événement.');
  });
  it('panneau Commandes vide : explique comment commencer', () => {
    expect(frameText(render({ bottom: 'commands' }))).toContain('/status');
  });
  it('la fenêtre agents suit la sélection quand il y en a trop', () => {
    const many = Array.from({ length: 30 }, (_, i) => agent(`agent-${String(i).padStart(2, '0')}`));
    const text = frameText(render({ agents: many, selected: 'agent-25', rows: 24, cols: 80 }));
    expect(text).toContain('agent-25');
    expect(text).toMatch(/\/30/);
  });
});

describe('buildFrame : vues', () => {
  it('confirmation : conséquence explicite, y confirme, Échap annule, Entrée n’est jamais un oui', () => {
    const text = frameText(
      render({
        view: 'confirm',
        confirm: {
          title: 'Fusionner « checkout-flow » dans main ?',
          lines: ['1 commit en attente sera intégré.', 'Le Test Gate s’exécute avant tout commit.'],
        },
      }),
    );
    expect(text).toContain('Fusionner « checkout-flow » dans main ?');
    expect(text).toContain('Test Gate');
    const last = text.split('\n').at(-1);
    expect(last).toMatch(/y .*confirmer/);
    expect(last).toMatch(/Échap .*annuler/);
    expect(last).not.toMatch(/Entrée/);
  });
  it('aide : liste les raccourcis', () => {
    const text = frameText(render({ view: 'help' }));
    expect(text).toContain('Aide — raccourcis');
    expect(text).toContain('Test Gate');
    expect(text).toMatch(/q\s+Ctrl\+C/);
  });
  it('détail (Entrée) : commits, fichiers, ticket et sortie de l’agent', () => {
    const text = frameText(render({ view: 'zoom' }));
    expect(text).toContain('Détail · checkout-flow');
    expect(text).toContain('a1b2c3d');
    expect(text).toContain('src/cart.js');
    expect(text).toContain('striart resolve --prepare f72c');
    expect(text).toContain('Sortie · checkout-flow');
    expect(text).toContain('claude> working…');
  });
  it('saisie : le curseur est un bloc inversé, les touches affichées changent', () => {
    const frame = render({
      input: { focused: true, text: '/sta', cursor: 4 },
      suggestions: [{ kind: 'command', value: 'status', description: 'État' }],
    });
    const lines = frame.map(lineText);
    expect(lines.at(-2)).toBe('> /sta ');
    expect(lines.at(-1)).toMatch(/Entrée .*envoyer/);
    expect(lines.some((l) => l.includes('/status'))).toBe(true);
    const caret = frame.at(-2).find((seg) => seg.inverse);
    expect(caret).toBeTruthy();
  });
  it('toast : action en cours puis terminée, avec la durée', () => {
    const running = render({
      activity: [
        { id: 1, label: 'Merge de « a »', status: 'pending', startedAt: NOW - 2500, endedAt: null },
      ],
    }).map(lineText);
    expect(running.some((l) => /Merge de « a » \(2\.5s\)/.test(l))).toBe(true);
    const failed = render({
      activity: [
        {
          id: 1,
          label: 'Merge de « a »',
          status: 'error',
          startedAt: NOW - 1000,
          endedAt: NOW,
          detail: 'voir Commandes',
        },
      ],
    }).map(lineText);
    expect(failed.some((l) => l.startsWith('✗ Merge de « a » (1.0s)'))).toBe(true);
  });
});

describe('allocate : budget vertical', () => {
  it('somme exacte pour chaque hauteur raisonnable', () => {
    for (let rows = 10; rows <= 60; rows += 1) {
      const b = allocate(rows, 0, 7);
      // en-tête + chiffres + titre + colonnes + détail + agents + bas + retour + saisie + touches
      expect(2 + 2 + b.detail + b.agents + b.bottom + 3).toBeLessThanOrEqual(Math.max(rows, 20));
      expect(b.agents).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('petits utilitaires de présentation', () => {
  it('fitLine tronque avec une ellipse sans jamais déborder', () => {
    const line = fitLine([{ text: 'abcdef' }, { text: 'ghij', tone: 'muted' }], 7, '…');
    expect(lineText(line)).toBe('abcdef…');
  });
  it('ageText garde la première unité', () => {
    expect(ageText(fr, ago(190_000), NOW, '—')).toBe('3 min');
    expect(ageText(fr, null, NOW, '—')).toBe('—');
    expect(ageText(en, ago(3 * 3_600_000), NOW, '-')).toBe('3h');
  });
});

describe('vocabulaire d’état partagé (CLI + cockpit)', () => {
  const t = 'TICKET';
  it('MISSING / BROKEN / ticket → à traiter, en erreur, glyphe ✗', () => {
    for (const a of [{ status: 'MISSING' }, { status: 'BROKEN' }]) {
      expect(agentStateView(a, false, t)).toMatchObject({
        level: 'error',
        glyph: 'error',
        group: 'attention',
      });
    }
    expect(agentStateView({ status: 'ACTIVE' }, true, t)).toMatchObject({
      label: 'TICKET',
      level: 'error',
      group: 'attention',
    });
  });
  it('REMOVING → avertissement', () => {
    expect(agentStateView({ status: 'REMOVING' }, false, t)).toMatchObject({
      level: 'warn',
      glyph: 'warn',
    });
  });
  it('ACTIVE avec session ou commits → en cours ; sinon inactif atténué', () => {
    expect(
      agentStateView({ status: 'ACTIVE', session: { state: 'running' } }, false, t).group,
    ).toBe('running');
    expect(agentStateView({ status: 'ACTIVE', pendingCommits: 2 }, false, t).group).toBe('running');
    expect(
      agentStateView({ status: 'ACTIVE', session: { state: 'idle' } }, false, t),
    ).toMatchObject({
      group: 'idle',
      glyph: 'idle',
      level: 'skip',
    });
  });
});

describe('layoutColumns : règle de repli partagée', () => {
  const specs = [
    { priority: 10 },
    { priority: 5 },
    { priority: 1 },
    { priority: 7, shrink: { min: 6 } },
  ];
  it('sans limite : tout est conservé', () => {
    expect(layoutColumns(specs, [10, 10, 10, 20], null).visible).toEqual([0, 1, 2, 3]);
  });
  it('la moins prioritaire tombe d’abord, la première jamais', () => {
    const { visible } = layoutColumns(specs, [10, 10, 10, 20], 40);
    expect(visible).not.toContain(2);
    expect(visible[0]).toBe(0);
  });
  it('une colonne compressible se réduit avant qu’une prioritaire ne parte', () => {
    const { visible, widths } = layoutColumns(
      [{ priority: 10 }, { priority: 7, shrink: { min: 6 } }],
      [10, 30],
      25,
    );
    expect(visible).toEqual([0, 1]);
    expect(widths[1]).toBe(13);
  });
});

describe('style Ink : une seule palette, coupée par NO_COLOR', () => {
  it('sans couleur, aucun ton ne produit de couleur ni d’attribut décoratif', () => {
    for (const tone of ['ok', 'warn', 'error', 'info', 'skip', 'accent', 'muted', 'code']) {
      expect(inkStyleForTone(tone, 'default', false)).toEqual({});
    }
  });
  it('thème par défaut : vert / jaune / rouge ; daltonien : jamais rouge-vert', () => {
    expect(inkStyleForTone('ok', 'default', true).color).toBe('green');
    expect(inkStyleForTone('error', 'default', true)).toMatchObject({ color: 'red', bold: true });
    expect(inkStyleForTone('ok', 'colorblind', true).color).toBe('blue');
    expect(inkStyleForTone('error', 'colorblind', true).color).toBe('magenta');
  });
  it('segProps : la sortie émulée garde ses couleurs seulement quand la couleur est permise', () => {
    const seg = { text: 'x', color: '#ff0000', backgroundColor: '#00ff00', bold: true };
    const on = segProps(seg, { colorStdout: true, theme: 'default' });
    const off = segProps(seg, { colorStdout: false, theme: 'default' });
    expect(on.color).toBe('#ff0000');
    expect(off.color).toBeUndefined();
    expect(off.backgroundColor).toBeUndefined();
    expect(off.bold).toBe(true);
  });
});

describe('confirmation : la conséquence n’est jamais tronquée', () => {
  it('une phrase longue passe à la ligne au lieu d’être coupée par une ellipse', () => {
    const long =
      'Le Test Gate s’exécute avant tout commit : en cas d’échec, le merge est annulé et un ticket est créé.';
    const frame = render({
      cols: 60,
      rows: 20,
      view: 'confirm',
      confirm: { title: 'Fusionner « a » dans main ?', lines: [long] },
    });
    const text = frame.map(lineText).join('\n');
    const joined = text.replace(/\s+/g, ' ');
    expect(joined).toContain('un ticket est créé.');
    const lines = frame.map(lineText);
    const start = lines.findIndex((l) => l.includes('Fusionner'));
    const panel = lines.slice(start + 1).filter((l) => /^ {2}\S/.test(l));
    expect(panel.length).toBeGreaterThan(1);
    for (const l of panel) expect(l).not.toContain('…');
  });
});

describe('indicateur d’inactivité (GC) dans le tableau et le détail', () => {
  const IDLE_AGENTS = [
    agent('forgotten', {
      session: { state: 'idle', via: null, pid: null },
      idle: { stage: 'idle', minutes: 192 },
    }),
    agent('warned-one', { idle: { stage: 'warned', minutes: 75 } }),
    agent('closable-one', { idle: { stage: 'closable', minutes: 150 } }),
    agent('fresh', {}),
  ];

  it('idleLabel : durée courte + étage, null sans cellule (fr / en)', () => {
    expect(idleLabel(fr, null)).toBeNull();
    expect(idleLabel(fr, undefined)).toBeNull();
    expect(idleLabel(fr, { stage: 'idle', minutes: 192 })).toMatch(/^inactif 3\s?h/);
    expect(idleLabel(fr, { stage: 'warned', minutes: 75 })).toMatch(/^inactif 1\s?h, averti$/);
    expect(idleLabel(en, { stage: 'closable', minutes: 150 })).toMatch(/^idle 2\s?h, closable$/);
  });

  it('tableau : mot d’état conservé + inactivité entre parenthèses, rien pour un agent actif', () => {
    const text = frameText(render({ agents: IDLE_AGENTS, selected: 'fresh', cols: 120, rows: 30 }));
    expect(text).toMatch(/forgotten.*ACTIVE \(inactif 3\s?h\)/);
    expect(text).toMatch(/warned-one.*ACTIVE \(inactif 1\s?h, averti\)/);
    expect(text).toMatch(/closable-one.*ACTIVE \(inactif 2\s?h, fermable\)/);
    expect(text).not.toMatch(/fresh.*\(inactif/);
  });

  it('détail de l’agent sélectionné : la ligne de session porte l’inactivité', () => {
    const text = frameText(
      render({ agents: IDLE_AGENTS, selected: 'warned-one', cols: 120, rows: 30 }),
    );
    expect(text).toMatch(/Session.*inactif 1\s?h, averti/);
  });

  it('sans cellule, le rendu est identique à celui d’avant (aucun mot « inactif »)', () => {
    expect(frameText(render())).not.toMatch(/inactif \d/);
  });

  it('instantanés : français Unicode, anglais, ASCII', () => {
    const over = { agents: IDLE_AGENTS, selected: 'warned-one', cols: 120, rows: 30 };
    expect(normalize(frameText(render(over)))).toMatchSnapshot();
    expect(normalize(frameText(render(over, UNICODE, en)))).toMatchSnapshot();
    expect(normalize(frameText(render({ ...over, cols: 100, rows: 24 }, ASCII)))).toMatchSnapshot();
  });

  it('calibrage : jamais plus large que l’écran, même au plus étroit', () => {
    for (const cols of [40, 60, 80]) {
      const lines = render({ agents: IDLE_AGENTS, selected: 'warned-one', cols, rows: 24 });
      for (const line of lines) expect([...lineText(line)].length).toBeLessThanOrEqual(cols);
    }
  });
});
