/**
 * Conscience des workspaces monorepo (npm/yarn : champ `workspaces` du
 * package.json racine).
 *
 * Les verrous Striart sont par fichier et fonctionnent déjà cross-package.
 * Ce module ajoute le signal que le graphe d'imports ne voit pas : les
 * dépendances INTER-PACKAGES passent par des bare specifiers
 * (`@acme/auth`), invisibles pour la résolution relative. Quand deux agents
 * travaillent dans deux packages liés par une dépendance déclarée, on
 * avertit — jamais on ne bloque : deux packages indépendants du même
 * monorepo doivent pouvoir avancer en parallèle sans aucun bruit.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeFilePath } from './router.js';
import { logger } from './logger.js';

/**
 * @typedef {{name: string, dir: string, dependencies: Set<string>}} WorkspacePackage
 */

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Étend un motif de workspace npm ('packages/*', 'apps/web') en dossiers
 * existants. Seul le `*` final est supporté — la forme standard ; les motifs
 * exotiques sont ignorés (signal advisory, pas de sur-ingénierie).
 */
async function expandWorkspacePattern(root, pattern) {
  const normalized = normalizeFilePath(pattern).replace(/\/$/, '');
  if (!normalized.endsWith('/*')) {
    const dir = path.join(root, normalized);
    return (await stat(dir).catch(() => null))?.isDirectory() ? [normalized] : [];
  }
  const parent = normalized.slice(0, -2);
  const entries = await readdir(path.join(root, parent), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => `${parent}/${e.name}`);
}

async function loadNpmWorkspaces(root) {
  const rootPkg = await readJsonFile(path.join(root, 'package.json'));
  const patterns = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : rootPkg?.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) return [];

  const packages = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    for (const dir of await expandWorkspacePattern(root, pattern)) {
      const pkg = await readJsonFile(path.join(root, dir, 'package.json'));
      if (!pkg?.name) continue;
      packages.push({
        name: pkg.name,
        dir,
        dependencies: new Set([
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
          ...Object.keys(pkg.peerDependencies ?? {}),
        ]),
      });
    }
  }
  return packages;
}

async function readTextFile(filePath) {
  return readFile(filePath, 'utf8').catch(() => null);
}

/**
 * Workspace Cargo : `[workspace] members` du Cargo.toml racine, puis nom
 * (`[package] name`) et clés des sections `[*dependencies*]` de chaque
 * membre. Parse TOML par expressions régulières, ASSUMÉ approximatif : le
 * signal est advisory, une dépendance manquée ne coûte qu'un avertissement —
 * ajouter un parseur TOML pour ça serait disproportionné.
 */
