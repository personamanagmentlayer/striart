/**
 * Fusion à trois voies par RÉGIONS (diff3) — pure, sans dépendance (lot T).
 *
 * Le Merger envoyait les trois versions ENTIÈRES d'un fichier au LLM même
 * quand le conflit tient en vingt lignes. Ici, un diff3 local sépare :
 *  - les parties STABLES, fusionnées sans modèle (modifiées d'un seul côté,
 *    ou modifiées à l'identique des deux côtés) ;
 *  - les régions en CONFLIT (modifiées différemment des deux côtés), seules
 *    soumises au LLM avec un contexte configurable.
 *
 * Sémantique alignée sur git : deux modifications qui se TOUCHENT (adjacentes
 * sans se chevaucher) sont un conflit, pas deux changements indépendants.
 * L'algorithme de différence est Myers (O(ND)) sur des lignes ; au-delà d'une
 * borne de distance (fichier réécrit de fond en comble), `diff3Merge` rend
 * `null` et l'appelant retombe sur le chemin « fichier entier » — jamais un
 * résultat approximatif.
 */

export type MergeSegment =
  | { kind: 'stable'; lines: string[] }
  | { kind: 'conflict'; index: number; base: string[]; ours: string[]; theirs: string[] };

interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Distance d'édition maximale explorée par Myers (mémoire O(D²)). */
const MAX_EDIT_DISTANCE = 3000;

/** Paires (indexA, indexB) des lignes communes, ou null si la distance dépasse la borne. */
export function myersMatches(
  a: readonly string[],
  b: readonly string[],
): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  // Préfixe et suffixe communs : le gros du travail sur des fichiers proches.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) {
    suffix += 1;
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < prefix; i += 1) out.push([i, i]);
  const middle = myersCore(a.slice(prefix, n - suffix), b.slice(prefix, m - suffix));
  if (middle === null) return null;
  for (const [i, j] of middle) out.push([i + prefix, j + prefix]);
  for (let i = suffix; i > 0; i -= 1) out.push([n - i, m - i]);
  return out;
}

function myersCore(a: string[], b: string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= maxD && found < 0; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const snap = trace[d]; // V au début de l'étape d, indexé k + (d - 1) pour |k| <= d - 1
    const at = (k: number) => snap[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  return matches.reverse();
}

function hunksFromMatches(n: number, m: number, matches: Array<[number, number]>): Hunk[] {
  const hunks: Hunk[] = [];
  let a = 0;
  let b = 0;
  for (const [i, j] of matches) {
    if (i > a || j > b) hunks.push({ aStart: a, aEnd: i, bStart: b, bEnd: j });
    a = i + 1;
    b = j + 1;
  }
  if (n > a || m > b) hunks.push({ aStart: a, aEnd: n, bStart: b, bEnd: m });
  return hunks;
}

function diffHunks(base: readonly string[], other: readonly string[]): Hunk[] | null {
  const matches = myersMatches(base, other);
  return matches === null ? null : hunksFromMatches(base.length, other.length, matches);
}

function sameLines(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((line, i) => line === y[i]);
}

/**
 * Ajoute `source` à `target` en place. Jamais `target.push(...source)` : la
 * décomposition passe chaque élément comme argument et lève RangeError
 * au-delà de ~120 000 lignes (fichier généré, fixture).
 */
function appendAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item);
}

/** Contenu d'une plage de la base tel que le voit un côté (ses hunks appliqués). */
function sideContent(
  base: readonly string[],
  side: readonly string[],
  hunks: readonly Hunk[],
  aStart: number,
  aEnd: number,
): string[] {
  const out: string[] = [];
  let pos = aStart;
  for (const h of hunks) {
    appendAll(out, base.slice(pos, h.aStart));
    appendAll(out, side.slice(h.bStart, h.bEnd));
    pos = h.aEnd;
  }
  appendAll(out, base.slice(pos, aEnd));
  return out;
}

