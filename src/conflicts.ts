import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { striartDir } from './paths.ts';
import { StriartError, ticketUnknownError } from './errors.ts';
import { removeTreeWithBackoff, withTransientRetry, writeJsonAtomic } from './json-file.ts';
import { writePrivateFile } from './private-fs.ts';
import { redactSecrets, secretValuesFromEnv } from './redact-secrets.ts';
import { ensureStateProtection } from './state-protection.ts';
import type {
  ConflictClass,
  CorruptTicket,
  GateFailureCode,
  ProtectedPathChange,
  Ticket,
  TicketEntry,
  TicketReason,
} from './types.js';

/**
 * Dossier de ticket sans ticket.json depuis plus longtemps que ça : débris
 * (le ticket.json est écrit atomiquement juste après le mkdir — plus jeune,
 * c'est un ticket en cours de création).
 */
const MISSING_TICKET_GRACE_MS = 60_000;

/**
 * Crée un ticket de conflit dans .striart/conflicts/<id>/ :
 * ticket.json (métadonnées) + test-output.log (sortie du Test Gate).
 * C'est le fallback humain obligatoire (règle d'or n°4).
 */
/**
 * Préfixe des fichiers d'un chemin du ticket (`<prefix>.base/.ours/.theirs/
 * .llm-attempt/.resolved/.delete`).
 *
 * Version 2 (S-M6) : encodage INJECTIF — tout octet hors `[A-Za-z0-9._-]` est
 * écrit `%HH` (UTF-8), donc `a/b.txt` (`a%2Fb.txt`) et `a__b.txt` ne se
 * confondent plus (la version 1 remplaçait `/` et `\` par `__` : deux chemins
 * distincts partageaient `.base/.ours/.theirs/.resolved`, d'où une résolution
 * humaine appliquée au mauvais fichier). Un nom trop long pour un système de
 * fichiers (255 octets) est abrégé + empreinte SHA-256 (injectif en pratique).
 * Version 1 conservée pour LIRE les tickets créés avant : `ticket.fileNaming`
 * (absent = 1) dit laquelle s'applique.
 * @param {string} filePath @param {1 | 2} [version]
 */
