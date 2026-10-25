import { describe, expect, it } from 'vitest';
import {
  formatMergeSubject,
  parseMergeSubject,
  parseRevertSubject,
} from '../../src/merge-subject.ts';

const SHA = '4af5ca60e1d2c3b4a5968778695a4b3c2d1e0f9a';

describe('formatMergeSubject / parseMergeSubject', () => {
  it('merge sans conflit : format historique inchangé', () => {
    const subject = formatMergeSubject({
      agent: 'agent-a',
      branch: 'striart/agent-a/task-1',
      agentSha: SHA,
    });
    expect(subject).toBe('merge(striart): agent-a striart/agent-a/task-1 (4af5ca60)');
    expect(parseMergeSubject(subject)).toEqual({
      agent: 'agent-a',
      branch: 'striart/agent-a/task-1',
      agentSha: '4af5ca60',
      resolution: 'auto',
      semanticFiles: [],
      ticketId: null,
    });
  });

  it('fusion sémantique : fichiers restitués', () => {
    const subject = formatMergeSubject({
      agent: 'agent-a',
      branch: 'b',
      agentSha: SHA,
      semanticFiles: ['src/a.js', 'src/b.js'],
    });
    expect(subject).toBe(
      'merge(striart): agent-a b (4af5ca60) [fusion sémantique: src/a.js, src/b.js]',
    );
    const parsed = parseMergeSubject(subject);
    expect(parsed.resolution).toBe('semantic');
    expect(parsed.semanticFiles).toEqual(['src/a.js', 'src/b.js']);
  });

  it('résolution manuelle (resolve --apply) : reconnue, ticket restitué', () => {
    const subject = formatMergeSubject({
      agent: 'agent-a',
      branch: 'b',
      agentSha: SHA,
      ticketId: 'agent-a-f72c4ba9',
    });
    expect(subject).toBe(
      'merge(striart): agent-a b (4af5ca60) [résolution manuelle: agent-a-f72c4ba9]',
    );
    const parsed = parseMergeSubject(subject);
    expect(parsed.resolution).toBe('manual');
    expect(parsed.ticketId).toBe('agent-a-f72c4ba9');
  });

  it('un chemin contenant des crochets ne fait pas disparaître le merge', () => {
    const parsed = parseMergeSubject(
      'merge(striart): agent-a b (4af5ca60) [fusion sémantique: app/[id]/page.tsx]',
    );
    expect(parsed?.semanticFiles).toEqual(['app/[id]/page.tsx']);
  });

  it('une note inconnue (version future) reste un merge reconnu', () => {
    const parsed = parseMergeSubject('merge(striart): agent-a b (4af5ca60) [autre chose: x]');
    expect(parsed?.agent).toBe('agent-a');
    expect(parsed?.resolution).toBe('auto');
  });

  it('rejette ce qui n’est pas un merge Striart', () => {
    expect(parseMergeSubject('feat: ajoute x')).toBeNull();
    expect(parseMergeSubject('merge(striart): agent-a b (pas-un-sha)')).toBeNull();
    expect(parseMergeSubject('Merge branch main')).toBeNull();
  });
});

describe('parseRevertSubject', () => {
  it('reconnaît le revert d’un merge Striart, y compris manuel', () => {
    const inner = formatMergeSubject({
      agent: 'agent-b',
      branch: 'b',
      agentSha: SHA,
      ticketId: 't-1',
    });
    expect(parseRevertSubject(`Revert "${inner}"`)?.agent).toBe('agent-b');
  });

  it('ignore les autres reverts', () => {
    expect(parseRevertSubject('Revert "feat: x"')).toBeNull();
  });
});
