/**
 * Confidentialité locale des données de Striart : fichiers et dossiers lisibles
 * par l'utilisateur courant SEUL.
 *
 * Pourquoi : `.striart/` contient du code source (versions base/ours/theirs
 * des tickets), des sorties d'outils (journaux de session, Test Gate), des
 * prompts (file des tâches) et des jetons (Control Protocol). Avec le umask par
 * défaut (≈ 0644, ou l'ACL héritée du dépôt sous Windows), tout autre compte
 * local les lit.
 *
 * Mécanisme (déplacé depuis `control/auth.ts`, qui le ré-exporte — une seule
 * implémentation) :
 *  - POSIX : 0700 (dossiers) / 0600 (fichiers), vérifié par `stat` ;
 *  - Windows : DACL PROTÉGÉE (héritage coupé) ne donnant de droits qu'au SID de
 *    l'utilisateur courant, posée par `icacls` et VÉRIFIÉE en SDDL (indépendant
 *    de la langue). Sur un dossier, l'ACE est héritable (OI)(CI) : les fichiers
 *    créés ensuite sont privés sans appel supplémentaire à icacls.
 *
 * Échec du resserrement = `STATE_UNPROTECTED` (fail closed), jamais un repli
 * silencieux. Le relâchement existe, explicite : `privateStateDir: false` dans
 * la config (affiché par `striart doctor`).
 *
 * Les clones d'agents (`agents/`) et les clones en cours de suppression
 * (`removing/`) ne sont JAMAIS parcourus : ce sont des arbres de travail
 * (copies du dépôt, `node_modules`), dont les objets git sont des hardlinks
 * partagés avec le dépôt principal — en changer l'ACL changerait aussi celle du
 * principal, et la propagation d'ACL coûterait un parcours complet.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { StriartError } from './errors.js';
import { striartDir } from './paths.js';

/** Sous-dossiers de `.striart/` qui sont des arbres de travail (jamais parcourus ni resserrés). */
export const WORKTREE_DIRS: readonly string[] = Object.freeze(['agents', 'removing']);

const IS_WINDOWS = () => process.platform === 'win32';

/** Raison stable d'un défaut de protection (contrat de `STATE_UNPROTECTED`, jamais un chemin). */
export type UnprotectedReason =
  'icacls' | 'acl-open' | 'mode-open' | 'foreign-owner' | 'chmod' | 'not-a-directory';

export function unprotectedError(
  target: string,
  reason: UnprotectedReason | string,
  cause?: unknown,
): StriartError {
  return new StriartError(
    `Cannot restrict ${target} to the current user (${reason}): refused, local data would stay readable by other accounts.`,
    {
      code: 'STATE_UNPROTECTED',
      details: { path: target, reason },
      hint: 'Check the permissions and the owner of the .striart/ folder, then run "striart doctor". On a file system without permissions (FAT, exFAT, some network shares), set privateStateDir: false in the config (explicit, shown by "striart doctor").',
      cause,
    },
  );
}

// --- Windows : SID, SDDL ---------------------------------------------------------

const windowsTool = (name: string) =>
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);

let cachedSid: string | null = null;

/** SID de l'utilisateur courant (`whoami /user`, sortie CSV indépendante de la langue). */
export async function currentUserSid(): Promise<string> {
  if (cachedSid) return cachedSid;
  const { stdout } = await execa(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  });
  const sid = /"(S-1-[0-9-]+)"/.exec(stdout)?.[1];
  if (!sid) throw new Error('whoami returned no SID');
  cachedSid = sid;
  return sid;
}

/** icacls écrit en UTF-16LE (avec ou sans BOM). */
function decodeIcaclsDump(raw: Buffer): string {
  return raw[0] === 0xff && raw[1] === 0xfe
    ? raw.subarray(2).toString('utf16le')
    : raw.toString('utf16le');
}

/**
 * DACL d'un fichier en SDDL (`icacls /save`, indépendant de la langue de
 * l'OS — les noms de comptes affichés par `icacls <fichier>` sont traduits).
 */
async function readSddl(file: string): Promise<string> {
  const dump = `${file}.acl-${randomBytes(6).toString('hex')}`;
  try {
    await execa(windowsTool('icacls.exe'), [file, '/save', dump], { windowsHide: true });
    const sddl = /D:[^\r\n]*/.exec(decodeIcaclsDump(await readFile(dump)))?.[0];
    if (!sddl) throw new Error('no DACL in icacls output');
    return sddl;
  } finally {
    await rm(dump, { force: true });
  }
}

