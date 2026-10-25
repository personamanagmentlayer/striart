import { describe, expect, it, vi } from 'vitest';

// Ink réel exigerait un terminal en mode raw : on remplace `render` par une
// instance factice dont la fin ne survient qu'au démontage — exactement ce
// que fait Ink.
const instances = [];
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    render: vi.fn(() => {
      let finish;
      const exited = new Promise((resolve) => {
        finish = resolve;
      });
      const instance = {
        unmount: vi.fn(() => finish()),
        waitUntilExit: () => exited,
      };
      instances.push(instance);
      return instance;
    }),
  };
});

const { runWatchUi } = await import('../../src/watch-ui.ts');

describe('runWatchUi : arrêt demandé de l’extérieur', () => {
  // `watch` est une commande à arrêt propre (main.ts) : le premier SIGTERM
  // ne fait qu'abandonner ctx.signal. Avant, l'UI ne l'écoutait pas — un
  // seul SIGTERM était ignoré, il en fallait un second.
  it('se démonte quand le signal est abandonné', async () => {
    const controller = new AbortController();
    const done = runWatchUi('/repo', { signal: controller.signal });
    await Promise.resolve();
    expect(instances).toHaveLength(1);
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(instances[0].unmount).toHaveBeenCalledTimes(1);
  });

  it('signal déjà abandonné : ne monte rien', async () => {
    const before = instances.length;
    await runWatchUi('/repo', { signal: AbortSignal.abort() });
    expect(instances).toHaveLength(before);
  });
});
