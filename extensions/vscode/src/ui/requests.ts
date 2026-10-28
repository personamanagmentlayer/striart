/**
 * Demandes d'arbitrage humain venues des sessions ACP : permissions et
 * élicitations (questions structurées). Notification actionnable dès qu'une
 * nouvelle demande apparaît dans l'état ; la réponse passe par
 * `permission.answer` / `elicitation.answer` (plan humain).
 *
 * Fail closed : fermer la notification ne répond JAMAIS (la demande reste dans
 * la vue « À traiter » jusqu'à son délai, après quoi le serveur refuse). Le
 * texte de la demande vient de l'agent : texte brut, neutralisé, borné. Une URL
 * d'élicitation est affichée, jamais ouverte automatiquement.
 */
import * as vscode from 'vscode';
import { RequestTracker, type HumanRequest } from '../core/model.ts';
import { sanitizeBlock, sanitizeLine } from '../core/sanitize.ts';
import type { ControlState, ElicitationRequest, PermissionRequest } from '../core/types.ts';
import { readSettings } from './config.ts';
import type { Controller } from './controller.ts';
import { reportError, type ErrorSink } from './feedback.ts';

const l10n = vscode.l10n;
/** Au-delà, les demandes supplémentaires sont regroupées en une seule notification. */
const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

export class RequestNotifier implements vscode.Disposable {
  private readonly tracker = new RequestTracker();
  private readonly subscription: vscode.Disposable;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly controller: Controller,
    private readonly sink: ErrorSink,
  ) {
    this.subscription = controller.onState((state) => this.onState(state));
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private onState(state: ControlState): void {
    const fresh = this.tracker.fresh(state);
    if (fresh.length === 0 || !readSettings().notifyRequests) return;
    const individual = fresh.slice(0, MAX_INDIVIDUAL_NOTIFICATIONS);
    for (const request of individual) void this.notify(request);
    const rest = fresh.length - individual.length;
    if (rest > 0) {
      void vscode.window
        .showWarningMessage(l10n.t('{0} more agent requests are waiting for you.', rest), l10n.t('Show'))
        .then((choice) => {
          if (choice) void vscode.commands.executeCommand('workbench.view.extension.striart');
        });
    }
  }

  private async notify(request: HumanRequest): Promise<void> {
    const agent = sanitizeLine(request.agent, 64);
    if (request.kind === 'permission') {
      const title = sanitizeLine(request.title, 200);
      const options = request.options.slice(0, 2).map((o) => optionLabel(o));
      const more = request.options.length > 2 ? [l10n.t('Other options…')] : [];
      const choice = await vscode.window.showWarningMessage(
        l10n.t('Agent {0} asks permission: {1}', agent, title),
        ...options,
        ...more,
      );
      if (choice === undefined) return;
      if (choice === l10n.t('Other options…')) {
        await this.answerRequest(request);
        return;
      }
      const index = options.indexOf(choice);
      const picked = request.options[index];
      if (picked) await this.answerPermission(request, picked.optionId);
      return;
    }
    const message = sanitizeLine(request.message, 200);
    const answerLabel = l10n.t('Answer…');
    const choice = await vscode.window.showWarningMessage(l10n.t('Agent {0} asks: {1}', agent, message), answerLabel);
    if (choice === answerLabel) await this.answerRequest(request);
  }

  /** Point d'entrée commun (notification, vue, palette). */
  async answerRequest(request: HumanRequest): Promise<void> {
    if (this.inFlight.has(request.id)) return;
    this.inFlight.add(request.id);
    try {
      if (request.kind === 'permission') await this.askPermission(request);
      else await this.askElicitation(request);
    } finally {
      this.inFlight.delete(request.id);
    }
  }

  private async askPermission(request: PermissionRequest): Promise<void> {
    if (request.options.length === 0) {
      void vscode.window.showWarningMessage(l10n.t('This request offers no option; answer it from the dashboard.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      request.options.map((o) => ({
        label: optionLabel(o),
        description: o.kind ? sanitizeLine(o.kind, 40) : undefined,
        optionId: o.optionId,
      })),
      {
        title: l10n.t('Agent {0} asks permission', sanitizeLine(request.agent, 64)),
        placeHolder: sanitizeLine(request.title, 300),
        ignoreFocusOut: true,
      },
    );
    if (!picked) return;
    await this.answerPermission(request, picked.optionId);
  }

  private async answerPermission(request: PermissionRequest, optionId: string): Promise<void> {
    try {
      await this.controller.call('permission.answer', { id: request.id, option: optionId }, 'action');
      this.sink.log.info(`Answered permission ${request.id}.`);
    } catch (error) {
      await reportError(this.sink, l10n.t('Answering the permission request'), error);
    }
  }

  private async askElicitation(request: ElicitationRequest): Promise<void> {
    const agent = sanitizeLine(request.agent, 64);
    if (request.mode === 'url') {
      const copy = l10n.t('Copy URL');
      const decline = l10n.t('Decline');
      const cancel = l10n.t('Cancel request');
      const choice = await vscode.window.showWarningMessage(
        l10n.t(
          'Agent {0} asks you to visit a URL (not opened automatically): {1}',
          agent,
          sanitizeLine(request.url ?? '', 300),
        ),
        { modal: true, detail: sanitizeBlock(request.message, 1000) },
        copy,
        decline,
        cancel,
      );
      if (choice === copy && request.url) await vscode.env.clipboard.writeText(request.url);
      else if (choice === decline) await this.sendElicitation(request, 'decline');
      else if (choice === cancel) await this.sendElicitation(request, 'cancel');
      return;
    }
    const content = await collectForm(request);
    if (content === 'cancel') return;
    if (content === 'unsupported') {
      const decline = l10n.t('Decline');
      const choice = await vscode.window.showWarningMessage(
        l10n.t(
          'Agent {0} asked a question this extension cannot render. Answer it from the dashboard, or decline.',
          agent,
        ),
        decline,
      );
      if (choice === decline) await this.sendElicitation(request, 'decline');
      return;
    }
    await this.sendElicitation(request, 'accept', content);
  }

  private async sendElicitation(
    request: ElicitationRequest,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.controller.call(
        'elicitation.answer',
        { id: request.id, action, ...(content ? { content } : {}) },
        'action',
      );
      this.sink.log.info(`Answered elicitation ${request.id} (${action}).`);
    } catch (error) {
      await reportError(this.sink, l10n.t('Answering the agent question'), error);
    }
  }
}

