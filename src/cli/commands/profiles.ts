import { loadConfig } from '../../config.ts';
import { listProfiles } from '../../session.ts';
import type { AcpImportResult } from '../../agents/acp-registry.ts';
import type { DetectionResult } from '../../agents/detect.ts';
import type { CommandModule, CommandWarning } from '../context.ts';
import { writeProfileCache } from './complete.ts';

export interface ProfilesInput {
  /** Sonde des outils installés (PATH + version), sans config du dépôt. */
  detect?: boolean;
  /** Catalogue des presets (prêts et expérimentaux). */
  catalog?: boolean;
  /** Import d'un agent du registre ACP (métadonnées seules par défaut). */
  importAcp?: string | null;
}

export interface CatalogEntry {
  id: string;
  label: string;
  status: 'ready' | 'experimental';
  /** Clé de profil par défaut (presets prêts : présente dans agentProfiles). */
  profileKey: string;
  transport: 'argv' | 'acp';
  command: string;
  writeMode: string;
  commitPolicy: string;
  structuredOutput: string;
  instructions: string;
  docs: string[];
  notes: string[];
}

export interface DetectedTool extends DetectionResult {
  label: string;
  /** Presets qui lancent ce binaire, et leurs clés de profil. */
  presets: string[];
  profiles: string[];
}

export interface ProfilesData {
  /** Valeurs d'environnement jamais exposées : seulement leurs NOMS (`envKeys`). */
  profiles?: ReturnType<typeof listProfiles>;
  catalog?: CatalogEntry[];
  detected?: DetectedTool[];
  imported?: AcpImportResult;
}

async function catalogEntries(): Promise<CatalogEntry[]> {
  const { PRESETS } = await import('../../agents/catalog.ts');
  const { resolveInstructionsChannel } = await import('../../agents/instructions.ts');
  return PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    status: p.status,
    profileKey: p.profileKey,
    transport: p.transport,
    command: p.binaries[0],
    writeMode: p.writeMode,
    commitPolicy: p.commitPolicy,
    structuredOutput: p.structuredOutput,
    instructions: resolveInstructionsChannel({
      command: p.binaries[0],
      args: [],
      acp: p.transport === 'acp',
      instructions: p.instructions,
    }),
    docs: [...p.docs],
    notes: [...p.notes],
  }));
}

/**
 * Détection : un binaire peut porter plusieurs presets (argv et ACP,
 * variantes) — une seule sonde par binaire. Aucune config chargée : la
 * détection ne dépend que du catalogue, et fonctionne hors d'un dépôt.
 */
async function detectTools(): Promise<DetectedTool[]> {
  const { PRESETS } = await import('../../agents/catalog.ts');
  const { detectTargets } = await import('../../agents/detect.ts');
  const groups = new Map<string, (typeof PRESETS)[number][]>();
  for (const preset of PRESETS) {
    const key = preset.binaries.join('|');
    groups.set(key, [...(groups.get(key) ?? []), preset]);
  }
  const entries = [...groups.values()];
  const results = await detectTargets(
    entries.map((presets) => ({
      id: presets[0].id,
      binaries: presets[0].binaries,
      versionArgs: presets[0].versionArgs,
      minVersion: presets.map((p) => p.minVersion).find(Boolean) ?? null,
    })),
  );
  return results.map((result, i) => ({
    ...result,
    label: entries[i][0].label,
    presets: entries[i].map((p) => p.id),
    profiles: entries[i].filter((p) => p.status === 'ready').map((p) => p.profileKey),
  }));
}

