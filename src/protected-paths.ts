/**
 * Garde des chemins protégés (lot I2, décision D4/D12).
 *
 * Un agent ne modifie jamais, par un merge, un fichier qui configure ou
 * instruit les agents de coding (AGENTS.md, CLAUDE.md, `.claude/`, `.mcp.json`,
 * `.vscode/settings.json`…) ni la configuration de Striart lui-même
 * (`striart.config.*`, `.striartrc*`, clé `striart` de package.json,
 * `.striart/`). Ces fichiers sont relus par les sessions SUIVANTES — humaines
 * ou autonomes — avec la confiance qu'on accorde au dépôt : les laisser passer
 * transformerait une injection de prompt ponctuelle en compromission
 * persistante (CVE-2025-53773 : un agent qui active l'auto-approbation dans
 * `.vscode/settings.json`), ou désarmerait le Test Gate (un agent qui
 * réécrit `testCommand`).
 *
 * Fail closed : tout changement EFFECTIF d'un chemin protégé (le contenu que
 * le merge apporterait diffère de celui de la branche cible) refuse le merge
 * et ouvre un ticket humain, avant toute fusion LLM et avant le Test Gate.
 *
 * Sémantique des motifs : globs ANCRÉS à la racine du dépôt, séparateur `/`.
 *   `*`  — tout sauf `/` ;  `?` — un caractère sauf `/` ;
 *   `**` en segment entier — zéro ou plusieurs segments ;
 *   `x/**` — le chemin `x` lui-même (fichier, lien, submodule qui
 *            remplacerait le dossier) ET tout ce qu'il contient.
 * Pas de classes `[…]`, d'accolades ni de négation : un motif reste lisible
 * et sa portée évidente — le relâchement passe par `allow`, explicite.
 */
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import type { SimpleGit } from 'simple-git';
import { StriartError } from './errors.ts';
import { compileGlob, globPatternProblem } from './glob-lite.ts';
import type { ProtectedPathChange, StriartConfig } from './types.js';

export type ProtectedPathKind = 'instructions' | 'agent-config' | 'striart-config';

export interface ProtectedPathRule {
  pattern: string;
  kind: ProtectedPathKind;
  /** Outils qui lisent ce chemin (documentation, affichage). */
  tools: string[];
}

/**
 * Liste par défaut — vérifiée contre la documentation des outils (état
 * 2026-10). Les répertoires de configuration sont protégés à toute
 * profondeur (`**​/.claude/**`) : la plupart des outils relisent aussi ceux
 * d'un sous-dossier quand on les lance depuis celui-ci (monorepos).
 */
