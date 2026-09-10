import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import { stopPtyHost } from '../../src/pty-host.ts';
import {
  computeSuggestions,
  looksLikeIdleShellPrompt,
  LogTailManager,
  parseAgentMessage,
  readTerminalLines,
  routeAgentMessage,
  TERMINAL_TAB,
  tokenizeCommand,
  writeToTerminal,
} from '../../src/watch-ui.ts';
import {
  connectWithRetry,
  seedAgentRegistry,
  waitFor,
  withRealPtySlot,
} from '../helpers/pty-test-utils.js';

// Cf. le même commentaire dans watch-ui.ts : import CJS par défaut puis
// déstructuration à l'exécution, `@xterm/headless` n'a pas d'export ESM nommé.
const { Terminal: HeadlessTerminal } = xtermHeadless;

const ECHO_EOL = process.platform === 'win32' ? '\r\n' : '\n';

describe('tokenizeCommand', () => {
  it('découpe une ligne simple sur les espaces', () => {
    expect(tokenizeCommand('merge agent-a')).toEqual(['merge', 'agent-a']);
  });

  it('respecte un argument entre guillemets doubles', () => {
    expect(tokenizeCommand('start agent-a --command "aider --model gpt-4o"')).toEqual([
      'start',
      'agent-a',
      '--command',
      'aider --model gpt-4o',
    ]);
  });

  it('respecte un argument entre guillemets simples', () => {
    expect(tokenizeCommand("run --prompt 'fix the bug'")).toEqual([
      'run',
      '--prompt',
      'fix the bug',
    ]);
  });

  it('ignore les espaces superflus', () => {
    expect(tokenizeCommand('   status   --json   ')).toEqual(['status', '--json']);
  });

  it('renvoie un tableau vide pour une ligne vide', () => {
    expect(tokenizeCommand('   ')).toEqual([]);
  });
});

/** Texte visible d'une ligne stylée, sans les props SGR — pour les assertions qui ne portent que sur le contenu. */
function linesText(styledLines) {
  return styledLines.map((chunks) => chunks.map((c) => c.text).join(''));
}

/** Terminal headless de test — petit par défaut pour garder les assertions lisibles. */
function makeTerminal(cols = 20, rows = 5) {
  return new HeadlessTerminal({ cols, rows, allowProposedApi: true });
}

