#!/usr/bin/env node
// Construction de l'archive npm PUBLIABLE de Striart — sans la publier.
//
// Usage : node scripts/pack.ts [--out-dir <dossier>] [--dry-run] [--json]
//                              [--allow-dirty] [--keep-staging]
//         (ou : npm run pack:release -- <options>)
//
// Pourquoi ce script existe : Node refuse délibérément le type stripping des
// fichiers situés sous node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING,
// aucun flag ne lève ce refus). Un `npm pack` brut du dépôt publie les .ts de
// src/ tels quels : le paquet installé ne démarre pas. Le développement reste
// sans build (Node exécute src/*.ts directement) ; seule la publication émet
// du JavaScript, fichier par fichier, par pur effacement des types
// (tsconfig.pack.json).
//
// Déroulé :
//   1. sélection des fichiers SUIVIS par git (`git ls-files`) couverts par
//      `files` du package.json — un fichier non suivi ne peut jamais fuiter
//      dans l'archive ; refus si le périmètre a des modifications non
//      commitées (sauf --allow-dirty, réservé aux vérifications locales) ;
//   2. copie dans un staging HORS du dépôt (dossier temporaire) ;
//   3. émission JS de src/ (tsc du paquet `typescript`, réécriture
//      `./x.ts` → `./x.js`), puis contrôle qu'aucun spécificateur relatif
//      `.ts` ne subsiste ;
//   4. package.json de staging (scripts et devDependencies retirés, bin
//      inchangé) ; `npm pack` dans le staging, contrôle de la liste publiée ;
//   5. SBOM CycloneDX des dépendances de production à côté du .tgz.
//
// La publication reste un acte humain : `npm publish <chemin du .tgz>`
// (procédure dans CONTRIBUTING.md). Données sur stdout (chemin du .tgz, ou
// JSON avec --json), diagnostics sur stderr. Sorties : 0 succès, 1 échec,
// 2 usage.

import { execFile } from 'node:child_process';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
  NATIVE_MANIFEST_FILE,
  NATIVE_MANIFEST_SCHEMA,
  NATIVE_PLATFORMS,
  NATIVE_PROTOCOL_VERSION,
  NATIVE_SIGNATURE_FILE,
  locateNativeBinary,
  nativePlatform,
  parseNativeManifest,
  resolveNativeBinary,
} from '../src/native.ts';
import type { NativeManifest, NativePlatform } from '../src/native.ts';
import {
  DEFAULT_SIGNATURE_SCHEME,
  getSignatureScheme,
  publicKeyPath,
  signatureSchemeNames,
} from '../src/native-signature.ts';
import type { SigningSecret } from '../src/native-signature.ts';
import {
  binaryFileName,
  checksumFileName,
  detectBinaryTarget,
  parseCargoLock,
  parseChecksumLine,
  platformPackageManifest,
} from './native-artifacts.ts';
import type { CargoLockPackage } from './native-artifacts.ts';

const execFileAsync = promisify(execFile);

/** Variables d'environnement (CI) portant la clé privée de signature. */
export const SIGNING_KEY_ENV = 'STRIART_NATIVE_SIGNING_KEY';
export const SIGNING_PASSWORD_ENV = 'STRIART_NATIVE_SIGNING_KEY_PASSWORD';

/**
 * Erreur du script de publication. Volontairement distincte de
 * `StriartError` (src/errors.js) : les codes `PACK_*` décrivent l'outillage
 * du mainteneur, pas le produit — ils n'entrent ni dans le contrat `--json`/MCP
 * ni dans la doc de dépannage utilisateur, et le script ne doit pas dépendre
 * de l'évolution du contrat d'erreur du CLI. Même forme : `code` stable,
 * `hint` = prochaine commande, `usage` = sortie 2.
 */
export class PackError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly hint: string | null;
  readonly usage: boolean;

  constructor(
    message: string,
    {
      code,
      details = {},
      hint = null,
      usage = false,
    }: { code: string; details?: Record<string, unknown>; hint?: string | null; usage?: boolean },
  ) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    this.details = details;
    this.hint = hint;
    this.usage = usage;
  }
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Dossier de sortie par défaut (gitignoré). */
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'dist');

/** Racine du code exécuté : seul dossier émis par tsc. */
const CODE_ROOT = 'src/';

/**
 * Fichiers suivis hors `files` qui participent à l'archive : .npmignore est
 * relu par npm dans le staging (défense en profondeur, en plus de `files`).
 */
const EXTRA_STAGED = ['.npmignore'];

/**
 * Fichiers dont une modification non commitée change l'archive produite — le
 * contrôle de propreté les couvre en plus des entrées de `files`.
 */
const BUILD_INPUTS = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.pack.json',
  // Les crates de Cargo.lock entrent dans le SBOM des binaires natifs.
  'native/Cargo.lock',
];

const USAGE = `Usage : node scripts/pack.ts [options]   (ou npm run pack:release -- [options])

Construit l'archive npm publiable (JS émis depuis src/) sans la publier.

Options :
  --out-dir <dossier>  dossier de sortie du .tgz et du SBOM (défaut : dist/)
  --dry-run            construit le staging et liste le contenu, sans .tgz
  --json               sortie machine sur stdout
  --allow-dirty        accepte des modifications non commitées dans le
                       périmètre publié (vérification locale — jamais pour
                       une release)
  --keep-staging       conserve le dossier de staging (inspection du JS émis)
  --native-dir <dossier>
                       binaires natifs construits (requis) : <clé>/striart-native[.exe]
                       et son .sha256, déposés par npm run native:stage
  --native-platforms <clé,…>
                       restreint les plateformes déclarées (défaut : les six) —
                       vérification locale, jamais pour une release
  --signing-scheme <nom>
                       schéma de signature du manifeste (défaut : ${DEFAULT_SIGNATURE_SCHEME})
  --ephemeral-signing-key
                       signe avec une clé JETABLE embarquée dans l'archive
                       (CI sans secret, vérification locale). EXIGE --dry-run
                       (PACK_EPHEMERAL_REQUIRES_DRY_RUN) : aucune archive
                       installable ne sort jamais signée d'une clé jetable.
                       Le manifeste est en plus marqué « ephemeral » (refusé
                       à l'exécution)
  --signing-public-key <fichier>
                       clé publique de l'archive à la place de
                       native/keys/<schéma>.pub — organisation qui signe avec
                       SA clé. Le keyId est à déclarer côté utilisateur
                       (native.trustedKeyIds de la config utilisateur)
  -h, --help           cette aide

Signature : la clé privée est lue dans ${SIGNING_KEY_ENV} (et
${SIGNING_PASSWORD_ENV} si elle est chiffrée) ; la clé publique est
native/keys/<schéma>.pub du dépôt. Au chargement, le keyId signataire doit
figurer parmi les clés de confiance (épinglées dans le code ; voir
src/native.ts) : une release signée d'une autre clé échoue ici, à l'auto-contrôle.

Exemples :
  npm run native:build && npm run native:stage
  npm run pack:release -- --native-dir dist/native
  npm run pack:release -- --native-dir dist/native --dry-run --native-platforms win32-x64 --ephemeral-signing-key
Puis, pour publier (acte manuel), les paquets de plateforme d'abord :
  npm publish dist/jumsay-striart-native-<plateforme>-<version>.tgz   (×6)
  npm publish dist/jumsay-striart-<version>.tgz`;

// ── Fonctions pures (testées en unitaire) ────────────────────────────────

export interface PackPlan {
  /** Fichiers copiés tels quels dans l'archive. */
  copy: string[];
  /** Fichiers source de src/ émis en JS par tsc (.js et .ts). */
  compile: string[];
  /** Fichiers suivis délibérément non publiés, avec leur motif. */
  dropped: { file: string; reason: string }[];
}