export const DEFAULT_PROTECTED_AGENT_PATHS: readonly ProtectedPathRule[] = Object.freeze([
  // --- Instructions (relues comme consignes par l'agent suivant) ---------
  { pattern: '**/AGENTS.md', kind: 'instructions', tools: ['codex', 'agents.md'] },
  { pattern: '**/AGENTS.override.md', kind: 'instructions', tools: ['codex'] },
  { pattern: '**/AGENT.md', kind: 'instructions', tools: ['amp', 'zed'] },
  { pattern: '**/CLAUDE.md', kind: 'instructions', tools: ['claude'] },
  { pattern: '**/CLAUDE.local.md', kind: 'instructions', tools: ['claude'] },
  { pattern: '**/GEMINI.md', kind: 'instructions', tools: ['gemini'] },
  { pattern: '**/QWEN.md', kind: 'instructions', tools: ['qwen-code'] },
  { pattern: '**/CRUSH.md', kind: 'instructions', tools: ['crush'] },
  { pattern: '**/WARP.md', kind: 'instructions', tools: ['warp'] },
  { pattern: '**/.rules', kind: 'instructions', tools: ['zed'] },
  { pattern: '**/.cursorrules', kind: 'instructions', tools: ['cursor'] },
  { pattern: '**/.clinerules', kind: 'instructions', tools: ['cline'] },
  { pattern: '**/.clinerules/**', kind: 'instructions', tools: ['cline'] },
  { pattern: '**/.windsurfrules', kind: 'instructions', tools: ['windsurf'] },
  { pattern: '**/.goosehints', kind: 'instructions', tools: ['goose'] },
  { pattern: '**/.augment-guidelines', kind: 'instructions', tools: ['augment'] },
  { pattern: '**/.github/copilot-instructions.md', kind: 'instructions', tools: ['copilot'] },
  { pattern: '**/.github/instructions/**', kind: 'instructions', tools: ['copilot'] },
  { pattern: '**/.github/prompts/**', kind: 'instructions', tools: ['copilot'] },
  { pattern: '**/.github/chatmodes/**', kind: 'instructions', tools: ['copilot'] },
  { pattern: '**/.github/agents/**', kind: 'instructions', tools: ['copilot'] },
  // --- Configuration, hooks, serveurs MCP, permissions -------------------
  { pattern: '**/.claude/**', kind: 'agent-config', tools: ['claude'] },
  { pattern: '**/.mcp.json', kind: 'agent-config', tools: ['claude'] },
  { pattern: '**/.gemini/**', kind: 'agent-config', tools: ['gemini'] },
  { pattern: '**/.qwen/**', kind: 'agent-config', tools: ['qwen-code'] },
  { pattern: '**/.codex/**', kind: 'agent-config', tools: ['codex'] },
  { pattern: '**/.cursor/**', kind: 'agent-config', tools: ['cursor'] },
  { pattern: '**/.cursorignore', kind: 'agent-config', tools: ['cursor'] },
  { pattern: '**/.cursorindexingignore', kind: 'agent-config', tools: ['cursor'] },
  { pattern: '**/.clineignore', kind: 'agent-config', tools: ['cline'] },
  { pattern: '**/.windsurf/**', kind: 'agent-config', tools: ['windsurf'] },
  { pattern: '**/.codeiumignore', kind: 'agent-config', tools: ['windsurf'] },
  { pattern: '**/.github/hooks/**', kind: 'agent-config', tools: ['copilot'] },
  {
    pattern: '**/.github/workflows/copilot-setup-steps.yml',
    kind: 'agent-config',
    tools: ['copilot'],
  },
  {
    pattern: '**/.github/workflows/copilot-setup-steps.yaml',
    kind: 'agent-config',
    tools: ['copilot'],
  },
  { pattern: '**/.vscode/mcp.json', kind: 'agent-config', tools: ['vscode', 'copilot'] },
  // Auto-approbation des outils de l'agent (CVE-2025-53773, « YOLO mode »).
  { pattern: '**/.vscode/settings.json', kind: 'agent-config', tools: ['vscode', 'copilot'] },
  { pattern: '**/.warp/**', kind: 'agent-config', tools: ['warp'] },
  { pattern: '**/.agents/**', kind: 'agent-config', tools: ['agents.md', 'skills'] },
  { pattern: '**/.aider.conf.yml', kind: 'agent-config', tools: ['aider'] },
  { pattern: '**/.aider.model.settings.yml', kind: 'agent-config', tools: ['aider'] },
  { pattern: '**/.aider.model.metadata.json', kind: 'agent-config', tools: ['aider'] },
  { pattern: '**/.aiderignore', kind: 'agent-config', tools: ['aider'] },
  { pattern: '**/.kilocode/**', kind: 'agent-config', tools: ['kilo-code'] },
  { pattern: '**/.kilocodemodes', kind: 'agent-config', tools: ['kilo-code'] },
  { pattern: '**/.roo/**', kind: 'agent-config', tools: ['roo-code'] },
  { pattern: '**/.roomodes', kind: 'agent-config', tools: ['roo-code'] },
  { pattern: '**/.rooignore', kind: 'agent-config', tools: ['roo-code'] },
  { pattern: '**/.junie/**', kind: 'agent-config', tools: ['junie'] },
  { pattern: '**/.aiassistant/**', kind: 'agent-config', tools: ['jetbrains-ai'] },
  { pattern: '**/.aiignore', kind: 'agent-config', tools: ['jetbrains-ai'] },
  { pattern: '**/.continue/**', kind: 'agent-config', tools: ['continue'] },
  { pattern: '**/.continuerc.json', kind: 'agent-config', tools: ['continue'] },
  { pattern: '**/.amazonq/**', kind: 'agent-config', tools: ['amazon-q'] },
  { pattern: '**/.kiro/**', kind: 'agent-config', tools: ['kiro'] },
  { pattern: '**/.trae/**', kind: 'agent-config', tools: ['trae'] },
  { pattern: '**/.augment/**', kind: 'agent-config', tools: ['augment'] },
  { pattern: '**/.zed/**', kind: 'agent-config', tools: ['zed'] },
  { pattern: '**/opencode.json', kind: 'agent-config', tools: ['opencode'] },
  { pattern: '**/opencode.jsonc', kind: 'agent-config', tools: ['opencode'] },
  { pattern: '**/.opencode/**', kind: 'agent-config', tools: ['opencode'] },
  // Auto-exécution à l'ouverture du dossier (runOn: folderOpen), conteneur de
  // dev, crochets git/pré-commit, chargement d'environnement : du code que
  // l'humain ou l'agent suivant exécute sans le relire (S-M7).
  { pattern: '**/.vscode/tasks.json', kind: 'agent-config', tools: ['vscode'] },
  { pattern: '**/.devcontainer/**', kind: 'agent-config', tools: ['vscode', 'devcontainers'] },
  { pattern: '**/.devcontainer.json', kind: 'agent-config', tools: ['vscode', 'devcontainers'] },
  { pattern: '**/.husky/**', kind: 'agent-config', tools: ['husky'] },
  { pattern: '**/.githooks/**', kind: 'agent-config', tools: ['git'] },
  { pattern: '**/.envrc', kind: 'agent-config', tools: ['direnv'] },
  { pattern: '**/.pre-commit-config.yaml', kind: 'agent-config', tools: ['pre-commit'] },
  { pattern: '**/lefthook.*', kind: 'agent-config', tools: ['lefthook'] },
  { pattern: '**/.lefthook.*', kind: 'agent-config', tools: ['lefthook'] },
  { pattern: '**/crush.json', kind: 'agent-config', tools: ['crush'] },
  { pattern: '**/.crush.json', kind: 'agent-config', tools: ['crush'] },
  // --- Striart lui-même : config (lieux de recherche de cosmiconfig 9) et
  //     état local. Un agent qui réécrit testCommand ou protectedAgentPaths
  //     désarmerait le Test Gate ou cette garde au merge suivant ; un
  //     `.striart/` versionné écraserait registre et tickets du principal.
  { pattern: '.striart/**', kind: 'striart-config', tools: ['striart'] },
  // Boîtes d'échange Striart ↔ agent (lot O), locales au clone : jamais
  // versionnées — contre un `git add -f` de l'agent.
  { pattern: '**/.striart-inbox.md', kind: 'striart-config', tools: ['striart'] },
  { pattern: '**/.striart-outbox.json', kind: 'striart-config', tools: ['striart'] },
  { pattern: '.striartrc', kind: 'striart-config', tools: ['striart'] },
  { pattern: '.striartrc.*', kind: 'striart-config', tools: ['striart'] },
  { pattern: '.config/striartrc', kind: 'striart-config', tools: ['striart'] },
  { pattern: '.config/striartrc.*', kind: 'striart-config', tools: ['striart'] },
  { pattern: 'striart.config.*', kind: 'striart-config', tools: ['striart'] },
  // Méta-config de cosmiconfig : redirige les lieux de recherche/chargeurs.
  { pattern: '.config/config.*', kind: 'striart-config', tools: ['striart'] },
]);

