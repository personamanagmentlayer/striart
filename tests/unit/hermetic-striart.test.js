import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { llmGenerate } from '../../src/llm.ts';
import { predictFiles } from '../../src/router.ts';
import { resetRootCache, resolveRoot } from '../../src/tokens/call.ts';
import { resetUsageIndex } from '../../src/tokens/ledger.ts';
import { withTokenContext } from '../../src/tokens/context.ts';
import { diffSnapshots, snapshotUsageTree } from '../helpers/hermetic-striart.js';

/**
 * Garde de régression : un test unitaire n'écrit JAMAIS dans le `.striart/` du
 * dépôt de développement. On simule ce dépôt par un dossier temporaire qui
 * contient un `.striart/`, et on appelle le LLM « comme le font les tests
 * unitaires » : sans racine, depuis l'intérieur de ce dépôt (config.configPath).
 */
const reply = (text) => ({ ok: true, json: async () => ({ response: text, done_reason: 'stop' }) });

describe('tests unitaires hermétiques vis-à-vis de .striart/', () => {
  let dev; // faux « dépôt de développement » initialisé
  let config;

  beforeEach(async () => {
    resetRootCache();
    resetUsageIndex();
    dev = await mkdtemp(path.join(os.tmpdir(), 'striart-hermetic-'));
    await mkdir(path.join(dev, '.striart'), { recursive: true });
    config = {
      ollamaHost: 'http://localhost:11434',
      ollamaModel: 'llama3.1:8b',
      configPath: path.join(dev, '.striartrc.json'),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('{"files": ["a.js"]}')));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetRootCache();
    await rm(dev, { recursive: true, force: true, maxRetries: 5 });
  });

  it('le projet unit neutralise la découverte implicite de la racine', () => {
    expect(process.env.STRIART_TOKENS_NO_DISCOVERY).toBe('1');
  });

  it('llmGenerate sans racine, dans un dépôt initialisé : rien n’est écrit (registre ni cache)', async () => {
    await llmGenerate({ config, prompt: 'p', role: 'router', retries: 0 });
    await predictFiles({ prompt: 'tâche', projectFiles: ['a.js'], config });
    expect(fetch).toHaveBeenCalledTimes(2); // le cache n'a pas servi : rien n'a été écrit
    await expect(readdir(path.join(dev, '.striart'))).resolves.toEqual([]);
  });

  it('une racine EXPLICITE (ou posée par le contexte) reste honorée : les tests d’usage fonctionnent', async () => {
    expect(await resolveRoot(dev, config)).toBe(dev);
    await withTokenContext({ root: dev }, async () => {
      expect(await resolveRoot(null, config)).toBe(dev);
    });
    await llmGenerate({ config, prompt: 'p', role: 'router', retries: 0, root: dev });
    const files = await readdir(path.join(dev, '.striart', 'usage'));
    expect(files.some((f) => f.endsWith('.ndjson'))).toBe(true);
  });

  it('témoin : sans la neutralisation, le MÊME appel écrirait dans le .striart/ découvert', async () => {
    // Prouve que ce fichier sait détecter la pollution (un test qui ne peut
    // pas échouer ne prouve rien) : découverte rétablie → le registre est écrit.
    vi.stubEnv('STRIART_TOKENS_NO_DISCOVERY', '');
    resetRootCache();
    await llmGenerate({ config, prompt: 'p', role: 'router', retries: 0 });
    const files = await readdir(path.join(dev, '.striart', 'usage')).catch(() => []);
    expect(files.some((f) => f.endsWith('.ndjson'))).toBe(true);
  });
});

describe('empreinte de .striart/usage (garde posée par le setup du projet unit)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-snapshot-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('dossier absent : empreinte vide, aucun écart', async () => {
    const empty = await snapshotUsageTree(root);
    expect(empty.size).toBe(0);
    expect(diffSnapshots(empty, await snapshotUsageTree(root))).toEqual([]);
  });

  it('détecte un fichier créé, modifié ou supprimé, y compris dans le cache', async () => {
    const usage = path.join(root, '.striart', 'usage');
    await mkdir(path.join(usage, 'cache'), { recursive: true });
    await writeFile(path.join(usage, '2026-10-24.ndjson'), '{}\n');
    const before = await snapshotUsageTree(root);

    await writeFile(path.join(usage, 'cache', 'k.json'), '{}');
    expect(diffSnapshots(before, await snapshotUsageTree(root))).toEqual([
      path.join('.striart', 'usage', 'cache', 'k.json'),
    ]);

    await writeFile(path.join(usage, '2026-10-24.ndjson'), '{}\n{}\n');
    expect(diffSnapshots(before, await snapshotUsageTree(root))).toContain(
      path.join('.striart', 'usage', '2026-10-24.ndjson'),
    );

    await rm(path.join(usage, '2026-10-24.ndjson'));
    expect(diffSnapshots(before, await snapshotUsageTree(root))).toContain(
      path.join('.striart', 'usage', '2026-10-24.ndjson'),
    );
  });
});