/**
 * Fusion diff3 : segments stables (déjà fusionnés) et régions en conflit.
 * `null` si une différence dépasse la borne de Myers (appelant : chemin fichier entier).
 */
export function diff3Merge(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeSegment[] | null {
  const oursHunks = diffHunks(base, ours);
  const theirsHunks = diffHunks(base, theirs);
  if (!oursHunks || !theirsHunks) return null;

  const all = [
    ...oursHunks.map((h) => ({ ...h, side: 'o' as const })),
    ...theirsHunks.map((h) => ({ ...h, side: 't' as const })),
  ].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd);

  // Regroupe les hunks qui se chevauchent OU se touchent (aStart <= fin du groupe).
  const groups: Array<{ aStart: number; aEnd: number; o: Hunk[]; t: Hunk[] }> = [];
  for (const h of all) {
    const last = groups[groups.length - 1];
    if (last && h.aStart <= last.aEnd) {
      last.aEnd = Math.max(last.aEnd, h.aEnd);
      (h.side === 'o' ? last.o : last.t).push(h);
    } else {
      groups.push({
        aStart: h.aStart,
        aEnd: h.aEnd,
        o: h.side === 'o' ? [h] : [],
        t: h.side === 't' ? [h] : [],
      });
    }
  }

  const segments: MergeSegment[] = [];
  const pushStable = (lines: string[]) => {
    if (lines.length === 0) return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'stable') appendAll(last.lines, lines);
    else segments.push({ kind: 'stable', lines: [...lines] });
  };
  let pos = 0;
  let conflictIndex = 0;
  for (const g of groups) {
    pushStable(base.slice(pos, g.aStart));
    const o = sideContent(base, ours, g.o, g.aStart, g.aEnd);
    const t = sideContent(base, theirs, g.t, g.aStart, g.aEnd);
    if (g.t.length === 0) pushStable(o);
    else if (g.o.length === 0) pushStable(t);
    else if (sameLines(o, t)) pushStable(o);
    else {
      conflictIndex += 1;
      segments.push({
        kind: 'conflict',
        index: conflictIndex,
        base: base.slice(g.aStart, g.aEnd),
        ours: o,
        theirs: t,
      });
    }
    pos = g.aEnd;
  }
  pushStable(base.slice(pos));
  return segments;
}

/** Découpe un texte en lignes SANS perdre la fin de ligne finale ni les CRLF. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  // 'a\nb\n' → ['a','b'] + marqueur de fin de ligne finale conservé par l'appelant.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function hasFinalNewline(text: string): boolean {
  return text.endsWith('\n');
}

export interface ConflictRegion {
  index: number;
  base: string[];
  ours: string[];
  theirs: string[];
  before: string[];
  after: string[];
}

/** Régions en conflit avec `context` lignes du texte déjà fusionné de part et d'autre. */
export function conflictRegions(
  segments: readonly MergeSegment[],
  context: number,
): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  segments.forEach((seg, i) => {
    if (seg.kind !== 'conflict') return;
    const prev = segments[i - 1];
    const next = segments[i + 1];
    regions.push({
      index: seg.index,
      base: seg.base,
      ours: seg.ours,
      theirs: seg.theirs,
      before: prev?.kind === 'stable' && context > 0 ? prev.lines.slice(-context) : [],
      after: next?.kind === 'stable' && context > 0 ? next.lines.slice(0, context) : [],
    });
  });
  return regions;
}

/** Réassemble le fichier avec la résolution de chaque région (indexée par `index`). */
export function assemble(
  segments: readonly MergeSegment[],
  resolutions: ReadonlyMap<number, string[]>,
  finalNewline: boolean,
): string {
  const lines: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'stable') appendAll(lines, seg.lines);
    else {
      const resolved = resolutions.get(seg.index);
      if (!resolved) throw new Error(`région ${seg.index} sans résolution`);
      appendAll(lines, resolved);
    }
  }
  const text = lines.join('\n');
  return finalNewline && lines.length > 0 ? `${text}\n` : text;
}