/** Vrai si `file` est couvert par une entrée de `files` (dossier « x/ » ou fichier exact). */
export function isCoveredByFilesEntry(file: string, entries: readonly string[]): boolean {
  const globbed = entries.filter((e) => /[*?[\]{}!]/.test(e));
  if (globbed.length > 0) {
    // Un motif glob que ce sélecteur ne sait pas évaluer ferait disparaître
    // des fichiers de l'archive en silence : refus explicite.
    throw new PackError(
      `Entrées "files" à motif glob non prises en charge : ${globbed.join(', ')}.`,
      {
        code: 'PACK_UNSUPPORTED_FILES_ENTRY',
        details: { entries: globbed },
        hint: 'Lister des dossiers (« src/ ») ou des fichiers exacts dans "files" (package.json).',
      },
    );
  }
  return entries.some((raw) => {
    const entry = raw.replace(/^\.\//, '');
    if (entry.endsWith('/')) return file.startsWith(entry);
    return file === entry || file.startsWith(`${entry}/`);
  });
}

/**
 * Chemin publié d'un fichier source émis : `src/x.ts` → `src/x.js`.
 * Les `.js` gardent leur nom (ils sont réémis pour réécrire leurs imports `.ts`).
 */
export function emittedPath(file: string): string {
  return file.endsWith('.ts') ? `${file.slice(0, -'.ts'.length)}.js` : file;
}

/**
 * Répartit les fichiers suivis par git entre copie, émission et exclusion.
 * Fail closed : toute forme TypeScript que le paquet ne saurait pas exécuter
 * (`.ts` hors src/, `.tsx`/`.mts`/`.cts`, collision `x.js`/`x.ts`) est refusée.
 */
export function planPackFiles(
  tracked: readonly string[],
  filesEntries: readonly string[],
): PackPlan {
  const plan: PackPlan = { copy: [], compile: [], dropped: [] };
  const unsupported: string[] = [];
  for (const file of [...tracked].sort()) {
    const covered = isCoveredByFilesEntry(file, filesEntries);
    if (!covered && !EXTRA_STAGED.includes(file)) continue;
    if (/\.(tsx|mts|cts)$/.test(file)) {
      unsupported.push(file);
      continue;
    }
    if (file.endsWith('.d.ts')) {
      // Déclarations pures : servent au typecheck du dépôt, jamais exécutées,
      // et le paquet n'expose pas de types (pas de champ "types").
      plan.dropped.push({ file, reason: 'déclarations de types (typecheck du dépôt uniquement)' });
      continue;
    }
    if (file.startsWith(CODE_ROOT) && /\.(js|mjs|cjs|ts)$/.test(file)) {
      plan.compile.push(file);
      continue;
    }
    if (file.endsWith('.ts')) {
      unsupported.push(file); // .ts hors src/ : inexécutable une fois installé
      continue;
    }
    plan.copy.push(file);
  }
  if (unsupported.length > 0) {
    throw new PackError(
      `Fichiers TypeScript non publiables (hors ${CODE_ROOT} ou extension non émise) : ${unsupported.join(', ')}.`,
      {
        code: 'PACK_UNSUPPORTED_FILE',
        details: { files: unsupported },
        hint: `Déplacer le code exécuté sous ${CODE_ROOT} en .ts/.js, ou le retirer de "files" (package.json).`,
      },
    );
  }
  const seen = new Map<string, string>();
  for (const file of plan.compile) {
    const out = emittedPath(file);
    const other = seen.get(out);
    if (other) {
      throw new PackError(`${other} et ${file} produiraient tous deux ${out}.`, {
        code: 'PACK_OUTPUT_COLLISION',
        details: { files: [other, file], output: out },
        hint: 'Supprimer ou renommer l’un des deux fichiers.',
      });
    }
    seen.set(out, file);
  }
  return plan;
}

/**
 * package.json du staging : identique au manifeste du dépôt, moins ce qui n'a
 * aucun sens pour un paquet installé (scripts de dev, devDependencies). `bin`,
 * `files`, `engines`, `publishConfig` sont conservés tels quels. `gitHead`
 * n'est renseigné que pour un arbre propre : sur un arbre modifié il mentirait
 * sur la provenance.
 */
export function buildStagedManifest(
  manifest: Record<string, unknown>,
  { gitHead }: { gitHead: string | null },
): Record<string, unknown> {
  const staged: Record<string, unknown> = structuredClone(manifest);
  delete staged.scripts;
  delete staged.devDependencies;
  // `private: true` est la garde du DÉPÔT (npm refuse de publier depuis
  // lui, même avec --ignore-scripts qui désarme prepublishOnly) ; l'archive
  // vérifiée, elle, est faite pour être publiée.
  delete staged.private;
  if (gitHead) staged.gitHead = gitHead;
  else delete staged.gitHead;
  return staged;
}

/** Entrée de l'index git d'un fichier suivi. */
export interface IndexEntry {
  /** Mode git : 100644, 100755, 120000 (lien symbolique), 160000 (sous-module). */
  mode: string;
  /** Objet blob — le contenu publié pour un arbre propre. */
  object: string;
  /** Marqué skip-worktree ou assume-unchanged : invisible à `git status`. */
  hidden: boolean;
}

/**
 * Croise `git ls-files -z -s` (mode, objet) et `git ls-files -z -v`
 * (marqueurs : minuscule = assume-unchanged, `S` = skip-worktree).
 */
export function parseLsFilesIndex(stageOutput: string, tagOutput: string): Map<string, IndexEntry> {
  const hidden = new Set<string>();
  for (const record of tagOutput.split('\0')) {
    if (!record) continue;
    const tag = record[0] ?? '';
    const file = record.slice(2);
    // `S`/`s` : skip-worktree ; toute lettre minuscule : assume-unchanged.
    if (tag === 'S' || /^[a-z]$/.test(tag)) hidden.add(file);
  }
  const index = new Map<string, IndexEntry>();
  for (const record of stageOutput.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode = '', object = ''] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    index.set(file, { mode, object, hidden: hidden.has(file) });
  }
  return index;
}

/**
 * Fail closed sur ce qui ferait mentir la provenance de l'archive :
 *  - lien symbolique / sous-module : le contenu copié serait celui d'une
 *    cible hors du suivi git ;
 *  - skip-worktree / assume-unchanged : une modification locale échappe à
 *    `git status`, donc au contrôle PACK_DIRTY_TREE, alors que `gitHead`
 *    attesterait le commit.
 */
export function assertPublishableIndex(
  index: ReadonlyMap<string, IndexEntry>,
  files: readonly string[],
): void {
  const missing = files.filter((file) => !index.has(file));
  if (missing.length > 0) {
    throw new PackError(`Fichiers planifiés absents de l'index git : ${missing.join(', ')}.`, {
      code: 'PACK_NOT_IN_INDEX',
      details: { files: missing },
    });
  }
  const special = files.filter((file) => !/^100(644|755)$/.test(index.get(file)?.mode ?? ''));
  if (special.length > 0) {
    throw new PackError(
      `Liens symboliques ou sous-modules dans le périmètre publié : ${special.join(', ')}.`,
      {
        code: 'PACK_UNSUPPORTED_MODE',
        details: { files: special },
        hint: 'Remplacer le lien par le fichier réel, ou le retirer de "files" (package.json).',
      },
    );
  }
  const hidden = files.filter((file) => index.get(file)?.hidden);
  if (hidden.length > 0) {
    throw new PackError(
      `Fichiers marqués skip-worktree/assume-unchanged dans le périmètre publié : ${hidden.join(', ')}.`,
      {
        code: 'PACK_HIDDEN_CHANGES',
        details: { files: hidden },
        hint: 'git update-index --no-skip-worktree --no-assume-unchanged <fichier>, vérifier git status, puis relancer.',
      },
    );
  }
}

