import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractL10nStrings } from '../../scripts/l10n-strings.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = async (rel: string) => readFile(`${root}${rel}`, 'utf8');
const json = async <T = Record<string, string>>(rel: string): Promise<T> => JSON.parse(await read(rel)) as T;

describe('manifeste et localisation', () => {
  it('chaque message l10n.t() a sa traduction française (et inversement)', async () => {
    const used = new Set<string>(await extractL10nStrings(`${root}src`));
    const fr = new Set(Object.keys(await json('l10n/bundle.l10n.fr.json')));
    assert.deepEqual(
      [...used].filter((s) => !fr.has(s)),
      [],
      'messages sans traduction fr',
    );
    assert.deepEqual(
      [...fr].filter((s) => !used.has(s)),
      [],
      'traductions orphelines',
    );
  });

  it('chaque %clé% du manifeste existe en en et en fr, et inversement', async () => {
    const manifest = await read('package.json');
    const keys = new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]!));
    const en = new Set(Object.keys(await json('package.nls.json')));
    const fr = new Set(Object.keys(await json('package.nls.fr.json')));
    assert.deepEqual(
      [...keys].filter((k) => !en.has(k)),
      [],
    );
    assert.deepEqual(
      [...keys].filter((k) => !fr.has(k)),
      [],
    );
    assert.deepEqual(
      [...en].filter((k) => !keys.has(k)),
      [],
      'clés nls inutilisées',
    );
    assert.deepEqual([...en].sort(), [...fr].sort());
  });

  it('les placeholders {n} sont identiques entre l’anglais et le français', async () => {
    const fr = await json('l10n/bundle.l10n.fr.json');
    const placeholders = (s: string) =>
      [...s.matchAll(/\{\d+\}/g)]
        .map((m) => m[0])
        .sort()
        .join(',');
    for (const [en, tr] of Object.entries(fr)) assert.equal(placeholders(tr), placeholders(en), en);
  });

  it('réglages sensibles en scope machine, aucune dépendance d’exécution, pas de télémétrie', async () => {
    const pkg = await json<{
      dependencies?: unknown;
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
      capabilities: { untrustedWorkspaces: { supported: string } };
      activationEvents: string[];
    }>('package.json');
    assert.equal(pkg.dependencies, undefined);
    const props = pkg.contributes.configuration.properties;
    for (const key of ['striart.binaryPath', 'striart.nodePath']) assert.equal(props[key]!.scope, 'machine', key);
    assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
    assert.ok(!pkg.activationEvents.includes('*'));
    assert.ok(!Object.keys(props).some((k) => /telemetry/i.test(k)));
  });

  it('chaque commande déclarée est enregistrée dans le code, et inversement', async () => {
    const pkg = await json<{ contributes: { commands: Array<{ command: string }> } }>('package.json');
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    const source = await read('src/extension.ts');
    const registered = new Set([...source.matchAll(/reg\('(striart\.[A-Za-z]+)'/g)].map((m) => m[1]!));
    assert.deepEqual(
      [...declared].filter((c) => !registered.has(c)),
      [],
    );
    assert.deepEqual(
      [...registered].filter((c) => !declared.has(c)),
      [],
    );
  });
});