/**
 * SDDL de TOUS les enfants directs d'un dossier (un seul appel à icacls) et,
 * avec `recursive`, de tout l'arbre. Clé : chemin relatif tel que le rend
 * icacls. `/C` : poursuit malgré un enfant illisible (rapporté par l'appelant).
 */
async function readSddlMany(
  target: string,
  { children, recursive }: { children: boolean; recursive: boolean },
): Promise<Map<string, string>> {
  const dump = path.join(os.tmpdir(), `striart-acl-${randomBytes(6).toString('hex')}.tmp`);
  try {
    const subject = children ? path.join(target, '*') : target;
    await execa(
      windowsTool('icacls.exe'),
      [subject, '/save', dump, '/C', ...(recursive ? ['/T'] : [])],
      { windowsHide: true, reject: false },
    );
    const out = new Map<string, string>();
    // Aucune correspondance (dossier vide) : icacls ne produit pas de fichier.
    const raw = await readFile(dump).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return out;
    const text = decodeIcaclsDump(raw);
    let name: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      if (/^D:/.test(line)) {
        if (name !== null) out.set(name, line);
        name = null;
      } else {
        name = line;
      }
    }
    return out;
  } finally {
    await rm(dump, { force: true });
  }
}

function parseSddl(sddl: string): { flags: string; aces: string[][] } | null {
  const match = /^D:([A-Z]*)(\(.*\))?$/.exec(sddl.trim());
  if (!match) return null;
  return {
    flags: match[1],
    aces: [...(match[2] ?? '').matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(';')),
  };
}

/**
 * Écritures SDDL d'un même compte : son SID, et l'alias que le formateur de
 * Windows lui substitue — administrateur local (RID 500, ex. `runneradmin`) →
 * `LA`, SYSTEM → `SY`. Sans cela, l'Administrateur intégré voyait sa propre
 * DACL, pourtant restreinte à lui seul, refusée comme « accordée à d'autres ».
 * L'alias ne vaut que pour SON SID : jamais un blanc-seing.
 */
function sddlPrincipals(sid: string): string[] {
  if (sid === 'S-1-5-18') return [sid, 'SY'];
  if (/^S-1-5-21-\d+-\d+-\d+-500$/.test(sid)) return [sid, 'LA'];
  return [sid];
}

/** Chaque ACE d'autorisation vise-t-elle `sid` (et la DACL en contient-elle au moins une) ? */
function acesGrantOnly(aces: string[][], sid: string): boolean {
  if (aces.length === 0) return false;
  const principals = sddlPrincipals(sid);
  return aces.every((ace) => ace.length >= 6 && (ace[0] !== 'A' || principals.includes(ace[5])));
}

/**
 * La DACL n'accorde-t-elle des droits QU'À `sid`, sans héritage ? (drapeau
 * P = protégée ; chaque ACE « (type;…;sid) » d'autorisation vise `sid`).
 */
export function sddlRestrictedTo(sddl: string, sid: string): boolean {
  const parsed = parseSddl(sddl);
  if (!parsed || !parsed.flags.includes('P')) return false;
  return acesGrantOnly(parsed.aces, sid);
}

/**
 * Variante pour un ENFANT d'un dossier déjà privé : sa DACL peut être héritée
 * (non protégée) — elle est privée tant qu'elle n'accorde rien à un autre
 * compte, héritage compris.
 */
export function sddlGrantsOnly(sddl: string, sid: string): boolean {
  const parsed = parseSddl(sddl);
  return parsed !== null && acesGrantOnly(parsed.aces, sid);
}

// --- Primitives publiques --------------------------------------------------------

/**
 * Restreint `target` (fichier ou dossier) à l'utilisateur courant, puis le
 * VÉRIFIE (fail closed : `STATE_UNPROTECTED`). Dossier : l'ACE est héritable,
 * les enfants existants et futurs la reçoivent.
 */
