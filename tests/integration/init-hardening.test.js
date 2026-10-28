import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { logger } from '../../src/logger.js';
import { resetStateProtectionMemo } from '../../src/state-protection.ts';
import { resetHardenMemo } from '../../src/private-fs.ts';

const hardeningLogs = (spy) =>
  spy.mock.calls.filter((call) => String(call[call.length - 1]).includes('resserrées'));

describe('striart init : journal du durcissement', () => {
  let repo;
  let info;
  beforeEach(async () => {
    repo = await createTempRepo();
    info = vi.spyOn(logger, 'info');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await repo.cleanup();
  });

  // Chaque `striart init` est un nouveau process : mémoires par process remises à zéro.
  const freshProcess = () => {
    resetStateProtectionMemo();
    resetHardenMemo();
  };

  it('init idempotent : aucune ligne « resserrées » (ni au premier init, ni aux suivants)', async () => {
    await initStriart(repo.root);
    freshProcess();
    await initStriart(repo.root);
    freshProcess();
    await initStriart(repo.root);
    expect(hardeningLogs(info)).toHaveLength(0);
  });

  it('migration d’un .striart/ préexistant ouvert : une seule ligne, puis plus rien', async () => {
    await mkdir(path.join(repo.root, '.striart'));
    await initStriart(repo.root);
    expect(hardeningLogs(info)).toHaveLength(1);
    freshProcess();
    await initStriart(repo.root);
    expect(hardeningLogs(info)).toHaveLength(1);
  });
});

describe('striart init : gabarit de configuration', () => {
  it('cite les modèles vérifiés le 2026-10-26, aucun modèle périmé', async () => {
    const repo = await createTempRepo();
    try {
      await initStriart(repo.root);
      const template = await readFile(path.join(repo.root, 'striart.config.mjs'), 'utf8');
      expect(template).toContain('gpt-5.4-mini');
      expect(template).toContain('claude-haiku-5-5');
      expect(template).toContain('openai/gpt-oss-120b');
      expect(template).not.toMatch(/gpt-4o-mini|claude-haiku-4-5|llama-3\.3-70b/);
    } finally {
      await repo.cleanup();
    }
  });
});