describe('readTerminalLines / writeToTerminal (émulation de terminal réelle)', () => {
  it('un texte simple ressort sur une ligne, sans style', async () => {
    const term = makeTerminal();
    await writeToTerminal(term, 'Hello\r\n');
    const lines = readTerminalLines(term, term.rows);
    expect(linesText(lines)).toContain('Hello');
  });

  it('convertit les codes SGR de base en props Ink (couleur standard, gras, souligné)', async () => {
    const term = makeTerminal();
    await writeToTerminal(term, '\x1b[1;4;31mErreur\x1b[0m\r\n');
    const lines = readTerminalLines(term, term.rows);
    const row = lines.find((l) => l.some((c) => c.text.includes('Erreur')));
    expect(row).toEqual([{ text: 'Erreur', bold: true, underline: true, color: '#CD3131' }]);
  });

  it('convertit une couleur 256 (38;5;n) et une couleur vraie (38;2;r;g;b)', async () => {
    const term = makeTerminal();
    await writeToTerminal(
      term,
      '\x1b[38;5;196mRed256\x1b[0m\r\n\x1b[38;2;255;128;0mOrange\x1b[0m\r\n',
    );
    const lines = readTerminalLines(term, term.rows);
    expect(lines.find((l) => l.some((c) => c.text.includes('Red256')))).toEqual([
      { text: 'Red256', color: '#ff0000' },
    ]);
    expect(lines.find((l) => l.some((c) => c.text.includes('Orange')))).toEqual([
      { text: 'Orange', color: '#ff8000' },
    ]);
  });

  it(
    'un outil hébergé qui redessine sa ligne de statut par positionnement de curseur ' +
      "écrase l'ancien contenu — ne l'empile JAMAIS dessus (bug réel corrigé le " +
      '2026-09-09 : plusieurs états successifs de la même ligne apparaissaient ' +
      'concaténés — cf. capture watch --ui, "Try ... / auto mode on / connecting..." ' +
      'tous mélangés sur la même ligne)',
    async () => {
      const term = makeTerminal(40, 5);
      // L'outil hébergé écrit un premier état de sa ligne de statut...
      await writeToTerminal(term, '\x1b[5;1HTry "fix lint errors"');
      // ...puis remonte le curseur en début de ligne et réécrit PAR-DESSUS
      // avec un texte différent (padding d'espaces pour effacer le
      // reliquat) — exactement un redessin de barre de statut.
      await writeToTerminal(term, `\x1b[5;1Hauto mode on${' '.repeat(15)}`);
      const lines = readTerminalLines(term, term.rows);
      const last = lines[lines.length - 1];
      const text = (last ?? []).map((c) => c.text).join('');
      expect(text).toBe('auto mode on');
      expect(text).not.toContain('fix lint errors'); // pas d'empilement des deux états
    },
  );

  it(
    'ne laisse jamais de séquence brute dans le texte affiché (curseur, clear, ' +
      'écran alternatif, clavier Kitty, modifyOtherKeys)',
    async () => {
      const term = makeTerminal();
      await writeToTerminal(
        term,
        '\x1b[2J\x1b[H\x1b[?1049h\x1b[<u\x1b[>5u\x1b[>4;2m\x1b[31mrouge\x1b[0m encore\r\n',
      );
      const lines = readTerminalLines(term, term.rows);
      for (const chunk of lines.flat()) {
        expect(chunk.text.includes('\x1b')).toBe(false);
      }
    },
  );

  it('ne montre que les N dernières lignes (scrollback compris)', async () => {
    const term = makeTerminal(20, 3);
    let data = '';
    for (let i = 1; i <= 10; i++) data += `ligne${i}\r\n`;
    await writeToTerminal(term, data);
    // Chaque `\r\n` déplace vraiment le curseur sur une ligne neuve encore
    // vide — un terminal réel montrerait la même chose à qui s'attache
    // maintenant : les 3 dernières lignes écrites, puis la ligne courante
    // vide où le curseur attend la suite.
    const lines = readTerminalLines(term, 4);
    expect(linesText(lines)).toEqual(['ligne8', 'ligne9', 'ligne10', '']);
  });
});

describe('parseAgentMessage', () => {
  it('extrait agent et texte de "@agent message"', () => {
    expect(parseAgentMessage('@agent-a fais le refactor')).toEqual({
      agent: 'agent-a',
      text: 'fais le refactor',
    });
  });

  it('accepte un message multi-mots avec espaces', () => {
    expect(parseAgentMessage('  @agent-a   commit puis push  ')).toEqual({
      agent: 'agent-a',
      text: 'commit puis push',
    });
  });

  it('renvoie null sans préfixe @', () => {
    expect(parseAgentMessage('agent-a fais le refactor')).toBeNull();
  });

  it('renvoie null sans texte de message', () => {
    expect(parseAgentMessage('@agent-a')).toBeNull();
    expect(parseAgentMessage('@agent-a   ')).toBeNull();
  });
});