/**
 * Manifestes dont seules CERTAINES clés configurent Striart (cosmiconfig lit
 * `striart` dans package.json, et `cosmiconfig` comme méta-config) : le
 * manifeste lui-même reste modifiable, un changement de ces clés est protégé.
 */
const MANIFEST_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'package.json': ['striart', 'cosmiconfig'],
  'package.yaml': ['striart', 'cosmiconfig'],
});

/** Valeurs de `protectedAgentPaths.matchCase`. */
export const PROTECTED_MATCH_CASE = ['insensitive', 'platform'] as const;
export type ProtectedMatchCase = (typeof PROTECTED_MATCH_CASE)[number];

interface CompiledGlob {
  pattern: string;
  re: RegExp;
}

export interface ProtectedPathsPolicy {
  rules: Array<CompiledGlob & { kind: ProtectedPathKind; source: 'default' | 'extend' }>;
  allow: CompiledGlob[];
  caseInsensitive: boolean;
  matchCase: ProtectedMatchCase;
  /** Relâchements explicites de la protection — journalisés et affichés par doctor. */
  relaxed: { allow: string[]; caseSensitive: boolean };
  /** Nombre de motifs par défaut et ajoutés (affichage). */
  counts: { defaults: number; extend: number };
}

/**
 * Pourquoi un motif est refusé ; null s'il est valide. Grammaire et
 * compilation : source unique dans src/glob-lite.ts (aussi utilisée par le
 * filtre de l'arbre du Router).
 */
