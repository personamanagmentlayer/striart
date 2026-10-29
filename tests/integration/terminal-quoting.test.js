import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { quotePosix, quotePowerShell } from '../../src/terminal.ts';

// En intégration : ces tests lancent le VRAI interpréteur (PowerShell sous
// Windows, sh ailleurs) — seule preuve que la citation de terminal.js est
// fidèle, mais plusieurs secondes par lancement.
// Arguments hostiles : chacun casserait une interpolation naïve.
const HOSTILE = ["O'Brien", 'a b', '$HOME', '`whoami`', 'x;y', '’typo’', '$(id)', '%PATH%'];

describe('citation : restitution exacte par le vrai interpréteur', () => {
  const echoArgs = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

  it.runIf(process.platform === 'win32')(
    'PowerShell restitue chaque argument hostile à l’identique',
    async () => {
      const argv = [process.execPath, '-e', echoArgs, ...HOSTILE];
      const command = `& ${argv.map(quotePowerShell).join(' ')}`;
      const { stdout } = await execa('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
      ]);
      expect(JSON.parse(stdout)).toEqual(HOSTILE);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'sh restitue chaque argument hostile à l’identique',
    async () => {
      const argv = [process.execPath, '-e', echoArgs, ...HOSTILE, '"q"'];
      const { stdout } = await execa('sh', ['-c', argv.map(quotePosix).join(' ')]);
      expect(JSON.parse(stdout)).toEqual([...HOSTILE, '"q"']);
    },
  );
});
