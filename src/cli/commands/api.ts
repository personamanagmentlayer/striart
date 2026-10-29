import { createRequire } from 'node:module';
import { assertInitialized } from '../../clone.ts';
import { loadConfig } from '../../config.ts';
import { StriartError } from '../../errors.ts';
import { assertHumanPlane } from '../../control/guard.ts';
import type { Framing } from '../../control/framing.ts';
import type { CommandModule } from '../context.ts';

export interface ApiInput {
  stdio: boolean;
  framing: Framing | null;
  schema: 'openrpc' | 'json-schema' | null;
}

export type ApiData =
  { action: 'schema'; kind: 'openrpc' | 'json-schema' } | { action: 'stdio'; requests: number };

/**
 * `striart api` — transport stdio du Striart Control Protocol v1, le plan
 * HUMAIN (extensions VS Code / JetBrains) : stdout EST le canal du protocole,
 * rien d'autre n'y est écrit (journaux sur stderr). Se termine quand le
 * client ferme stdin, après les requêtes en vol.
 *
 * Tout se vérifie AVANT le premier octet sur stdout (fail closed) : session
 * d'agent (refus), dépôt initialisé, config valide.
 *
 * `--schema` imprime le schéma publié (OpenRPC ou JSON Schema du document
 * `--json`) — la même source que `rpc.discover` et que `schemas/`.
 */
export const api: CommandModule<ApiInput, ApiData> = {
  async execute(ctx, input) {
    if (input.schema !== null) {
      const { buildDocumentJsonSchema, buildOpenRpcDocument } =
        await import('../../control/schema.ts');
      const document =
        input.schema === 'openrpc' ? buildOpenRpcDocument() : buildDocumentJsonSchema();
      ctx.out.print(JSON.stringify(document, null, 2));
      return { data: { action: 'schema', kind: input.schema }, outcome: 'ok' };
    }
    if (!input.stdio) {
      throw new StriartError(ctx.m.api.needsTransport, {
        code: 'MISSING_OPTION',
        details: { options: ['--stdio', '--schema'] },
        hint: 'striart api --stdio',
      });
    }
    assertHumanPlane(process.env, 'striart api');
    const root = await ctx.repoRoot();
    await assertInitialized(root);
    const config = await loadConfig(root);
    const { version } = createRequire(import.meta.url)('../../../package.json') as {
      version: string;
    };
    const { serveStdio } = await import('../../control/stdio.ts');
    const { requests } = await serveStdio({
      root,
      input: process.stdin,
      output: process.stdout,
      framing: input.framing ?? 'ndjson',
      m: ctx.m,
      locale: ctx.locale,
      version,
      maxBufferedBytes: config.controlSseMaxBufferedBytes,
      maxDelayMs: config.controlStateMaxDelayMs,
      signal: ctx.signal,
    });
    return { data: { action: 'stdio', requests }, outcome: 'ok' };
  },
};
