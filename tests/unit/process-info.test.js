import { describe, expect, it } from 'vitest';
import {
  assessDeclaringShell,
  IDENTITY_START_MARGIN_MS,
  checkProcessInstance,
  declaringShellName,
  isNonInteractiveInvocation,
  normalizeImageName,
  parseStartedAt,
  pidHintForShell,
  splitCommandLine,
  trimForeignAncestors,
} from '../../src/process-info.ts';

const proc = (pid, name, commandLine, ppid = 1) => ({ pid, ppid, name, commandLine });

describe('normalizeImageName', () => {
  it('retire chemin, .exe, casse et tiret de login shell', () => {
    expect(normalizeImageName('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
    expect(normalizeImageName('/usr/bin/zsh')).toBe('zsh');
    expect(normalizeImageName('-bash')).toBe('bash');
    expect(normalizeImageName('CMD.EXE')).toBe('cmd');
  });
});

describe('splitCommandLine', () => {
  it('respecte les guillemets doubles', () => {
    expect(splitCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '--login',
      '-i',
    ]);
    expect(splitCommandLine('cmd /c "node cli.js"')).toEqual(['cmd', '/c', 'node cli.js']);
  });
});

describe('isNonInteractiveInvocation', () => {
  it.each([
    ['cmd', 'cmd.exe /c striart lock --start x', true],
    ['cmd', 'cmd.exe /k', false],
    ['cmd', 'C:\\Windows\\system32\\cmd.exe', false],
    ['pwsh', 'pwsh -Command "striart lock --start x"', true],
    ['pwsh', 'pwsh -NoExit -Command "Set-Location C:\\"', false],
    ['pwsh', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo', false],
    ['bash', 'bash -c "striart lock --start x"', true],
    ['bash', 'bash -lc "x"', true],
    ['bash', 'bash --login -i', false],
    ['zsh', '-zsh', false],
  ])('%s « %s » → %s', (name, commandLine, expected) => {
    expect(isNonInteractiveInvocation(proc(10, name, commandLine))).toBe(expected);
  });

  it('ligne de commande inconnue → présumé interactif (le nom a déjà été vérifié)', () => {
    expect(isNonInteractiveInvocation(proc(10, 'bash', null))).toBe(false);
  });
});

describe('assessDeclaringShell', () => {
  it('shell interactif → accepté', () => {
    const result = assessDeclaringShell([proc(10, 'pwsh', 'pwsh -NoLogo')], 'win32');
    expect(result).toMatchObject({ ok: true, shell: { pid: 10 } });
  });

  it('chaîne vide (identité illisible) → UNKNOWN, fail closed', () => {
    expect(assessDeclaringShell([], 'linux')).toMatchObject({ ok: false, reason: 'UNKNOWN' });
  });

  it('parent qui n’est pas un shell (npm exec, node) → NOT_A_SHELL', () => {
    expect(assessDeclaringShell([proc(10, 'node', 'node npx-cli.js')], 'linux')).toMatchObject({
      ok: false,
      reason: 'NOT_A_SHELL',
    });
  });

  it('cmd /c → NON_INTERACTIVE', () => {
    expect(
      assessDeclaringShell([proc(10, 'cmd', 'cmd /c striart lock --start x')], 'win32'),
    ).toMatchObject({ ok: false, reason: 'NON_INTERACTIVE' });
  });

  it('copie MSYS de Git Bash (même image, même ligne que le parent) → FORK_WRAPPER', () => {
    const line = '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" --login -i';
    expect(
      assessDeclaringShell([proc(20, 'bash', line, 10), proc(10, 'bash', line, 5)], 'win32'),
    ).toMatchObject({ ok: false, reason: 'FORK_WRAPPER' });
  });

  it('bash imbriqué volontairement sous Linux → accepté (pas d’émulation de fork)', () => {
    const line = 'bash';
    expect(
      assessDeclaringShell([proc(20, 'bash', line, 10), proc(10, 'bash', line, 5)], 'linux'),
    ).toMatchObject({ ok: true });
  });
});

describe('declaringShellName', () => {
  it('saute le shim non interactif (cmd /c striart.cmd) pour désigner le vrai shell', () => {
    const chain = [
      proc(30, 'cmd', 'C:\\Windows\\system32\\cmd.exe /d /s /c "striart.cmd lock --start x"', 20),
      proc(20, 'pwsh', 'pwsh.exe -NoLogo', 10),
      proc(10, 'windowsterminal', 'WindowsTerminal.exe'),
    ];
    expect(declaringShellName(chain)).toBe('pwsh');
  });

  it('retient un cmd interactif, et rend null sans shell interactif', () => {
    expect(declaringShellName([proc(5, 'cmd', 'cmd.exe')])).toBe('cmd');
    expect(declaringShellName([proc(5, 'node', 'node x.js')])).toBeNull();
    expect(declaringShellName([])).toBeNull();
  });
});

describe('pidHintForShell', () => {
  it('donne la variable propre à chaque shell', () => {
    expect(pidHintForShell('pwsh', 'win32')).toBe('$PID');
    expect(pidHintForShell('bash', 'win32')).toBe('$(cat /proc/$$/winpid)');
    expect(pidHintForShell('bash', 'linux')).toBe('$$');
    expect(pidHintForShell('fish', 'darwin')).toBe('$fish_pid');
    expect(pidHintForShell(null, 'linux')).toBe('$$');
  });
});

describe('checkProcessInstance (identité d’un PID publié)', () => {
  const NODE = String.raw`C:\Program Files\nodejs\node.exe`;
  const CLI = String.raw`C:\x\src\cli.js`;
  const OTHER = String.raw`C:\x\other.js`;
  const expected = { scriptName: 'cli.js', args: ['pty-host-run', 'agent-a'] };
  const check = (chain, alive = true) =>
    checkProcessInstance(4242, expected, {
      isAlive: () => alive,
      readChain: async () => chain,
      cache: false,
    });

  it('process mort → dead, sans même lire son identité', async () => {
    let read = false;
    const verdict = await checkProcessInstance(4242, expected, {
      isAlive: () => false,
      readChain: async () => {
        read = true;
        return [];
      },
      cache: false,
    });
    expect(verdict).toBe('dead');
    expect(read).toBe(false);
  });

  it('ligne de commande lisible et conforme → alive', async () => {
    expect(
      await check([proc(4242, 'node', `"${NODE}" ${CLI} pty-host-run agent-a --root C:/r`)]),
    ).toBe('alive');
  });

  // PID recyclé par l'OS : un autre process porte désormais ce numéro. Le
  // croire vivant gelait start/stop des daemons ; le tuer frapperait un
  // innocent.
  it('ligne de commande lisible mais étrangère → foreign', async () => {
    expect(await check([proc(4242, 'node', `"${NODE}" ${OTHER}`)])).toBe('foreign');
    expect(await check([proc(4242, 'node', `"${NODE}" ${CLI} pty-host-run agent-b`)])).toBe(
      'foreign',
    );
  });

  it('image étrangère sans ligne de commande lisible (autre utilisateur) → foreign', async () => {
    expect(await check([proc(4242, 'svchost', null)])).toBe('foreign');
  });

  it('image node sans ligne de commande lisible → unverified (on s’abstient)', async () => {
    expect(await check([proc(4242, 'node', null)])).toBe('unverified');
  });

  it('identité illisible → unverified', async () => {
    expect(await check([])).toBe('unverified');
  });

  it('verdict mis en cache par PID et identité attendue, jamais pour un process mort', async () => {
    let reads = 0;
    const deps = {
      isAlive: () => true,
      readChain: async () => {
        reads += 1;
        return [proc(9191, 'node', 'node cli.js pty-host-run agent-a')];
      },
      cache: true,
    };
    expect(await checkProcessInstance(9191, expected, deps)).toBe('alive');
    expect(await checkProcessInstance(9191, expected, deps)).toBe('alive');
    expect(reads).toBe(1);
    expect(await checkProcessInstance(9191, expected, { ...deps, isAlive: () => false })).toBe(
      'dead',
    );
  });

  // Le dashboard sonde en continu : un « alive » en cache ne doit jamais
  // resservir au process qui reçoit ensuite le numéro (sinon « Stop » le tue).
  it('mort constatée → le verdict en cache est oublié ; le PID recyclé est relu', async () => {
    const pid = 7373;
    const live = (commandLine) => ({
      isAlive: () => true,
      readChain: async () => [proc(pid, 'node', commandLine)],
      cache: true,
    });
    expect(
      await checkProcessInstance(pid, expected, live('node cli.js pty-host-run agent-a')),
    ).toBe('alive');
    expect(await checkProcessInstance(pid, expected, { ...live(''), isAlive: () => false })).toBe(
      'dead',
    );
    expect(await checkProcessInstance(pid, expected, live('node C:/x/other.js'))).toBe('foreign');
  });

  it('cache: false (décision destructive) relit toujours l’identité', async () => {
    const pid = 8484;
    const cached = {
      isAlive: () => true,
      readChain: async () => [proc(pid, 'node', 'node cli.js pty-host-run agent-a')],
      cache: true,
    };
    expect(await checkProcessInstance(pid, expected, cached)).toBe('alive');
    const fresh = {
      isAlive: () => true,
      readChain: async () => [proc(pid, 'code', 'code.exe')],
      cache: false,
    };
    expect(await checkProcessInstance(pid, expected, fresh)).toBe('foreign');
  });
});

describe('checkProcessInstance — heure de création contre startedAt publié', () => {
  const expected = (startedAt) => ({ scriptName: 'cli.js', args: ['watch'], startedAt });
  const withStart = (startTimeMs) => ({
    isAlive: () => true,
    readChain: async (pid) => [
      { pid, ppid: 1, name: 'node', commandLine: 'node C:/x/cli.js watch', startTimeMs },
    ],
    cache: false,
  });
  const published = '2026-10-24T10:00:00.000Z';
  const publishedMs = Date.parse(published);

  // Un autre `striart watch`, lancé APRÈS la mort du daemon publié, a la même
  // ligne de commande : seule l'heure de création le démasque.
  it('process créé après la publication (au-delà de la marge) → foreign', async () => {
    const recycled = publishedMs + IDENTITY_START_MARGIN_MS + 1;
    expect(await checkProcessInstance(3131, expected(published), withStart(recycled))).toBe(
      'foreign',
    );
  });

  it('créé avant la publication, ou dans la marge d’horloge → alive', async () => {
    expect(
      await checkProcessInstance(3131, expected(published), withStart(publishedMs - 200)),
    ).toBe('alive');
    expect(
      await checkProcessInstance(
        3131,
        expected(publishedMs),
        withStart(publishedMs + IDENTITY_START_MARGIN_MS),
      ),
    ).toBe('alive');
  });

  it('heure illisible ou startedAt absent : la ligne de commande seule décide', async () => {
    expect(await checkProcessInstance(3131, expected(published), withStart(null))).toBe('alive');
    expect(await checkProcessInstance(3131, expected(undefined), withStart(9e15))).toBe('alive');
    expect(await checkProcessInstance(3131, expected('pas une date'), withStart(9e15))).toBe(
      'alive',
    );
  });

  it('le cache distingue les publications (un nouveau PID file ne réutilise pas un verdict)', async () => {
    const deps = { ...withStart(publishedMs + 60_000), cache: true };
    expect(await checkProcessInstance(4141, expected(published), deps)).toBe('foreign');
    const later = new Date(publishedMs + 60_000).toISOString();
    expect(await checkProcessInstance(4141, expected(later), deps)).toBe('alive');
  });
});

describe('parseStartedAt / trimForeignAncestors', () => {
  it('ISO 8601 ou ms epoch ; sinon null', () => {
    expect(parseStartedAt('2026-10-24T10:00:00.000Z')).toBe(1792836000000);
    expect(parseStartedAt(1234)).toBe(1234);
    for (const bad of [null, undefined, '', 'x', 0, -5, Number.NaN]) {
      expect(parseStartedAt(bad)).toBeNull();
    }
  });

  it('coupe la chaîne au « parent » créé après son enfant (PID parent recyclé, Windows)', () => {
    const link = (pid, startTimeMs) => ({ ...proc(pid, 'pwsh', 'pwsh'), startTimeMs });
    expect(
      trimForeignAncestors([link(3, 300), link(2, 200), link(1, 100)]).map((p) => p.pid),
    ).toEqual([3, 2, 1]);
    expect(
      trimForeignAncestors([link(3, 300), link(2, 400), link(1, 100)]).map((p) => p.pid),
    ).toEqual([3]);
    expect(trimForeignAncestors([link(3, 300), link(2, null)]).map((p) => p.pid)).toEqual([3, 2]);
  });
});