export const profiles: CommandModule<ProfilesInput, ProfilesData> = {
  async execute(ctx, input) {
    if (input.catalog) {
      return { data: { catalog: await catalogEntries() }, outcome: 'ok' };
    }
    if (input.detect) {
      return { data: { detected: await detectTools() }, outcome: 'ok' };
    }
    if (input.importAcp) {
      const root = await ctx.repoRoot();
      const config = await loadConfig(root);
      const { importAcpAgent } = await import('../../agents/acp-registry.ts');
      const imported = await importAcpAgent({
        root,
        id: input.importAcp,
        settings: config.acpRegistry,
      });
      const warnings: CommandWarning[] = [];
      if (imported.installation.downloaded) {
        // Relâchement explicite (allowBinaryDownload) : toujours signalé.
        warnings.push({
          code: 'ACP_BINARY_DOWNLOADED',
          message: ctx.m.profiles.acpBinaryDownloaded(imported.id, imported.version),
        });
      }
      return { data: { imported }, outcome: 'ok', warnings };
    }

    const root = await ctx.repoRoot();
    const config = await loadConfig(root);
    const rows = listProfiles(config);
    // Confort de complétion (Tab ne lit la config en code que par ce
    // cache) : un échec d'écriture — dépôt non initialisé, disque en
    // lecture seule — ne doit pas faire échouer l'affichage des profils.
    await writeProfileCache(
      root,
      config.configPath,
      rows.map((p) => p.name),
    ).catch(() => {});
    return { data: { profiles: rows }, outcome: 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.catalog) {
      out.table(
        [
          { key: 'id', header: m.profiles.colPreset, value: (p) => p.id, priority: 9 },
          {
            key: 'status',
            header: m.profiles.colStatus,
            value: (p) => (p.status === 'ready' ? m.profiles.ready : m.profiles.experimental),
            priority: 8,
          },
          { key: 'profile', header: m.profiles.colName, value: (p) => p.profileKey, priority: 7 },
          {
            key: 'transport',
            header: m.profiles.colTransport,
            value: (p) => (p.transport === 'acp' ? 'ACP' : 'argv'),
            priority: 6,
          },
          { key: 'write', header: m.profiles.colWrite, value: (p) => p.writeMode, priority: 4 },
          {
            key: 'commit',
            header: m.profiles.colCommit,
            value: (p) => p.commitPolicy,
            priority: 5,
          },
          {
            key: 'instructions',
            header: m.profiles.colInstructions,
            value: (p) => p.instructions,
            priority: 3,
          },
          {
            key: 'tool',
            header: m.profiles.colTool,
            value: (p) => p.label,
            priority: 2,
            shrink: { min: 10 },
          },
        ],
        data.catalog,
      );
      out.print();
      out.print(m.profiles.catalogUsage);
      return;
    }
    if (data.detected) {
      const status = (d: DetectedTool) =>
        ({
          found: m.profiles.detectFound,
          outdated: m.profiles.detectOutdated,
          missing: m.profiles.detectMissing,
          'unknown-version': m.profiles.detectUnknownVersion,
        })[d.status];
      out.table(
        [
          { key: 'tool', header: m.profiles.colTool, value: (d) => d.label, priority: 9 },
          { key: 'status', header: m.profiles.colStatus, value: status, priority: 8 },
          {
            key: 'version',
            header: m.profiles.colVersion,
            value: (d) => d.version ?? '',
            priority: 7,
          },
          {
            key: 'profiles',
            header: m.profiles.colProfiles,
            value: (d) => d.profiles.join(', '),
            priority: 6,
            shrink: { min: 10 },
          },
          {
            key: 'path',
            header: m.profiles.colPath,
            value: (d) => (d.path ? out.path(d.path) : ''),
            priority: 3,
            shrink: { min: 16 },
          },
        ],
        data.detected,
      );
      out.print();
      const found = data.detected.filter((d) => d.status !== 'missing').length;
      out.print(m.profiles.detectSummary(found, data.detected.length));
      return;
    }
    if (data.imported) {
      const imp = data.imported;
      out.heading(m.profiles.importTitle(out.untrusted(imp.name), out.untrusted(imp.version)));
      if (imp.installation.downloaded && imp.installation.path) {
        out.line('ok', m.profiles.importDownloaded(out.path(imp.installation.path)));
      } else if (imp.installation.resolvedAtLaunchBy) {
        out.line('info', m.profiles.importResolvedAtLaunch(imp.installation.resolvedAtLaunchBy));
      } else if (imp.installation.archive) {
        out.line(
          'warn',
          m.profiles.importInstallBinary(
            out.untrusted(imp.installation.archive),
            imp.installation.sha256 ? out.untrusted(imp.installation.sha256) : null,
          ),
        );
      }
      out.print();
      out.print(m.profiles.importPaste);
      // Données du registre (non fiables) : neutralisées avant affichage.
      out.print(out.untrusted(JSON.stringify({ [imp.profileKey]: imp.profile }, null, 2)));
      return;
    }

    const rows = data.profiles ?? [];
    if (rows.length === 0) {
      out.line('info', m.profiles.empty);
      out.hint(m.profiles.emptyHint);
      return;
    }
    out.table(
      [
        {
          key: 'name',
          header: m.profiles.colName,
          value: (p) => (p.experimental ? `${p.name} (${m.profiles.experimental})` : p.name),
          priority: 9,
        },
        {
          key: 'transport',
          header: m.profiles.colTransport,
          value: (p) => (p.acp ? 'ACP' : 'argv'),
          priority: 6,
        },
        { key: 'preset', header: m.profiles.colPreset, value: (p) => p.preset ?? '', priority: 5 },
        {
          key: 'commit',
          header: m.profiles.colCommit,
          value: (p) => p.commitPolicy ?? '',
          priority: 4,
        },
        {
          key: 'instructions',
          header: m.profiles.colInstructions,
          value: (p) => p.instructions,
          priority: 3,
        },
        {
          key: 'timeout',
          header: m.profiles.colTimeout,
          value: (p) => (p.timeout != null ? out.duration(p.timeout) : ''),
          priority: 2,
        },
        {
          key: 'env',
          header: m.profiles.colEnv,
          value: (p) => p.envKeys.join(', '),
          priority: 4,
          shrink: { min: 10 },
        },
        {
          key: 'invocation',
          header: m.profiles.colInvocation,
          value: (p) => p.invocation,
          priority: 7,
          shrink: { min: 16 },
        },
      ],
      rows,
    );
    out.print();
    out.print(m.profiles.usage);
  },
};
