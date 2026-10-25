import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { findRepoRoot } from './clone.js';
import { agentsDir, striartDir } from './paths.js';

const CONFIG_TEMPLATE = `export default {
  testCommand: 'npm test',      // Test Gate : 'yarn test', 'make test', 'pytest'...
  targetBranch: 'main',         // branche où merger (staging si mainBranch est défini)
  autoPush: false,              // l'humain valide le push par défaut
  // agentCommand: 'claude',    // commande de ton agent de coding (cursor, aider, ...)

  // LLM du Router et du Merger — Ollama local par défaut :
  ollamaModel: 'llama3.1:8b',
  ollamaHost: 'http://localhost:11434',
  // Ou n'importe quel provider cloud / endpoint compatible OpenAI :
  // llm: { provider: 'openai', model: 'gpt-4o-mini' },                                  // clé via OPENAI_API_KEY
  // llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },                 // clé via ANTHROPIC_API_KEY
  // llm: { provider: 'openai', model: 'llama-3.1-70b', baseUrl: 'http://localhost:1234/v1' }, // LM Studio, vLLM, ...
  // La clé API n'est JAMAIS écrite ici : seulement le nom de la variable d'env (apiKeyEnv).

  // Pipeline staging → main (striart promote) :
  // mainBranch: 'main', promoteTestCommand: 'npm run test:integration',

  // Projets volumineux :
  // cloneFilter: 'blob:none', // clone partiel (gros historiques)
  // pruneDays: 14,            // rétention de striart prune
  // webhookUrl: null,         // notifications Slack/Discord
};
`;

async function writeIfAbsent(filePath, content) {
  try {
    await writeFile(filePath, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

async function ensureGitignore(root) {
  const gitignorePath = path.join(root, '.gitignore');
  let current = '';
  try {
    current = await readFile(gitignorePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes('.striart/') || lines.includes('.striart')) return false;
  const suffix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFile(gitignorePath, `${current}${suffix}.striart/\n`, 'utf8');
  return true;
}

/**
 * striart init :
 *  - crée .striart/{agents,conflicts,logs} + queue.json, locks.json, agents.json
 *  - ajoute .striart/ au .gitignore du repo
 *  - génère striart.config.mjs si absent, puis valide la config
 * Idempotent. Aucun diagnostic ici : c'est le rôle de `runDoctor`
 * (doctor.js), source unique — la CLI l'enchaîne après l'initialisation.
 *
 * `created` liste des identifiants stables (contrat `--json`) :
 * 'queue.json' | 'locks.json' | 'agents.json' | 'striart.config.mjs' | '.gitignore'.
 * @param {string} [cwd]
 * @returns {Promise<{root: string, configPath: string|null, created: string[], alreadyInitialized: boolean}>}
 */
export async function initStriart(cwd = process.cwd()) {
  const root = await findRepoRoot(cwd);
  const base = striartDir(root);
  const alreadyInitialized = Boolean(await stat(base).catch(() => null));

  await mkdir(agentsDir(root), { recursive: true });
  await mkdir(path.join(base, 'conflicts'), { recursive: true });
  await mkdir(path.join(base, 'logs'), { recursive: true });

  const created = [];
  if (await writeIfAbsent(path.join(base, 'queue.json'), '[]\n')) created.push('queue.json');
  if (await writeIfAbsent(path.join(base, 'locks.json'), '{}\n')) created.push('locks.json');
  if (await writeIfAbsent(path.join(base, 'agents.json'), '{}\n')) created.push('agents.json');
  // .mjs : ESM explicite, fonctionne même si le repo cible est en CommonJS.
  // cosmiconfig accepte aussi striart.config.js / .striartrc.* si l'utilisateur préfère.
  const hasConfig = await loadConfig(root)
    .then((c) => c.configPath !== null)
    .catch(() => true);
  if (!hasConfig && (await writeIfAbsent(path.join(root, 'striart.config.mjs'), CONFIG_TEMPLATE))) {
    created.push('striart.config.mjs');
  }
  if (await ensureGitignore(root)) created.push('.gitignore');

  // Validation : une config invalide fait échouer init (CONFIG_INVALID).
  const config = await loadConfig(root);
  return { root, configPath: config.configPath ?? null, created, alreadyInitialized };
}
