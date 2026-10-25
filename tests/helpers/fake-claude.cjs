/**
 * Faux Claude Code headless : se comporte comme `claude -p` depuis 2.1.302,
 * qui démarre en mode Manual — sans `--permission-mode acceptEdits` les
 * éditions sont refusées, sans règle `Bash(git commit *)` le commit aussi.
 * Il EXIGE donc les drapeaux du preset corrigé ; un profil `-p {{prompt}}`
 * seul échoue (exit 1, « permission denied »), exactement comme l'outil réel.
 *
 * Vérifie aussi le canal des consignes : `--append-system-prompt-file <f>`
 * doit désigner un fichier HORS du clone qui contient les règles Striart.
 * Émet un flux stream-json minimal (system/init, assistant, result).
 * Lancé par `node fake-claude.cjs <args du preset…>`.
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const deny = (why) => {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: why });
  process.exit(1);
};

emit({ type: 'system', subtype: 'init', model: 'fake-claude' });
if (valueOf('--permission-mode') !== 'acceptEdits') deny('permission denied: Edit (Manual mode)');
const allowed = valueOf('--allowedTools') ?? '';
if (!allowed.split(',').includes('Bash(git commit *)')) deny('permission denied: Bash(git commit)');
if (!args.includes('--bare')) deny('repository hooks would run: --bare missing');

const rulesFile = valueOf('--append-system-prompt-file');
if (!rulesFile || !existsSync(rulesFile)) deny('instructions file missing');
if (path.resolve(rulesFile).startsWith(path.resolve(process.cwd())))
  deny('instructions inside clone');
const rules = readFileSync(rulesFile, 'utf8');
if (!rules.includes('Striart session rules')) deny('instructions without Striart rules');

const prompt = args[args.indexOf('-p') + 1];
writeFileSync('feature.js', `// ${prompt}\nexport const feature = 1;\n`);
const git = (a) => execFileSync('git', a, { stdio: 'pipe' });
git(['add', '-A']);
git([
  '-c',
  'user.email=agent@striart.test',
  '-c',
  'user.name=Fake Claude',
  'commit',
  '-m',
  'feat: fake',
]);
emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'feature.js écrit' }] } });
emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done' });
