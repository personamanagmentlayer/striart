import { describe, expect, it } from 'vitest';
import { parsePlan, validatePlan } from '../../src/plan.ts';
import { StriartError } from '../../src/errors.js';

describe('parsePlan / validatePlan', () => {
  it('parse un plan minimal valide (multi-ligne + commentaire)', () => {
    const plan = parsePlan(`
# Plan de refonte
version: 1
tasks:
  - id: schema
    prompt: |
      Ajoute une colonne jwt_version
      à la table users.
`);
    expect(plan.version).toBe(1);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ id: 'schema', autonomous: false, after: null });
    // Le scalaire bloc préserve les sauts de ligne du prompt.
    expect(plan.tasks[0].prompt).toContain('\n');
  });

  it('normalise les champs optionnels (défauts explicites)', () => {
    const { tasks } = validatePlan({ version: 1, tasks: [{ prompt: 'x' }] });
    expect(tasks[0]).toEqual({
      id: null,
      agent: null,
      prompt: 'x',
      autonomous: false,
      profile: null,
      command: null,
      timeout: null,
      after: null,
    });
  });

  it('YAML illisible → PLAN_INVALID', () => {
    expect(() => parsePlan('version: 1\n  tasks: [')).toThrow(StriartError);
    expect(() => parsePlan('version: 1\n  tasks: [')).toThrow(/YAML invalide|Plan/);
  });

  it('rejette une version non supportée', () => {
    expect(() => validatePlan({ version: 2, tasks: [{ prompt: 'x' }] })).toThrowError(/version/);
  });

  it('rejette des tasks absentes ou vides', () => {
    expect(() => validatePlan({ version: 1 })).toThrowError(/tasks/);
    expect(() => validatePlan({ version: 1, tasks: [] })).toThrowError(/non vide/);
  });

  it('rejette une tâche sans prompt', () => {
    expect(() => validatePlan({ version: 1, tasks: [{ id: 'a' }] })).toThrowError(/prompt/);
    expect(() => validatePlan({ version: 1, tasks: [{ prompt: '  ' }] })).toThrowError(/prompt/);
  });

  it('rejette un id en double', () => {
    expect(() =>
      validatePlan({
        version: 1,
        tasks: [
          { id: 'a', prompt: 'x' },
          { id: 'a', prompt: 'y' },
        ],
      }),
    ).toThrowError(/double/);
  });

  it('rejette autonomous non booléen et timeout invalide', () => {
    expect(() =>
      validatePlan({ version: 1, tasks: [{ prompt: 'x', autonomous: 'oui' }] }),
    ).toThrowError(/autonomous/);
    expect(() => validatePlan({ version: 1, tasks: [{ prompt: 'x', timeout: 500 }] })).toThrowError(
      /timeout/,
    );
  });

  it('accepte une dépendance vers une tâche définie AVANT', () => {
    const { tasks } = validatePlan({
      version: 1,
      tasks: [
        { id: 'a', prompt: 'x' },
        { id: 'b', prompt: 'y', after: 'a' },
      ],
    });
    expect(tasks[1].after).toBe('a');
  });

  it('rejette une dépendance vers une tâche définie APRÈS (anti-cycle par construction)', () => {
    expect(() =>
      validatePlan({
        version: 1,
        tasks: [
          { id: 'a', prompt: 'x', after: 'b' },
          { id: 'b', prompt: 'y' },
        ],
      }),
    ).toThrowError(/APRÈS|acyclique/);
  });

  it('rejette une auto-dépendance', () => {
    expect(() =>
      validatePlan({ version: 1, tasks: [{ id: 'a', prompt: 'x', after: 'a' }] }),
    ).toThrowError(/APRÈS|acyclique/);
  });

  it('laisse passer un after qui ne désigne aucun id de plan (référence d’exécution)', () => {
    // `after: agent-vivant` n'est pas un id du plan → validé au runtime par
    // runTask (AFTER_UNKNOWN), pas ici.
    const { tasks } = validatePlan({
      version: 1,
      tasks: [{ prompt: 'x', after: 'un-agent-deja-actif' }],
    });
    expect(tasks[0].after).toBe('un-agent-deja-actif');
  });
});