/** Cibles `bin` d'un manifeste, normalisées sans `./` initial. */
export function binTargets(manifest: Record<string, unknown>): string[] {
  const bin = manifest.bin;
  const raw =
    typeof bin === 'string'
      ? [bin]
      : bin && typeof bin === 'object'
        ? Object.values(bin as Record<string, unknown>).filter(
            (v): v is string => typeof v === 'string',
          )
        : [];
  return raw.map((target) => path.posix.normalize(target.replace(/\\/g, '/')).replace(/^\.\//, ''));
}

export interface SourceHit {
  line: number;
  text: string;
}

export interface EmittedModuleAnalysis {
  /** Chemins `.ts` restés dans le code (introuvables une fois installé). */
  tsPaths: SourceHit[];
  /** Spécificateurs relatifs à littéral : `import`/`export … from`, `import()`. */
  relativeImports: (SourceHit & { specifier: string })[];
}

const RELATIVE = /^\.{1,2}\//;

/**
 * Analyse d'un module JS émis, sur l'AST (parseur TypeScript) et non sur le
 * texte : les commentaires — dont les `import('./x.ts')` de JSDoc, inertes à
 * l'exécution — ne comptent pas.
 *
 * - `tsPaths` : tsc réécrit les imports statiques et les `import()` à
 *   littéral, mais PAS un chemin construit à l'exécution
 *   (`new URL('./x.ts', import.meta.url)`, `path.join(dir, 'x.ts')`).
 *   Signalés : toute chaîne relative finissant en `.ts`, toute chaîne égale au
 *   nom d'un module `.ts` émis (`'acp.ts'`), tout gabarit `./${…}.ts`.
 * - `relativeImports` : permet de vérifier que chaque module importé existe
 *   bien dans l'archive (un module non suivi par git n'y est pas).
 */
export function analyzeEmittedModule(
  code: string,
  tsModuleNames: ReadonlySet<string> = new Set(),
): EmittedModuleAnalysis {
  const source = ts.createSourceFile(
    'emitted.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const analysis: EmittedModuleAnalysis = { tsPaths: [], relativeImports: [] };
  const hitOf = (node: ts.Node): SourceHit => ({
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    text: node.getText(source),
  });
  const isTsPath = (value: string) =>
    (RELATIVE.test(value) && /\.ts$/.test(value) && !/\.d\.ts$/.test(value)) ||
    tsModuleNames.has(value);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isTsPath(node.text)) analysis.tsPaths.push(hitOf(node));
    } else if (ts.isTemplateExpression(node)) {
      const tail = node.templateSpans.at(-1)?.literal.text ?? '';
      if (RELATIVE.test(node.head.text) && /\.ts$/.test(tail)) analysis.tsPaths.push(hitOf(node));
    }
    let specifier: ts.Node | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier) && RELATIVE.test(specifier.text)) {
      analysis.relativeImports.push({ ...hitOf(specifier), specifier: specifier.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return analysis;
}

/**
 * Imports relatifs d'un module publié qui ne désignent aucun fichier de
 * l'archive. `from` et les entrées de `packaged` sont des chemins POSIX
 * relatifs à la racine du paquet.
 */
export function unresolvedImports(
  from: string,
  specifiers: readonly string[],
  packaged: ReadonlySet<string>,
): string[] {
  return specifiers.filter((spec) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    return !packaged.has(target);
  });
}

export interface StatusEntry {
  status: string;
  file: string;
}

/** Analyse `git status --porcelain=v1 -z` (renommages : deux chemins). */
export function parsePorcelainZ(output: string): StatusEntry[] {
  const parts = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || part.length < 4) continue;
    const status = part.slice(0, 2);
    entries.push({ status, file: part.slice(3) });
    if (status.includes('R') || status.includes('C')) i += 1; // chemin d'origine
  }
  return entries;
}

/**
 * Documentation de conception, consignes d'agents, feuille de route et
 * métadonnées de session : elles vivent dans le dépôt et ne quittent jamais
 * le dépôt. `files` ne les couvre pas et `.npmignore` les liste, mais seul ce
 * contrôle FAIL CLOSED sur la liste réellement publiée empêche qu'une entrée
 * ajoutée par mégarde à `files` (ou un `.md` déposé sous `src/`) les embarque.
 * README*, CHANGELOG et LICENSE restent publiés (convention npm).
 */
const FORBIDDEN_PACKED_CONTENT =
  /(^|\/)(AGENTS|CLAUDE|CONTRIBUTING|SECURITY)\.md$|(^|\/)\.claude(\/|$)|^(docs|roadmap)(\/|$)|(^|\/)adr(\/|$)/i;

/**
 * Contrôle de la liste réellement publiée par `npm pack` : aucun `.ts`
 * (inexécutable sous node_modules), chaque cible `bin` présente, package.json
 * présent, et aucune documentation interne ni consigne d'agent.
 */