export function protectedPatternProblem(pattern: unknown): string | null {
  return globPatternProblem(pattern);
}

/** Glob ancré → RegExp. Lève si le motif est invalide (voir protectedPatternProblem). */
export function compileProtectedGlob(pattern: string, caseInsensitive: boolean): RegExp {
  return compileGlob(pattern, caseInsensitive);
}

/**
 * Forme canonique d'un chemin avant comparaison. Windows ignore les points et
 * espaces finaux d'un composant et lit `fichier::$DATA` comme `fichier` :
 * `CLAUDE.md.` y désigne `CLAUDE.md`. Neutralisé partout (fail closed) — un
 * dépôt mergé sous Linux peut être extrait sous Windows.
 */
export function canonicalProtectedPath(filePath: string): string {
  return filePath
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => {
      const stream = segment.indexOf(':');
      const base = stream > 0 ? segment.slice(0, stream) : segment;
      const trimmed = base.replace(/[. ]+$/, '');
      return trimmed.length > 0 ? trimmed : base;
    })
    .join('/');
}

/**
 * Forme PLIÉE d'un chemin, pour la comparaison sur un système de fichiers
 * insensible à la casse (Windows, macOS) : NFKC (`ſ` → `s`, signe Kelvin →
 * `k`, ligatures, pleine chasse) puis minuscules. L'indicateur `i` d'une
 * RegExp ne plie pas ces caractères : `AGENTſ.md` désigne `AGENTS.md` sur
 * APFS/HFS+ sans que le motif ne le voie (S-M7).
 */
export function foldProtectedPath(canonical: string): string {
  return canonical.normalize('NFKC').toLowerCase();
}

/**
 * Nom court Windows 8.3 (`CLAUDE~1.MD`, `PROGRA~1`) : alias d'un nom long que
 * le motif ne peut pas reconnaître. Un tel segment est traité comme protégé
 * (fail closed) — un vrai fichier de ce nom se débloque par `allow`.
 */
const SHORT_NAME_SEGMENT = /^[^/.~]{1,6}~\d+(\.[^/.]{0,3})?$/;

function invalidConfig(): StriartError {
  return new StriartError('Valeur invalide pour "protectedAgentPaths" dans la config Striart', {
    code: 'CONFIG_INVALID',
    hint: 'striart doctor',
    details: { reason: 'INVALID_VALUE', key: 'protectedAgentPaths' },
  });
}

/**
 * Politique effective, depuis la config. `extend` ajoute librement ; seul
 * `allow` retire (un chemin qu'il couvre n'est plus protégé) — relâchement
 * remonté dans `relaxed`, journalisé à chaque merge et affiché par doctor.
 */
