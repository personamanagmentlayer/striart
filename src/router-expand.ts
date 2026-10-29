/**
 * Expansion DÉTERMINISTE de la prédiction du Router, après le LLM.
 *
 * Une tâche réelle modifie rarement un seul fichier : le test qui couvre le
 * module, l'importeur dont l'appel change, la déclaration de types, la
 * traduction jumelle, le fichier de contrat qui accompagne toujours le module.
 * Le LLM, devant une demande vague, ne les nomme pas. Ces règles les ajoutent
 * à partir de FAITS du dépôt (noms, graphe d'imports, historique), jamais d'un
 * second avis du LLM.
 *
 * Chaque ajout porte sa raison (`reason`), son origine (`from`) et une
 * confiance héritée : le Router rend ces détails en structure additive, et
 * `maxAdded` borne l'expansion (un faux négatif est rattrapé par la fusion et le
 * Test Gate ; une expansion sans borne sérialiserait pour rien).
 */
import { associatedWith } from './router-cochange.ts';
import type { CoChangeModel } from './router-cochange.ts';

export type ExpansionReason =
  | 'test'
  | 'tested-code'
  | 'importer'
  | 'importee'
  | 'sibling'
  | 'contract'
  | 'co-change'
  | 'retrieval';

export interface Added {
  path: string;
  reason: ExpansionReason;
  from: string;
  confidence: number;
}

export interface ExpansionSettings {
  imports: 'off' | 'importees' | 'importers' | 'both';
  depth: 1 | 2;
  tests: boolean;
  siblings: boolean;
  contracts: boolean;
  coChange: boolean;
  maxAdded: number;
}

export interface ExpandInput {
  core: ReadonlyArray<{ path: string; confidence: number }>;
  files: ReadonlySet<string>;
  graph: ReadonlyMap<string, ReadonlySet<string>> | null;
  inverse: ReadonlyMap<string, ReadonlySet<string>> | null;
  coChange: CoChangeModel | null;
  settings: ExpansionSettings;
}

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e)\//i;
const TEST_NAME = /(\.(test|spec)\.[^/.]+$|(^|\/)test_[^/]+$|_test\.[^/.]+$)/i;

export function isTestPath(file: string): boolean {
  return TEST_DIR.test(file) || TEST_NAME.test(file);
}

/** Radical de comparaison source ↔ test : nom sans extension, sans `.test`/`.spec`/`test_`/`_test`/`.d`. */
export function stemOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/\.(test|spec|d)$/i, '')
    .replace(/^test_/i, '')
    .replace(/_test$/i, '')
    .replace(/-(test|spec)$/i, '')
    .toLowerCase();
}

/** Au-delà de ce nombre d'importeurs, un fichier est un « hub » : ses voisins ne sont pas des candidats. */
function hubThreshold(fileCount: number): number {
  return Math.max(8, Math.floor(fileCount * 0.02));
}

/** `docs/fr/x.md` ↔ `docs/en/x.md`, `i18n/fr.ts` ↔ `i18n/en.ts`, `x.fr.json` ↔ `x.en.json`. */
function localeTwins(file: string, files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const variants = [
    [/(^|\/)fr(\/|\.)/, '$1en$2'],
    [/(^|\/)en(\/|\.)/, '$1fr$2'],
    [/\.fr\./, '.en.'],
    [/\.en\./, '.fr.'],
  ] as const;
  for (const [from, to] of variants) {
    if (!from.test(file)) continue;
    const twin = file.replace(from, to);
    if (twin !== file && files.has(twin)) out.push(twin);
  }
  return out;
}