export function verifyPackedFiles(
  packed: readonly string[],
  manifest: Record<string, unknown>,
): void {
  const set = new Set(packed);
  const tsFiles = packed.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
  const missing = [...binTargets(manifest), 'package.json'].filter((f) => !set.has(f));
  const internalDocs = packed.filter((f) => FORBIDDEN_PACKED_CONTENT.test(f));
  if (tsFiles.length === 0 && missing.length === 0 && internalDocs.length === 0) return;
  throw new PackError(
    [
      tsFiles.length > 0 ? `fichiers .ts dans l'archive : ${tsFiles.join(', ')}` : null,
      missing.length > 0 ? `fichiers attendus absents : ${missing.join(', ')}` : null,
      internalDocs.length > 0
        ? `documentation interne ou consigne d'agent dans l'archive : ${internalDocs.join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join(' ; '),
    {
      code: 'PACK_CONTENT_INVALID',
      details: { tsFiles, missing, internalDocs },
      hint: 'npm run pack:release -- --dry-run --keep-staging  (inspecter le staging) ; retirer l’entrée de "files" (package.json)',
    },
  );
}

/**
 * Schémas versionnés du Striart Control Protocol, publiés avec le paquet
 * (un client installé les lit sans le dépôt). Le test de dérive
 * (tests/unit/control-contract.test.js) ne voit que le dépôt : ces deux
 * contrôles prolongent la garantie à l'ARCHIVE.
 */
export const SCHEMA_FILES = [
  'schemas/striart-control-v1.openrpc.json',
  'schemas/striart-document-v1.schema.json',
] as const;

/** "files" déclare schemas/ ET l'archive contient chaque schéma — sinon refus. */
export function verifyPackedSchemas(
  packed: readonly string[],
  manifest: Record<string, unknown>,
): void {
  const set = new Set(packed);
  const declared =
    Array.isArray(manifest.files) &&
    manifest.files.some((entry) => entry === 'schemas/' || entry === 'schemas');
  const missing = SCHEMA_FILES.filter((f) => !set.has(f));
  if (declared && missing.length === 0) return;
  throw new PackError(
    [
      declared ? null : 'package.json "files" ne déclare pas schemas/',
      missing.length > 0 ? `schémas absents de l'archive : ${missing.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' ; '),
    {
      code: 'PACK_SCHEMAS_MISSING',
      details: { declared, missing },
      hint: 'ajoute "schemas/" à "files" dans package.json (et commite schemas/)',
    },
  );
}

/**
 * Le contenu des schémas DE L'ARCHIVE est exactement ce que génère le code
 * de l'archive (même comparaison que le test de dérive). `read` lit un
 * chemin relatif à la racine du paquet stagé.
 */
export async function verifySchemaContents(
  read: (relativePath: string) => Promise<string>,
): Promise<void> {
  const { buildDocumentJsonSchema, buildOpenRpcDocument } =
    await import('../src/control/schema.ts');
  const expected: Record<string, unknown> = {
    [SCHEMA_FILES[0]]: buildOpenRpcDocument(),
    [SCHEMA_FILES[1]]: buildDocumentJsonSchema(),
  };
  const stale: string[] = [];
  for (const file of SCHEMA_FILES) {
    try {
      if (!isDeepStrictEqual(JSON.parse(await read(file)), expected[file])) stale.push(file);
    } catch {
      stale.push(file); // illisible ou JSON invalide : jamais ignoré
    }
  }
  if (stale.length === 0) return;
  throw new PackError(`schémas périmés ou illisibles dans l'archive : ${stale.join(', ')}`, {
    code: 'PACK_SCHEMAS_STALE',
    details: { stale },
    hint: 'régénère : voir tests/unit/control-contract.test.js (commande de régénération), commite, relance',
  });
}

/**
 * Chemin de npm-cli.js, lancé par `process.execPath` (argv, sans shell — sous
 * Windows, `npm` est un .cmd que Node refuse de lancer sans shell).
 * Ordre : `npm_execpath` (positionné par `npm run`), puis les emplacements
 * standards relatifs au binaire Node (Windows, puis POSIX).
 */
export function resolveNpmCli({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  exists?: (p: string) => boolean;
} = {}): string {
  const fromEnv = env.npm_execpath;
  const candidates = [
    fromEnv && /npm-cli\.c?js$/.test(fromEnv) ? fromEnv : null,
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => exists(c));
  if (found) return found;
  throw new PackError('npm introuvable à côté de Node.', {
    code: 'PACK_NPM_NOT_FOUND',
    details: { candidates },
    hint: 'npm run pack:release  (npm transmet alors son propre chemin)',
  });
}

// ── Distribution native (fonctions pures) ────────────────────────────────

/**
 * Plateformes déclarées par l'archive : les six publiées par défaut, ou une
 * sélection explicite (vérification locale). Une clé inconnue est une erreur
 * d'usage, jamais ignorée.
 */
export function selectNativePlatforms(list: readonly string[] | null): NativePlatform[] {
  if (list === null) return [...NATIVE_PLATFORMS];
  const unknown = list.filter((key) => !NATIVE_PLATFORMS.some((p) => p.key === key));
  if (unknown.length > 0 || list.length === 0) {
    throw new PackError(
      `Plateformes natives inconnues : ${unknown.join(', ') || '(liste vide)'} (connues : ${NATIVE_PLATFORMS.map((p) => p.key).join(', ')}).`,
      { code: 'PACK_USAGE', usage: true, details: { unknown } },
    );
  }
  return NATIVE_PLATFORMS.filter((p) => list.includes(p.key));
}

export interface NativeBinaryArtifact {
  platform: NativePlatform;
  /** Fichier déposé dans --native-dir. */
  source: string;
  sha256: string;
  size: number;
}

/** Manifeste des binaires (clés triées : octets stables, signés tels quels). */
export function buildNativeManifest(
  version: string,
  artifacts: readonly NativeBinaryArtifact[],
  {
    nativeVersion,
    ephemeral = false,
  }: {
    /** Version du crate `striart-native` (native/striart-native/Cargo.toml). */
    nativeVersion: string;
    /** Signé d'une clé jetable : le manifeste le dit, l'exécution le refuse. */
    ephemeral?: boolean;
  },
): NativeManifest {
  const binaries: NativeManifest['binaries'] = {};
  for (const artifact of [...artifacts].sort((a, b) =>
    a.platform.key.localeCompare(b.platform.key),
  )) {
    binaries[artifact.platform.key] = {
      package: artifact.platform.packageName,
      path: artifact.platform.binaryPath,
      sha256: artifact.sha256,
      size: artifact.size,
    };
  }
  const manifest: NativeManifest = {
    schemaVersion: NATIVE_MANIFEST_SCHEMA,
    protocol: NATIVE_PROTOCOL_VERSION,
    version,
    nativeVersion,
    ...(ephemeral ? { ephemeral: true as const } : {}),
    binaries,
  };
  // Le paquet doit pouvoir relire ce qu'on signe : même validation qu'au chargement.
  parseNativeManifest(manifest);
  return manifest;
}

/**
 * package.json de staging, complété pour la distribution native : une
 * dépendance optionnelle EXACTE par paquet de plateforme (même version que le
 * paquet principal : le manifeste signé n'en accepte pas d'autre), et le
 * manifeste + sa signature dans `files`.
 */
export function addNativeDistribution(
  staged: Record<string, unknown>,
  platforms: readonly NativePlatform[],
): Record<string, unknown> {
  const out = structuredClone(staged);
  const version = String(out.version);
  out.optionalDependencies = Object.fromEntries(
    [...platforms]
      .sort((a, b) => a.packageName.localeCompare(b.packageName))
      .map((p) => [p.packageName, version]),
  );
  const files = Array.isArray(out.files) ? [...(out.files as string[])] : [];
  for (const file of [NATIVE_MANIFEST_FILE, NATIVE_SIGNATURE_FILE]) {
    if (!files.includes(file)) files.push(file);
  }
  out.files = files;
  return out;
}

/** Fichiers natifs que l'archive principale doit contenir. */
export function verifyNativeFilesPacked(packed: readonly string[], schemeName: string): void {
  const missing = [NATIVE_MANIFEST_FILE, NATIVE_SIGNATURE_FILE, publicKeyPath(schemeName)].filter(
    (file) => !packed.includes(file),
  );
  if (missing.length === 0) return;
  throw new PackError(`Fichiers natifs absents de l'archive : ${missing.join(', ')}.`, {
    code: 'PACK_CONTENT_INVALID',
    details: { tsFiles: [], missing },
    hint: 'Vérifier "files" (package.json : native/keys/) et le staging (--keep-staging).',
  });
}

/** Contenu exact attendu d'un paquet de plateforme. */
export function expectedPlatformPackageFiles(platform: NativePlatform): string[] {
  return ['LICENSE', platform.binaryPath, 'package.json'].sort();
}

const cyclonedxPurlNpm = (name: string, version: string) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

/**
 * Composants CycloneDX des binaires natifs (un par paquet de plateforme,
 * avec son empreinte SHA-256 et sa cible Rust) et des crates de Cargo.lock
 * qui y sont compilées (somme de contrôle du registre).
 */
export function nativeSbomComponents(
  version: string,
  artifacts: readonly NativeBinaryArtifact[],
  crates: readonly CargoLockPackage[],
): Record<string, unknown>[] {
  const binaries = artifacts.map((artifact) => ({
    type: 'application',
    'bom-ref': cyclonedxPurlNpm(artifact.platform.packageName, version),
    name: artifact.platform.packageName,
    version,
    purl: cyclonedxPurlNpm(artifact.platform.packageName, version),
    hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
    properties: [
      { name: 'striart:native:target', value: artifact.platform.rustTarget },
      { name: 'striart:native:file', value: artifact.platform.binaryPath },
    ],
  }));
  const registryCrates = crates
    .filter((c) => c.source !== null)
    .map((c) => ({
      type: 'library',
      'bom-ref': `pkg:cargo/${c.name}@${c.version}`,
      name: c.name,
      version: c.version,
      purl: `pkg:cargo/${c.name}@${c.version}`,
      ...(c.checksum ? { hashes: [{ alg: 'SHA-256', content: c.checksum }] } : {}),
      properties: [{ name: 'striart:native:source', value: c.source as string }],
    }));
  return [...binaries, ...registryCrates];
}

/** SBOM npm complété des composants natifs. */
export function mergeNativeSbom(bomText: string, components: Record<string, unknown>[]): string {
  let bom: Record<string, unknown>;
  try {
    bom = JSON.parse(bomText) as Record<string, unknown>;
  } catch {
    // Un SBOM illisible est un échec, pas un fichier à moitié valide.
    throw new PackError('npm sbom a produit une sortie qui n’est pas du JSON.', {
      code: 'PACK_SBOM_FAILED',
    });
  }
  const existing = Array.isArray(bom.components) ? (bom.components as unknown[]) : [];
  bom.components = [...existing, ...components];
  return `${JSON.stringify(bom, null, 2)}\n`;
}

// ── Effets de bord ───────────────────────────────────────────────────────

async function run(
  file: string,
  args: string[],
  options: { cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout, stderr };
}

/** Message d'échec d'un process enfant, sans pile ni environnement. */
function childFailure(error: unknown): string {
  const e = error as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || String(error)).trim();
}

async function gitOutput(args: string[]): Promise<string> {
  try {
    return (await run('git', ['-C', REPO_ROOT, ...args], { cwd: REPO_ROOT })).stdout;
  } catch (error) {
    throw new PackError(`git ${args[0]} a échoué : ${childFailure(error)}`, {
      code: 'PACK_GIT_FAILED',
      details: { args },
      hint: 'Lancer le script depuis un checkout git du dépôt Striart.',
    });
  }
}

async function npm(args: string[], cwd: string): Promise<string> {
  try {
    return (await run(process.execPath, [resolveNpmCli(), ...args], { cwd })).stdout;
  } catch (error) {
    if (error instanceof PackError) throw error;
    throw new PackError(`npm ${args[0]} a échoué : ${childFailure(error)}`, {
      code: 'PACK_NPM_FAILED',
      details: { args },
    });
  }
}

/** Le `tsc` du paquet `typescript` (alias TS 6) — pas `@typescript/native`. */
function resolveTsc(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('typescript/package.json');
  const pkg = require(pkgPath) as { bin?: Record<string, string> };
  const rel = pkg.bin?.tsc ?? pkg.bin?.tsc6 ?? Object.values(pkg.bin ?? {})[0];
  if (!rel) {
    throw new PackError('Binaire tsc introuvable dans le paquet "typescript".', {
      code: 'PACK_TSC_NOT_FOUND',
      hint: 'npm ci',
    });
  }
  return path.join(path.dirname(pkgPath), rel);
}