describe('computeSuggestions', () => {
  const agents = [
    { name: 'agent-a', status: 'ACTIVE', mode: 'attended' },
    { name: 'agent-ask', status: 'ACTIVE', mode: 'autonomous' },
    { name: 'agent-b', status: 'STOPPED', mode: 'attended' },
  ];

  it('"@" seul liste tous les agents (aucun filtre)', () => {
    const result = computeSuggestions('@', agents);
    expect(result.map((s) => s.value)).toEqual(['agent-a', 'agent-ask', 'agent-b']);
    expect(result.every((s) => s.kind === 'agent')).toBe(true);
  });

  it('"@ag" filtre par préfixe, insensible à la casse', () => {
    expect(computeSuggestions('@AG', agents).map((s) => s.value)).toEqual([
      'agent-a',
      'agent-ask',
      'agent-b',
    ]);
    expect(computeSuggestions('@agent-a', agents).map((s) => s.value)).toEqual([
      'agent-a',
      'agent-ask',
    ]);
  });

  it('un espace après le nom (message déjà commencé) : plus de suggestion', () => {
    expect(computeSuggestions('@agent-a salut', agents)).toEqual([]);
  });

  it('"/" seul liste toutes les commandes striart', () => {
    const result = computeSuggestions('/', []);
    expect(result.length).toBeGreaterThan(15);
    expect(result.every((s) => s.kind === 'command')).toBe(true);
    expect(result.map((s) => s.value)).toContain('status');
    expect(result.map((s) => s.value)).toContain('exit');
  });

  it('"/me" filtre par préfixe (ex. "merge")', () => {
    expect(computeSuggestions('/me', []).map((s) => s.value)).toEqual(['merge']);
  });

  it('un espace après la commande (arguments déjà commencés) : plus de suggestion', () => {
    expect(computeSuggestions('/merge agent-a', [])).toEqual([]);
  });

  it('texte sans préfixe "@"/"/" : aucune suggestion', () => {
    expect(computeSuggestions('bonjour', agents)).toEqual([]);
    expect(computeSuggestions('', agents)).toEqual([]);
  });
});

describe('looksLikeIdleShellPrompt', () => {
  const line = (text) => [{ text }];

  it('reconnaît une invite PowerShell inactive', () => {
    expect(
      looksLikeIdleShellPrompt([line('PS C:\\Projets\\batilogis\\.striart\\agents\\agent-b>')]),
    ).toBe(true);
  });

  it('reconnaît une invite cmd.exe inactive', () => {
    expect(looksLikeIdleShellPrompt([line('C:\\Projets\\batilogis>')])).toBe(true);
  });

  it('reconnaît une invite POSIX inactive (bash/zsh)', () => {
    expect(looksLikeIdleShellPrompt([line('jumsay@dragon:~/projets$')])).toBe(true);
    expect(looksLikeIdleShellPrompt([line('root@dragon:/etc#')])).toBe(true);
  });

  it("ne se déclenche pas sur la sortie normale d'un outil hébergé", () => {
    expect(
      looksLikeIdleShellPrompt([line('Bonjour ! Sur quoi souhaitez-vous que je travaille ?')]),
    ).toBe(false);
  });

  it('ignore les lignes vides en fin d’écran pour trouver la dernière ligne réelle', () => {
    expect(looksLikeIdleShellPrompt([line('PS C:\\agent-b>'), line(''), line('   '), []])).toBe(
      true,
    );
  });

  it('écran entièrement vide : pas une invite inactive (rien à en conclure)', () => {
    expect(looksLikeIdleShellPrompt([[], line(''), line('   ')])).toBe(false);
  });
});

/**
 * Seul membre de `LogTailManager` qui ne touche ni pty ni socket (le reste
 * dépend de `ensurePtyHost`/`connectAttachClient` réels — testés via
 * `routeAgentMessage` ci-dessous) : `root` n'a donc pas besoin d'exister sur
 * le disque pour ce test.
 */
