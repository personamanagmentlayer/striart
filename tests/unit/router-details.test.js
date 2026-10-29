import { describe, expect, it } from 'vitest';
import { publicRouterDetails } from '../../src/router-details.ts';
import { tokensRelaxations } from '../../src/tokens/settings.ts';
import { collectRelaxations } from '../../src/doctor-relaxations.ts';

const details = {
  promptVersion: 'router-v3.1',
  sample: { files: [{ path: 'secret-llm-output.txt' }], raw: 'NE DOIT PAS SORTIR' },
  files: [
    { path: 'src/a.js', confidence: 0.9, source: 'llm' },
    {
      path: 'tests/a.test.js',
      confidence: 0.7,
      source: 'expansion',
      reason: 'test',
      from: 'src/a.js',
    },
    { path: '../evil', confidence: 1, source: 'llm' },
  ],
  shared: ['CHANGELOG.md'],
  serialized: { kind: 'vague', reasons: ['broad-scope'] },
  expansion: [{ path: 'tests/a.test.js', reason: 'test', from: 'src/a.js', confidence: 0.7 }],
  tree: { mode: 'full', total: 10, shown: 10, omitted: 0, estimatedTokens: 99 },
  retrieval: [{ path: 'x', score: 1 }],
};

describe('publicRouterDetails — forme publique additive', () => {
  it('garde raison de sérialisation, shared, expansions, fichiers ; jamais la sortie brute du LLM', () => {
    const pub = publicRouterDetails(details);
    expect(pub.serialized).toEqual({ kind: 'vague', reasons: ['broad-scope'] });
    expect(pub.shared).toEqual(['CHANGELOG.md']);
    expect(pub.expansion).toEqual([
      { path: 'tests/a.test.js', reason: 'test', from: 'src/a.js', confidence: 0.7 },
    ]);
    expect(pub.files.map((f) => f.path)).toEqual(['src/a.js', 'tests/a.test.js']);
    expect(JSON.stringify(pub)).not.toContain('NE DOIT PAS SORTIR');
    expect(JSON.stringify(pub)).not.toContain('secret-llm-output');
  });

  it('filtre les chemins non sûrs et borne les listes', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ path: `src/f${i}.js`, source: 'llm' }));
    const pub = publicRouterDetails({ ...details, files: many, shared: many.map((f) => f.path) });
    expect(pub.files.length).toBeLessThanOrEqual(50);
    expect(pub.shared.length).toBeLessThanOrEqual(50);
  });

  it('détails absents ou mal formés : null, jamais une exception', () => {
    expect(publicRouterDetails(null)).toBeNull();
    expect(publicRouterDetails(undefined)).toBeNull();
    expect(publicRouterDetails('x')).toBeNull();
  });
});

describe('doctor — tenue de livre et filet', () => {
  it("sharedFiles posé EXPLICITEMENT à 'exclude' est un relâchement affiché", () => {
    expect(
      tokensRelaxations({ tokens: { router: { sharedFiles: { mode: 'exclude' } } } }).map(
        (r) => r.key,
      ),
    ).toContain('tokens.router.sharedFiles');
  });

  it("le défaut implicite ('exclude' hérité) n'est pas un relâchement", () => {
    expect(tokensRelaxations({}).map((r) => r.key)).not.toContain('tokens.router.sharedFiles');
    expect(
      tokensRelaxations({ tokens: { router: { sharedFiles: { mode: 'keep' } } } }).map(
        (r) => r.key,
      ),
    ).not.toContain('tokens.router.sharedFiles');
  });

  it('collectRelaxations remonte les deux', () => {
    const report = collectRelaxations({
      config: {
        overlap: { enabled: false },
        tokens: { router: { sharedFiles: { mode: 'exclude' } } },
      },
    });
    expect(report.names).toEqual(
      expect.arrayContaining(['overlap.enabled', 'tokens.router.sharedFiles']),
    );
  });
});
