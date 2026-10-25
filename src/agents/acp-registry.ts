import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from '../errors.js';
import { logger } from '../logger.js';
import { striartDir } from '../paths.js';
import type { AcpRegistryConfig, AgentProfile } from '../types.js';
import { isForbiddenRegistryEnvName } from './profile-schema.ts';

/**
 * Import d'un agent du registre ACP (`striart profiles --import-acp <id>`,
 * décision D8).
 *
 * Par défaut : MÉTADONNÉES SEULES. Striart lit le registre (JSON, https) et
 * en dérive un profil ACP épinglé à la version publiée — il ne télécharge
 * jamais de binaire. Une distribution npx/uvx est épinglée par son
 * spécificateur exact (c'est l'outil npx/uvx de l'utilisateur qui la
 * résoudra au lancement, avec ses propres contrôles d'intégrité) ; une
 * distribution binaire est décrite (archive, empreinte) pour une
 * installation par l'utilisateur.
 *
 * `acpRegistry.allowBinaryDownload: true` (décision explicite, journalisée)
 * autorise le téléchargement de l'archive binaire de la plateforme
 * courante, refusé sans empreinte sha256 publiée, vérifié contre elle, puis
 * extrait sous `.striart/acp-agents/<id>/<version>/` — aucun lien
 * symbolique ni chemin sortant toléré.
 */

/** Plafond d'un document de registre (un registre n'est pas un binaire). */
const REGISTRY_MAX_BYTES = 5 * 1024 * 1024;
/** Plafond d'une archive téléchargée. */
const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Identifiant d'agent du registre : sert de nom de dossier et de clé de profil. */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface AcpNpxDistribution {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AcpBinaryTarget {
  archive: string;
  cmd: string;
  args?: string[];
  sha256?: string;
  env?: Record<string, string>;
}

export interface AcpRegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  distribution: {
    npx?: AcpNpxDistribution;
    uvx?: AcpNpxDistribution;
    binary?: Record<string, AcpBinaryTarget>;
  };
}

export interface AcpImportResult {
  id: string;
  name: string;
  version: string;
  /** Clé de profil suggérée (l'id du registre). */
  profileKey: string;
  /** Profil prêt à coller dans `agentProfiles`. */
  profile: AgentProfile;
  distribution: 'npx' | 'uvx' | 'binary';
  /** Ce qu'il reste à faire à l'utilisateur, en clair. */
  installation: {
    /** Téléchargement fait par Striart (allowBinaryDownload). */
    downloaded: boolean;
    /** Archive à installer soi-même (binaire, métadonnées seules). */
    archive: string | null;
    sha256: string | null;
    /** Dossier d'extraction (téléchargement fait). */
    path: string | null;
    /** npx/uvx résoudront le paquet épinglé au premier lancement. */
    resolvedAtLaunchBy: 'npx' | 'uvx' | null;
  };
  repository: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStringMap = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every((x) => typeof x === 'string');

function registryError(reason: string, extra: Record<string, unknown> = {}): StriartError {
  return new StriartError(`Registre ACP invalide (${reason}).`, {
    code: 'ACP_REGISTRY_INVALID',
    hint: 'striart doctor',
    details: { reason, ...extra },
  });
}

/** Valide la forme d'un agent du registre (ce que l'import consomme, rien de plus). */
function parseAgent(raw: unknown): AcpRegistryAgent | null {
  if (!isObject(raw)) return null;
  const { id, name, version, distribution } = raw;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof version !== 'string')
    return null;
  // La version devient un SEGMENT DE CHEMIN (acpAgentDir) puis la cible d'un
  // `rm -rf` : une entrée dont la version n'est pas un segment sûr est ignorée.
  if (!SAFE_VERSION_RE.test(version)) return null;
  if (!isObject(distribution)) return null;
  const dist: AcpRegistryAgent['distribution'] = {};
  for (const kind of ['npx', 'uvx'] as const) {
    const d = distribution[kind];
    if (d === undefined) continue;
    if (!isObject(d) || typeof d.package !== 'string') return null;
    if (d.args !== undefined && !isStringArray(d.args)) return null;
    if (d.env !== undefined && !isStringMap(d.env)) return null;
    dist[kind] = {
      package: d.package,
      args: d.args as string[] | undefined,
      env: d.env as Record<string, string> | undefined,
    };
  }
  if (distribution.binary !== undefined) {
    if (!isObject(distribution.binary)) return null;
    const targets: Record<string, AcpBinaryTarget> = {};
    for (const [platform, t] of Object.entries(distribution.binary)) {
      if (!isObject(t) || typeof t.archive !== 'string' || typeof t.cmd !== 'string') return null;
      if (t.args !== undefined && !isStringArray(t.args)) return null;
      if (t.env !== undefined && !isStringMap(t.env)) return null;
      if (t.sha256 !== undefined && typeof t.sha256 !== 'string') return null;
      targets[platform] = {
        archive: t.archive,
        cmd: t.cmd,
        args: t.args as string[] | undefined,
        sha256: t.sha256 as string | undefined,
        env: t.env as Record<string, string> | undefined,
      };
    }
    dist.binary = targets;
  }
  return {
    id,
    name,
    version,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    repository: typeof raw.repository === 'string' ? raw.repository : undefined,
    distribution: dist,
  };
}

