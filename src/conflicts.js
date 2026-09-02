import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { striartDir } from './clone.js';
import { StriartError } from './errors.js';

/**
 * Crée un ticket de conflit dans .striart/conflicts/<id>/ :
 * ticket.json (métadonnées) + test-output.log (sortie du Test Gate).
 * C'est le fallback humain obligatoire (règle d'or n°4).
 */
function safeFileName(filePath) {
  return filePath.replaceAll(/[\\/]/g, '__');
}

/**
 * `resolutions` : [{ path, base, ours, theirs, llmAttempt? }] — les 3 versions
 * de chaque fichier en conflit (+ la tentative LLM si la fusion sémantique
 * a tourné), écrites à côté du ticket pour la résolution humaine.
 */
export async function createConflictTicket(
  root,
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
  },
) {
  const id = `${agent}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(striartDir(root), 'conflicts', id);
  await mkdir(dir, { recursive: true });

  const ticket = {
    id,
    agent,
    branch,
    sha,
    reason, // voir TicketReason dans types.d.ts
    conflictedFiles,
    // Conflits hors de portée du Merger (delete/binaire/lockfile/oversize/opaque),
    // avec la nature de chacun — guide la résolution humaine.
    ...(unmergeable.length > 0 ? { unmergeable } : {}),
    prompt,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, 'ticket.json'), `${JSON.stringify(ticket, null, 2)}\n`, 'utf8');
  if (log) await writeFile(path.join(dir, 'test-output.log'), log, 'utf8');

  for (const res of resolutions) {
    const prefix = safeFileName(res.path);
    await writeFile(path.join(dir, `${prefix}.base`), res.base ?? '', 'utf8');
    await writeFile(path.join(dir, `${prefix}.ours`), res.ours ?? '', 'utf8');
    await writeFile(path.join(dir, `${prefix}.theirs`), res.theirs ?? '', 'utf8');
    if (res.llmAttempt != null) {
      await writeFile(path.join(dir, `${prefix}.llm-attempt`), res.llmAttempt, 'utf8');
    }
  }

  return { ...ticket, dir };
}

/**
 * Liste les tickets de conflit (métadonnées de ticket.json).
 * Par défaut, seuls les tickets OUVERTS sont retournés : un ticket portant
 * un fichier RESOLVED (créé par striart resolve --close, ou à la main par
 * l'humain après correction) est considéré traité.
 */
/** @param {string} root @param {{includeResolved?: boolean}} [opts] @returns {Promise<import('./types.js').Ticket[]>} */
export async function listConflictTickets(root, { includeResolved = false } = {}) {
  const dir = path.join(striartDir(root), 'conflicts');
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const tickets = [];
  for (const entry of entries) {
    try {
      const ticketDir = path.join(dir, entry);
      const raw = await readFile(path.join(ticketDir, 'ticket.json'), 'utf8');
      const resolved = await stat(path.join(ticketDir, 'RESOLVED')).then(
        () => true,
        () => false,
      );
      if (resolved && !includeResolved) continue;
      tickets.push({ ...JSON.parse(raw), dir: ticketDir, resolved });
    } catch {
      // Dossier sans ticket.json lisible : ignoré.
    }
  }
  return tickets.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Détail complet d'un ticket pour la résolution humaine : métadonnées +
 * contenu des 3 versions (et de la tentative LLM) de chaque fichier en
 * conflit + log du Test Gate. Les fichiers absents valent null.
 * @param {string} root @param {string} ticketId
 * @returns {Promise<import('./types.js').Ticket & {resolutions: Array<{path: string, base: string|null, ours: string|null, theirs: string|null, llmAttempt: string|null}>, log: string|null}>}
 */
export async function readTicketDetail(root, ticketId) {
  const tickets = await listConflictTickets(root, { includeResolved: true });
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw new StriartError(`Ticket inconnu : "${ticketId}".`, {
      code: 'TICKET_UNKNOWN',
      details: { ticketId },
    });
  }
  const readOrNull = (file) => readFile(path.join(ticket.dir, file), 'utf8').catch(() => null);
  const resolutions = await Promise.all(
    (ticket.conflictedFiles ?? []).map(async (filePath) => {
      const prefix = safeFileName(filePath);
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
/** @param {string} root @param {string} ticketId @returns {Promise<import('./types.js').Ticket>} */
export async function closeConflictTicket(root, ticketId) {
  const tickets = await listConflictTickets(root, { includeResolved: true });
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    throw new StriartError(`Ticket inconnu : "${ticketId}". Voir "striart resolve --all".`, {
      code: 'TICKET_UNKNOWN',
      details: { ticketId },
    });
  }
  await writeFile(path.join(ticket.dir, 'RESOLVED'), `${new Date().toISOString()}\n`, 'utf8');
  return { ...ticket, resolved: true };
}
