import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SEMANTIC_FAILURES,
  readState,
  recordSemanticFailure,
  recordSemanticSuccess,
  resetManualMode,
} from '../../src/state.js';

describe("state (règle d'or n°4)", () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-state-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
  });

  it('état par défaut : pas de mode manuel, streak 0', async () => {
    expect(await readState(root)).toEqual({ semanticFailureStreak: 0, manualMode: false });
  });

  it('passe en mode manuel après 3 échecs consécutifs', async () => {
    for (let i = 1; i < MAX_SEMANTIC_FAILURES; i += 1) {
      const state = await recordSemanticFailure(root);
      expect(state.manualMode).toBe(false);
    }
    const final = await recordSemanticFailure(root);
    expect(final).toMatchObject({ semanticFailureStreak: 3, manualMode: true });
  });

  it('un succès remet le compteur à zéro', async () => {
    await recordSemanticFailure(root);
    await recordSemanticFailure(root);
    const state = await recordSemanticSuccess(root);
    expect(state.semanticFailureStreak).toBe(0);
    expect(state.manualMode).toBe(false);
  });

  it('resetManualMode réactive tout', async () => {
    for (let i = 0; i < MAX_SEMANTIC_FAILURES; i += 1) await recordSemanticFailure(root);
    expect((await readState(root)).manualMode).toBe(true);
    await resetManualMode(root);
    expect(await readState(root)).toEqual({ semanticFailureStreak: 0, manualMode: false });
  });
});