/** Lit et valide un document de registre déjà téléchargé. */
export function parseRegistry(document: unknown): AcpRegistryAgent[] {
  if (!isObject(document) || !Array.isArray(document.agents)) throw registryError('NO_AGENTS');
  const agents: AcpRegistryAgent[] = [];
  for (const raw of document.agents) {
    const agent = parseAgent(raw);
    // Une entrée mal formée n'invalide pas tout le registre : elle est
    // ignorée (et ne pourra pas être importée — l'id resterait inconnu).
    if (agent) agents.push(agent);
  }
  return agents;
}

/** Télécharge le registre (https, borné en taille et en temps). */
export async function fetchRegistry(
  settings: AcpRegistryConfig,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<AcpRegistryAgent[]> {
  if (!/^https:\/\//.test(settings.url)) throw registryError('URL_NOT_HTTPS');
  let response: Response;
  try {
    response = await fetchImpl(settings.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new StriartError(`Registre ACP injoignable : ${(error as Error).message}`, {
      code: 'ACP_REGISTRY_FETCH_FAILED',
      hint: 'striart profiles --import-acp <id>',
      details: { cause: (error as Error).message },
    });
  }
  if (!response.ok) {
    throw new StriartError(`Registre ACP : réponse HTTP ${response.status}.`, {
      code: 'ACP_REGISTRY_FETCH_FAILED',
      hint: 'striart profiles --import-acp <id>',
      details: { status: response.status },
    });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > REGISTRY_MAX_BYTES) throw registryError('TOO_LARGE');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw registryError('NOT_JSON');
  }
  return parseRegistry(document);
}

/** Clé de plateforme du registre pour l'hôte courant. */
export function registryPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform;
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null;
  if (!cpu || !['windows', 'darwin', 'linux'].includes(os)) return null;
  return `${os}-${cpu}`;
}

/**
 * Le spécificateur npx/uvx épingle-t-il une version EXACTE ? `pkg@1.2.3`,
 * `@scope/pkg@1.2.3`, `pkg==1.2.3` ; refus de `latest`, des plages et de
 * l'absence de version (le registre « latest » bougerait sous le profil).
 */
export function isPinnedPackage(spec: string): boolean {
  return NPM_PINNED_RE.test(spec) || PYPI_PINNED_RE.test(spec);
}

const EXACT_VERSION = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
/**
 * `[@scope/]nom@x.y.z` : nom npm (minuscules, jamais en tête `-`, ni `/` hors
 * scope, ni `:` `=` espace) — la forme entière est ancrée, donc une option
 * (`--registry=http://x@1.2.3`) ou une URL ne passe pas pour un paquet.
 */
const NPM_PINNED_RE = new RegExp(
  String.raw`^(?:@[a-z0-9~][a-z0-9._~-]*/)?[a-z0-9~][a-z0-9._~-]*@${EXACT_VERSION}$`,
);
/** `nom==x.y.z` (PyPI) ou `nom@x.y.z` (uvx) : nom commençant par un alphanumérique. */
const PYPI_PINNED_RE = new RegExp(String.raw`^[A-Za-z0-9][A-Za-z0-9._-]*(?:==|@)${EXACT_VERSION}$`);

/** Segment de chemin sûr pour une version : alphanumérique en tête, jamais `..` ni séparateur. */
const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/** Construit le profil d'un agent du registre — métadonnées seules. */
export function profileFromRegistryAgent(
  agent: AcpRegistryAgent,
  {
    platform = registryPlatformKey(),
    allowEnv = [],
  }: { platform?: string | null; allowEnv?: readonly string[] } = {},
): Omit<AcpImportResult, 'installation'> & { installation: AcpImportResult['installation'] } {
  if (!AGENT_ID_RE.test(agent.id)) throw registryError('AGENT_ID_INVALID', { id: agent.id });
  if (!SAFE_VERSION_RE.test(agent.version)) {
    throw registryError('VERSION_INVALID', { id: agent.id });
  }
  const base = {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    profileKey: agent.id,
    repository: agent.repository ?? null,
  };
  const acpProfile = (command: string, args: string[], env?: Record<string, string>) => {
    // Env fourni par le registre = injection potentielle (NODE_OPTIONS, PATH…) :
    // refusé sauf nom listé dans acpRegistry.allowEnv, et jamais pour une
    // variable d'interpréteur/chargeur.
    for (const name of Object.keys(env ?? {})) {
      if (isForbiddenRegistryEnvName(name) || !allowEnv.includes(name)) {
        throw new StriartError(
          `L'agent ACP "${agent.id}" demande la variable d'environnement ${name} : import refusé.`,
          {
            code: 'ACP_IMPORT_ENV_FORBIDDEN',
            hint: 'acpRegistry.allowEnv (config) — jamais pour NODE_OPTIONS, PATH, LD_*…',
            details: { id: agent.id, variable: name },
          },
        );
      }
    }
    const profile: AgentProfile = {
      command,
      args,
      acp: true,
      writeMode: 'workspace',
      commitPolicy: 'agent-then-striart',
      structuredOutput: 'none',
      instructions: { channel: 'acp-prompt' },
    };
    if (env && Object.keys(env).length > 0) profile.env = { ...env };
    return profile;
  };
  for (const kind of ['npx', 'uvx'] as const) {
    const d = agent.distribution[kind];
    if (!d) continue;
    if (!isPinnedPackage(d.package)) {
      throw new StriartError(
        `L'agent ACP "${agent.id}" n'épingle pas de version exacte (${d.package}) : import refusé.`,
        {
          code: 'ACP_IMPORT_UNPINNED',
          hint: `striart profiles --import-acp ${agent.id}`,
          details: { id: agent.id, distribution: kind },
        },
      );
    }
    const args =
      kind === 'npx' ? ['-y', d.package, ...(d.args ?? [])] : [d.package, ...(d.args ?? [])];
    return {
      ...base,
      distribution: kind,
      profile: acpProfile(kind, args, d.env),
      installation: {
        downloaded: false,
        archive: null,
        sha256: null,
        path: null,
        resolvedAtLaunchBy: kind,
      },
    };
  }
  const targets = agent.distribution.binary;
  const target = platform && targets ? targets[platform] : undefined;
  if (!target) {
    throw new StriartError(
      `L'agent ACP "${agent.id}" ne publie pas de distribution pour cette plateforme (${platform ?? 'inconnue'}).`,
      {
        code: 'ACP_IMPORT_PLATFORM_UNSUPPORTED',
        hint: 'striart profiles --import-acp <id>',
        details: { id: agent.id, platform, available: Object.keys(targets ?? {}) },
      },
    );
  }
  // Métadonnées seules : l'utilisateur installe l'archive et met le binaire
  // dans son PATH ; le profil vise le NOM du binaire, jamais un chemin
  // fourni par le registre.
  const binaryName = path.posix.basename(target.cmd.replaceAll('\\', '/'));
  return {
    ...base,
    distribution: 'binary',
    profile: acpProfile(binaryName, [...(target.args ?? [])], target.env),
    installation: {
      downloaded: false,
      archive: target.archive,
      sha256: target.sha256 ?? null,
      path: null,
      resolvedAtLaunchBy: null,
    },
  };
}

/** Dossier d'installation d'un agent téléchargé. */
export function acpAgentDir(root: string, id: string, version: string): string {
  if (!AGENT_ID_RE.test(id) || !SAFE_VERSION_RE.test(version)) {
    throw registryError('PATH_SEGMENT_INVALID', { id });
  }
  const base = path.join(striartDir(root), 'acp-agents');
  const dir = path.join(base, id, version);
  // Défense en profondeur : même validé, le résultat reste sous `acp-agents/`.
  const relative = path.relative(base, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw registryError('PATH_SEGMENT_INVALID', { id });
  }
  return dir;
}

function unsafeArchive(reason: string, id: string): StriartError {
  return new StriartError(`Archive ACP refusée : ${reason}.`, {
    code: 'ACP_EXTRACT_UNSAFE',
    hint: 'striart profiles --import-acp <id>',
    details: { id },
  });
}

/**
 * Listing détaillé (`tar -tvf`) : seules les entrées « fichier » (`-`) et
 * « dossier » (`d`) passent. Liens symboliques (`l`), liens durs (`h`),
 * périphériques, FIFO : refus avant extraction. (bsdtar et GNU tar placent le
 * type en 1re colonne du listing.)
 */
export function assertSafeListing(listing: string, id: string): void {
  for (const line of listing.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (!'-d'.includes(line[0])) throw unsafeArchive('lien ou entrée spéciale dans l’archive', id);
  }
}

/** Noms d'entrées : ni absolu, ni lecteur Windows, ni segment `..`. */
export function assertSafeNames(names: string, id: string): void {
  for (const raw of names.split(/\r?\n/)) {
    const name = raw.replaceAll('\\', '/');
    if (name.length === 0) continue;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      throw unsafeArchive('chemin absolu ou sortant', id);
    }
  }
}

