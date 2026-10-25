import { describe, expect, it } from 'vitest';
import { composeTurnPrompt } from '../../src/orchestration/briefing.ts';

const BASE = {
  task: 'Ajoute la route /health.',
  group: 'team-0123456789ab',
  role: 'impl',
  roleKind: 'member',
  rolePrompt: null,
  peers: ['tests'],
  scope: ['src/**', 'lib/**'],
  readOnly: false,
  noCommit: false,
  facts: ['Round 1 of 2; you are role 1 of 2 (impl → tests).'],
  untrusted: [{ label: 'note from tests to impl', text: 'Signature : health(): Promise<void>' }],
  outboxFile: true,
  inboxFile: true,
  review: null,
  maxChars: 12000,
};

describe('briefing — règles permanentes déjà dans les consignes', () => {
  it('par défaut (consignes non garanties) : version COMPLÈTE autonome (outbox JSON + inbox + outil)', () => {
    const prompt = composeTurnPrompt(BASE);
    expect(prompt).toContain('.striart-outbox.json');
    expect(prompt).toContain('"messages":[{"to"');
    expect(prompt).toContain('striart_collab_post');
    expect(prompt).toContain('.striart-inbox.md');
  });

  it('consignes actives : ni format JSON, ni mention d’outil, ni rappel d’inbox — un renvoi aux consignes', () => {
    const prompt = composeTurnPrompt({ ...BASE, rulesInInstructions: true });
    expect(prompt).not.toContain('"messages":[{"to"');
    expect(prompt).not.toContain('striart_collab_post');
    expect(prompt).not.toContain('.striart-inbox.md');
    expect(prompt).toMatch(/session instructions/i);
    // Le propre du tour reste.
    expect(prompt).toContain('Ajoute la route /health.');
    expect(prompt).toContain('your role: impl');
    expect(prompt).toContain('`src/**`, `lib/**`');
    expect(prompt).toContain('Round 1 of 2');
    expect(prompt).toContain('Signature : health(): Promise<void>');
    expect(prompt).toContain('tests');
  });

  it('plus court avec les consignes, sans perdre le périmètre ni le commit', () => {
    const full = composeTurnPrompt({ ...BASE, noCommit: true });
    const slim = composeTurnPrompt({ ...BASE, noCommit: true, rulesInInstructions: true });
    expect(slim.length).toBeLessThan(full.length);
    expect(slim).toContain('Do NOT commit');
    expect(slim).toContain('Write scope');
  });

  it('lecture seule : la règle du tour est conservée', () => {
    const prompt = composeTurnPrompt({
      ...BASE,
      scope: [],
      readOnly: true,
      rulesInInstructions: true,
    });
    expect(prompt).toContain('READ-ONLY');
  });

  it('relecture : verdict raccourci avec les consignes, format complet à la relance', () => {
    const review = {
      baseCommit: 'abc',
      tip: 'def',
      round: 1,
      retry: false,
      verdictToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    };
    const base = { ...BASE, roleKind: 'reviewer', readOnly: true, scope: [], review };
    const full = composeTurnPrompt(base);
    expect(full).toContain('"verdict":"approve|request-changes|reject"');
    const slim = composeTurnPrompt({ ...base, rulesInInstructions: true });
    expect(slim).toContain('striart-verdict-a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(full).toContain('```striart-verdict-a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(slim).not.toContain('"severity":"blocker|major|minor|info"');
    expect(slim.length).toBeLessThan(full.length);
    // Relance : le format redevient explicite (le relecteur s’est trompé).
    const retry = composeTurnPrompt({
      ...base,
      rulesInInstructions: true,
      review: { ...review, retry: true },
    });
    expect(retry).toContain('"verdict":"approve|request-changes|reject"');
  });

  it('canaux désactivés : aucune règle de canal, avec ou sans consignes', () => {
    for (const rulesInInstructions of [false, true]) {
      const prompt = composeTurnPrompt({
        ...BASE,
        outboxFile: false,
        inboxFile: false,
        rulesInInstructions,
      });
      expect(prompt).not.toContain('.striart-outbox.json');
      expect(prompt).not.toContain('.striart-inbox.md');
    }
  });
});