export async function restrictToCurrentUser(target: string): Promise<void> {
  if (IS_WINDOWS()) {
    try {
      const isDir = (await stat(target)).isDirectory();
      const sid = await currentUserSid();
      // /reset d'abord : le DACL par défaut du jeton d'une session élevée donne au
      // fichier des ACE EXPLICITES (SYSTEM, Administrateurs…) que ni
      // `/inheritance:r` (héritage seulement) ni `/grant:r` (le compte visé
      // seulement) ne retirent. /reset les efface ; l'héritage est ensuite coupé
      // et le seul droit accordé est celui de l'utilisateur.
      await execa(windowsTool('icacls.exe'), [target, '/reset'], { windowsHide: true });
      await execa(
        windowsTool('icacls.exe'),
        [target, '/inheritance:r', '/grant:r', `*${sid}:${isDir ? '(OI)(CI)' : ''}(F)`],
        { windowsHide: true },
      );
      const sddl = await readSddl(target);
      // La DACL (SDDL : SID et droits, aucun secret) accompagne le refus : sans elle,
      // un compte dont l'écriture SDDL est inattendue est indiagnostiquable.
      if (!sddlRestrictedTo(sddl, sid))
        throw new Error(`ACL still grants other accounts (${sddl})`);
    } catch (error) {
      throw unprotectedError(target, 'icacls', error);
    }
    return;
  }
  try {
    const isDir = (await stat(target)).isDirectory();
    await chmod(target, isDir ? 0o700 : 0o600);
  } catch (error) {
    throw unprotectedError(target, 'chmod', error);
  }
  await assertPrivate(target);
}

/** `target` n'est-il accessible qu'à son propriétaire, l'utilisateur courant ? (lève sinon) */
export async function assertPrivate(target: string): Promise<void> {
  if (IS_WINDOWS()) {
    let ok = false;
    try {
      ok = sddlRestrictedTo(await readSddl(target), await currentUserSid());
    } catch (error) {
      throw unprotectedError(target, 'icacls', error);
    }
    if (!ok) throw unprotectedError(target, 'acl-open');
    return;
  }
  const info = await stat(target);
  if ((info.mode & 0o077) !== 0) throw unprotectedError(target, 'mode-open');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    throw unprotectedError(target, 'foreign-owner');
}

/**
 * `target` est-il inaccessible aux autres comptes ? Plus tolérant que
 * `assertPrivate` : une DACL HÉRITÉE d'un dossier privé qui ne vise que
 * l'utilisateur suffit (un fichier créé dans `.striart/` durci). Booléen —
 * une cible absente remonte l'erreur système.
 */
export async function isPrivate(target: string): Promise<boolean> {
  if (IS_WINDOWS()) {
    try {
      return sddlGrantsOnly(await readSddl(target), await currentUserSid());
    } catch (error) {
      throw unprotectedError(target, 'icacls', error);
    }
  }
  try {
    await assertPrivate(target);
    return true;
  } catch (error) {
    if (error instanceof StriartError && error.code === 'STATE_UNPROTECTED') return false;
    throw error;
  }
}

/**
 * Écrit un fichier privé : créé en 0600 (POSIX) — et resserré s'il existait
 * déjà plus ouvert. Sous Windows le fichier hérite de la DACL protégée de son
 * dossier : le dossier a été durci avant (`hardenStriartDir` / `restrictToCurrentUser`).
 */
export async function writePrivateFile(
  file: string,
  data: string | Uint8Array,
  { append = false }: { append?: boolean } = {},
): Promise<void> {
  const handle = await open(file, append ? 'a' : 'w', 0o600);
  try {
    if (!IS_WINDOWS()) await handle.chmod(0o600);
    await handle.writeFile(data, typeof data === 'string' ? 'utf8' : undefined);
  } finally {
    await handle.close();
  }
}

// --- Migration / inspection de `.striart/` ---------------------------------------

export interface PrivacyFinding {
  path: string;
  reason: string;
}

export interface PrivacyReport {
  /** Dossier inspecté (`<racine>/.striart`). */
  dir: string;
  /** Éléments resserrés par cet appel (vide si tout l'était déjà : idempotence). */
  tightened: string[];
  /** Éléments qui n'ont pas pu l'être. */
  failed: PrivacyFinding[];
  /** Nombre d'éléments inspectés. */
  inspected: number;
}

/**
 * Parcours des éléments de `.striart/` hors arbres de travail. `onDir` / `onFile`
 * reçoivent le chemin absolu ; les liens symboliques ne sont jamais suivis.
 */
