import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from 'commander';
import {
  EXIT,
  autonomousOutcome,
  exitCodeForErrorKind,
  exitCodeForOutcome,
  manualResolutionOutcome,
  mainSessionOutcome,
  mergeOutcome,
  orchestrationOutcome,
  promoteOutcome,
  syncOutcome,
  worstOutcome,
} from '../../src/cli/exit.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { agentNameParser, integerParser, ticketIdParser } from '../../src/cli/parse.ts';
import { StriartError, errorKindOf } from '../../src/errors.ts';

describe('codes de sortie', () => {
  it('barème par nature : 0 ok, 1 échec, 2 usage, 3 refus', () => {
    expect(exitCodeForOutcome('ok')).toBe(0);
    expect(exitCodeForOutcome('failed')).toBe(1);
    expect(exitCodeForOutcome('refused')).toBe(3);
    expect(exitCodeForErrorKind('usage')).toBe(2);
    expect(exitCodeForErrorKind('refusal')).toBe(3);
    expect(exitCodeForErrorKind('failure')).toBe(1);
    expect(EXIT).toMatchObject({ SIGINT: 130, SIGTERM: 143 });
  });

  it('merge : conflit et Test Gate rouge sont des REFUS (sortie 3, plus jamais 0)', () => {
    expect(mergeOutcome('MERGED')).toBe('ok');
    expect(mergeOutcome('UP_TO_DATE')).toBe('ok');
    expect(mergeOutcome('CONFLICT')).toBe('refused');
    expect(mergeOutcome('GATE_FAILED')).toBe('refused');
    expect(promoteOutcome('GATE_FAILED')).toBe('refused');
    expect(manualResolutionOutcome('GATE_FAILED')).toBe('refused');
    expect(manualResolutionOutcome('ALREADY_CLEAN')).toBe('ok');
  });

  it('sync : un rebase reporté est un ajournement voulu, un stash en conflit un refus', () => {
    for (const status of [
      'REBASED',
      'UP_TO_DATE',
      'SKIPPED_DIRTY',
      'SKIPPED_SESSION',
      'REBASE_CONFLICT',
    ]) {
      expect(syncOutcome(status)).toBe('ok');
    }
    expect(syncOutcome('STASH_CONFLICT')).toBe('refused');
  });

  it('autonome : session plantée = échec relançable, merge bloqué = refus', () => {
    expect(autonomousOutcome('MERGED')).toBe('ok');
    expect(autonomousOutcome('QUEUED')).toBe('ok');
    expect(autonomousOutcome('SESSION_FAILED')).toBe('failed');
    expect(autonomousOutcome('EMPTY')).toBe('failed');
    expect(autonomousOutcome('MERGE_BLOCKED')).toBe('refused');
  });

  it('session sur le principal : un plafond de tokens est un refus (3), comme en autonome', () => {
    expect(mainSessionOutcome('COMPLETED')).toBe('ok');
    expect(mainSessionOutcome('BUDGET_EXCEEDED')).toBe('refused');
    expect(mainSessionOutcome('FAILED')).toBe('failed');
    expect(mainSessionOutcome('TIMEOUT')).toBe('failed');
    // Cause nommée de nature « refus » (agent ACP non connecté) : refus.
    expect(mainSessionOutcome('FAILED', 'ACP_AUTH_REQUIRED')).toBe('refused');
    expect(mainSessionOutcome('FAILED', 'ACP_HOST_LOST')).toBe('failed');
  });

  it('autonome : cause nommée de refus et renvoi voulu vers l’humain', () => {
    expect(autonomousOutcome('SESSION_FAILED', 'FAILED', 'ACP_AUTH_REQUIRED')).toBe('refused');
    expect(autonomousOutcome('SESSION_FAILED', 'FAILED', 'ACP_HOST_LOST')).toBe('failed');
    // commitPolicy 'human' : personne ne committe, le travail attend l'humain (refus, pas échec).
    expect(autonomousOutcome('EMPTY', 'human')).toBe('refused');
    expect(autonomousOutcome('EMPTY', 'striart')).toBe('failed');
  });

  it('orchestration : une erreur suit la nature du code de domaine qui l’a produite', () => {
    expect(orchestrationOutcome('ERROR', 'SESSION_LIVE')).toBe('refused');
    expect(orchestrationOutcome('ERROR', 'AGENT_EXISTS')).toBe('refused');
    expect(orchestrationOutcome('ERROR', 'UNEXPECTED')).toBe('failed');
    expect(orchestrationOutcome('ERROR', null)).toBe('failed');
    expect(orchestrationOutcome('ERROR', 'CODE_INCONNU')).toBe('failed');
  });

  it('worstOutcome : refus > échec > ok', () => {
    expect(worstOutcome([])).toBe('ok');
    expect(worstOutcome(['ok', 'failed'])).toBe('failed');
    expect(worstOutcome(['failed', 'refused', 'ok'])).toBe('refused');
  });
});