async function loadCargoWorkspaces(root) {
  const rootToml = await readTextFile(path.join(root, 'Cargo.toml'));
  if (!rootToml) return [];
  const membersMatch = rootToml.match(/\[workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/s);
  if (!membersMatch) return [];
  const patterns = [...membersMatch[1].matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]);

  const packages = [];
  for (const pattern of patterns) {
    for (const dir of await expandWorkspacePattern(root, pattern)) {
      const toml = await readTextFile(path.join(root, dir, 'Cargo.toml'));
      const name = toml?.match(/\[package\][^[]*?name\s*=\s*["']([^"'\n]+)["']/s)?.[1];
      if (!name) continue;
      const dependencies = new Set();
      // Clés des sections [dependencies]/[dev-dependencies]/[build-dependencies]
      // (et leurs variantes [dependencies.foo]).
      for (const section of toml.matchAll(/\[(?:dev-|build-)?dependencies\]([^[]*)/g)) {
        for (const dep of section[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*[=.]/gm)) {
          dependencies.add(dep[1]);
        }
      }
      for (const dep of toml.matchAll(/\[(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)\]/g)) {
        dependencies.add(dep[1]);
      }
      packages.push({ name, dir, dependencies });
    }
  }
  return packages;
}

/**
 * Modules Go : les répertoires `use` d'un go.work, nommés par la directive
 * `module` de leur go.mod ; dépendances = modules requis (`require`) ou
 * remplacés (`replace`) — c'est par `replace` que les modules d'un même
 * repo se référencent le plus souvent.
 */
async function loadGoWorkspaces(root) {
  const goWork = await readTextFile(path.join(root, 'go.work'));
  if (!goWork) return [];
  const dirs = [
    ...[...goWork.matchAll(/^\s*use\s+\(([^)]*)\)/gms)].flatMap((m) =>
      [...m[1].matchAll(/^\s*(\S+)\s*$/gm)].map((u) => u[1]),
    ),
    ...[...goWork.matchAll(/^\s*use\s+([^\s(]+)\s*$/gm)].map((m) => m[1]),
  ];

  const packages = [];
  for (const rawDir of dirs) {
    const dir = normalizeFilePath(rawDir.replace(/^\.\//, ''));
    if (!dir || dir === '.') continue;
    const goMod = await readTextFile(path.join(root, dir, 'go.mod'));
    const name = goMod?.match(/^module\s+(\S+)/m)?.[1];
    if (!name) continue;
    const dependencies = new Set([
      ...[...goMod.matchAll(/^\s*require\s+\(([^)]*)\)/gms)].flatMap((m) =>
        [...m[1].matchAll(/^\s*(\S+)\s+v\S+/gm)].map((r) => r[1]),
      ),
      ...[...goMod.matchAll(/^require\s+(\S+)\s+v\S+/gm)].map((m) => m[1]),
      ...[...goMod.matchAll(/^replace\s+(\S+)\s*=>/gm)].map((m) => m[1]),
    ]);
    packages.push({ name, dir, dependencies });
  }
  return packages;
}

/**
 * Modules Maven : `<modules>` du pom.xml racine, artifactId de chaque module,
 * dépendances = artifactId des blocs `<dependency>`. Parse XML par regex,
 * même politique d'approximation assumée que Cargo.
 */
async function loadMavenModules(root) {
  const rootPom = await readTextFile(path.join(root, 'pom.xml'));
  if (!rootPom) return [];
  const modulesBlock = rootPom.match(/<modules>([\s\S]*?)<\/modules>/)?.[1];
  if (!modulesBlock) return [];
  const dirs = [...modulesBlock.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1].trim());

  const packages = [];
  for (const rawDir of dirs) {
    const dir = normalizeFilePath(rawDir);
    const pom = await readTextFile(path.join(root, dir, 'pom.xml'));
    if (!pom) continue;
    // Le premier artifactId hors bloc <parent> est celui du module.
    const withoutParent = pom.replace(/<parent>[\s\S]*?<\/parent>/, '');
    const name = withoutParent.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    if (!name) continue;
    const dependencies = new Set(
      [
        ...pom.matchAll(
          /<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g,
        ),
      ].map((m) => m[1].trim()),
    );
    packages.push({ name, dir, dependencies });
  }
  return packages;
}

/**
 * Charge les packages du monorepo, tous écosystèmes confondus : npm/yarn
 * (`workspaces` du package.json), Cargo (`[workspace] members`), Go
 * (`go.work`), Maven (`<modules>`). Même forme pour tous — l'aval
 * (fileToPackage, detectWorkspaceLinks) ne connaît pas l'écosystème.
 * Repo sans workspaces → [] (toutes les fonctions en aval sont no-op).
 * @param {string} root
 * @returns {Promise<WorkspacePackage[]>}
 */
export async function loadWorkspaces(root) {
  return [
    ...(await loadNpmWorkspaces(root)),
    ...(await loadCargoWorkspaces(root)),
    ...(await loadGoWorkspaces(root)),
    ...(await loadMavenModules(root)),
  ];
}

/**
 * Package auquel appartient un fichier (préfixe de dossier le plus long),
 * ou null (fichier à la racine ou hors workspace).
 * @param {WorkspacePackage[]} workspaces @param {string} file
 */
export function fileToPackage(workspaces, file) {
  const normalized = normalizeFilePath(file);
  let best = null;
  for (const pkg of workspaces) {
    if (normalized.startsWith(`${pkg.dir}/`) && (!best || pkg.dir.length > best.dir.length)) {
      best = pkg;
    }
  }
  return best;
}

/**
 * Liens inter-packages entre la tâche entrante et chaque agent actif :
 * mon package dépend du sien, ou l'inverse. Même package → rien (les
 * verrous fichier et le Merger couvrent déjà) ; packages non liés → rien.
 * @param {{workspaces: WorkspacePackage[], predictedFiles: string[], agents: Array<{name: string, predictedFiles?: string[]}>}} params
 * @returns {import('./types.js').WorkspaceWarning[]}
 */
export function detectWorkspaceLinks({ workspaces, predictedFiles, agents }) {
  if (workspaces.length === 0) return [];
  const minePackages = new Map();
  for (const file of predictedFiles) {
    const pkg = fileToPackage(workspaces, file);
    if (pkg) minePackages.set(pkg.name, pkg);
  }
  if (minePackages.size === 0) return [];

  const warnings = [];
  for (const agent of agents) {
    const links = [];
    const seen = new Set();
    for (const theirFile of agent.predictedFiles ?? []) {
      const theirPkg = fileToPackage(workspaces, theirFile);
      if (!theirPkg) continue;
      for (const minePkg of minePackages.values()) {
        if (minePkg.name === theirPkg.name) continue;
        const key = `${minePkg.name}→${theirPkg.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (minePkg.dependencies.has(theirPkg.name)) {
          links.push({ mine: minePkg.name, theirs: theirPkg.name, direction: 'depends-on' });
        } else if (theirPkg.dependencies.has(minePkg.name)) {
          links.push({ mine: minePkg.name, theirs: theirPkg.name, direction: 'dependency-of' });
        }
      }
    }
    if (links.length > 0) warnings.push({ agent: agent.name, links });
  }
  return warnings;
}

/**
 * Calcule les avertissements workspace pour une tâche — best effort :
 * un monorepo malformé ne doit jamais empêcher un start.
 * @param {{root: string, predictedFiles: string[], agents: Array<{name: string, predictedFiles?: string[]}>}} params
 * @returns {Promise<import('./types.js').WorkspaceWarning[]>}
 */
export async function computeWorkspaceWarnings({ root, predictedFiles, agents }) {
  try {
    const workspaces = await loadWorkspaces(root);
    return detectWorkspaceLinks({ workspaces, predictedFiles, agents });
  } catch (error) {
    logger.warn({ err: error }, 'Analyse des workspaces impossible (avertissements ignorés)');
    return [];
  }
}
