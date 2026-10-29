import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent, scanHistoricalSecrets } from '../../src/clone.ts';
import { compileSecretPattern, secretPatternMatches } from '../../src/secret-patterns.ts';

/** Contrat S-I3 : l'exclusion des secrets trackés ne dépend pas de la forme du motif. */
describe('secretPatterns : syntaxe gitignore complète, fail closed (S-I3)', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  async function track(files) {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo.root, file)), { recursive: true });
      await writeFile(path.join(repo.root, file), content);
      await repo.git.add([file]);
    }
    await repo.git.commit('chore: fichiers');
  }
  const gone = async (p) => (await stat(p).catch(() => null)) === null;

  it.each([
    ['/.env', { '.env': 'S=1\n', 'a/.env': 'ok\n' }, ['.env']],
    [
      'secrets/',
      { 'secrets/k.txt': 'S\n', 'x/secrets/y.txt': 'S\n', 'app.js': 'ok\n' },
      ['secrets/k.txt', 'x/secrets/y.txt'],
    ],
    ['**/.env', { '.env': 'S\n', 'a/b/c/.env': 'S\n', 'app.js': 'ok\n' }, ['.env', 'a/b/c/.env']],
    ['config/*.key', { 'config/a.key': 'S\n', 'other/a.key': 'ok\n' }, ['config/a.key']],
    ['clé.pem', { 'clé.pem': 'S\n', 'app.js': 'ok\n' }, ['clé.pem']],
  ])('motif %s : masqué du clone', async (pattern, files, expected) => {
    await track(files);
    const info = await createAgent({
      root: repo.root,
      name: 'agent-a',
      secretPatterns: [pattern],
      allowHistoricalSecrets: true,
    });
    expect([...info.secretsExcluded].sort()).toEqual([...expected].sort());
    for (const file of expected) expect(await gone(path.join(info.path, file))).toBe(true);
    expect((await simpleGit(info.path).status()).isClean()).toBe(true);
  });

  it('scan historique : nom non ASCII et renommage vers un nom de secret', async () => {
    await track({ 'clé.pem': 'S\n', 'neutre.txt': 'x\n' });
    await repo.git.raw(['mv', 'neutre.txt', 'prod.key']);
    await repo.git.commit('chore: renomme');
    const found = await scanHistoricalSecrets(repo.root, ['*.pem', '*.key']);
    expect(found).toEqual(['clé.pem', 'prod.key']);
  });

  it('l évaluateur JS (historique) concorde avec git (tracké) sur les formes de motifs', async () => {
    const files = [
      '.env',
      'a/.env',
      'a/b/.env',
      'secrets/k',
      'x/secrets/k',
      'config/a.key',
      'other/a.key',
      'deep/er/f.pem',
      'plain.txt',
    ];
    await track(Object.fromEntries(files.map((f) => [f, 'x\n'])));
    for (const pattern of [
      '.env',
      '/.env',
      '**/.env',
      'secrets/',
      '/secrets/',
      'config/*.key',
      '*.pem',
      'deep/**',
      'a/**/.env',
    ]) {
      const raw = await repo.git.raw([
        '--literal-pathspecs',
        'ls-files',
        '-z',
        '--cached',
        '--ignored',
        `--exclude=${pattern}`,
      ]);
      const byGit = raw.split(String.fromCharCode(0)).filter(Boolean).sort();
      const compiled = compileSecretPattern(pattern);
      const byJs = files.filter((f) => secretPatternMatches(compiled, f)).sort();
      expect(byJs, pattern).toEqual(byGit);
    }
  });

  it('refuse une négation ou un commentaire (CONFIG/SECRET_PATTERN_INVALID)', async () => {
    expect(() => compileSecretPattern('!.env')).toThrow(/non supporté/);
    expect(() => compileSecretPattern('#x')).toThrow(/non supporté/);
  });
});