async function walkData(
  dir: string,
  visit: (full: string, isDir: boolean) => Promise<void>,
  depth = 0,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (depth === 0 && WORKTREE_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await visit(full, true);
      await walkData(full, visit, depth + 1);
    } else if (entry.isFile()) {
      await visit(full, false);
    }
  }
}

async function posixScan(base: string, fix: boolean, report: PrivacyReport): Promise<void> {
  const check = async (full: string, isDir: boolean) => {
    report.inspected += 1;
    const info = await lstat(full);
    const loose = (info.mode & 0o077) !== 0;
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      report.failed.push({ path: full, reason: 'foreign-owner' });
      return;
    }
    if (!loose) return;
    if (!fix) {
      report.failed.push({ path: full, reason: 'mode-open' });
      return;
    }
    try {
      await chmod(full, isDir ? 0o700 : 0o600);
      report.tightened.push(full);
    } catch {
      report.failed.push({ path: full, reason: 'chmod' });
    }
  };
  await check(base, true);
  // Arbres de travail : le dossier lui-même seulement (0700 interdit la
  // traversée aux autres comptes), jamais son contenu.
  for (const name of WORKTREE_DIRS) {
    const full = path.join(base, name);
    if ((await lstat(full).catch(() => null))?.isDirectory()) await check(full, true);
  }
  await walkData(base, check);
}

/** Exécute `task` sur chaque élément, `limit` à la fois (icacls est un process : on borne). */
async function mapLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * Windows. Chaque appel à icacls est un process (~300 ms) : les étapes
 * indépendantes tournent en parallèle et le cas courant — un dossier déjà
 * privé — ne coûte qu'une ronde de lectures.
 *
 *  A. (parallèle) SID, DACL de la racine, DACL des enfants directs, et — pour
 *     corriger — isolement des arbres de travail : ils ne doivent JAMAIS
 *     recevoir la propagation d'héritage de `.striart/` (parcours complet de
 *     clones, hardlinks partagés avec le dépôt). `/inheritance:d` convertit les
 *     ACE héritées en explicites avec les mêmes drapeaux d'héritage : leurs
 *     enfants ne changent pas d'accès.
 *  B. Racine : DACL protégée, ACE héritable pour l'utilisateur seul (`/reset`
 *     d'abord seulement si des ACE EXPLICITES existent — DACL par défaut d'un
 *     jeton élevé). Windows propage aux enfants héritants.
 *  C. (parallèle) vérification : racine et enfants relus si B a eu lieu,
 *     sous-dossiers de données parcourus récursivement (un appel chacun) ; ce
 *     qui n'est toujours pas privé (ACL explicite, DACL protégée d'un ancien
 *     fichier) est resserré individuellement.
 */
