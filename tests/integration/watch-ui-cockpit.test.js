import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { waitFor } from '../helpers/pty-test-utils.js';
import { initStriart } from '../../src/init.ts';
import { runWatchUi } from '../../src/watch-ui.ts';
import { fr } from '../../src/cli/i18n/fr.ts';

/**
 * Le VRAI Ink et le VRAI cockpit sur un terminal simulé (flux en mémoire) :
 * clavier, raccourcis, aide, confirmation, sortie propre, aucune fuite
 * (minuteurs, abonnements). L'état vient d'un vrai dépôt Striart temporaire.
 */
function fakeTerminal(columns = 100, rows = 30) {
  const stdout = new PassThrough();
  Object.assign(stdout, { columns, rows, isTTY: true });
  let output = '';
  let writes = 0;
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
    writes += 1;
  });
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  return {
    stdin,
    stdout,
    // eslint-disable-next-line no-control-regex -- retire les séquences d'écran pour lire le texte
    text: () => output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''),
    writes: () => writes,
    resetText: () => {
      output = '';
    },
  };
}

const CAPS = { unicode: true, colorStdout: false, plain: false, theme: 'default', animate: false };

describe('cockpit watch --ui (Ink réel, terminal simulé)', () => {
  let repo;
  let term;
  let done;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    term = fakeTerminal();
  });

  afterEach(async () => {
    term.stdin.write('\u0003'); // Ctrl+C : sortie de secours si un test a échoué en route
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await repo.cleanup();
  });

  function start(extra = {}) {
    done = runWatchUi(repo.root, {
      messages: fr,
      caps: CAPS,
      autoMerge: true,
      io: { stdin: term.stdin, stdout: term.stdout },
      ...extra,
    });
    return done;
  }

  it('affiche tout de suite l’en-tête et l’état vide, avec la barre de touches', async () => {
    start();
    await waitFor(() => term.text().includes('striart watch'), 15000);
    await waitFor(() => term.text().includes('Aucun agent pour l’instant.'), 15000);
    const text = term.text();
    expect(text).toContain('striart start agent-a');
    expect(text).toContain('quitter');
    expect(text).toContain('aide');
  });

  it('? ouvre l’aide, Échap la ferme, q quitte et la promesse se résout', async () => {
    start();
    await waitFor(() => term.text().includes('Aucun agent pour l’instant.'), 15000);
    term.resetText();
    term.stdin.write('?');
    await waitFor(() => term.text().includes('Aide — raccourcis'), 8000);
    term.resetText();
    term.stdin.write('\u001b');
    await waitFor(() => term.text().includes('Appuie sur / pour une commande'), 8000);
    term.stdin.write('q');
    await expect(done).resolves.toBeUndefined();
  });

  it('dans le champ de saisie, q n’est PAS un raccourci (il s’écrit)', async () => {
    start();
    await waitFor(() => term.text().includes('Aucun agent pour l’instant.'), 15000);
    term.stdin.write('/');
    await waitFor(() => term.text().includes('envoyer'), 8000); // barre de touches de la saisie
    term.resetText();
    term.stdin.write('q');
    await waitFor(() => term.text().includes('/q'), 8000);
    // Le cockpit est toujours là : la promesse n'est pas résolue.
    const state = await Promise.race([
      done.then(() => 'exited'),
      new Promise((r) => setTimeout(() => r('alive'), 400)),
    ]);
    expect(state).toBe('alive');
    term.stdin.write('\u001b'); // Échap abandonne la saisie
    await waitFor(() => term.text().includes('Appuie sur / pour une commande'), 8000);
  });

  it('abandon par signal : démonté proprement, plus aucune écriture ensuite (aucune fuite de minuteur)', async () => {
    const controller = new AbortController();
    start({ signal: controller.signal });
    await waitFor(() => term.text().includes('Aucun agent pour l’instant.'), 15000);
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    const writesAtExit = term.writes();
    // L'horloge (1 s) et le rafraîchissement (8 s) auraient écrit dans cette fenêtre s'ils fuyaient.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(term.writes()).toBe(writesAtExit);
  });

  it('ne laisse aucun écouteur de process derrière lui', async () => {
    const before = ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException'].map((e) =>
      process.listenerCount(e),
    );
    start();
    await waitFor(() => term.text().includes('Aucun agent pour l’instant.'), 15000);
    term.stdin.write('q');
    await done;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException'].map((e) =>
      process.listenerCount(e),
    );
    expect(after).toEqual(before);
  });

  it('au repos : aucune repeinture en rafale (< 1 image/s), donc pas de scintillement ni de CPU', async () => {
    start();
    await waitFor(() => term.text().includes('Aucun agent pour l’instant.'), 15000);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // laisse finir le premier rafraîchissement
    const before = term.writes();
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(term.writes() - before).toBeLessThanOrEqual(2);
    term.stdin.write('q');
    await done;
  });

  it('redimensionnement : la trame est recalculée à la nouvelle largeur', async () => {
    start();
    await waitFor(() => term.text().includes('commits en attente'), 15000); // libellé large (≥ 72 colonnes)
    term.resetText();
    Object.assign(term.stdout, { columns: 60, rows: 20 });
    term.stdout.emit('resize');
    await waitFor(() => term.text().includes('ag.'), 8000); // libellé court des chiffres clés
    term.stdin.write('q');
    await done;
  });

  it('terminal trop petit : message explicite, jamais un cadre cassé', async () => {
    term = fakeTerminal(30, 8);
    start();
    await waitFor(() => term.text().includes('trop petit'), 15000);
    term.stdin.write('q');
    await done;
  });
});

describe('watch --ui --plain : mode linéaire (lecteur d’écran, CI, console ancienne)', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  function plainTerminal() {
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true });
    const stdout = new PassThrough();
    Object.assign(stdout, { isTTY: true, columns: 80 });
    let text = '';
    stdout.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    return { stdin, stdout, text: () => text };
  }

  const PLAIN_CAPS = {
    unicode: false,
    colorStdout: false,
    plain: true,
    theme: 'default',
    animate: false,
  };

  it('imprime un flux de lignes ASCII sans séquence d’écran, répond aux commandes et se ferme sur q', async () => {
    const t = plainTerminal();
    const done = runWatchUi(repo.root, {
      messages: fr,
      caps: PLAIN_CAPS,
      autoMerge: false,
      io: { stdin: t.stdin, stdout: t.stdout },
    });
    await waitFor(() => t.text().includes('watcher actif'), 20000);
    t.stdin.write('?\n');
    await waitFor(
      () => t.text().includes('Aide - raccourcis') || t.text().includes('Navigation'),
      8000,
    );
    t.stdin.write('m ghost\n');
    await waitFor(() => t.text().includes('Fusionner "ghost" dans main ?'), 8000);
    expect(t.text()).toMatch(/Test Gate/);
    t.stdin.write('n\n'); // tout autre mot que « y » annule : Entrée seule n'est jamais un oui
    await waitFor(() => t.text().includes('Annulé.'), 8000);
    t.stdin.write('q\n');
    await expect(done).resolves.toBeUndefined();

    const text = t.text();
    // Aucune séquence d'échappement (couleur, curseur, écran alternatif) : texte nu.
    // eslint-disable-next-line no-control-regex -- vérifie l'absence de séquences de contrôle
    expect(text).not.toMatch(/\u001b/);
    // Les niveaux sont des mots, pas des glyphes.
    expect(text).not.toMatch(/[●○✓✗▸]/u);
  });
});