export function expandPrediction(input: ExpandInput): Added[] {
  const { core, files, graph, inverse, coChange, settings } = input;
  const have = new Set(core.map((c) => c.path));
  const added: Added[] = [];
  const hub = hubThreshold(files.size);

  const byStem = new Map<string, string[]>();
  if (settings.tests) {
    for (const f of files) {
      const s = stemOf(f);
      const list = byStem.get(s);
      if (list) list.push(f);
      else byStem.set(s, [f]);
    }
  }

  const push = (
    path: string,
    reason: ExpansionReason,
    from: string,
    confidence: number,
  ): boolean => {
    if (have.has(path) || !files.has(path)) return false;
    have.add(path);
    added.push({ path, reason, from, confidence });
    return true;
  };

  const importersOf = (f: string) => inverse?.get(f) ?? new Set<string>();
  const importsOf = (f: string) => graph?.get(f) ?? new Set<string>();

  const expandFrom = (seed: { path: string; confidence: number }, hop: number): string[] => {
    const f = seed.path;
    const fresh: string[] = [];
    const conf = seed.confidence * (hop === 1 ? 0.6 : 0.3);
    const keep = (p: string, r: ExpansionReason, c = conf) => {
      if (push(p, r, f, c)) fresh.push(p);
    };
    const testy = isTestPath(f);

    if (settings.tests) {
      const peers = (byStem.get(stemOf(f)) ?? []).filter((p) => p !== f);
      if (!testy) {
        for (const p of peers) if (isTestPath(p)) keep(p, 'test');
        // Tests qui importent CE module — seulement s'ils sont peu nombreux (sinon : bruit).
        const testers = [...importersOf(f)].filter(isTestPath);
        if (testers.length > 0 && testers.length <= 3) for (const p of testers) keep(p, 'test');
      } else {
        for (const p of peers) if (!isTestPath(p)) keep(p, 'tested-code');
        const targets = [...importsOf(f)].filter(
          (p) => !isTestPath(p) && importersOf(p).size <= hub,
        );
        if (targets.length > 0 && targets.length <= 2)
          for (const p of targets) keep(p, 'tested-code');
      }
    }

    if (settings.siblings && !testy) {
      const dir = f.slice(0, f.lastIndexOf('/') + 1);
      const stem = stemOf(f);
      for (const p of files) {
        if (
          p !== f &&
          p.startsWith(dir) &&
          !p.slice(dir.length).includes('/') &&
          stemOf(p) === stem &&
          !isTestPath(p)
        )
          keep(p, 'sibling');
      }
    }

    if (settings.contracts) {
      for (const twin of localeTwins(f, files)) keep(twin, 'contract', seed.confidence);
    }

    if (!testy && graph) {
      if (settings.imports === 'importers' || settings.imports === 'both') {
        const importers = [...importersOf(f)].filter((p) => !isTestPath(p));
        if (importers.length <= hub) for (const p of importers) keep(p, 'importer');
      }
      if (settings.imports === 'importees' || settings.imports === 'both') {
        for (const p of importsOf(f)) {
          if (!isTestPath(p) && importersOf(p).size <= hub) keep(p, 'importee');
        }
      }
    }

    if (settings.coChange && coChange) {
      for (const a of associatedWith(coChange, f)) {
        keep(a.path, 'co-change', Math.min(seed.confidence, a.confidence));
      }
    }
    return fresh;
  };

  let frontier = [...core];
  for (let hop = 1; hop <= settings.depth; hop += 1) {
    const next: Array<{ path: string; confidence: number }> = [];
    for (const seed of frontier) {
      for (const p of expandFrom(seed, hop)) {
        const a = added.find((x) => x.path === p);
        if (a) next.push({ path: p, confidence: a.confidence });
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // Plus fiables d'abord (confiance héritée, puis raison), puis borne.
  const order: Record<ExpansionReason, number> = {
    test: 0,
    'tested-code': 1,
    contract: 2,
    sibling: 3,
    'co-change': 4,
    retrieval: 4,
    importer: 5,
    importee: 6,
  };
  added.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      order[a.reason] - order[b.reason] ||
      (a.path < b.path ? -1 : 1),
  );
  return added.slice(0, Math.max(0, settings.maxAdded));
}
