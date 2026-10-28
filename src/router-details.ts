/**
 * Forme PUBLIQUE des détails du Router (`predictFilesDetailed().details`) pour
 * `--json`, le registre, la file et le Control Protocol.
 *
 * Additive et informative : aucune décision en aval n'en dépend (les collisions
 * se décident sur `files`, comme avant). Liste blanche de champs — la sortie
 * brute du LLM (`sample`), les extraits de la carte du dépôt et le classement
 * lexical n'en sortent jamais — et chaque chemin repasse par `isSafeProjectPath`
 * (un chemin vient du LLM : contenu non fiable). Listes bornées.
 */
import { isSafeProjectPath, normalizeFilePath } from './project-path.ts';

/** Bornes des listes publiées (les totaux réels restent dans `counts`). */
const MAX_LISTED = 50;
const MAX_REASONS = 10;

export interface PublicRouterDetails {
  promptVersion: string | null;
  /** Pourquoi le Router a sérialisé la tâche derrière tout le monde (sentinelle `**`) ; null sinon. */
  serialized: {
    kind: string;
    reasons?: string[];
    code?: string;
    kept?: number;
    total?: number;
  } | null;
  files: Array<{
    path: string;
    confidence: number | null;
    source: string;
    reason?: string;
    from?: string;
  }>;
  /** Tenue de livre écartée de la détection de collisions (politique `sharedFiles`). */
  shared: string[];
  expansion: Array<{ path: string; reason: string; from: string; confidence: number }>;
  tree: { mode: string; total: number; shown: number; omitted: number } | null;
  /** Totaux avant bornage des listes. */
  counts: { files: number; shared: number; expansion: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 200 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function safePath(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const p = normalizeFilePath(v);
  // `**` est la sentinelle « tout le dépôt » du Router : une valeur légitime ici.
  if (p === '**') return p;
  return p && !/[\u0000-\u001f\u007f]/.test(p) && isSafeProjectPath(p) ? p : null;
}

export function publicRouterDetails(details: unknown): PublicRouterDetails | null {
  if (!isRecord(details)) return null;

  const files: PublicRouterDetails['files'] = [];
  let fileCount = 0;
  for (const f of Array.isArray(details.files) ? details.files : []) {
    if (!isRecord(f)) continue;
    const p = safePath(f.path);
    if (!p) continue;
    fileCount += 1;
    if (files.length >= MAX_LISTED) continue;
    const entry: PublicRouterDetails['files'][number] = {
      path: p,
      confidence: num(f.confidence),
      source: str(f.source) ?? 'unknown',
    };
    const reason = str(f.reason);
    if (reason) entry.reason = reason;
    const from = safePath(f.from);
    if (from) entry.from = from;
    files.push(entry);
  }

  const shared: string[] = [];
  let sharedCount = 0;
  for (const s of Array.isArray(details.shared) ? details.shared : []) {
    const p = safePath(s);
    if (!p) continue;
    sharedCount += 1;
    if (shared.length < MAX_LISTED) shared.push(p);
  }

  const expansion: PublicRouterDetails['expansion'] = [];
  let expansionCount = 0;
  for (const e of Array.isArray(details.expansion) ? details.expansion : []) {
    if (!isRecord(e)) continue;
    const p = safePath(e.path);
    const from = safePath(e.from);
    const reason = str(e.reason);
    if (!p || !from || !reason) continue;
    expansionCount += 1;
    if (expansion.length < MAX_LISTED)
      expansion.push({ path: p, reason, from, confidence: num(e.confidence) ?? 0 });
  }

  let serialized: PublicRouterDetails['serialized'] = null;
  if (isRecord(details.serialized) && str(details.serialized.kind)) {
    const s = details.serialized;
    serialized = { kind: str(s.kind) as string };
    if (Array.isArray(s.reasons)) {
      serialized.reasons = s.reasons
        .map(str)
        .filter((r): r is string => r !== null)
        .slice(0, MAX_REASONS);
    }
    const code = str(s.code);
    if (code) serialized.code = code;
    if (num(s.kept) !== null) serialized.kept = num(s.kept) as number;
    if (num(s.total) !== null) serialized.total = num(s.total) as number;
  }

  let tree: PublicRouterDetails['tree'] = null;
  if (isRecord(details.tree) && str(details.tree.mode)) {
    const t = details.tree;
    tree = {
      mode: str(t.mode) as string,
      total: num(t.total) ?? 0,
      shown: num(t.shown) ?? 0,
      omitted: num(t.omitted) ?? 0,
    };
  }

  return {
    promptVersion: str(details.promptVersion),
    serialized,
    files,
    shared,
    expansion,
    tree,
    counts: { files: fileCount, shared: sharedCount, expansion: expansionCount },
  };
}
