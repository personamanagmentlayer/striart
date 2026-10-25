import { describe, expect, it } from 'vitest';
import {
  MAX_LINK_TTL_MS,
  SessionStore,
  SignInVerifier,
  generateToken,
  mintSignInCode,
  parseCookies,
  sddlRestrictedTo,
  sessionCookie,
  sessionCookieName,
} from '../../src/control/auth.ts';

describe('jeton, liens à usage unique et sessions du dashboard', () => {
  it('un code valide passe UNE fois ; rejoué → replayed', () => {
    const token = generateToken();
    const verifier = new SignInVerifier(token, 3456);
    const { code } = mintSignInCode(token, { port: 3456 });
    expect(verifier.verify(code)).toBe('ok');
    expect(verifier.verify(code)).toBe('replayed');
  });

  it('autre jeton, autre port, code altéré ou mal formé → invalid', () => {
    const token = generateToken();
    const verifier = new SignInVerifier(token, 3456);
    expect(verifier.verify(mintSignInCode(generateToken(), { port: 3456 }).code)).toBe('invalid');
    expect(verifier.verify(mintSignInCode(token, { port: 3457 }).code)).toBe('invalid');
    const { code } = mintSignInCode(token, { port: 3456 });
    const flipped = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    expect(verifier.verify(flipped)).toBe('invalid');
    for (const bad of [undefined, null, '', 'v1', 'v1.a.b.c', `${code}x`, 42])
      expect(verifier.verify(bad)).toBe('invalid');
  });

  it('expiré → expired ; échéance au-delà de la borne absolue → invalid', () => {
    const token = generateToken();
    const verifier = new SignInVerifier(token, 1);
    const now = Date.now();
    const { code } = mintSignInCode(token, { port: 1, ttlMs: 1000, now: now - 5000 });
    expect(verifier.verify(code, now)).toBe('expired');
    // Code fabriqué (avec le jeton) pour une échéance hors borne : refusé.
    const far = mintSignInCode(token, {
      port: 1,
      ttlMs: MAX_LINK_TTL_MS,
      now: now + MAX_LINK_TTL_MS,
    });
    expect(verifier.verify(far.code, now)).toBe('invalid');
  });

  it('le code ne contient pas le jeton', () => {
    const token = generateToken();
    const { code } = mintSignInCode(token, { port: 3456 });
    expect(code).not.toContain(token.toString('base64url'));
    expect(code).not.toContain(token.toString('hex'));
  });

  it('sessions : identifiant aléatoire, expiration, borne du nombre, faux identifiants refusés', () => {
    const store = new SessionStore({ ttlMs: 1000, max: 2 });
    const now = Date.now();
    const a = store.create(now);
    expect(store.check(a.id, now + 10)).toBe(true);
    expect(store.check(a.id, now + 1001)).toBe(false);
    const b = store.create(now);
    const c = store.create(now + 1);
    const d = store.create(now + 2);
    expect(store.size).toBe(2);
    expect(store.check(b.id, now + 5)).toBe(false); // évincée (plus ancienne)
    expect(store.check(c.id, now + 5)).toBe(true);
    expect(store.check(d.id, now + 5)).toBe(true);
    for (const bad of [undefined, '', 'x', `${c.id}=`, '../../etc/passwd'])
      expect(store.check(bad)).toBe(false);
  });

  it('cookie : HttpOnly; SameSite=Strict; Path=/, nom propre au port, analyse robuste', () => {
    const header = sessionCookie(sessionCookieName(3456), 'abc', 60);
    expect(header).toBe('striart_session_3456=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=60');
    const cookies = parseCookies('a=1; striart_session_3456=xyz ; junk; a=2');
    expect(cookies.get('striart_session_3456')).toBe('xyz');
    expect(cookies.get('a')).toBe('1');
    expect(parseCookies(undefined).size).toBe(0);
  });

  it('SDDL : seule une DACL protégée n’accordant qu’au SID courant est acceptée', () => {
    const me = 'S-1-5-21-1-2-3-1001';
    expect(sddlRestrictedTo(`D:PAI(A;;FA;;;${me})`, me)).toBe(true);
    expect(sddlRestrictedTo(`D:P(A;;FA;;;${me})`, me)).toBe(true);
    // Héritage actif (pas de P) : refusé.
    expect(sddlRestrictedTo(`D:AI(A;;FA;;;${me})`, me)).toBe(false);
    // Un autre compte (Everyone, Users) : refusé.
    expect(sddlRestrictedTo(`D:PAI(A;;FA;;;${me})(A;;FR;;;S-1-1-0)`, me)).toBe(false);
    expect(sddlRestrictedTo(`D:PAI(A;;FA;;;${me})(A;ID;FR;;;BU)`, me)).toBe(false);
    expect(sddlRestrictedTo('D:P', me)).toBe(false);
    expect(sddlRestrictedTo('garbage', me)).toBe(false);
  });

  it('SDDL : le formateur Windows abrège le SID de certains comptes — même principal, autre écriture', () => {
    // Administrateur local (RID 500, ex. runneradmin) : « LA ».
    const admin = 'S-1-5-21-3776380004-1005456608-3524014338-500';
    expect(sddlRestrictedTo('D:P(A;;FA;;;LA)', admin)).toBe(true);
    expect(sddlRestrictedTo('D:PAI(A;;FA;;;LA)', admin)).toBe(true);
    // SYSTEM : « SY ».
    expect(sddlRestrictedTo('D:P(A;;FA;;;SY)', 'S-1-5-18')).toBe(true);
    // L'alias ne vaut QUE pour son propre SID : un utilisateur ordinaire ne
    // reçoit pas la bénédiction de « LA », et un alias ne masque pas un
    // deuxième ACE.
    const me = 'S-1-5-21-1-2-3-1001';
    expect(sddlRestrictedTo('D:P(A;;FA;;;LA)', me)).toBe(false);
    expect(sddlRestrictedTo('D:P(A;;FA;;;LA)(A;;FA;;;BA)', admin)).toBe(false);
    expect(sddlRestrictedTo('D:P(A;;FA;;;SY)', admin)).toBe(false);
  });
});