export function resolveProtectedPathsPolicy(
  config: Pick<StriartConfig, 'protectedAgentPaths'>,
  platform: NodeJS.Platform = process.platform,
): ProtectedPathsPolicy {
  const raw = config.protectedAgentPaths ?? {};
  const extend = raw.extend ?? [];
  const allow = raw.allow ?? [];
  const matchCase: ProtectedMatchCase = raw.matchCase ?? 'insensitive';
  if (!Array.isArray(extend) || !Array.isArray(allow) || !PROTECTED_MATCH_CASE.includes(matchCase))
    throw invalidConfig();
  const caseInsensitive =
    matchCase === 'insensitive' || platform === 'win32' || platform === 'darwin';
  const compile = (pattern: string): RegExp => {
    try {
      return compileProtectedGlob(pattern, caseInsensitive);
    } catch {
      throw invalidConfig();
    }
  };
  return {
    rules: [
      ...DEFAULT_PROTECTED_AGENT_PATHS.map((r) => ({
        pattern: r.pattern,
        kind: r.kind,
        source: 'default' as const,
        re: compile(r.pattern),
      })),
      ...extend.map((pattern) => ({
        pattern,
        kind: 'agent-config' as const,
        source: 'extend' as const,
        re: compile(pattern),
      })),
    ],
    allow: allow.map((pattern) => ({ pattern, re: compile(pattern) })),
    caseInsensitive,
    matchCase,
    relaxed: { allow: [...allow], caseSensitive: !caseInsensitive },
    counts: { defaults: DEFAULT_PROTECTED_AGENT_PATHS.length, extend: extend.length },
  };
}

export type PathVerdict =
  | { protected: false }
  | { protected: true; pattern: string; kind: ProtectedPathKind }
  | { protected: false; exemptedBy: string; pattern: string; kind: ProtectedPathKind };

/** Verdict pour un chemin (glob uniquement — les clés de manifeste à part). */
export function matchProtectedPath(policy: ProtectedPathsPolicy, filePath: string): PathVerdict {
  const canonical = canonicalProtectedPath(filePath);
  const folded = policy.caseInsensitive ? foldProtectedPath(canonical) : canonical;
  const hit = (re: RegExp) => re.test(canonical) || re.test(filePath) || re.test(folded);
  let rule: { pattern: string; kind: ProtectedPathKind } | undefined = policy.rules.find((r) =>
    hit(r.re),
  );
  if (!rule && canonical.split('/').some((segment) => SHORT_NAME_SEGMENT.test(segment))) {
    rule = { pattern: '8.3 short name (~N)', kind: 'agent-config' };
  }
  if (!rule) return { protected: false };
  const allowed = policy.allow.find((a) => hit(a.re));
  if (allowed) {
    return {
      protected: false,
      exemptedBy: allowed.pattern,
      pattern: rule.pattern,
      kind: rule.kind,
    };
  }
  return { protected: true, pattern: rule.pattern, kind: rule.kind };
}

const NUL = String.fromCharCode(0);

/** `git diff --name-status --no-renames -z a b` → Map chemin → statut (A/M/D/T…). */
async function diffStatus(
  git: SimpleGit,
  revs: string[],
  paths: string[] | null = null,
): Promise<Map<string, string>> {
  const raw = await git.raw([
    '--literal-pathspecs',
    'diff',
    '--name-status',
    '--no-renames',
    '--no-relative',
    '--no-ext-diff',
    '-z',
    ...revs,
    '--',
    ...(paths ?? []),
  ]);
  const tokens = raw.split(NUL).filter((t) => t.length > 0);
  const changes = new Map<string, string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) changes.set(tokens[i + 1], tokens[i].charAt(0));
  return changes;
}

const UNREADABLE = Symbol('unreadable');

async function manifestKeyValues(
  git: SimpleGit,
  rev: string,
  filePath: string,
  keys: readonly string[],
): Promise<Record<string, string | undefined> | typeof UNREADABLE> {
  let content: string;
  try {
    content = await git.show([`${rev}:${filePath}`]);
  } catch {
    return Object.fromEntries(keys.map((k) => [k, undefined])); // fichier absent de ce côté
  }
  try {
    const parsed = filePath.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
    const object = parsed !== null && typeof parsed === 'object' ? parsed : {};
    return Object.fromEntries(
      keys.map((k) => [k, Object.hasOwn(object, k) ? JSON.stringify(object[k]) : undefined]),
    );
  } catch {
    return UNREADABLE;
  }
}

