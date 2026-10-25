/**
 * Détenteur de `main.lock` dans un AUTRE process, pour les tests du verrou
 * inter-processus (tests/integration/lock*.test.js).
 *
 *   node lock-holder.mjs <root> <holdMs> [label] [mode] [modeArg]
 *
 * Prend le verrou par le vrai `withMainLock`, écrit `ACQUIRED <label> <epochMs>`
 * puis `READY <pid>` sur stdout une fois DANS la section critique, et :
 *  - mode `hold` (défaut) : garde le verrou `holdMs` (event loop libre : il bat) ;
 *  - mode `freeze`        : FIGE tout le process `holdMs` (Atomics.wait — plus
 *                           aucun timer, donc plus aucun battement), puis sort ;
 *  - mode `until`         : `modeArg` = fichier de libération ; garde le verrou
 *                           tant que ce fichier n'existe pas (`holdMs` = plafond
 *                           de sécurité). Libération pilotée par le test et non
 *                           par une durée devinée : le démarrage d'un process
 *                           peut durer plusieurs secondes sous charge ;
 *  - mode `probe`         : `modeArg` = dossier témoin ; crée `<dossier>/<pid>`,
 *                           écrit `OVERLAP` si un autre témoin y est déjà,
 *                           garde `holdMs`, retire son témoin.
 */
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { withMainLock } from '../../src/lock.js';

const [root, holdMs = '10000', label = 'child-holder', mode = 'hold', modeArg = ''] =
  process.argv.slice(2);

await withMainLock(
  root,
  label,
  async () => {
    process.stdout.write(`ACQUIRED ${label} ${Date.now()}\n`);
    if (mode === 'probe') {
      await mkdir(modeArg, { recursive: true });
      const mine = path.join(modeArg, String(process.pid));
      await writeFile(mine, label, { flag: 'wx' });
      if ((await readdir(modeArg)).length > 1) process.stdout.write('OVERLAP\n');
      process.stdout.write(`READY ${process.pid}\n`);
      await sleep(Number(holdMs));
      await rm(mine, { force: true });
      return;
    }
    process.stdout.write(`READY ${process.pid}\n`);
    if (mode === 'freeze') {
      await sleep(200); // laisse partir READY (stdout asynchrone selon la plateforme)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
      return;
    }
    if (mode === 'until') {
      const ceiling = Date.now() + Number(holdMs);
      while (
        Date.now() < ceiling &&
        !(await access(modeArg).then(
          () => true,
          () => false,
        ))
      ) {
        await sleep(25);
      }
      return;
    }
    await sleep(Number(holdMs));
  },
  { timeoutMs: 60_000 },
);