function optionLabel(option: { optionId: string; name: string | null }): string {
  return sanitizeLine(option.name ?? option.optionId, 60) || sanitizeLine(option.optionId, 60);
}

type SchemaProp = {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  enum?: unknown;
  default?: unknown;
  minimum?: unknown;
  maximum?: unknown;
};

/**
 * Formulaire minimal depuis le `requestedSchema` de l'agent (non fiable) :
 * chaînes, énumérations, booléens, nombres. Un type non géré rend
 * 'unsupported' ; le serveur valide de toute façon le contenu contre le
 * schéma (la demande reste ouverte s'il est invalide).
 */
export async function collectForm(
  request: ElicitationRequest,
): Promise<Record<string, unknown> | 'cancel' | 'unsupported'> {
  const schema = request.requestedSchema;
  const properties =
    schema && typeof schema.properties === 'object' && schema.properties !== null
      ? (schema.properties as Record<string, SchemaProp>)
      : null;
  if (!properties) return 'unsupported';
  const required = new Set(
    Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string')
      : [],
  );
  const entries = Object.entries(properties).slice(0, 20);
  if (entries.length === 0) return {};
  const result: Record<string, unknown> = {};
  for (const [key, prop] of entries) {
    if (typeof prop !== 'object' || prop === null) return 'unsupported';
    const label = sanitizeLine(typeof prop.title === 'string' ? prop.title : key, 80);
    const hint = sanitizeLine(typeof prop.description === 'string' ? prop.description : '', 200);
    const title = `${sanitizeLine(request.message, 120)} — ${label}`;
    const isRequired = required.has(key);
    if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === 'string')) {
      const pick = await vscode.window.showQuickPick(
        (prop.enum as string[]).slice(0, 100).map((v) => ({ label: sanitizeLine(v, 80), value: v })),
        { title, placeHolder: hint || label, ignoreFocusOut: true },
      );
      if (!pick) return 'cancel';
      result[key] = pick.value;
      continue;
    }
    if (prop.type === 'boolean') {
      const pick = await vscode.window.showQuickPick(
        [
          { label: l10n.t('Yes'), value: true },
          { label: l10n.t('No'), value: false },
        ],
        { title, placeHolder: hint || label, ignoreFocusOut: true },
      );
      if (!pick) return 'cancel';
      result[key] = pick.value;
      continue;
    }
    if (prop.type === 'string' || prop.type === 'number' || prop.type === 'integer') {
      const numeric = prop.type !== 'string';
      const text = await vscode.window.showInputBox({
        title,
        prompt: hint || label,
        value: typeof prop.default === 'string' || typeof prop.default === 'number' ? String(prop.default) : undefined,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (value === '') return isRequired ? l10n.t('This field is required.') : undefined;
          if (!numeric) return undefined;
          const n = Number(value);
          if (!Number.isFinite(n)) return l10n.t('Enter a number.');
          if (prop.type === 'integer' && !Number.isInteger(n)) return l10n.t('Enter an integer.');
          return undefined;
        },
      });
      if (text === undefined) return 'cancel';
      if (text === '') continue;
      result[key] = numeric ? Number(text) : text;
      continue;
    }
    return 'unsupported';
  }
  return result;
}
