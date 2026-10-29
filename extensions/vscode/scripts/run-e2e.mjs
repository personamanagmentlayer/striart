// Tests de bout en bout dans un VRAI VS Code (téléchargé par @vscode/test-electron).
//
// Deux passes, chacune avec un profil utilisateur neuf :
//  - « trusted »    : confiance désactivée → l'extension se connecte au vrai `striart api`
//                     d'un dépôt temporaire ; un .vscode/settings.json hostile du dépôt est ignoré ;
//  - « restricted » : espace NON approuvé → aucun process lancé.
// Variables : VSCODE_VERSION (défaut 1.96.0, le plancher du manifeste), STRIART_CLI.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';

const run = promisify(execFile);
const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const CLI = process.env.STRIART_CLI ?? path.resolve(extensionDir, '../../src/cli.js');
const version = process.env.VSCODE_VERSION ?? '1.96.0';

if (!existsSync(CLI)) throw new Error(`Striart CLI not found at ${CLI} (set STRIART_CLI)`);
if (!existsSync(path.join(extensionDir, 'dist', 'extension.cjs'))) throw new Error('Run "npm run build" first.');

const git = (cwd, ...args) => run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], { cwd });

async function makeFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-e2e-'));
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-qm', 'init');
  const env = { ...process.env, STRIART_LANG: 'en' };
  await run(process.execPath, [CLI, 'init'], { cwd: dir, env });
  await writeFile(path.join(dir, '.striartrc.json'), JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }));
  await run(process.execPath, [CLI, 'start', 'agent-a'], { cwd: dir, env });
  const clone = path.join(dir, '.striart', 'agents', 'agent-a');
  await writeFile(path.join(clone, 'feature.txt'), 'x\n');
  await git(clone, 'add', '.');
  await git(clone, 'commit', '-qm', 'feat: e2e');
  // Réglages HOSTILES posés par le dépôt : ils doivent être ignorés (scope machine + lecture utilisateur seule).
  await mkdir(path.join(dir, '.vscode'));
  const evil = path.join(dir, 'evil-striart.js');
  await writeFile(evil, "require('fs').writeFileSync(require('path').join(__dirname, 'PWNED'), 'x');\n");
  await writeFile(
    path.join(dir, '.vscode', 'settings.json'),
    JSON.stringify({ 'striart.binaryPath': evil, 'striart.nodePath': process.execPath }),
  );
  return dir;
}

async function pass(name, { trustEnabled, forceUntrusted = false }) {
  const workspace = await makeFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'striart-e2e-profile-'));
  const userData = path.join(root, 'user-data');
  await mkdir(path.join(userData, 'User'), { recursive: true });
  await writeFile(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'striart.binaryPath': CLI,
      'striart.nodePath': process.execPath,
      'security.workspace.trust.enabled': trustEnabled,
      'security.workspace.trust.startupPrompt': 'never',
      'security.workspace.trust.banner': 'never',
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'workbench.startupEditor': 'none',
      'extensions.autoUpdate': false,
    }),
  );
  console.log(`\n=== e2e: ${name} (VS Code ${version}) ===`);
  try {
    await runTests({
      version,
      extensionDevelopmentPath: extensionDir,
      extensionTestsPath: path.join(extensionDir, 'tests', 'e2e', 'runner.cjs'),
      extensionTestsEnv: {
        ...(forceUntrusted ? { STRIART_FORCE_UNTRUSTED: '1' } : {}),
        STRIART_E2E_SUITE: path.join(extensionDir, 'tests', 'e2e', `${name}.cjs`),
        STRIART_E2E_WORKSPACE: workspace,
      },
      launchArgs: [
        workspace,
        '--user-data-dir',
        userData,
        '--extensions-dir',
        path.join(root, 'extensions'),
        '--disable-extensions',
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
    if (existsSync(path.join(workspace, 'PWNED'))) throw new Error('the repository-controlled binary was executed');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
}

try {
  await pass('trusted', { trustEnabled: false });
  await pass('restricted', { trustEnabled: true, forceUntrusted: true });
  console.log('\ne2e: all passes OK');
} catch (error) {
  console.error('\ne2e FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
}