/** Aucun lien ni chemin sortant dans une extraction (fail closed). */
async function assertSafeTree(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(entry.parentPath ?? dir, entry.name);
    const info = await lstat(full);
    const relative = path.relative(dir, full);
    // nlink > 1 sur un fichier : lien dur (vers l'extérieur ou entre entrées).
    const hardLinked = info.isFile() && info.nlink > 1;
    if (
      info.isSymbolicLink() ||
      hardLinked ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new StriartError('Archive ACP refusée : lien symbolique ou chemin hors du dossier.', {
        code: 'ACP_EXTRACT_UNSAFE',
        hint: 'striart profiles --import-acp <id>',
        details: { path: relative },
      });
    }
  }
}

/**
 * Télécharge, vérifie (sha256 publié OBLIGATOIRE) et extrait la
 * distribution binaire de la plateforme courante. Appelé seulement quand
 * `acpRegistry.allowBinaryDownload` est vrai.
 */
export async function downloadBinaryAgent({
  root,
  agent,
  result,
  platform = registryPlatformKey(),
  fetchImpl = fetch,
}: {
  root: string;
  agent: AcpRegistryAgent;
  result: AcpImportResult;
  platform?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<AcpImportResult> {
  const target = platform ? agent.distribution.binary?.[platform] : undefined;
  if (!target) return result;
  const expected = target.sha256?.toLowerCase() ?? null;
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new StriartError(
      `L'agent ACP "${agent.id}" ne publie pas d'empreinte sha256 : téléchargement refusé (intégrité invérifiable).`,
      {
        code: 'ACP_IMPORT_NO_INTEGRITY',
        hint: 'striart profiles --import-acp <id>',
        details: { id: agent.id, platform },
      },
    );
  }
  if (!/^https:\/\//.test(target.archive))
    throw registryError('ARCHIVE_NOT_HTTPS', { id: agent.id });
  // Validé AVANT tout accès réseau ou disque : id/version = segments de chemin.
  const dest = acpAgentDir(root, agent.id, agent.version);
  const cmd = target.cmd.replaceAll('\\', '/');
  if (cmd.startsWith('/') || cmd.split('/').includes('..')) {
    throw registryError('CMD_UNSAFE', { id: agent.id });
  }
  logger.warn(
    { id: agent.id, version: agent.version, archive: target.archive, sha256: expected },
    'Import ACP : téléchargement d’une distribution binaire (acpRegistry.allowBinaryDownload)',
  );
  let response: Response;
  try {
    response = await fetchImpl(target.archive, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new StriartError(
      `Téléchargement de l'agent ACP impossible : ${(error as Error).message}`,
      {
        code: 'ACP_REGISTRY_FETCH_FAILED',
        hint: 'striart profiles --import-acp <id>',
        details: { id: agent.id, cause: (error as Error).message },
      },
    );
  }
  if (!response.ok) {
    throw new StriartError(`Téléchargement de l'agent ACP : réponse HTTP ${response.status}.`, {
      code: 'ACP_REGISTRY_FETCH_FAILED',
      hint: 'striart profiles --import-acp <id>',
      details: { id: agent.id, status: response.status },
    });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > ARCHIVE_MAX_BYTES) throw registryError('ARCHIVE_TOO_LARGE', { id: agent.id });
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new StriartError(
      `Empreinte de l'archive de "${agent.id}" différente de celle du registre : téléchargement rejeté.`,
      {
        code: 'ACP_DOWNLOAD_INTEGRITY_MISMATCH',
        hint: 'striart profiles --import-acp <id>',
        details: { id: agent.id, expected, actual },
      },
    );
  }

  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const archiveName = (
    path.posix.basename(new URL(target.archive).pathname).replace(/[^A-Za-z0-9._-]/g, '_') ||
    'archive'
  ).replace(/^\.+/, '_');
  const archiveFile = `${agent.version}-${archiveName}`;
  const archivePath = path.join(path.dirname(dest), archiveFile);
  await writeFile(archivePath, bytes);
  try {
    // `tar` (bsdtar sous Windows/macOS, GNU tar sous Linux) : argv,
    // shell: false. L'archive est désignée par un nom RELATIF (cwd = son
    // dossier) : GNU tar lit `C:\…` comme « hôte C: » et échoue sous Windows.
    // Le contenu est LISTÉ avant extraction (liens, périphériques et chemins
    // sortants refusés d'emblée — un lien dur n'est pas détectable après
    // coup), puis l'arbre extrait est revérifié.
    const isTarball = /\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar|zip)$/i.test(archiveName);
    if (isTarball) {
      const tarOptions = {
        shell: false,
        reject: false,
        timeout: DOWNLOAD_TIMEOUT_MS,
        cwd: path.dirname(dest),
      } as const;
      const listing = await execa('tar', ['-tvf', archiveFile], tarOptions);
      if (listing.exitCode !== 0) {
        throw new StriartError(`Lecture de l'archive ACP impossible : ${listing.shortMessage}`, {
          code: 'ACP_EXTRACT_FAILED',
          hint: 'tar --version',
          details: { id: agent.id },
        });
      }
      assertSafeListing(String(listing.stdout), agent.id);
      const names = await execa('tar', ['-tf', archiveFile], tarOptions);
      assertSafeNames(String(names.stdout), agent.id);
      // -C relatif au cwd aussi : les chemins absolus Windows (C:…) déroutent GNU tar/MSYS.
      const extracted = await execa('tar', ['-xf', archiveFile, '-C', agent.version], tarOptions);
      if (extracted.exitCode !== 0) {
        throw new StriartError(
          `Extraction de l'archive ACP impossible : ${extracted.shortMessage}`,
          {
            code: 'ACP_EXTRACT_FAILED',
            hint: 'tar --version',
            details: { id: agent.id },
          },
        );
      }
    } else {
      // Binaire nu : l'archive EST l'exécutable désigné par `cmd`.
      const exe = path.join(dest, ...cmd.split('/'));
      await mkdir(path.dirname(exe), { recursive: true });
      await writeFile(exe, bytes, { mode: 0o755 });
    }
    await assertSafeTree(dest);
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
  }
  const executable = path.join(dest, ...cmd.split('/'));
  const info = await lstat(executable).catch(() => null);
  if (!info?.isFile()) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw registryError('CMD_MISSING_IN_ARCHIVE', { id: agent.id });
  }
  return {
    ...result,
    profile: { ...result.profile, command: executable },
    installation: { ...result.installation, downloaded: true, path: dest, sha256: expected },
  };
}

