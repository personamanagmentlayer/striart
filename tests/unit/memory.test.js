import { describe, expect, it } from 'vitest';
import { renderLiveSection } from '../../src/memory.js';

const registry = {
  'agent-a': {
    path: '/x/agent-a',
    prompt: 'Refondre le module de login',
    predictedFiles: ['src/auth.js', 'src/session.js'],
    mode: 'attended',
  },
  'agent-b': {
    path: '/x/agent-b',
    prompt: 'Ajouter la facturation',
    predictedFiles: ['src/billing.js'],
    mode: 'autonomous',
  },
};

const queue = [
  {
    id: 'task-1234abcd',
    status: 'WAITING',
    agent: 'agent-c',
    prompt: 'Nettoyer les logs',
    predictedFiles: ['src/logger.js'],
    collisions: [],
    after: 'agent-a',
  },
];

describe('renderLiveSection (Memory Layer temps réel)', () => {
  it('liste les AUTRES agents actifs avec leurs fichiers prédits, jamais soi-même', () => {
    const section = renderLiveSection(registry, [], 'agent-a');
    expect(section).toContain('agent-b');
    expect(section).toContain('src/billing.js');
    expect(section).toContain('autonome');
    // Le destinataire connaît sa propre tâche : il ne doit pas s'y voir.
    expect(section).not.toContain('agent-a');
    expect(section).not.toContain('src/auth.js');
  });

  it('liste les tâches en file avec leur dépendance déclarée', () => {
    const section = renderLiveSection(registry, queue, 'agent-b');
    expect(section).toContain('agent-c');
    expect(section).toContain('en file');
    expect(section).toContain('task-1234abcd');
    expect(section).toContain('après agent-a');
    expect(section).toContain('src/logger.js');
  });

  it("chaîne vide quand l'agent est seul (rien à signaler = pas de section)", () => {
    expect(renderLiveSection({ 'agent-a': registry['agent-a'] }, [], 'agent-a')).toBe('');
    expect(renderLiveSection({}, [], 'agent-x')).toBe('');
  });

  it('le prompt est tronqué et ramené sur une ligne (extrait, pas le pavé)', () => {
    const long = {
      'agent-long': {
        path: '/x',
        prompt: `Première ligne\ndeuxième ligne\n${'x'.repeat(500)}`,
        predictedFiles: [],
        mode: 'attended',
      },
    };
    const section = renderLiveSection(long, [], 'agent-autre');
    const line = section.split('\n').find((l) => l.includes('agent-long'));
    expect(line).toContain('Première ligne deuxième ligne');
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(250);
  });

  it('des prédictions absentes ne cassent rien (aucun prédit, affiché tel quel)', () => {
    const bare = { 'agent-nu': { path: '/x', prompt: null, predictedFiles: [], mode: 'attended' } };
    const section = renderLiveSection(bare, [], 'agent-autre');
    expect(section).toContain('agent-nu');
    expect(section).toContain('(aucun prédit)');
  });
});