export interface ProtectedScan {
  changes: ProtectedPathChange[];
  /** Chemins qu'un défaut aurait protégés mais qu'`allow` exempte (journalisés). */
  exempted: Array<{ path: string; pattern: string; exemptedBy: string }>;
}

/**
 * Changements EFFECTIFS de chemins protégés qu'apporterait le merge de
 * `theirs` dans `ours` : un chemin modifié par l'agent depuis l'ancêtre
 * commun (`base..theirs`) ET dont le contenu diffère de la branche cible
 * (`ours..theirs`). `--no-renames` : un renommage apparaît comme
 * suppression + ajout, les DEUX chemins sont examinés — aucune dépendance au
 * seuil de similarité de git.
 */
export async function findProtectedChanges({
  git,
  base = null,
  ours,
  theirs,
  policy,
}: {
  git: SimpleGit;
  /** Ancêtre commun ; absent : `ours...theirs` (git le calcule, un spawn de moins). */
  base?: string | null;
  ours: string;
  theirs: string;
  policy: ProtectedPathsPolicy;
}): Promise<ProtectedScan> {
  // Chemin chaud : UN seul diff (côté agent depuis l'ancêtre commun). Le
  // contrôle d'effet et l'ancêtre ne sont calculés que s'il existe un
  // candidat — l'immense majorité des merges n'en a aucun.
  const agentChanges = await diffStatus(git, base ? [base, theirs] : [`${ours}...${theirs}`]);
  const candidates: Array<{
    filePath: string;
    status: string;
    verdict: PathVerdict;
    manifest?: string;
  }> = [];
  for (const [filePath, status] of agentChanges) {
    const verdict = matchProtectedPath(policy, filePath);
    if (verdict.protected || 'exemptedBy' in verdict) {
      candidates.push({ filePath, status, verdict });
      continue;
    }
    const canonical = canonicalProtectedPath(filePath);
    const manifest = Object.keys(MANIFEST_KEYS).find((m) =>
      policy.caseInsensitive ? m.toLowerCase() === foldProtectedPath(canonical) : m === canonical,
    );
    if (manifest) candidates.push({ filePath, status, verdict, manifest });
  }
  const changes: ProtectedPathChange[] = [];
  const exempted: ProtectedScan['exempted'] = [];
  if (candidates.length === 0) return { changes, exempted };

  // Effet réel sur la cible : un contenu déjà identique côté `ours` n'en a aucun.
  const effective = await diffStatus(
    git,
    [ours, theirs],
    candidates.map((c) => c.filePath),
  );
  let mergeBase = base;
  for (const { filePath, status, verdict, manifest } of candidates) {
    if (!effective.has(filePath)) continue;
    if (verdict.protected) {
      changes.push({ path: filePath, status, pattern: verdict.pattern, kind: verdict.kind });
      continue;
    }
    if ('exemptedBy' in verdict) {
      exempted.push({ path: filePath, pattern: verdict.pattern, exemptedBy: verdict.exemptedBy });
      continue;
    }
    if (!manifest) continue;
    mergeBase ??= (await git.raw(['merge-base', ours, theirs])).trim();
    const pattern = `${manifest}#${MANIFEST_KEYS[manifest].join(',')}`;
    const allowedBy = policy.allow.find((a) => a.re.test(filePath));
    const keys = MANIFEST_KEYS[manifest];
    const [b, o, t] = await Promise.all(
      [mergeBase, ours, theirs].map((rev) => manifestKeyValues(git, rev, filePath, keys)),
    );
    // Côté agent illisible : impossible de prouver que les clés n'ont pas
    // bougé — fail closed.
    const touched =
      t === UNREADABLE ||
      keys.some((k) => (b === UNREADABLE || t[k] !== b[k]) && (o === UNREADABLE || t[k] !== o[k]));
    if (!touched) continue;
    if (allowedBy) {
      exempted.push({ path: filePath, pattern, exemptedBy: allowedBy.pattern });
      continue;
    }
    changes.push({ path: filePath, status, pattern, kind: 'striart-config' });
  }
  return { changes, exempted };
}
