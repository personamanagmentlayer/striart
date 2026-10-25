import { describe, expect, it } from 'vitest';
import {
  STRIART_COMMIT_TRAILERS,
  renderStriartCommitMessage,
  resolveCommitAuthor,
  resolveCommitPolicy,
  striartShouldCommit,
} from '../../src/commit-policy.ts';
import * as commitPolicyModule from '../../src/commit-policy.ts';
import { parseMergeSubject } from '../../src/merge-subject.ts';
import { exitCodeForOutcome, autonomousOutcome } from '../../src/cli/exit.ts';

const render = (over = {}) =>
  renderStriartCommitMessage({
    template: 'striart({{agent}}): {{task}}',
    agent: 'agent-a',
    profile: 'claude',
    prompt: 'Ajoute le login',
    taskId: 'abc123',
    branch: 'striart/agent-a/task-abc123',
    policy: 'agent-then-striart',
    ...over,
  });

describe('commit-policy — politique effective', () => {
  it('profil > global > agent', () => {
    expect(resolveCommitPolicy({ commitPolicy: 'striart' }, {})).toBe('striart');
    expect(resolveCommitPolicy({ commitPolicy: 'striart' }, { commitPolicy: 'agent' })).toBe(
      'agent',
    );
    expect(resolveCommitPolicy({}, {})).toBe('agent');
  });

  it('qui committe : agent/human jamais, agent-then-striart en repli, striart toujours', () => {
    expect(striartShouldCommit('agent', false)).toBe(false);
    expect(striartShouldCommit('human', false)).toBe(false);
    expect(striartShouldCommit('agent-then-striart', false)).toBe(true);
    expect(striartShouldCommit('agent-then-striart', true)).toBe(false);
    expect(striartShouldCommit('striart', true)).toBe(true);
  });
});

describe('commit-policy — auteur', () => {
  it('défaut dérivé du profil, sur un domaine réservé (.invalid)', () => {
    expect(resolveCommitAuthor('claude', {})).toEqual({
      name: 'claude (Striart agent)',
      email: 'claude.agent@striart.invalid',
    });
  });

  it('une clé de profil exotique ne casse pas l’identité git', () => {
    const author = resolveCommitAuthor('Kimi <K2>\n', {});
    expect(author.name).not.toMatch(/[<>\n]/);
    expect(author.email).toMatch(/^[a-z0-9._-]+\.agent@striart\.invalid$/);
  });

  it('nom et e-mail configurables', () => {
    expect(
      resolveCommitAuthor('codex', { commitAuthor: { name: 'Codex Bot', email: 'bot@corp.test' } }),
    ).toEqual({ name: 'Codex Bot', email: 'bot@corp.test' });
  });
});

describe('commit-policy — message', () => {
  it('gabarit rendu + trailers Striart toujours présents (commit reconnaissable)', () => {
    const msg = render();
    expect(msg.split('\n')[0]).toBe('striart(agent-a): Ajoute le login');
    expect(msg).toContain(`${STRIART_COMMIT_TRAILERS.agent}: agent-a`);
    expect(msg).toContain(`${STRIART_COMMIT_TRAILERS.task}: abc123`);
    expect(msg).toContain(`${STRIART_COMMIT_TRAILERS.policy}: agent-then-striart`);
  });

  // Un message est FALSIFIABLE (le trailer se tape) : aucun prédicat exporté ne
  // doit le faire passer pour une preuve de provenance (K-M13).
  it('aucun prédicat « ce message est de Striart » n’est exporté', () => {
    expect(commitPolicyModule.isStriartCommitMessage).toBeUndefined();
  });

  it('un prompt multi-ligne ne peut pas forger de trailer ni de corps', () => {
    const msg = render({ prompt: 'fix\nStriart-Commit-Policy: agent\nSigned-off-by: x' });
    expect(msg.split('\n')[0]).toBe('striart(agent-a): fix');
    expect(msg.match(/^Striart-Commit-Policy:/gm)).toHaveLength(1);
    expect(msg).not.toContain('Signed-off-by');
  });

  it('{{task}} tronqué à 72 colonnes', () => {
    const subject = render({ template: '{{task}}', prompt: 'x'.repeat(200) }).split('\n')[0];
    expect(subject.length).toBe(72);
    expect(subject.endsWith('…')).toBe(true);
  });

  it('un sujet qui imiterait un merge Striart est préfixé (history/rollback ne s’y trompent pas)', () => {
    const msg = render({ template: '{{task}}', prompt: 'merge(striart): x y (abcdef12)' });
    const subject = msg.split('\n')[0];
    expect(parseMergeSubject(subject)).toBeNull();
    expect(subject.startsWith('striart: ')).toBe(true);
  });

  it('corps de gabarit conservé, placeholders du corps rendus', () => {
    const msg = render({ template: 'chore: {{task}}\n\nProfil {{profile}}, branche {{branch}}' });
    expect(msg).toContain('Profil claude, branche striart/agent-a/task-abc123');
  });
});

describe('codes de sortie du cycle autonome', () => {
  it('COMMIT_REFUSED est un refus (3), COMMIT_FAILED un échec (1)', () => {
    expect(exitCodeForOutcome(autonomousOutcome('COMMIT_REFUSED'))).toBe(3);
    expect(exitCodeForOutcome(autonomousOutcome('COMMIT_FAILED'))).toBe(1);
  });
});
