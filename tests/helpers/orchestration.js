import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';

/**
 * Outillage des tests d'intégration du lot O (modes d'orchestration) : des
 * profils d'agents scriptés (tests/helpers/fake-collab-agent.cjs), un Router
 * mocké, et un dossier d'état HORS des clones (compteurs, prompts reçus).
 */
export const FAKE_COLLAB_AGENT = fileURLToPath(new URL('./fake-collab-agent.cjs', import.meta.url));
export const GATE_OK = 'node -e "process.exit(0)"';
/** Gate rouge si un fichier du dépôt contient le marqueur BAD. */
export const GATE_NO_BAD =
  "node -e \"const fs=require('fs');const bad=fs.readdirSync('.').filter(f=>f.endsWith('.js')).some(f=>fs.readFileSync(f,'utf8').includes('BAD'));process.exit(bad?1:0)\"";

export async function createScriptDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-collab-script-'));
  return {
    dir,
    stampLog: path.join(dir, 'stamps.log'),
    /** Profil scripté : chaque invocation joue le tour suivant de `turns`. */
    profile(name, turns, extra = {}) {
      return {
        command: process.execPath,
        args: [FAKE_COLLAB_AGENT, '{{prompt}}'],
        env: {
          FAKE_COLLAB_SPEC: JSON.stringify({
            state: path.join(dir, `${name}.state.json`),
            promptLog: path.join(dir, `${name}.prompts.log`),
            stampLog: path.join(dir, 'stamps.log'),
            turns,
          }),
        },
        ...extra,
      };
    },
    async prompts(name) {
      return readFile(path.join(dir, `${name}.prompts.log`), 'utf8').catch(() => '');
    },
    async invocations(name) {
      const raw = await readFile(path.join(dir, `${name}.state.json`), 'utf8').catch(() => null);
      return raw === null ? 0 : JSON.parse(raw).n + 1;
    },
    async stamps() {
      return (await readFile(path.join(dir, 'stamps.log'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

export async function writeStriartConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

/**
 * Router mocké : fichiers prédits selon une aiguille du prompt. Défaut : UN
 * fichier propre à la tâche (dérivé du prompt) — une tâche isolée, que le
 * Router laisse tourner en parallèle. Une prédiction VIDE n'est plus « aucune
 * collision » : le Router la juge vague (`empty-prediction`, router-vague.ts) et
 * sérialise la tâche derrière tous les agents actifs — ce qui bloquerait un plan
 * `parallel` (et, derrière un clone gardé après échec, jusqu'au délai d'attente).
 */
const isolatedFile = (prompt) =>
  `src/isolated-${createHash('sha256').update(prompt).digest('hex').slice(0, 10)}.js`;

export function mockRouter(filesByNeedle = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.prompt ?? body.messages?.map((m) => m.content).join('\n') ?? '';
      const match = Object.entries(filesByNeedle).find(([needle]) => prompt.includes(needle));
      return {
        ok: true,
        json: async () => ({
          response: JSON.stringify({ files: match ? match[1] : [isolatedFile(prompt)] }),
        }),
      };
    }),
  );
}
