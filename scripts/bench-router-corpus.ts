#!/usr/bin/env node
/**
 * Corpus du banc réaliste du Router — `node scripts/bench-router-corpus.ts`.
 *
 * Le banc historique prenait le MESSAGE d'un commit comme tâche : il est écrit
 * après le travail et cite souvent les fichiers touchés (optimiste). Ici la
 * tâche est une demande NATURELLE et VAGUE, générée par un LLM à partir du diff
 * dont les chemins sont masqués, avec interdiction de citer chemin, fichier ou
 * symbole littéral ; une validation déterministe rejette (et fait régénérer)
 * toute tâche qui en contient quand même.
 *
 * Le résultat est versionné (`scripts/data/router-bench-tasks.json`) : on ne
 * repaie pas la génération, et le corpus est reproductible. Les commits sont
 * répartis une fois pour toutes en jeu de RÉGLAGE (~60 %) et jeu de TEST (~40 %)
 * par empreinte de leur SHA : on règle sur l'un, on rapporte sur l'autre.
 *
 * Réseau + ANTHROPIC_API_KEY (lue dans `.env`, jamais affichée). Opt-in.
 * Usage : node scripts/bench-router-corpus.ts [--model claude-haiku-5-5]
 *         [--max-files 20] [--regenerate] [--concurrency 4]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CORPUS_PATH = fileURLToPath(
  new URL('./data/router-bench-tasks.json', import.meta.url),
);

/** Version du prompt de génération : à incrémenter si GENERATION_PROMPT change. */
export const GENERATION_PROMPT_VERSION = 'vague-task-v1';

export const GENERATION_PROMPT = `Tu es un développeur qui s'apprête à commencer un travail. Voici les modifications qui ont été faites ensuite (le diff, noms de fichiers masqués).
Écris, en 1 à 2 phrases courtes en français, la demande TELLE QU'ON LA FORMULE AVANT d'écrire le code : l'intention et le comportement visé, pas la solution ni l'implémentation.
Reste vague et naturel, comme un vrai ticket (« ajouter une garde pour les dépôts vides lors d'un rollback », « rendre le message d'erreur plus clair quand le verrou est perdu »).
INTERDIT : chemins, noms ou extensions de fichiers ; noms de fonctions, classes, variables, constantes, codes d'erreur, options ou commandes (tout ce qui est en camelCase, snake_case, MAJUSCULES_AVEC_TIRET_BAS, kebab-case, entre backticks ou précédé de --) ; citations de code ; numéros de version.
Réponds UNIQUEMENT par la demande, sans guillemets ni préambule.`;

interface CorpusCase {
  sha: string;
  split: 'tune' | 'test';
  task: string;
}

interface Corpus {
  generatedAt: string;
  generator: { model: string; promptVersion: string };
  headAtGeneration: string;
  tuneShare: number;
  cases: CorpusCase[];
}

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const LOCKS = /(^|\/)(package-lock\.json|Cargo\.lock)$/;

