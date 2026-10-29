// Bout en bout : une demande `gateEnv` du DÉPÔT n'est honorée que si la config
// UTILISATEUR (`gate.envAllow`, hors dépôt) l'autorise ; sinon elle est écartée
// et annoncée en tête du journal du gate.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTestGate } from '../../src/gate.ts';

const NODE = JSON.stringify(process.execPath);
const PROBE = `${NODE} -e ${JSON.stringify(
  "console.log('REGION=' + (process.env.MYAPP_REGION === undefined ? 'absent' : process.env.MYAPP_REGION))",
)}`;

let home;
let previous;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'striart-gate-user-'));
  previous = process.env.STRIART_CONFIG_HOME;
  process.env.STRIART_CONFIG_HOME = home;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.STRIART_CONFIG_HOME;
  else process.env.STRIART_CONFIG_HOME = previous;
  await rm(home, { recursive: true, force: true });
});

const gate = (gateEnv) =>
  runTestGate({
    cwd: process.cwd(),
    testCommand: PROBE,
    container: 'process',
    baseEnv: { ...process.env, MYAPP_REGION: 'eu-west' },
    gateEnv,
  });

describe('gateEnv (dépôt) plafonné par gate.envAllow (utilisateur)', () => {
  it('config utilisateur absente : la demande du dépôt est refusée et annoncée', async () => {
    const r = await gate(['MYAPP_*']);
    expect(r.success).toBe(true);
    expect(r.log).toContain('REGION=absent');
    expect(r.log).toMatch(/^\[Striart\] gateEnv : .*MYAPP_\*/);
  });

  it('config utilisateur qui l’autorise : la variable est transmise, rien n’est annoncé', async () => {
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ gate: { envAllow: ['MYAPP_*'] } }),
    );
    const r = await gate(['MYAPP_*']);
    expect(r.log).toContain('REGION=eu-west');
    expect(r.log).not.toContain('[Striart] gateEnv');
  });

  it('config utilisateur qui autorise autre chose : demande refusée', async () => {
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ gate: { envAllow: ['OTHER_*'] } }),
    );
    const r = await gate(['MYAPP_*']);
    expect(r.log).toContain('REGION=absent');
    expect(r.log).toContain('MYAPP_*');
  });

  it('config utilisateur invalide (fail closed) : rien n’est transmis', async () => {
    await writeFile(path.join(home, 'config.json'), '{ not json');
    const r = await gate(['MYAPP_*']);
    expect(r.log).toContain('REGION=absent');
  });
});