/**
 * Dépose `file` dans le staging. Arbre propre (release) : le contenu vient
 * de l'OBJET git indexé, pas de l'arbre de travail — l'archive est alors
 * exactement le commit `gitHead`. Sous --allow-dirty (vérification locale
 * seulement) : copie de l'arbre de travail, liens symboliques non suivis.
 */
async function copyInto(
  file: string,
  destRoot: string,
  source: { entry: IndexEntry; fromIndex: boolean },
): Promise<void> {
  const dest = path.join(destRoot, file);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const mode = source.entry.mode === '100755' ? 0o755 : 0o644;
  if (source.fromIndex) {
    await fs.writeFile(dest, await gitBlob(source.entry.object), { mode });
    return;
  }
  const real = path.join(REPO_ROOT, file);
  if ((await fs.lstat(real)).isSymbolicLink()) {
    throw new PackError(`${file} est un lien symbolique dans l'arbre de travail.`, {
      code: 'PACK_UNSUPPORTED_MODE',
      details: { files: [file] },
    });
  }
  await fs.copyFile(real, dest);
  await fs.chmod(dest, mode);
}

/** Contenu brut d'un objet blob (binaire préservé). */
async function gitBlob(object: string): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'cat-file', 'blob', object], {
      cwd: REPO_ROOT,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw new PackError(`git cat-file blob ${object} a échoué : ${childFailure(error)}`, {
      code: 'PACK_GIT_FAILED',
      details: { object },
    });
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Émet src/ en JS dans le paquet et contrôle le résultat. Retourne, par
 * fichier publié, ses imports relatifs (vérifiés ensuite contre la liste
 * réelle de l'archive).
 */
async function emitJs(
  sourceDir: string,
  packageDir: string,
  compile: string[],
): Promise<Map<string, string[]>> {
  const importsByFile = new Map<string, string[]>();
  if (compile.length === 0) return importsByFile;
  const config = {
    extends: path.join(REPO_ROOT, 'tsconfig.pack.json'),
    compilerOptions: {
      rootDir: path.join(sourceDir, CODE_ROOT),
      outDir: path.join(packageDir, CODE_ROOT),
    },
    // `include: []` explicite : sans lui, l'include hérité de tsconfig.json
    // (relatif au dépôt) s'ajouterait à `files`.
    files: compile.map((f) => path.join(sourceDir, f)),
    include: [],
  };
  const configPath = path.join(sourceDir, 'tsconfig.json');
  await writeJson(configPath, config);
  try {
    await run(process.execPath, [resolveTsc(), '-p', configPath], { cwd: sourceDir });
  } catch (error) {
    throw new PackError(`Émission JS refusée par tsc :\n${childFailure(error)}`, {
      code: 'PACK_EMIT_FAILED',
      hint: 'npm run typecheck',
    });
  }
  const tsModuleNames = new Set(
    compile.filter((f) => f.endsWith('.ts')).map((f) => path.posix.basename(f)),
  );
  const leftovers: string[] = [];
  for (const file of compile) {
    const published = emittedPath(file);
    let code: string;
    try {
      code = await fs.readFile(path.join(packageDir, published), 'utf8');
    } catch {
      // Sortie absente : tsc n'a pas émis ce fichier — signalé, jamais ignoré.
      leftovers.push(`${published} (non émis)`);
      continue;
    }
    const analysis = analyzeEmittedModule(code, tsModuleNames);
    for (const hit of analysis.tsPaths) leftovers.push(`${published}:${hit.line}  ${hit.text}`);
    importsByFile.set(
      published,
      analysis.relativeImports.map((i) => i.specifier),
    );
  }
  if (leftovers.length > 0) {
    throw new PackError(
      `Chemins .ts non réécrits dans le JS émis (introuvables une fois installé) :\n  ${leftovers.join('\n  ')}`,
      {
        code: 'PACK_UNREWRITTEN_TS',
        details: { leftovers },
        hint: 'Importer par spécificateur statique (`./x.ts`, réécrit par tsc) ou résoudre un fichier .js.',
      },
    );
  }
  return importsByFile;
}

/**
 * Chaque import relatif d'un module publié doit désigner un fichier de
 * l'archive — sinon le paquet installé échoue au chargement
 * (ERR_MODULE_NOT_FOUND). Cas typique : module ajouté mais pas encore suivi
 * par git, donc exclu.
 */
function verifyImportsResolve(
  importsByFile: ReadonlyMap<string, string[]>,
  packed: readonly string[],
  untracked: readonly string[],
): void {
  const packedSet = new Set(packed);
  const missing: string[] = [];
  for (const [file, specifiers] of importsByFile) {
    if (!packedSet.has(file)) continue; // non publié (filtré par .npmignore) : sans objet
    for (const spec of unresolvedImports(file, specifiers, packedSet))
      missing.push(`${file} → ${spec}`);
  }
  if (missing.length === 0) return;
  const hintFiles = untracked.filter((f) => /\.(js|ts)$/.test(f));
  throw new PackError(
    `Imports vers des modules absents de l'archive :\n  ${missing.join('\n  ')}`,
    {
      code: 'PACK_UNRESOLVED_IMPORT',
      details: { missing },
      hint:
        hintFiles.length > 0
          ? `Fichiers non suivis par git, donc exclus : git add ${hintFiles.join(' ')}`
          : 'Vérifier que le module importé est suivi par git et couvert par "files" (package.json).',
    },
  );
}

/** `npm pack --json` dans le staging ; `destination` nul = --dry-run. */
async function npmPack(packageDir: string, destination: string | null): Promise<NpmPackEntry> {
  const args = ['pack', '--json', '--ignore-scripts'];
  if (destination) args.push('--pack-destination', destination);
  else args.push('--dry-run');
  const parsed = JSON.parse(await npm(args, packageDir)) as NpmPackEntry[];
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new PackError('Sortie inattendue de npm pack --json.', { code: 'PACK_NPM_FAILED' });
  }
  return parsed[0];
}

/**
 * Lit les binaires déposés dans --native-dir (npm run native:stage, ou les
 * artefacts de la CI) et les contrôle, fail closed : présence pour CHAQUE
 * plateforme déclarée, empreinte déposée concordante, en-tête d'exécutable
 * conforme à la plateforme, lien statique sous Linux.
 */
async function collectNativeBinaries(
  nativeDir: string,
  platforms: readonly NativePlatform[],
): Promise<NativeBinaryArtifact[]> {
  const missing: string[] = [];
  const artifacts: NativeBinaryArtifact[] = [];
  for (const platform of platforms) {
    const source = path.join(nativeDir, platform.key, binaryFileName(platform));
    const bytes = await fs.readFile(source).catch(() => null);
    if (!bytes) {
      missing.push(platform.key);
      continue;
    }
    const sumFile = path.join(nativeDir, platform.key, checksumFileName(platform));
    const recorded = parseChecksumLine(
      await fs.readFile(sumFile, 'utf8').catch(() => ''),
      binaryFileName(platform),
    );
    if (!recorded) {
      throw new PackError(
        `Empreinte déposée absente ou illisible pour ${platform.key} : ${sumFile}.`,
        {
          code: 'PACK_NATIVE_DIGEST_MISSING',
          details: { platform: platform.key, file: sumFile },
          hint: `npm run native:stage -- --platform ${platform.key}`,
        },
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== recorded) {
      throw new PackError(
        `Le binaire ${platform.key} ne correspond pas à l'empreinte déposée par sa construction (${recorded} attendu, ${sha256} lu).`,
        {
          code: 'PACK_NATIVE_DIGEST_MISMATCH',
          details: { platform: platform.key, expected: recorded, actual: sha256 },
          hint: 'Reconstruire et redéposer le binaire (artefact corrompu ou remplacé).',
        },
      );
    }
    const target = detectBinaryTarget(bytes);
    if (!target || target.os !== platform.os || target.cpu !== platform.cpu) {
      throw new PackError(
        `${source} n'est pas un exécutable ${platform.key} (en-tête : ${target ? `${target.os}-${target.cpu}` : 'inconnu'}).`,
        { code: 'PACK_NATIVE_FORMAT_MISMATCH', details: { platform: platform.key } },
      );
    }
    if (target.dynamic) {
      throw new PackError(`${source} est lié dynamiquement (musl statique attendu).`, {
        code: 'PACK_NATIVE_NOT_STATIC',
        details: { platform: platform.key },
      });
    }
    artifacts.push({ platform, source, sha256, size: bytes.length });
  }
  if (missing.length > 0) {
    throw new PackError(
      `Binaires natifs absents de ${nativeDir} pour des plateformes déclarées : ${missing.join(', ')}.`,
      {
        code: 'PACK_NATIVE_MISSING',
        details: { missing, nativeDir },
        hint: 'Déposer chaque binaire (npm run native:stage -- --platform <clé>), ou restreindre --native-platforms pour une vérification locale.',
      },
    );
  }
  return artifacts;
}

/** Paquet de plateforme dans le staging : package.json, bin/, LICENSE. */
async function writePlatformPackage(
  stagingRoot: string,
  artifact: NativeBinaryArtifact,
  mainManifest: Record<string, unknown>,
  licenseSource: string,
): Promise<string> {
  const dir = path.join(stagingRoot, 'native-packages', artifact.platform.key);
  const binary = path.join(dir, ...artifact.platform.binaryPath.split('/'));
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.copyFile(artifact.source, binary);
  await fs.chmod(binary, 0o755);
  await fs.copyFile(licenseSource, path.join(dir, 'LICENSE'));
  await writeJson(
    path.join(dir, 'package.json'),
    platformPackageManifest(artifact.platform, mainManifest),
  );
  return dir;
}

interface NativeSigning {
  scheme: string;
  keyId: string;
  ephemeral: boolean;
  /** Clé publique fournie par --signing-public-key (hors clé épinglée du dépôt). */
  customKey: boolean;
}

/** Garde N-I1 : une clé jetable ne produit que des archives de vérification (--dry-run). */
export function assertEphemeralOnlyInDryRun(ephemeral: boolean, dryRun: boolean): void {
  if (!ephemeral || dryRun) return;
  throw new PackError(
    '--ephemeral-signing-key exige --dry-run : une archive signée d’une clé jetable se vérifierait elle-même et serait installable sans garantie de provenance.',
    {
      code: 'PACK_EPHEMERAL_REQUIRES_DRY_RUN',
      usage: true,
      hint: 'Ajouter --dry-run (vérification locale / CI sans secret), ou signer avec la clé de release (STRIART_NATIVE_SIGNING_KEY) pour une archive installable.',
    },
  );
}

/** Version du crate `striart-native` (premier `version = "…"` de son Cargo.toml). */
export async function readNativeCrateVersion(
  cargoToml = path.join(REPO_ROOT, 'native', 'striart-native', 'Cargo.toml'),
): Promise<string> {
  const text = await fs.readFile(cargoToml, 'utf8').catch((error: Error) => {
    throw new PackError(`Cargo.toml du crate natif illisible : ${error.message}`, {
      code: 'PACK_NATIVE_VERSION_UNREADABLE',
    });
  });
  const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(text);
  if (!match?.[1]) {
    throw new PackError('Version du crate natif introuvable dans Cargo.toml.', {
      code: 'PACK_NATIVE_VERSION_UNREADABLE',
    });
  }
  return match[1];
}

/**
 * Signe le manifeste, écrit la signature et la clé publique de l'archive,
 * puis revérifie la signature produite (une archive invérifiable ne sort
 * jamais du staging).
 */
async function signNativeManifest(
  packageDir: string,
  manifestBytes: Buffer,
  {
    schemeName,
    ephemeral,
    env,
    publicKeyFile = null,
  }: {
    schemeName: string;
    ephemeral: boolean;
    env: NodeJS.ProcessEnv;
    publicKeyFile?: string | null;
  },
): Promise<NativeSigning> {
  const scheme = getSignatureScheme(schemeName);
  if (!scheme) {
    throw new PackError(
      `Schéma de signature inconnu : ${schemeName} (connus : ${signatureSchemeNames().join(', ')}).`,
      { code: 'PACK_USAGE', usage: true },
    );
  }
  const keyFile = path.join(packageDir, ...publicKeyPath(scheme.name).split('/'));
  let publicKey: string;
  let secret: SigningSecret;
  if (ephemeral) {
    const pair = scheme.generateKeyPair();
    publicKey = pair.publicKey;
    secret = pair.secret;
    await fs.mkdir(path.dirname(keyFile), { recursive: true });
    await fs.writeFile(keyFile, publicKey);
  } else {
    const key = env[SIGNING_KEY_ENV];
    if (!key) {
      throw new PackError(`Clé privée de signature absente (${SIGNING_KEY_ENV}).`, {
        code: 'PACK_SIGNING_KEY_MISSING',
        hint: `Exporter ${SIGNING_KEY_ENV} (secret de CI) — ou --ephemeral-signing-key pour une vérification locale.`,
      });
    }
    const repoKey = await fs.readFile(publicKeyFile ?? keyFile, 'utf8').catch(() => null);
    if (repoKey === null) {
      throw new PackError(
        `Clé publique ${publicKeyPath(scheme.name)} absente de l'archive (non suivie par git ?).`,
        {
          code: 'PACK_SIGNING_KEY_MISSING',
          hint: 'npm run native:keygen -- --secret-out <chemin hors dépôt>, puis git add native/keys/',
        },
      );
    }
    publicKey = repoKey;
    secret = { key, password: env[SIGNING_PASSWORD_ENV] ?? null };
    if (publicKeyFile) {
      // La clé alternative devient celle de l'archive (le manifeste, sa
      // signature et la clé publique doivent être cohérents).
      await fs.mkdir(path.dirname(keyFile), { recursive: true });
      await fs.writeFile(keyFile, publicKey);
    }
  }
  let signature: string;
  let keyId: string;
  try {
    ({ signature, keyId } = scheme.sign(manifestBytes, secret, publicKey, NATIVE_MANIFEST_FILE));
    scheme.verify(manifestBytes, signature, publicKey);
  } catch (error) {
    throw new PackError(`Signature du manifeste natif impossible : ${(error as Error).message}`, {
      code: 'PACK_SIGNING_FAILED',
      details: { scheme: scheme.name },
      hint: `Vérifier ${SIGNING_KEY_ENV} (clé de native/keys/${scheme.name}.pub) et ${SIGNING_PASSWORD_ENV}.`,
    });
  }
  await writeJson(path.join(packageDir, NATIVE_SIGNATURE_FILE), {
    scheme: scheme.name,
    keyId,
    signature,
  });
  return { scheme: scheme.name, keyId, ephemeral, customKey: publicKeyFile !== null };
}

/**
 * Contrôle de bout en bout : chaque plateforme déclarée passe la
 * vérification EXACTE du chargement (src/native.ts), sur l'archive telle
 * qu'elle sera installée ; la plateforme courante, si déclarée, répond en
 * plus à la poignée de main (protocole, OS, CPU).
 */
async function selfCheckNative(
  packageDir: string,
  platformDirs: ReadonlyMap<string, string>,
  signing: NativeSigning,
): Promise<void> {
  const resolvePackageDir = (name: string) =>
    [...platformDirs.entries()].find(
      ([key]) => NATIVE_PLATFORMS.find((p) => p.key === key)?.packageName === name,
    )?.[1] ?? null;
  const host = nativePlatform();
  for (const key of platformDirs.keys()) {
    const platform = NATIVE_PLATFORMS.find((p) => p.key === key) as NativePlatform;
    const options = {
      env: {},
      packageRoot: packageDir,
      platform: platform.os,
      arch: platform.cpu,
      resolvePackageDir,
      // Auto-contrôle déterministe : jamais la config de l'utilisateur qui
      // construit. Une release doit être signée d'une clé ÉPINGLÉE (sinon elle
      // serait refusée chez tous les utilisateurs) ; seules une clé jetable
      // (dry-run) ou une clé alternative explicite sont ajoutées.
      trustedKeyIds: signing.ephemeral || signing.customKey ? [signing.keyId] : [],
      allowEphemeral: signing.ephemeral,
    };
    try {
      if (host?.key === key) await resolveNativeBinary(options);
      else await locateNativeBinary(options);
    } catch (error) {
      throw new PackError(
        `L'archive échouerait à la vérification native pour ${key} : ${(error as Error).message}`,
        { code: 'PACK_NATIVE_SELF_CHECK_FAILED', details: { platform: key } },
      );
    }
  }
}

async function readCargoLock(): Promise<CargoLockPackage[]> {
  const file = path.join(REPO_ROOT, 'native', 'Cargo.lock');
  try {
    return parseCargoLock(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new PackError(`native/Cargo.lock illisible : ${(error as Error).message}`, {
      code: 'PACK_SBOM_FAILED',
    });
  }
}

interface PackOptions {
  outDir: string;
  dryRun: boolean;
  allowDirty: boolean;
  keepStaging: boolean;
  /** Dossier des binaires natifs déposés (requis). */
  nativeDir: string | null;
  /** Plateformes déclarées ; null = les six. */
  nativePlatforms: string[] | null;
  signingScheme: string;
  ephemeralSigningKey: boolean;
  /** Clé publique d'archive alternative (organisation qui signe avec sa clé) ; null = celle du dépôt. */
  signingPublicKey?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface PackResult {
  name: string;
  version: string;
  dryRun: boolean;
  tarball: string | null;
  sbom: string | null;
  integrity: string | null;
  shasum: string | null;
  gitHead: string | null;
  dirty: string[];
  files: string[];
  dropped: { file: string; reason: string }[];
  staging: string | null;
  native: {
    platforms: {
      key: string;
      package: string;
      sha256: string;
      size: number;
      tarball: string | null;
    }[];
    manifestSha256: string;
    signature: NativeSigning;
  };
}

interface NpmPackEntry {
  name: string;
  version: string;
  filename: string;
  integrity?: string;
  shasum?: string;
  files: { path: string }[];
}

export async function packRelease(
  options: PackOptions,
  warn: (msg: string) => void,
): Promise<PackResult> {
  // N-I1 : la garde passe AVANT tout travail (et avant toute lecture git).
  assertEphemeralOnlyInDryRun(options.ephemeralSigningKey, options.dryRun);
  const manifest = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const filesEntries = manifest.files;
  if (!Array.isArray(filesEntries) || filesEntries.length === 0) {
    throw new PackError('package.json n’a pas de liste "files" : périmètre publié indéfini.', {
      code: 'PACK_NO_FILES_FIELD',
    });
  }

  // 0. Binaires natifs : contrôlés AVANT tout le reste (fail fast).
  if (!options.nativeDir) {
    throw new PackError(
      '--native-dir est requis : l’archive embarque les binaires natifs signés.',
      {
        code: 'PACK_NATIVE_DIR_REQUIRED',
        usage: true,
        hint: 'npm run native:build && npm run native:stage, puis --native-dir dist/native',
      },
    );
  }
  const platforms = selectNativePlatforms(options.nativePlatforms);
  if (options.nativePlatforms !== null) {
    warn(
      `--native-platforms : archive limitée à ${platforms.map((p) => p.key).join(', ')} — vérification locale, jamais pour une release.`,
    );
  }
  if (options.ephemeralSigningKey) {
    warn(
      '--ephemeral-signing-key : manifeste signé par une clé JETABLE embarquée — l’archive se vérifie elle-même, sans garantie de provenance. Jamais pour une release.',
    );
  }
  const nativeArtifacts = await collectNativeBinaries(options.nativeDir, platforms);
  const crates = await readCargoLock();

  // 1. Périmètre : fichiers suivis + propreté.
  const scope = [...(filesEntries as string[]), ...EXTRA_STAGED, ...BUILD_INPUTS];
  const dirty = parsePorcelainZ(
    await gitOutput(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...scope]),
  );
  // Suivi mais supprimé de l'arbre de travail (atteignable seulement sous
  // --allow-dirty, refusé sinon plus bas) : l'archive reflète l'arbre.
  const deleted = new Set(dirty.filter((e) => e.status.includes('D')).map((e) => e.file));
  const tracked = (await gitOutput(['ls-files', '-z']))
    .split('\0')
    .filter((f) => f && !deleted.has(f));
  const plan = planPackFiles(tracked, filesEntries as string[]);
  const index = parseLsFilesIndex(
    await gitOutput(['ls-files', '-z', '-s']),
    await gitOutput(['ls-files', '-z', '-v']),
  );
  assertPublishableIndex(index, [...plan.compile, ...plan.copy]);
  const dirtyList = dirty.map((e) => `${e.status} ${e.file}`);
  if (dirty.length > 0 && !options.allowDirty) {
    throw new PackError(
      `Modifications non commitées dans le périmètre publié :\n  ${dirtyList.join('\n  ')}`,
      {
        code: 'PACK_DIRTY_TREE',
        details: { files: dirty.map((e) => e.file) },
        hint: 'Commiter (ou remiser) puis relancer — ou --allow-dirty pour une vérification locale, jamais pour une release.',
      },
    );
  }
  if (dirty.length > 0) {
    warn(
      `--allow-dirty : archive construite depuis l'arbre de travail modifié :\n  ${dirtyList.join('\n  ')}`,
    );
    const untracked = dirty.filter((e) => e.status === '??').map((e) => e.file);
    if (untracked.length > 0) {
      warn(`Fichiers non suivis EXCLUS de l'archive : ${untracked.join(', ')}`);
    }
  }
  const gitHead = dirty.length === 0 ? (await gitOutput(['rev-parse', 'HEAD'])).trim() : null;

  // 2. Staging hors du dépôt.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'striart-pack-'));
  const sourceDir = path.join(staging, 'source');
  const packageDir = path.join(staging, 'package');
  try {
    const stagedManifest = addNativeDistribution(
      buildStagedManifest(manifest, { gitHead }),
      platforms,
    );
    // Le manifeste (type: module) doit précéder tsc : NodeNext choisit le
    // format de sortie (ESM/CJS) d'après le package.json le plus proche.
    await writeJson(path.join(sourceDir, 'package.json'), stagedManifest);
    await writeJson(path.join(packageDir, 'package.json'), stagedManifest);
    const fromIndex = dirty.length === 0;
    const sourceOf = (file: string) => ({ entry: index.get(file) as IndexEntry, fromIndex });
    for (const file of plan.compile) await copyInto(file, sourceDir, sourceOf(file));
    for (const file of plan.copy) await copyInto(file, packageDir, sourceOf(file));

    // 3. Émission JS.
    const importsByFile = await emitJs(sourceDir, packageDir, plan.compile);

    // 3bis. Distribution native : manifeste des empreintes, signature,
    // paquets de plateforme, puis contrôle de bout en bout par la
    // vérification même du chargement (src/native.ts).
    const nativeManifest = buildNativeManifest(String(stagedManifest.version), nativeArtifacts, {
      nativeVersion: await readNativeCrateVersion(),
      ephemeral: options.ephemeralSigningKey,
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(nativeManifest, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(packageDir, NATIVE_MANIFEST_FILE), manifestBytes);
    const signing = await signNativeManifest(packageDir, manifestBytes, {
      schemeName: options.signingScheme,
      ephemeral: options.ephemeralSigningKey,
      env: options.env ?? process.env,
      publicKeyFile: options.signingPublicKey ?? null,
    });
    const platformDirs = new Map<string, string>();
    for (const artifact of nativeArtifacts) {
      platformDirs.set(
        artifact.platform.key,
        await writePlatformPackage(staging, artifact, manifest, path.join(packageDir, 'LICENSE')),
      );
    }
    await selfCheckNative(packageDir, platformDirs, signing);
    if (signing.customKey) {
      warn(
        `--signing-public-key : archive signée de la clé ${signing.keyId}, absente des clés épinglées de Striart — chaque utilisateur doit la déclarer (native.trustedKeyIds).`,
      );
    }

    // 4. Contrôle du contenu AVANT toute écriture d'artefact : liste réelle de
    // npm (files + .npmignore), sans .ts, bin présent, imports résolus.
    const preview = await npmPack(packageDir, null);
    const files = preview.files.map((f) => f.path).sort();
    verifyPackedFiles(files, stagedManifest);
    verifyPackedSchemas(files, stagedManifest);
    await verifySchemaContents((rel) => fs.readFile(path.join(packageDir, rel), 'utf8'));
    verifyNativeFilesPacked(files, signing.scheme);
    for (const artifact of nativeArtifacts) {
      const dir = platformDirs.get(artifact.platform.key) as string;
      const listed = (await npmPack(dir, null)).files.map((f) => f.path).sort();
      const expected = expectedPlatformPackageFiles(artifact.platform);
      if (JSON.stringify(listed) !== JSON.stringify(expected)) {
        throw new PackError(
          `Contenu inattendu du paquet ${artifact.platform.packageName} : ${listed.join(', ')} (attendu : ${expected.join(', ')}).`,
          {
            code: 'PACK_NATIVE_PACKAGE_CONTENT',
            details: { platform: artifact.platform.key, listed, expected },
          },
        );
      }
    }
    verifyImportsResolve(
      importsByFile,
      files,
      dirty.filter((e) => e.status === '??').map((e) => e.file),
    );

    let tarball: string | null = null;
    let sbom: string | null = null;
    let entry = preview;
    const nativeTarballs = new Map<string, string>();
    if (!options.dryRun) {
      // 5. SBOM CycloneDX (dépendances de production, d'après le lockfile),
      // produit avant l'archive : un échec ne laisse pas de .tgz orphelin.
      const bom = await npm(
        [
          'sbom',
          '--sbom-format',
          'cyclonedx',
          '--sbom-type',
          'application',
          '--omit',
          'dev',
          '--package-lock-only',
        ],
        REPO_ROOT,
      );
      // Binaires natifs et crates compilées : composants du même SBOM.
      const fullBom = mergeNativeSbom(
        bom,
        nativeSbomComponents(String(stagedManifest.version), nativeArtifacts, crates),
      );
      await fs.mkdir(options.outDir, { recursive: true });
      entry = await npmPack(packageDir, options.outDir);
      tarball = path.join(options.outDir, entry.filename);
      sbom = tarball.replace(/\.tgz$/, '.cdx.json');
      await fs.writeFile(sbom, fullBom, 'utf8');
      for (const artifact of nativeArtifacts) {
        const packed = await npmPack(
          platformDirs.get(artifact.platform.key) as string,
          options.outDir,
        );
        nativeTarballs.set(artifact.platform.key, path.join(options.outDir, packed.filename));
      }
    }

    return {
      name: entry.name,
      version: entry.version,
      dryRun: options.dryRun,
      tarball,
      sbom,
      integrity: entry.integrity ?? null,
      shasum: entry.shasum ?? null,
      gitHead,
      dirty: dirty.map((e) => e.file),
      files,
      dropped: plan.dropped,
      staging: options.keepStaging ? staging : null,
      native: {
        platforms: nativeArtifacts.map((artifact) => ({
          key: artifact.platform.key,
          package: artifact.platform.packageName,
          sha256: artifact.sha256,
          size: artifact.size,
          tarball: nativeTarballs.get(artifact.platform.key) ?? null,
        })),
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        signature: signing,
      },
    };
  } finally {
    if (!options.keepStaging) {
      try {
        await fs.rm(staging, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // Windows (antivirus, handle traînant) : un reliquat temporaire ne doit
        // ni masquer le résultat ni l'erreur d'origine — mais il est signalé.
        warn(`Staging non supprimé (à effacer à la main) : ${staging}`);
      }
    }
  }
}

/**
 * `npm publish` lancé depuis le dépôt (hook `prepublishOnly` du package.json
 * du dépôt) publierait les .ts de src/ — le paquet cassé de v0.10.0. Le
 * manifeste de staging n'a pas de scripts : `npm publish <archive.tgz>` ne
 * passe pas par ce hook.
 */
function rawPublishError(): PackError {
  return new PackError(
    'npm publish depuis le dépôt publierait les sources .ts, que Node refuse d’exécuter sous node_modules.',
    {
      code: 'PACK_RAW_PUBLISH',
      hint: 'npm run pack:release  puis  npm publish <chemin du .tgz affiché>',
    },
  );
}

export function parseCli(argv: string[]): (PackOptions & { json: boolean }) | 'help' {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        'out-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'allow-dirty': { type: 'boolean', default: false },
        'keep-staging': { type: 'boolean', default: false },
        'native-dir': { type: 'string' },
        'native-platforms': { type: 'string' },
        'signing-scheme': { type: 'string', default: DEFAULT_SIGNATURE_SCHEME },
        'ephemeral-signing-key': { type: 'boolean', default: false },
        'signing-public-key': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        'refuse-raw-publish': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new PackError((error as Error).message, {
      code: 'PACK_USAGE',
      usage: true,
      hint: 'node scripts/pack.ts --help',
    });
  }
  if (values.help) return 'help';
  if (values['refuse-raw-publish']) throw rawPublishError();
  if (values['ephemeral-signing-key'] && values['signing-public-key'] !== undefined) {
    throw new PackError('--ephemeral-signing-key et --signing-public-key sont incompatibles.', {
      code: 'PACK_USAGE',
      usage: true,
    });
  }
  assertEphemeralOnlyInDryRun(values['ephemeral-signing-key'], values['dry-run']);
  return {
    outDir: path.resolve(values['out-dir'] ?? DEFAULT_OUT_DIR),
    dryRun: values['dry-run'],
    json: values.json,
    allowDirty: values['allow-dirty'],
    keepStaging: values['keep-staging'],
    nativeDir: values['native-dir'] ? path.resolve(values['native-dir']) : null,
    nativePlatforms:
      values['native-platforms'] === undefined
        ? null
        : values['native-platforms'].split(',').map((key) => key.trim()),
    signingScheme: values['signing-scheme'],
    ephemeralSigningKey: values['ephemeral-signing-key'],
    signingPublicKey:
      values['signing-public-key'] === undefined
        ? null
        : path.resolve(values['signing-public-key']),
  };
}

async function main(): Promise<void> {
  const warn = (msg: string) => process.stderr.write(`⚠ ${msg}\n`);
  try {
    const parsed = parseCli(process.argv.slice(2));
    if (parsed === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const result = await packRelease(parsed, warn);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.dryRun) {
      process.stderr.write(
        `${result.name}@${result.version} — ${result.files.length} fichiers (dry-run) :\n`,
      );
      process.stdout.write(`${result.files.join('\n')}\n`);
    } else {
      const platformTarballs = result.native.platforms
        .map((p) => `  npm publish "${p.tarball}"\n`)
        .join('');
      process.stderr.write(
        `${result.name}@${result.version} — ${result.files.length} fichiers, ${result.integrity}\n` +
          `Binaires natifs : ${result.native.platforms.map((p) => p.key).join(', ')} — manifeste signé ${result.native.signature.scheme} (clé ${result.native.signature.keyId}${result.native.signature.ephemeral ? ', JETABLE' : ''})\n` +
          `SBOM : ${result.sbom}\n` +
          `Publier (acte manuel), les paquets de plateforme d'abord :\n${platformTarballs}  npm publish "${result.tarball}"\n`,
      );
      process.stdout.write(`${result.tarball}\n`);
    }
    if (result.staging) process.stderr.write(`Staging conservé : ${result.staging}\n`);
  } catch (error) {
    if (error instanceof PackError) {
      process.stderr.write(`✖ ${error.message}\n`);
      if (error.hint) process.stderr.write(`  → ${error.hint}\n`);
      process.stderr.write(`  [${error.code}]\n`);
      process.exitCode = error.usage ? 2 : 1;
      return;
    }
    // Défaut interne du script : message lisible, pile seulement à la demande.
    process.stderr.write(`✖ Erreur inattendue : ${(error as Error)?.message ?? String(error)}\n`);
    if (process.env.STRIART_LOG_LEVEL === 'debug') {
      process.stderr.write(`${(error as Error)?.stack ?? ''}\n`);
    } else {
      process.stderr.write('  → STRIART_LOG_LEVEL=debug pour la pile complète\n');
    }
    process.stderr.write('  [PACK_UNEXPECTED]\n');
    process.exitCode = 1;
  }
}

/**
 * Vrai si ce module est le point d'entrée (`node scripts/pack.ts`), faux
 * quand il est importé (tests). `import.meta.main` n'existe pas sur toutes les
 * versions couvertes par `engines` : repli explicite sur la comparaison des
 * chemins réels — jamais un « faux » silencieux qui ne ferait rien.
 */
function isEntryPoint(): boolean {
  const flag = (import.meta as { main?: unknown }).main;
  if (typeof flag === 'boolean') return flag;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Chemin d'entrée illisible : ce n'est pas nous.
    return false;
  }
}

if (isEntryPoint()) await main();