/** Commits « de code » bornés : au moins un fichier src/tests/native/scripts, <= maxFiles fichiers. */
export function selectCommits(maxFiles: number): Array<{ sha: string; files: string[] }> {
  const out = git('log', '--no-merges', '--format=%x1e%H', '--name-only');
  const picked: Array<{ sha: string; files: string[] }> = [];
  for (const entry of out.split('\x1e').filter(Boolean)) {
    const [sha, ...rest] = entry.trim().split('\n');
    const files = rest.filter((f) => f && !LOCKS.test(f));
    if (!sha || files.length === 0 || files.length > maxFiles) continue;
    if (!files.some((f) => /^(src|tests|native|scripts)\//.test(f))) continue;
    try {
      git('rev-parse', '--verify', '--quiet', `${sha}^`);
    } catch {
      continue; // commit racine : pas de parent, pas d'arbre « avant »
    }
    picked.push({ sha, files });
  }
  return picked;
}

export function splitOf(sha: string, tuneShare = 0.6): 'tune' | 'test' {
  const h = createHash('sha256').update(sha).digest().readUInt32BE(0) / 0x1_0000_0000;
  return h < tuneShare ? 'tune' : 'test';
}

/** Diff sans noms de fichiers : seules les modifications, par bloc, plafonnées. */
function maskedDiff(sha: string): string {
  const raw = git(
    'show',
    '--format=',
    '--patch',
    '--no-color',
    '-U2',
    sha,
    '--',
    '.',
    ':!package-lock.json',
    ':!Cargo.lock',
  );
  const blocks = raw.split(/^diff --git .*$/m).filter((b) => b.trim());
  const parts: string[] = [];
  let total = 0;
  blocks.forEach((b, i) => {
    const body = b
      .split('\n')
      .filter(
        (l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(l),
      )
      .join('\n')
      .trim()
      .slice(0, 2600);
    if (total > 16_000) return;
    total += body.length;
    parts.push(`### fichier ${i + 1}\n${body}`);
  });
  return parts.join('\n\n');
}

/**
 * Motifs internes supplémentaires du mainteneur (noms de comptes, d'hôtes…) :
 * fournis par l'environnement, jamais écrits dans le dépôt.
 */
function internalPattern(): RegExp | null {
  const raw = process.env.STRIART_BENCH_INTERNAL_PATTERN;
  return raw ? new RegExp(raw, 'i') : null;
}

/** Raisons pour lesquelles une tâche cite un chemin ou un symbole (liste vide = acceptable). */
export function leakReasons(task: string, truthFiles: string[]): string[] {
  const reasons: string[] = [];
  if (/\bdiff\b/i.test(task)) reasons.push('méta-commentaire sur le diff');
  if (/\n\s*\n/.test(task) || task.length > 450) reasons.push('trop long / multi-paragraphe');
  if (!/[.?!)]$/.test(task)) reasons.push('phrase tronquée');
  if (/\.claude\//i.test(task) || internalPattern()?.test(task)) reasons.push('motif interne');
  if (/`/.test(task)) reasons.push('backticks');
  if (
    /\b[\w-]+\.(js|ts|tsx|jsx|md|json|rs|yml|yaml|toml|mjs|cjs|py|sh|css|html|d\.ts)\b/i.test(task)
  )
    reasons.push('nom de fichier');
  if (/[a-z0-9]+[A-Z][A-Za-z0-9]+/.test(task)) reasons.push('camelCase');
  if (/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/.test(task)) reasons.push('CONSTANTE');
  if (/\b[a-z0-9]+_[a-z0-9_]+\b/.test(task)) reasons.push('snake_case');
  if (/\b[a-z0-9]+-[a-z0-9]+-[a-z0-9-]+\b/.test(task)) reasons.push('kebab-case long');
  if (/(^|\s)--[a-z]/.test(task)) reasons.push('option --x');
  if (/\b(?:src|tests?|docs?|scripts|native|schemas|roadmap)\/[\w.-]+/i.test(task))
    reasons.push('chemin');
  const lower = task.toLowerCase();
  for (const f of truthFiles) {
    const stem = f
      .slice(f.lastIndexOf('/') + 1)
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
    if (stem.length >= 6 && stem.includes('-') && lower.includes(stem))
      reasons.push(`stem ${stem}`);
  }
  return reasons;
}

async function generate(
  apiKey: string,
  model: string,
  diff: string,
  extra: string,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'user', content: `${GENERATION_PROMPT}${extra}\n\nModifications :\n\n${diff}` },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === 'text')?.text ?? '';
  return text.trim().replace(/^["«]\s*|\s*["»]$/g, '');
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` ||
  process.argv[1]?.endsWith('bench-router-corpus.ts')
) {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'claude-haiku-5-5' },
      'max-files': { type: 'string', default: '20' },
      regenerate: { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '4' },
    },
  });
  try {
    const env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
    if (env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY)
      process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  } catch {
    // Pas de .env : la clé vient peut-être de l'environnement.
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY absente (.env ou environnement).');
    process.exit(2);
  }

  const previous: Corpus | null = existsSync(CORPUS_PATH)
    ? (JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus)
    : null;
  const known = new Map(previous?.cases.map((c) => [c.sha, c]) ?? []);
  const commits = selectCommits(Number(values['max-files']));
  console.error(`${commits.length} commits retenus.`);

  const cases: CorpusCase[] = [];
  let next = 0;
  let rejected = 0;
  const reasonStats = new Map<string, number>();
  await Promise.all(
    Array.from({ length: Number(values.concurrency) }, async () => {
      while (next < commits.length) {
        const c = commits[next++]!;
        const prior = known.get(c.sha);
        if (
          prior &&
          !values.regenerate &&
          previous?.generator.promptVersion === GENERATION_PROMPT_VERSION &&
          leakReasons(prior.task, c.files).length === 0
        ) {
          cases.push(prior);
          continue;
        }
        const diff = maskedDiff(c.sha);
        let task = '';
        let extra = '';
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            task = await generate(apiKey, values.model!, diff, extra);
          } catch (error) {
            console.error(`  ${c.sha.slice(0, 8)} échec appel : ${(error as Error).message}`);
            continue;
          }
          const reasons = leakReasons(task, c.files);
          if (reasons.length === 0 && task.length >= 15) break;
          rejected += 1;
          reasonStats.set(
            reasons.join('+') || 'courte',
            (reasonStats.get(reasons.join('+') || 'courte') ?? 0) + 1,
          );
          extra = `\n\nTa réponse précédente a été refusée (${reasons.join(', ') || 'trop courte'}). Reformule sans AUCUN identifiant technique.`;
          task = '';
        }
        if (!task) {
          console.error(`  ${c.sha.slice(0, 8)} abandonné (fuite persistante).`);
          continue;
        }
        cases.push({ sha: c.sha, split: splitOf(c.sha), task });
      }
    }),
  );
  console.error([...reasonStats.entries()].map(([k, v]) => `${k}=${v}`).join(' ; '));
  cases.sort((a, b) => (a.sha < b.sha ? -1 : 1));
  mkdirSync(dirname(CORPUS_PATH), { recursive: true });
  const corpus: Corpus = {
    generatedAt: new Date().toISOString(),
    generator: { model: values.model!, promptVersion: GENERATION_PROMPT_VERSION },
    headAtGeneration: git('rev-parse', 'HEAD').trim(),
    tuneShare: 0.6,
    cases,
  };
  writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  console.error(
    `${cases.length} cas (${cases.filter((c) => c.split === 'tune').length} réglage / ${cases.filter((c) => c.split === 'test').length} test), ${rejected} générations rejetées pour fuite.`,
  );
}
