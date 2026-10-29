/**
 * Chemins d'une résolution manuelle (revue du noyau K-M9) :
 *  - un chemin à métacaractères (`[id].tsx`) n'est jamais un motif : la
 *    suppression `git rm` d'un fichier résolu en `.delete` emportait aussi
 *    `i.tsx` et `d.tsx` (pathspec glob) ;
 *  - les chemins d'un ticket viennent de ticket.json (contenu modifiable) :
 *    absolu, `..` ou dossier `.git` sont refusés avant toute écriture
 *    (TICKET_PATH_UNSAFE) ;
 *  - un dossier de tickets illisible est nommé (TICKETS_UNREADABLE), pas une
 *    erreur système brute.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import { applyTicketResolution, mergeAgentCommit } from '../../src/orchestrator.ts';
import { createConflictTicket, listConflictTickets, safeFileName } from '../../src/conflicts.ts';

const GATE_OK = 'node -e "process.exit(0)"';
const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());
const exists = async (p) => Boolean(await stat(p).catch(() => null));

describe('résolution manuelle — chemins littéraux et confinés (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ gateContainer: 'process', testCommand: GATE_OK, semanticMerge: false }),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('`.delete` sur `[id].tsx` ne supprime QUE ce fichier (pas i.tsx, que le motif [id] désignerait)', async () => {
    await writeFile(path.join(repo.root, '[id].tsx'), 'export const page = "base";\n');
    await writeFile(path.join(repo.root, 'i.tsx'), 'export const i = 1;\n');
    await git(repo.root, 'add', '--', '[id].tsx', 'i.tsx');
    await git(repo.root, 'commit', '-q', '-m', 'feat: pages');
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    // main modifie [id].tsx, l'agent le supprime : conflit modify/delete.
    await writeFile(path.join(repo.root, '[id].tsx'), 'export const page = "main";\n');
    await git(repo.root, 'add', '--', '[id].tsx');
    await git(repo.root, 'commit', '-q', '-m', 'feat: main modifie');
    await git(
      agent.path,
      '-c',
      'user.name=Agent',
      '-c',
      'user.email=a@example.com',
      '--literal-pathspecs',
      'rm',
      '-q',
      '--',
      '[id].tsx',
    );
    await git(
      agent.path,
      '-c',
      'user.name=Agent',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: supprime',
    );

    const conflict = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(conflict.status).toBe('CONFLICT');
    expect(conflict.reason).toBe('UNMERGEABLE_CONFLICT');
    await writeFile(path.join(conflict.ticket.dir, `${safeFileName('[id].tsx')}.delete`), '');

    const applied = await applyTicketResolution({ root: repo.root, ticketId: conflict.ticket.id });

    expect(applied.status).toBe('MERGED');
    expect(await exists(path.join(repo.root, '[id].tsx'))).toBe(false);
    expect(await exists(path.join(repo.root, 'i.tsx'))).toBe(true);
    expect(await git(repo.root, 'ls-files', '--', 'i.tsx')).toBe('i.tsx');
  });

  describe('ticket.json falsifié', () => {
    const makeTamperedTicket = async (evilPath) => {
      const ticket = await createConflictTicket(repo.root, {
        agent: 'agent-a',
        branch: 'striart/agent-a/task-1',
        sha: 'abc12345',
        reason: 'MERGE_CONFLICT',
        conflictedFiles: ['app.js'],
        resolutions: [{ path: 'app.js', base: 'b', ours: 'o', theirs: 't' }],
      });
      const file = path.join(ticket.dir, 'ticket.json');
      const doc = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...doc, conflictedFiles: [evilPath] }));
      await writeFile(path.join(ticket.dir, `${safeFileName(evilPath)}.resolved`), 'PWNED');
      return ticket;
    };

    it.each([
      ['échappement ..', '../escaped.txt'],
      ['échappement imbriqué', 'src/../../escaped.txt'],
      ['dossier .git', '.git/hooks/pre-commit'],
      ['dossier .git en sous-chemin', 'vendor/.git/config'],
      ['chemin absolu POSIX', '/tmp/escaped.txt'],
      ['chemin absolu Windows', 'C:\\escaped.txt'],
    ])('%s : TICKET_PATH_UNSAFE avant toute écriture', async (_label, evilPath) => {
      const ticket = await makeTamperedTicket(evilPath);

      const error = await applyTicketResolution({ root: repo.root, ticketId: ticket.id }).catch(
        (e) => e,
      );

      expect(error).toMatchObject({ code: 'TICKET_PATH_UNSAFE', kind: 'refusal' });
      expect(await exists(path.join(repo.root, '..', 'escaped.txt'))).toBe(false);
      expect(await exists(path.join(repo.root, '.git', 'hooks', 'pre-commit'))).toBe(false);
      expect(await git(repo.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    });
  });

  it('dossier des tickets illisible : TICKETS_UNREADABLE nommé, pas une erreur système brute', async () => {
    await rm(path.join(repo.root, '.striart', 'conflicts'), { recursive: true, force: true });
    await writeFile(path.join(repo.root, '.striart', 'conflicts'), 'je suis un fichier');

    const error = await listConflictTickets(repo.root).catch((e) => e);

    expect(error).toMatchObject({ code: 'TICKETS_UNREADABLE', kind: 'failure' });
    expect(error.hint).toBeTruthy();
  });
});