/** Import complet : registre → agent → profil (→ téléchargement si autorisé). */
export async function importAcpAgent({
  root,
  id,
  settings,
  fetchImpl = fetch,
  platform = registryPlatformKey(),
}: {
  root: string;
  id: string;
  settings: AcpRegistryConfig;
  fetchImpl?: typeof fetch;
  platform?: string | null;
}): Promise<AcpImportResult> {
  if (!AGENT_ID_RE.test(id)) {
    throw new StriartError(`Identifiant d'agent ACP invalide : "${id}".`, {
      code: 'ACP_AGENT_UNKNOWN',
      hint: 'striart profiles --import-acp <id>',
      details: { id },
    });
  }
  const agents = await fetchRegistry(settings, { fetchImpl });
  const agent = agents.find((a) => a.id === id);
  if (!agent) {
    throw new StriartError(`Agent ACP inconnu du registre : "${id}".`, {
      code: 'ACP_AGENT_UNKNOWN',
      hint: 'striart profiles --import-acp <id>',
      details: { id, known: agents.map((a) => a.id).sort() },
    });
  }
  const result = profileFromRegistryAgent(agent, { platform, allowEnv: settings.allowEnv ?? [] });
  if (result.distribution !== 'binary' || !settings.allowBinaryDownload) return result;
  return downloadBinaryAgent({ root, agent, result, platform, fetchImpl });
}
