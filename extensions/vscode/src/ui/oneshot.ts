/**
 * Appels ponctuels de la CLI (`striart dashboard --link --json`) pour ce que le
 * Control Protocol ne porte pas (le dashboard est un autre transport). Même
 * résolution de binaire que la connexion, argv + `shell: false`, borné en
 * temps et en taille, sortie validée comme document `--json`.
 */
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { resolveStriartLaunch } from '../core/binary.ts';
import { RpcError } from '../core/errors.ts';
import { safeDashboardUrl } from '../core/url.ts';
import { readSettings } from './config.ts';
import { childEnv } from './controller.ts';

export interface OneShotDocument {
  ok: boolean;
  data: Record<string, unknown> | null;
  warnings: Array<{ code: string; message: string }>;
}

export async function runStriartJson(root: string, args: string[], timeoutMs = 30_000): Promise<OneShotDocument> {
  const settings = readSettings();
  const untrustedDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const launch = await resolveStriartLaunch(settings.binaryPath, settings.nodePath, { untrustedDirs });
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(
      launch.file,
      [...launch.prefixArgs, ...args, '--json'],
      { cwd: root, env: childEnv(), shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, out) => {
        // Un code de sortie non nul est normal pour un refus : le document JSON le décrit.
        if (error && out.trim() === '') reject(error);
        else resolve({ stdout: out });
      },
    );
  });
  const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('striart returned no JSON document');
  const doc = JSON.parse(line) as Record<string, unknown>;
  if (doc.schemaVersion !== 1 || typeof doc.ok !== 'boolean') throw new Error('unexpected document from striart');
  if (doc.ok === false) {
    const e = (doc.error ?? {}) as Record<string, unknown>;
    throw new RpcError({
      method: args.join(' '),
      rpcCode: -32000,
      code: typeof e.code === 'string' ? e.code : 'UNEXPECTED',
      kind: e.kind === 'usage' || e.kind === 'refusal' ? e.kind : 'failure',
      message: typeof e.message === 'string' ? e.message : 'striart failed',
      hint: typeof e.hint === 'string' ? e.hint : null,
      details: {},
    });
  }
  const warnings = Array.isArray(doc.warnings)
    ? (doc.warnings as Array<Record<string, unknown>>)
        .filter((w) => typeof w.code === 'string' && typeof w.message === 'string')
        .map((w) => ({ code: w.code as string, message: w.message as string }))
    : [];
  return {
    ok: true,
    data: typeof doc.data === 'object' && doc.data !== null ? (doc.data as Record<string, unknown>) : null,
    warnings,
  };
}

/** Lien de connexion valide (voir core/url.ts) converti en Uri, sinon null. */
export function validateSignInUrl(value: unknown): vscode.Uri | null {
  const safe = safeDashboardUrl(value);
  return safe ? vscode.Uri.parse(safe, true) : null;
}