async function windowsScan(base: string, fix: boolean, report: PrivacyReport): Promise<void> {
  const entries = await readdir(base, { withFileTypes: true });
  const worktrees = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && WORKTREE_DIRS.includes(e.name))
    .map((e) => path.join(base, e.name));
  const dataDirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !WORKTREE_DIRS.includes(e.name))
    .map((e) => path.join(base, e.name));

  const [sid, rootSddl, childSddls] = await Promise.all([
    currentUserSid(),
    readSddl(base),
    readSddlMany(base, { children: true, recursive: false }),
    ...(fix
      ? worktrees.map((dir) =>
          execa(windowsTool('icacls.exe'), [dir, '/inheritance:d'], { windowsHide: true }),
        )
      : []),
  ]);

  report.inspected += 1;
  let rootChanged = false;
  if (!sddlRestrictedTo(rootSddl, sid)) {
    if (!fix) {
      report.failed.push({ path: base, reason: 'acl-open' });
    } else {
      const explicit = (parseSddl(rootSddl)?.aces ?? []).some((ace) => !ace[1]?.includes('ID'));
      if (explicit) await execa(windowsTool('icacls.exe'), [base, '/reset'], { windowsHide: true });
      await execa(
        windowsTool('icacls.exe'),
        [base, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`],
        { windowsHide: true },
      );
      rootChanged = true;
      report.tightened.push(base);
    }
  }

  // C. Vérification.
  const [verifiedRoot, children, trees] = await Promise.all([
    rootChanged ? readSddl(base) : Promise.resolve(rootSddl),
    rootChanged
      ? readSddlMany(base, { children: true, recursive: false })
      : Promise.resolve(childSddls),
    Promise.all(
      dataDirs.map(
        async (dir) =>
          [dir, await readSddlMany(dir, { children: false, recursive: true })] as const,
      ),
    ),
  ]);
  if (rootChanged && !sddlRestrictedTo(verifiedRoot, sid)) {
    report.tightened.pop();
    report.failed.push({ path: base, reason: 'icacls' });
    return;
  }

  const open: string[] = [];
  for (const [name, sddl] of children) {
    report.inspected += 1;
    if (worktrees.includes(path.join(base, name))) continue;
    if (!sddlGrantsOnly(sddl, sid)) open.push(path.join(base, name));
  }
  for (const [dir, tree] of trees) {
    for (const [rel, sddl] of tree) {
      // icacls rend le chemin relatif au PARENT de la cible (`logs\x.log`).
      const full = path.join(path.dirname(dir), rel);
      if (full === dir) continue;
      report.inspected += 1;
      if (!sddlGrantsOnly(sddl, sid)) open.push(full);
    }
  }
  await mapLimit([...new Set(open)], 6, (full) => tightenOne(full, fix, report));
}

async function tightenOne(full: string, fix: boolean, report: PrivacyReport): Promise<void> {
  if (!fix) {
    report.failed.push({ path: full, reason: 'acl-open' });
    return;
  }
  try {
    await restrictToCurrentUser(full);
    report.tightened.push(full);
  } catch {
    report.failed.push({ path: full, reason: 'icacls' });
  }
}

async function scanStriartDir(root: string, fix: boolean): Promise<PrivacyReport> {
  const base = striartDir(root);
  const report: PrivacyReport = { dir: base, tightened: [], failed: [], inspected: 0 };
  if (fix) await mkdir(base, { recursive: true, mode: 0o700 });
  else if (!(await lstat(base).catch(() => null))) return report;
  if (!(await stat(base)).isDirectory()) {
    report.failed.push({ path: base, reason: 'not-a-directory' });
    return report;
  }
  try {
    if (IS_WINDOWS()) await windowsScan(base, fix, report);
    else await posixScan(base, fix, report);
  } catch (error) {
    if (error instanceof StriartError && error.code === 'STATE_UNPROTECTED') {
      report.failed.push({ path: String(error.details.path ?? base), reason: 'icacls' });
    } else {
      report.failed.push({ path: base, reason: IS_WINDOWS() ? 'icacls' : 'chmod' });
    }
  }
  return report;
}

/**
 * Inspecte `.striart/` sans rien modifier (contrôle `doctor`) : pur constat,
 * `failed` liste ce qui est lisible par d'autres comptes.
 */
export function inspectStriartPrivacy(root: string): Promise<PrivacyReport> {
  return scanStriartDir(root, false);
}

const hardened = new Map<string, Promise<PrivacyReport>>();

/**
 * Resserre `.striart/` (migration idempotente de l'existant) : dossier et
 * contenu hors arbres de travail. Un second appel sur un dossier déjà privé ne
 * change rien (`tightened` vide). Éléments non resserrables → `STATE_UNPROTECTED`
 * (fail closed), après avoir tout essayé ; `enabled: false` (config
 * `privateStateDir: false`) est le relâchement explicite et ne fait rien.
 * Mémorisé par racine et par process ; `force` ignore la mémoire.
 */
export function hardenStriartDir(
  root: string,
  { enabled = true, force = false }: { enabled?: boolean; force?: boolean } = {},
): Promise<PrivacyReport> {
  const base = striartDir(root);
  if (!enabled) return Promise.resolve({ dir: base, tightened: [], failed: [], inspected: 0 });
  const key = path.resolve(base);
  const known = hardened.get(key);
  if (known && !force) return known;
  const pending = scanStriartDir(root, true).then((report) => {
    if (report.failed.length > 0) {
      const first = report.failed[0];
      throw unprotectedError(first.path, first.reason);
    }
    return report;
  });
  hardened.set(key, pending);
  pending.catch(() => hardened.delete(key));
  return pending;
}

/** Oublie la mémoire de `hardenStriartDir` (tests). */
export function resetHardenMemo(): void {
  hardened.clear();
}
