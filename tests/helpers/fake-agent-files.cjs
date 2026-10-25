/**
 * Faux agent « à fichiers » pour les tests du contrat de commit et de la
 * garde des chemins protégés : il écrit, indexe, supprime ou committe ce que
 * le test lui demande, puis sort en 0.
 *
 * Piloté par FAKE_AGENT_SPEC (JSON) :
 *  - write   : { "chemin": "contenu" } — fichiers écrits (dossiers créés) ;
 *  - remove  : ["chemin"] — fichiers supprimés du worktree ;
 *  - stage   : ["chemin"] — `git add` sans commit (l'agent indexe puis s'arrête) ;
 *  - exclude : ["motif"] — ajoutés à .git/info/exclude (simule l'injection de
 *              consignes par Striart, lot I4) ;
 *  - commit  : true — `git add -A` + commit par l'agent ;
 *  - checkout: "branche" — l'agent quitte sa branche de tâche (`switch -c`) ;
 *  - after   : { "chemin": "contenu" } — écrits APRÈS le commit, laissés non committés.
 */
const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const spec = JSON.parse(process.env.FAKE_AGENT_SPEC || '{}');
const git = (args) => execFileSync('git', args, { stdio: 'pipe' });

for (const [file, content] of Object.entries(spec.write ?? {})) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
for (const file of spec.remove ?? []) rmSync(file, { force: true });
if (spec.exclude?.length) {
  appendFileSync(path.join('.git', 'info', 'exclude'), `\n${spec.exclude.join('\n')}\n`);
}
if (spec.checkout) git(['switch', '-c', spec.checkout]);
if (spec.stage?.length) git(['add', '--', ...spec.stage]);
if (spec.commit) {
  git(['add', '-A']);
  git([
    '-c',
    'user.email=agent@striart.test',
    '-c',
    'user.name=Fake Agent',
    'commit',
    '-m',
    'feat: travail du faux agent',
  ]);
}
for (const [file, content] of Object.entries(spec.after ?? {})) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log('fake-agent-files: done');
