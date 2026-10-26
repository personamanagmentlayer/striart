/**
 * Faux agent SCRIPTÉ pour les tests du lot O (modes d'orchestration et
 * collaboration) : chaque invocation joue le tour suivant d'un script, ce qui
 * permet de simuler un relecteur qui refuse puis approuve, un auteur qui
 * corrige, une étape de pipeline qui laisse un artefact, etc.
 *
 * Volontairement en .cjs (exécuté depuis un clone temporaire sans
 * package.json, comme fake-agent.cjs).
 *
 * Piloté par FAKE_COLLAB_SPEC (JSON, posé dans `profile.env` par le test) :
 *  - state      : chemin ABSOLU (hors clone) du compteur d'invocations ;
 *  - promptLog  : chemin ABSOLU (hors clone) où chaque prompt reçu est ajouté ;
 *  - turns      : liste de tours ; l'invocation n joue turns[min(n, len-1)].
 *
 * Un tour :
 *  - write   : { "chemin": "contenu" } (dossiers créés ; `{{n}}` → n° d'invocation) ;
 *  - writeIfPrompt : { "aiguille": { "chemin": "contenu" } } — écrit seulement si
 *              le prompt contient l'aiguille (preuve que le briefing est arrivé) ;
 *  - commit  : true → `git add -A` + commit ;
 *  - verdict : objet imprimé dans un bloc ```striart-verdict``` sur stdout ;
 *  - handoff : texte imprimé dans un bloc ```striart-handoff-<jeton>``` sur stdout ;
 *  - outbox  : objet écrit tel quel dans .striart-outbox.json ;
 *  - stdout  : texte libre imprimé ;
 *  - sleepMs : attente avant de sortir (courses) ;
 *  - stamp   : étiquette ; « <étiquette>-start » puis « <étiquette>-end » sont
 *              ajoutés à spec.stampLog (chemin ABSOLU hors clone) — preuve
 *              d'exécution parallèle ou séquentielle ;
 *  - touch   : chemin ABSOLU (hors clone) créé au début du tour ;
 *  - waitFor : chemin ABSOLU attendu (60 s au plus, sinon sortie 7) avant de
 *              finir — avec `touch` chez un autre agent, preuve DÉTERMINISTE
 *              que les deux sessions tournent en même temps ;
 *  - exit    : code de sortie (défaut 0).
 */
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const spec = JSON.parse(process.env.FAKE_COLLAB_SPEC || '{}');
const prompt = process.argv[2] || '';

let n = 0;
if (spec.state) {
  try {
    n = JSON.parse(readFileSync(spec.state, 'utf8')).n + 1;
  } catch {
    n = 0;
  }
  writeFileSync(spec.state, JSON.stringify({ n }));
}
if (spec.promptLog) appendFileSync(spec.promptLog, `\n=== invocation ${n} ===\n${prompt}\n`);

const turns = spec.turns ?? [{}];
const turn = turns[Math.min(n, turns.length - 1)] ?? {};
// Plusieurs sessions partagent un clone (mode team) : un verrou d'index tenu un instant
// par un autre git (l'orchestrateur, un autre rôle) ne doit pas tuer le faux agent.
// Toute autre erreur, ou un verrou durable, reste fatale — et sa trace est consignée.
const git = (args) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return execFileSync('git', args, { stdio: 'pipe' });
    } catch (error) {
      const text = String(error.stderr ?? error.message);
      if (attempt < 20 && /\.lock/.test(text)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      if (spec.stampLog)
        appendFileSync(
          spec.stampLog,
          `${turn.stamp ?? 'agent'}-git-error:${text.trim()}
`,
        );
      throw error;
    }
  }
};

const stamp = (phase) => {
  if (turn.stamp && spec.stampLog) appendFileSync(spec.stampLog, `${turn.stamp}-${phase}\n`);
};
stamp('start');
if (turn.touch) writeFileSync(turn.touch, String(n));

const writeAll = (files) => {
  for (const [file, content] of Object.entries(files ?? {})) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, String(content).replaceAll('{{n}}', String(n)));
  }
};

writeAll(turn.write);
for (const [needle, files] of Object.entries(turn.writeIfPrompt ?? {})) {
  if (prompt.includes(needle)) writeAll(files);
}
if (turn.outbox) writeFileSync('.striart-outbox.json', JSON.stringify(turn.outbox));
if (turn.commit) {
  git(['add', '-A']);
  git([
    '-c',
    'user.email=agent@striart.test',
    '-c',
    'user.name=Fake Collab Agent',
    'commit',
    '-m',
    `feat: tour ${n} du faux agent`,
  ]);
}
if (turn.stdout) console.log(turn.stdout);
if (turn.verdict) {
  // Le jeton du tour figure dans la balise demandée par le briefing.
  const token = /striart-verdict-([0-9a-f]{32})/.exec(prompt)?.[1];
  const tag = token ? `striart-verdict-${token}` : 'striart-verdict';
  console.log(`\`\`\`${tag}\n${JSON.stringify(turn.verdict)}\n\`\`\``);
}
if (turn.handoff) {
  // Même mécanique que le verdict : la balise porte le jeton du tour donné par le briefing.
  const handoffToken = /striart-handoff-([0-9a-f]{32})/.exec(prompt)?.[1];
  const handoffTag = handoffToken ? `striart-handoff-${handoffToken}` : 'striart-handoff';
  console.log(`\`\`\`${handoffTag}\n${turn.handoff}\n\`\`\``);
}

const finish = () => {
  stamp('end');
  process.exit(turn.exit ?? 0);
};
if (turn.waitFor) {
  const { existsSync } = require('node:fs');
  const deadline = Date.now() + 60_000;
  const poll = () => {
    if (existsSync(turn.waitFor)) return finish();
    if (Date.now() > deadline) process.exit(7);
    setTimeout(poll, 100);
  };
  poll();
} else if (turn.sleepMs) setTimeout(finish, turn.sleepMs);
else finish();
