/**
 * Faux agent de coding pour les tests du mode autonome.
 *
 * Volontairement en .cjs : il est exécuté depuis un clone temporaire qui n'a
 * pas forcément de package.json, donc aucune ambiguïté ESM/CJS possible.
 *
 * Comportement piloté par FAKE_AGENT_MODE :
 *  - commit (défaut) : écrit un fichier, le commite, sort en 0.
 *  - dirty           : commite, PUIS laisse un fichier non commité derrière lui.
 *  - noop            : sort en 0 sans rien produire.
 *  - fail            : sort en 3.
 *  - hang            : ne sort jamais (test du délai).
 */
const { writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

const mode = process.env.FAKE_AGENT_MODE || 'commit';
const prompt = process.argv[2] || '(sans prompt)';

// Sonde d'environnement (tests de profil) : si cette variable est présente,
// le faux agent écrit sa valeur — c'est ainsi qu'un test vérifie qu'un
// `profile.env` a bien atteint le process enfant. Inerte sinon.
if (process.env.STRIART_PROFILE_ENV_PROBE) {
  writeFileSync('profile-env-probe.txt', process.env.STRIART_PROFILE_ENV_PROBE);
}

if (mode === 'fail') process.exit(3);
if (mode === 'noop') process.exit(0);
if (mode === 'hang') {
  setInterval(() => {}, 1000);
  return;
}

const git = (args) => execFileSync('git', args, { stdio: 'pipe' });

writeFileSync('feature.js', `// ${prompt}\nexport const feature = 1;\n`);
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

if (mode === 'dirty') {
  // Travail EN COURS non commité : le nettoyage autonome doit refuser de
  // supprimer ce clone, sinon il détruirait du travail que personne n'a vu.
  writeFileSync('brouillon.js', '// travail en cours, non commité\n');
}

console.log(`fake-agent: mode=${mode} prompt=${prompt}`);