export function safeFileName(filePath, version = 2) {
  if (version === 1) return filePath.replaceAll(/[\\/]/g, '__');
  const encoded = Array.from(Buffer.from(filePath, 'utf8'), (byte) => {
    const ch = String.fromCharCode(byte);
    return /[A-Za-z0-9._-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  // Marge pour le suffixe (`.llm-attempt`, `.resolved`…).
  if (encoded.length <= 200) return encoded;
  return `${encoded.slice(0, 150)}~${createHash('sha256').update(filePath).digest('hex').slice(0, 32)}`;
}

/** Préfixe d'un fichier d'un ticket EXISTANT : la convention de nommage est celle de sa création. */
function ticketPrefix(ticket, filePath) {
  return safeFileName(filePath, ticket.fileNaming === 2 ? 2 : 1);
}

/**
 * `resolutions` : [{ path, base, ours, theirs, llmAttempt? }] — les 3 versions
 * de chaque fichier en conflit (+ la tentative LLM si la fusion sémantique
 * a tourné), écrites à côté du ticket pour la résolution humaine.
 */
export async function createConflictTicket(
  root: string,
  {
    agent,
    branch,
    sha,
    reason,
    conflictedFiles = [],
    prompt = null,
    log = '',
    resolutions = [],
    unmergeable = [],
    protectedChanges = [],
    mergeConflictedFiles = null,
    gate = null,
  }: {
    agent: string;
    branch: string;
    sha: string;
    reason: TicketReason;
    conflictedFiles?: string[];
    prompt?: string | null;
    log?: string;
    resolutions?: Array<{
      path: string;
      base: string | null;
      ours: string | null;
      theirs: string | null;
      llmAttempt?: string | null;
    }>;
    unmergeable?: Array<{ path: string } & ConflictClass>;
    protectedChanges?: ProtectedPathChange[];
    mergeConflictedFiles?: string[] | null;
    gate?: { code?: GateFailureCode; orphanPids?: number[]; truncated?: boolean } | null;
  },
): Promise<Ticket> {
  // Un même commit d'agent re-tenté (watch qui re-déclenche, merge relancé à
  // la main) ne crée pas un ticket de plus : il met à jour le ticket OUVERT
  // qui le concerne déjà. Sans ça, trois tentatives du même conflit
  // donnaient trois tickets identiques à trier. Le contenu est rafraîchi
  // (la branche cible a pu avancer : `.ours` change) ; les résolutions déjà
  // préparées par l'humain (`.resolved`/`.delete`) ne sont jamais touchées.
  const existing = (await listConflictTickets(root))
    .filter(isReadableTicket)
    .find((t) => t.agent === agent && t.sha === sha);
  const now = new Date().toISOString();
  const id = existing ? path.basename(existing.dir) : `${agent}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(striartDir(root), 'conflicts', id);
  // Un ticket contient le code des deux côtés du conflit et la sortie des
  // tests : réservé à l'utilisateur (0600 / ACL héritée d'un `.striart/` durci).
  await ensureStateProtection(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const ticket = {
    id,
    agent,
    branch,
    sha,
    reason, // voir TicketReason dans types.d.ts
    // Convention de nommage des fichiers du ticket (safeFileName) : 2 = injective ;
    // un ticket rafraîchi garde celle de sa création (ses .resolved existants).
    fileNaming: (existing ? (existing.fileNaming === 2 ? 2 : 1) : 2) as 1 | 2,
    conflictedFiles,
    // Conflits hors de portée du Merger (delete/binaire/lockfile/oversize/opaque),
    // avec la nature de chacun — guide la résolution humaine.
    ...(unmergeable.length > 0 ? { unmergeable } : {}),
    // PROTECTED_PATHS_CHANGED (garde I2) : chemins protégés changés par
    // l'agent (aussi dans conflictedFiles : l'humain fixe leur contenu final),
    // et les conflits TEXTUELS du merge, que --apply doit retrouver à l'identique.
    ...(protectedChanges.length > 0 ? { protectedChanges } : {}),
    ...(mergeConflictedFiles ? { mergeConflictedFiles } : {}),
    // Rouge « d'exécution » du Test Gate (orphelin, conteneur natif indisponible…) :
    // la cause stable, les PID tués et la troncature du journal accompagnent le ticket.
    ...(gate && (gate.code || gate.orphanPids?.length || gate.truncated)
      ? {
          gate: {
            ...(gate.code ? { code: gate.code } : {}),
            ...(gate.orphanPids?.length ? { orphanPids: gate.orphanPids } : {}),
            ...(gate.truncated ? { truncated: true } : {}),
          },
        }
      : {}),
    prompt,
    createdAt: existing?.createdAt ?? now,
    attempts: (existing?.attempts ?? 1) + (existing ? 1 : 0),
    ...(existing ? { updatedAt: now } : {}),
  };
  // Atomique : un crash ou un lecteur concurrent (dashboard, watch) ne voit
  // jamais un ticket.json tronqué — qui serait alors listé CORRUPT.
  await writeJsonAtomic(path.join(dir, 'ticket.json'), ticket);
  // La sortie des tests (du code que l'agent a pu écrire) est caviardée des secrets
  // connus avant d'être conservée : elle est relue par un humain, un LLM, le dashboard.
  if (log) {
    await writePrivateFile(
      path.join(dir, 'test-output.log'),
      redactSecrets(log, { values: secretValuesFromEnv(process.env) }),
    );
  } else if (existing) await rm(path.join(dir, 'test-output.log'), { force: true });

  for (const res of resolutions) {
    const prefix = safeFileName(res.path, ticket.fileNaming === 1 ? 1 : 2);
    await writePrivateFile(path.join(dir, `${prefix}.base`), res.base ?? '');
    await writePrivateFile(path.join(dir, `${prefix}.ours`), res.ours ?? '');
    await writePrivateFile(path.join(dir, `${prefix}.theirs`), res.theirs ?? '');
    if (res.llmAttempt != null) {
      await writePrivateFile(path.join(dir, `${prefix}.llm-attempt`), res.llmAttempt);
    } else if (existing) {
      // Tentative LLM d'un essai précédent : ne pas la présenter comme
      // celle de l'essai courant.
      await rm(path.join(dir, `${prefix}.llm-attempt`), { force: true });
    }
  }

  return { ...ticket, dir };
}

/**
 * Liste les tickets de conflit (métadonnées de ticket.json).
 * Par défaut, seuls les tickets OUVERTS sont retournés : un ticket portant
 * un fichier RESOLVED (créé par striart resolve --close, ou à la main par
 * l'humain après correction) est considéré traité.
 *
 * Un ticket dont le ticket.json est illisible (JSON tronqué, droits) ou
 * absent depuis plus de MISSING_TICKET_GRACE_MS n'est PLUS ignoré en
 * silence : il est listé avec `status: 'CORRUPT'` et sa cause — c'est un
 * conflit qui attend un humain, le taire le faisait disparaître. Ses champs
 * métier (agent, sha…) valent null ; il ne peut qu'être fermé
 * (`resolve --close`), jamais préparé ni appliqué (TICKET_CORRUPT).
 */
/** @param {string} root @param {{includeResolved?: boolean}} [opts] @returns {Promise<import('./types.js').TicketEntry[]>} */
export async function listConflictTickets(root, { includeResolved = false } = {}) {
  const dir = path.join(striartDir(root), 'conflicts');
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    // Droits, fichier à la place du dossier, E/S : nommé, jamais une erreur système brute.
    throw new StriartError(
      `Le dossier des tickets de conflit est illisible (${dir}) : ${error.code ?? error.message}.`,
      {
        code: 'TICKETS_UNREADABLE',
        hint: 'striart doctor',
        details: { path: dir, cause: error.code ?? error.message },
        cause: error,
      },
    );
  }
  /** @type {import('./types.js').TicketEntry[]} */
  const tickets = [];
  for (const entry of entries) {
    const ticketDir = path.join(dir, entry);
    const dirStat = await stat(ticketDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue; // fichier parasite, ou retiré entre-temps
    const resolved = await stat(path.join(ticketDir, 'RESOLVED')).then(
      () => true,
      () => false,
    );
    if (resolved && !includeResolved) continue;
    const loaded = await loadTicketFile(ticketDir, dirStat.mtimeMs);
    if (loaded === null) continue; // en cours de création
    if ('cause' in loaded) {
      tickets.push({
        id: entry,
        dir: ticketDir,
        resolved,
        status: 'CORRUPT',
        cause: loaded.cause,
        createdAt: new Date(dirStat.mtimeMs).toISOString(),
        agent: null,
        branch: null,
        sha: null,
        reason: null,
        conflictedFiles: [],
        prompt: null,
      });
      continue;
    }
    // L'id EST le nom du dossier, jamais le champ du JSON : ticket.json est
    // du contenu modifiable, et l'id sert à reconstruire des chemins
    // (mise à jour du ticket, résolution, dashboard).
    tickets.push({ ...loaded.ticket, id: entry, dir: ticketDir, resolved });
  }
  return tickets.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Lit le ticket.json d'un dossier de ticket.
 * @param {string} ticketDir @param {number} dirMtimeMs
 * @returns {Promise<{ticket: import('./types.js').Ticket} | {cause: import('./types.js').TicketCorruption} | null>}
 *   null : ticket.json pas encore écrit (dossier récent).
 */
async function loadTicketFile(ticketDir, dirMtimeMs) {
  let raw;
  try {
    raw = await withTransientRetry(() => readFile(path.join(ticketDir, 'ticket.json'), 'utf8'), {
      budgetMs: 1_000,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return Date.now() - dirMtimeMs > MISSING_TICKET_GRACE_MS ? { cause: 'MISSING' } : null;
    }
    return { cause: 'UNREADABLE' };
  }
  let ticket;
  try {
    ticket = JSON.parse(raw);
  } catch {
    return { cause: 'INVALID_JSON' };
  }
  if (
    ticket === null ||
    typeof ticket !== 'object' ||
    Array.isArray(ticket) ||
    typeof ticket.createdAt !== 'string' ||
    !Array.isArray(ticket.conflictedFiles)
  ) {
    return { cause: 'INCOMPLETE' };
  }
  return { ticket };
}

/**
 * Refuse toute exploitation du contenu d'un ticket CORRUPT : ses fichiers en
 * conflit et son commit sont inconnus, donc rien ne peut être lu, préparé ni
 * appliqué — seulement fermé.
 */
function assertTicketUsable(ticket: TicketEntry): asserts ticket is Ticket {
  if (!isReadableTicket(ticket)) {
    throw ticketCorruptError(ticket);
  }
}

export function isReadableTicket(ticket: TicketEntry): ticket is Ticket {
  return ticket.status !== 'CORRUPT';
}

function ticketCorruptError(ticket: CorruptTicket) {
  return new StriartError(
    `Ticket "${ticket.id}" illisible (${ticket.cause}) : son contenu ne peut être ni lu, ni préparé, ni appliqué. ` +
      'Inspecte son dossier, puis ferme-le.',
    {
      code: 'TICKET_CORRUPT',
      hint: `striart resolve --close ${ticket.id}`,
      details: { ticketId: ticket.id, cause: ticket.cause, path: ticket.dir },
    },
  );
}

/**
 * Un chemin de ticket est-il un chemin de PROJET sûr ? Refusé : non-chaîne, NUL,
 * absolu (POSIX, lettre de lecteur, UNC), segment `..`, dossier `.git` (config,
 * hooks : exécution de code) à n'importe quelle profondeur, et — si `root` est
 * donné — tout chemin dont la résolution sort de la racine. Les tickets sont des
 * fichiers modifiables : leur contenu est une donnée non fiable.
 * @param {string|null} ticketId @param {unknown} filePath @param {string|null} [root]
 */
export function assertTicketPathSafe(ticketId, filePath, root = null) {
  const text = typeof filePath === 'string' ? filePath : '';
  const normalized = text.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const unsafe =
    text.length === 0 ||
    text.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => segment === '..' || segment.toLowerCase() === '.git') ||
    (root !== null &&
      !path
        .resolve(root, text)
        .toLowerCase()
        .startsWith(`${path.resolve(root).toLowerCase()}${path.sep}`));
  if (!unsafe) return;
  throw new StriartError(
    `Chemin de ticket refusé (${JSON.stringify(text).slice(0, 120)}) : ni absolu, ni parent (..), ni dans .git. ` +
      "Le ticket a peut-être été modifié à la main : rien n'a été écrit.",
    {
      code: 'TICKET_PATH_UNSAFE',
      hint: ticketId ? `striart resolve --close ${ticketId}` : 'striart doctor',
      details: { ticketId, path: text.slice(0, 200) },
    },
  );
}

/**
 * Détail complet d'un ticket pour la résolution humaine : métadonnées +
 * contenu des 3 versions (et de la tentative LLM) de chaque fichier en
 * conflit + log du Test Gate. Les fichiers absents valent null.
 */
export async function readTicketDetail(
  root: string,
  ticketId: string,
): Promise<
  Ticket & {
    resolutions: Array<{
      path: string;
      base: string | null;
      ours: string | null;
      theirs: string | null;
      llmAttempt: string | null;
    }>;
    log: string | null;
  }
> {
  const tickets = await listConflictTickets(root, { includeResolved: true });
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw ticketUnknownError(ticketId);
  }
  assertTicketUsable(ticket);
  const readOrNull = (file) => readFile(path.join(ticket.dir, file), 'utf8').catch(() => null);
  const resolutions = await Promise.all(
    (ticket.conflictedFiles ?? []).map(async (filePath) => {
      const prefix = ticketPrefix(ticket, filePath);
      const [base, ours, theirs, llmAttempt] = await Promise.all([
        readOrNull(`${prefix}.base`),
        readOrNull(`${prefix}.ours`),
        readOrNull(`${prefix}.theirs`),
        readOrNull(`${prefix}.llm-attempt`),
      ]);
      return { path: filePath, base, ours, theirs, llmAttempt };
    }),
  );
  const log = await readOrNull('test-output.log');
  return { ...ticket, resolutions, log };
}

/**
 * Marque un ticket comme résolu (fichier RESOLVED horodaté dans son dossier).
 * Le dossier et son contenu sont conservés pour l'audit.
 */
/**
 * Supprime le dossier d'un ticket RÉSOLU (rétention de `striart prune`) dans
 * un ordre qui ne peut jamais rouvrir le ticket : un `rm` récursif interrompu
 * qui emporterait `RESOLVED` avant `ticket.json` ferait reparaître un ticket
 * OUVERT. D'abord `ticket.json`, puis tout le reste sauf `RESOLVED`, enfin
 * le dossier. Interrompu à n'importe quelle étape, le reliquat reste marqué
 * résolu (listé CORRUPT résolu, donc hors des listes par défaut) et la
 * prochaine rétention le termine.
 * @param {string} ticketDir chemin reconstruit par listConflictTickets
 */
export async function removeResolvedTicketDir(ticketDir) {
  await withTransientRetry(() => rm(path.join(ticketDir, 'ticket.json'), { force: true }));
  for (const name of await readdir(ticketDir).catch(() => [])) {
    if (name === 'RESOLVED') continue;
    await removeTreeWithBackoff(path.join(ticketDir, name));
  }
  await removeTreeWithBackoff(ticketDir);
}

/**
 * Un ticket CORRUPT se ferme comme un autre : c'est la seule sortie
 * possible pour l'humain qui l'a inspecté.
 *
 * Fermer un ticket DÉJÀ résolu est refusé (`TICKET_ALREADY_RESOLVED`, comme `--apply`) : un script
 * qui enchaîne des fermetures croirait avoir agi. La garde vit ici, dans le domaine, pour valoir
 * pour TOUS les appelants (CLI, Control Protocol et donc dashboard) — pas dans la seule CLI.
 * `idempotent: true` est réservé aux fermetures INTERNES de l'orchestrateur (doublons d'un même
 * conflit fermés au passage, tickets de hook périmés), qui peuvent légitimement croiser une
 * fermeture humaine concurrente : le marqueur d'origine est alors conservé, rien n'est réécrit.
 * @param {string} root @param {string} ticketId
 * @param {{idempotent?: boolean}} [options]
 * @returns {Promise<import('./types.js').TicketEntry>}
 */
export async function closeConflictTicket(root, ticketId, { idempotent = false } = {}) {
  const tickets = await listConflictTickets(root, { includeResolved: true });
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw ticketUnknownError(ticketId);
  }
  if (ticket.resolved) {
    if (idempotent) return ticket;
    throw new StriartError(`Ticket "${ticketId}" déjà marqué résolu.`, {
      code: 'TICKET_ALREADY_RESOLVED',
      hint: 'striart resolve --all',
      details: { ticketId },
    });
  }
  await writePrivateFile(path.join(ticket.dir, 'RESOLVED'), `${new Date().toISOString()}\n`);
  return { ...ticket, resolved: true };
}

/**
 * Contenu final que l'humain a préparé pour chaque fichier en conflit d'un
 * ticket, à côté des sandbox `.base`/`.ours`/`.theirs` déjà écrites par
 * `createConflictTicket` :
 *  - `<prefix>.resolved` : contenu final du fichier (binaire supporté, lu en
 *    Buffer — un lockfile ou une image n'est pas du texte) ;
 *  - `<prefix>.delete` (contenu ignoré) : résolution = supprimer le fichier.
 * `striart resolve --apply` refuse tant qu'il en manque un pour un fichier
 * conflictuel — pas de fusion partielle silencieuse.
 * @param {string} root @param {string} ticketId
 * @returns {Promise<import('./types.js').ResolutionInput[]>}
 */
export async function readResolutionInputs(root, ticketId) {
  const tickets = await listConflictTickets(root, { includeResolved: true });
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw ticketUnknownError(ticketId);
  }
  assertTicketUsable(ticket);
  // Les chemins viennent de ticket.json (contenu modifiable) : confinés AVANT
  // toute lecture ou écriture qui en dérive.
  for (const filePath of ticket.conflictedFiles ?? [])
    assertTicketPathSafe(ticketId, filePath, root);
  return Promise.all(
    (ticket.conflictedFiles ?? []).map(async (filePath) => {
      const prefix = ticketPrefix(ticket, filePath);
      const deleteMarker = await stat(path.join(ticket.dir, `${prefix}.delete`)).then(
        () => true,
        () => false,
      );
      if (deleteMarker) return { path: filePath, kind: 'delete' };
      const content = await readFile(path.join(ticket.dir, `${prefix}.resolved`)).catch(() => null);
      if (content === null) return { path: filePath, kind: 'missing' };
      return { path: filePath, kind: 'content', content };
    }),
  );
}

/**
 * Amorce `<prefix>.resolved` pour chaque fichier en conflit qui n'a encore
 * aucune résolution préparée, à partir de `.theirs` (repli `.ours`, puis
 * `.base`) — un point de départ à éditer, jamais une résolution automatique :
 * un fichier déjà marqué (`.resolved` ou `.delete`) n'est jamais écrasé.
 *
 * Un chemin PROTÉGÉ (ticket PROTECTED_PATHS_CHANGED) n'est JAMAIS amorcé
 * depuis la version de l'agent sans décision explicite : le `.resolved` est
 * ce qui distingue la décision de l'humain de celle de l'agent au --apply, un
 * scaffold automatique la lui ferait approuver sans lecture (S-I2). L'humain
 * écrit le contenu, ou nomme le chemin dans `acceptTheirs`. Les chemins
 * retenus sont rendus avec `held: true`.
 */
export async function prepareResolutionScaffold(
  root: string,
  ticketId: string,
  options: { acceptTheirs?: readonly string[] } = {},
): Promise<
  Array<{
    path: string;
    created: boolean;
    source: 'theirs' | 'ours' | 'base' | null;
    held?: boolean;
  }>
> {
  const tickets = await listConflictTickets(root, { includeResolved: true });
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw ticketUnknownError(ticketId);
  }
  assertTicketUsable(ticket);
  const accepted = new Set(options.acceptTheirs ?? []);
  const protectedPaths = new Set(
    ticket.reason === 'PROTECTED_PATHS_CHANGED'
      ? (ticket.protectedChanges ?? []).map((c) => c.path)
      : [],
  );
  return Promise.all(
    (ticket.conflictedFiles ?? []).map(async (filePath) => {
      const prefix = ticketPrefix(ticket, filePath);
      const resolvedPath = path.join(ticket.dir, `${prefix}.resolved`);
      const alreadyMarked =
        (await stat(resolvedPath).then(
          () => true,
          () => false,
        )) ||
        (await stat(path.join(ticket.dir, `${prefix}.delete`)).then(
          () => true,
          () => false,
        ));
      if (alreadyMarked) return { path: filePath, created: false, source: null };
      if (protectedPaths.has(filePath) && !accepted.has(filePath)) {
        return { path: filePath, created: false, source: null, held: true };
      }
      for (const source of ['theirs', 'ours', 'base'] as const) {
        const content = await readFile(path.join(ticket.dir, `${prefix}.${source}`)).catch(
          () => null,
        );
        if (content !== null) {
          await writePrivateFile(resolvedPath, content);
          return { path: filePath, created: true, source };
        }
      }
      return { path: filePath, created: false, source: null };
    }),
  );
}
