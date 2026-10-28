/**
 * Lecture des réglages. Défense en profondeur sur les réglages sensibles
 * (binaire à lancer) : ils sont déclarés `scope: machine` dans le manifeste
 * (VS Code ignore alors toute valeur posée par l'espace de travail), et
 * on ne lit de toute façon QUE la valeur utilisateur ou la valeur par défaut
 * via `inspect()` — une valeur de `.vscode/settings.json` ou de
 * `*.code-workspace` n'est jamais prise en compte, même si le manifeste était
 * un jour modifié par erreur. Le dépôt ouvert est non fiable : il ne choisit
 * jamais ce que nous exécutons.
 */
import * as vscode from 'vscode';

export interface Settings {
  binaryPath: string;
  nodePath: string;
  /** Racine configurée ('' = premier dossier de l'espace de travail). */
  root: string;
  requestTimeoutMs: number;
  actionTimeoutMs: number;
  reconnect: { initialMs: number; maxMs: number; maxAttempts: number };
  notifyRequests: boolean;
  /** Réglages sensibles posés par l'espace de travail et IGNORÉS (pour le journal). */
  ignoredWorkspaceOverrides: string[];
}

const SENSITIVE = [
  'binaryPath',
  'nodePath',
  'requestTimeoutSeconds',
  'actionTimeoutSeconds',
  'reconnect.initialDelaySeconds',
  'reconnect.maxDelaySeconds',
  'reconnect.maxAttempts',
  'notifications.requests',
] as const;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('striart');
  const ignored: string[] = [];

  function trusted<T>(key: (typeof SENSITIVE)[number], fallback: T): T {
    const info = cfg.inspect<T>(key);
    if (info && (info.workspaceValue !== undefined || info.workspaceFolderValue !== undefined)) {
      ignored.push(`striart.${key}`);
    }
    return (info?.globalValue ?? info?.defaultValue ?? fallback) as T;
  }

  const binaryPath = trusted<string>('binaryPath', 'striart');
  const nodePath = trusted<string>('nodePath', 'node');
  const requestSeconds = clamp(trusted<number>('requestTimeoutSeconds', 30), 1, 600, 30);
  const actionSeconds = clamp(trusted<number>('actionTimeoutSeconds', 3600), 30, 14_400, 3600);
  const initial = clamp(trusted<number>('reconnect.initialDelaySeconds', 1), 0.2, 60, 1);
  const max = clamp(trusted<number>('reconnect.maxDelaySeconds', 30), 1, 600, 30);
  const attempts = Math.floor(clamp(trusted<number>('reconnect.maxAttempts', 8), 0, 100, 8));
  const notify = trusted<boolean>('notifications.requests', true);

  return {
    binaryPath: typeof binaryPath === 'string' ? binaryPath : 'striart',
    nodePath: typeof nodePath === 'string' ? nodePath : 'node',
    root: typeof cfg.get('root') === 'string' ? (cfg.get<string>('root') ?? '') : '',
    requestTimeoutMs: requestSeconds * 1000,
    actionTimeoutMs: actionSeconds * 1000,
    reconnect: { initialMs: initial * 1000, maxMs: Math.max(initial, max) * 1000, maxAttempts: attempts },
    notifyRequests: notify !== false,
    ignoredWorkspaceOverrides: ignored,
  };
}