describe('nature des erreurs du domaine', () => {
  it('table centrale, défaut « failure » (le plus sûr pour un script)', () => {
    expect(errorKindOf('INVALID_AGENT_NAME')).toBe('usage');
    expect(errorKindOf('SESSION_LIVE')).toBe('refusal');
    expect(errorKindOf('AGENT_UNKNOWN')).toBe('failure');
    expect(errorKindOf('CODE_INCONNU')).toBe('failure');
    expect(new StriartError('x', { code: 'MAIN_DIRTY' }).kind).toBe('refusal');
    expect(new StriartError('x', { code: 'MAIN_DIRTY', kind: 'failure' }).kind).toBe('failure');
  });
});

describe('nature des erreurs : cohérence des familles de codes', () => {
  it('gardes qui refusent (décision humaine requise) : refus, sortie 3', () => {
    for (const code of [
      'STRIART_COMMIT_UNSAFE',
      'CONTROL_TOKEN_UNPROTECTED',
      'USER_CONFIG_UNSAFE',
      'PROMOTION_DISABLED',
      'COMMITTER_IDENTITY_MISSING',
      'UNSUPPORTED_RESOLUTION_KIND',
      'PERMISSION_NOT_PENDING',
      'ELICITATION_NOT_PENDING',
      'EMPTY_REPO',
    ]) {
      expect(errorKindOf(code), code).toBe('refusal');
    }
  });

  it('un identifiant inconnu est un ÉCHEC pour toute la famille « *_UNKNOWN » (comme AGENT_UNKNOWN)', () => {
    for (const code of [
      'AGENT_UNKNOWN',
      'REVIEW_UNKNOWN',
      'PROFILE_UNKNOWN',
      'ACP_AGENT_UNKNOWN',
    ]) {
      expect(errorKindOf(code), code).toBe('failure');
    }
  });

  it('un outil de hook inconnu est un ensemble fermé de la CLI : usage, sortie 2 (comme les autres valeurs invalides)', () => {
    expect(errorKindOf('HOOK_TOOL_UNKNOWN')).toBe('usage');
  });

  it('--after : la file refuse la dépendance, qu’elle soit inconnue ou cyclique', () => {
    expect(errorKindOf('AFTER_UNKNOWN')).toBe('refusal');
    expect(errorKindOf('AFTER_CYCLE')).toBe('refusal');
  });

  it('une config invalide est un échec, shell de pty compris (comme CONFIG_INVALID)', () => {
    expect(errorKindOf('CONFIG_INVALID')).toBe('failure');
    expect(errorKindOf('PTY_SHELL_INVALID')).toBe('failure');
  });
});

describe('analyseurs d’arguments (validation stricte, sortie 2)', () => {
  const days = integerParser(fr, { min: 0, max: 100 });

  it('entiers : refuse ce qu’un parseInt lâche acceptait', () => {
    expect(days('7')).toBe(7);
    expect(days('0')).toBe(0);
    for (const bad of ['abc', '-1', '7d', '1.5', '', '07', '101', '1e2']) {
      expect(() => days(bad)).toThrow(InvalidArgumentError);
    }
  });

  it('nom d’agent et id de ticket : alphabet fermé', () => {
    const name = agentNameParser(fr);
    expect(name('agent-a')).toBe('agent-a');
    for (const bad of ['bad name', '../x', '-a', 'a'.repeat(65), 'a;b']) {
      expect(() => name(bad)).toThrow(InvalidArgumentError);
    }
    const ticket = ticketIdParser(fr);
    expect(ticket('agent-a-f72c4ba9')).toBe('agent-a-f72c4ba9');
    expect(() => ticket('../../etc')).toThrow(InvalidArgumentError);
  });
});

describe('détails d’erreur publics (--json) — caviardage défensif', () => {
  it('le NOM d’un profil (chaîne) est un identifiant public ; sa définition (objet) reste masquée', async () => {
    const { publicErrorDetails } = await import('../../src/errors.ts');
    expect(publicErrorDetails({ reason: 'ACP_OPTION_INVALID', profile: 'claude-acp' })).toEqual({
      reason: 'ACP_OPTION_INVALID',
      profile: 'claude-acp',
    });
    expect(publicErrorDetails({ profile: { command: 'x', env: { A: 'b' } } })).toEqual({
      profile: '[redacted]',
    });
    // Une chaîne qui n'a pas la forme d'un nom de profil n'est pas un nom : masquée.
    expect(publicErrorDetails({ profile: 'token=abc def' })).toEqual({ profile: '[redacted]' });
    expect(publicErrorDetails({ profile: 'x'.repeat(65) })).toEqual({ profile: '[redacted]' });
  });

  it('masque récursivement env, value, url, profile et tout champ de type secret', async () => {
    const { publicErrorDetails } = await import('../../src/errors.ts');
    const details = publicErrorDetails({
      key: 'agentProfiles',
      agent: 'agent-a',
      value: { x: 1 },
      nested: { env: { TOKEN: 's' }, apiKey: 'k', webhookUrl: 'https://hooks', pid: 42 },
      profile: { command: 'claude' },
      list: [{ password: 'p', ok: 'yes' }],
    });
    expect(details).toEqual({
      key: 'agentProfiles',
      agent: 'agent-a',
      value: '[redacted]',
      nested: { env: '[redacted]', apiKey: '[redacted]', webhookUrl: '[redacted]', pid: 42 },
      profile: '[redacted]',
      list: [{ password: '[redacted]', ok: 'yes' }],
    });
  });
});
