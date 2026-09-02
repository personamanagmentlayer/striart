import { describe, expect, it } from 'vitest';
import { validateAgentName } from '../../src/clone.js';
import { StriartError } from '../../src/errors.js';

describe('validateAgentName', () => {
  it.each(['agent-a', 'billing', 'ui_2', 'A1'])('accepte "%s"', (name) => {
    expect(validateAgentName(name)).toBe(name);
  });

  it.each(['', '../evil', 'a b', 'agent/x', '.hidden', '-lead', 'a'.repeat(65), null, 42])(
    'rejette %j',
    (name) => {
      expect(() => validateAgentName(name)).toThrow(StriartError);
    },
  );
});