describe('LogTailManager.appendCommandOutput', () => {
  it('accumule la sortie dans le tab TERMINAL_TAB, consultable via get()', async () => {
    const manager = new LogTailManager('/chemin/jamais-touché', () => {});
    manager.appendCommandOutput('❯ /status', 'AGENT    STATUT\nagent-a  ACTIVE');
    await waitFor(() => manager.get(TERMINAL_TAB).lines.length > 0);

    const state = manager.get(TERMINAL_TAB);
    expect(state.connected).toBe(true);
    const text = linesText(state.lines).filter(Boolean);
    expect(text).toContain('❯ /status');
    expect(text.some((l) => l.includes('agent-a  ACTIVE'))).toBe(true);
  });

  it('accumule PLUSIEURS commandes à la suite (historique, pas un remplacement)', async () => {
    const manager = new LogTailManager('/chemin/jamais-touché', () => {});
    manager.appendCommandOutput('❯ /status', 'rien');
    await waitFor(() => manager.get(TERMINAL_TAB).lines.length > 0);
    manager.appendCommandOutput('❯ !ls', 'README.md');
    await waitFor(() => linesText(manager.get(TERMINAL_TAB).lines).some((l) => l.includes('!ls')));

    const text = linesText(manager.get(TERMINAL_TAB).lines);
    expect(text).toContain('❯ /status');
    expect(text).toContain('❯ !ls');
  });

  it("sortie vide : affiche un texte explicite plutôt qu'une ligne blanche", async () => {
    const manager = new LogTailManager('/chemin/jamais-touché', () => {});
    manager.appendCommandOutput('❯ /profiles', '');
    await waitFor(() => manager.get(TERMINAL_TAB).lines.length > 0);
    expect(linesText(manager.get(TERMINAL_TAB).lines)).toContain('(aucune sortie)');
  });

  it('"/clear" (clearTerminalTab) vide bien l’historique accumulé', async () => {
    const manager = new LogTailManager('/chemin/jamais-touché', () => {});
    manager.appendCommandOutput('❯ /status', 'AGENT STATUT');
    await waitFor(() => manager.get(TERMINAL_TAB).lines.length > 0);

    manager.clearTerminalTab();
    const state = manager.get(TERMINAL_TAB);
    expect(state.connected).toBe(true);
    expect(state.lines).toEqual([]);

    // Une commande APRÈS un clear repart bien de zéro, pas d'un terminal
    // "à moitié disposé" — le prochain appendCommandOutput doit fonctionner
    // normalement (nouveau terminal émulé recréé au besoin).
    manager.appendCommandOutput('❯ /profiles', 'aucun profil');
    await waitFor(() => manager.get(TERMINAL_TAB).lines.length > 0);
    expect(linesText(manager.get(TERMINAL_TAB).lines)).toContain('❯ /profiles');
  });
});

describe('routeAgentMessage', () => {
  let root;
  const agent = 'agent-route';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-watch-ui-'));
  });

  afterEach(async () => {
    await stopPtyHost(root, agent).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400)); // cf. pty-attach.test.js
  });

  it('refuse un agent inconnu (meta absente)', async () => {
    const result = await routeAgentMessage(root, 'fantome', 'salut', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('inconnu');
  });

  it('refuse explicitement un agent en mode autonome (Phase E non câblée)', async () => {
    const result = await routeAgentMessage(root, agent, 'salut', {
      mode: 'autonomous',
      path: root,
      command: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('autonome');
      expect(result.reason).toContain('Phase E');
    }
  });

  it(
    "démarre l'hôte au besoin et livre le message à un agent supervisé (vérifié via un attach client)",
    () =>
      withRealPtySlot(async () => {
        // ensurePtyHost (appelé par routeAgentMessage) exige désormais un agent
        // réellement inscrit au registre (défense en profondeur) — seedé ici,
        // séparément du 4e argument (agentMeta) passé directement à la fonction.
        await seedAgentRegistry(root, agent);
        // `command` est l'OUTIL de l'agent (résolu par resolveAttendedCommand),
        // pas le shell hébergeant le pty (celui-là est toujours defaultShell() —
        // fixé par routeAgentMessage) : lui passer SHELL relancerait un second
        // shell imbriqué comme "commande initiale", pas ce que ce test vérifie.
        const result = await routeAgentMessage(root, agent, 'echo ROUTE-MARQUEUR', {
          mode: 'attended',
          path: root,
          command: 'echo COMMANDE-INITIALE-IGNOREE',
        });
        expect(result.ok).toBe(true);

        // Grâce au tampon de rejeu (pty-attach.ts), un client qui se connecte
        // APRÈS l'envoi voit quand même la sortie déjà produite.
        let buffer = '';
        const conn = await connectWithRetry(root, agent, { onData: (t) => (buffer += t) });
        await waitFor(() => buffer.includes(`ROUTE-MARQUEUR${ECHO_EOL}`));
        conn.close();
      }),
    45000,
  );
});
