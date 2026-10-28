/** Confirmations proportionnées au risque, et présentation des erreurs (jamais de repli silencieux). */
import * as vscode from 'vscode';
import { ConnectionLostError, ProtocolError, RequestTimeoutError, RpcError } from '../core/errors.ts';
import { sanitizeLine } from '../core/sanitize.ts';

const l10n = vscode.l10n;

/** Confirmation modale simple pour une action courante mais non triviale. */
export async function confirmModal(message: string, detail: string, actionLabel: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, actionLabel);
  return choice === actionLabel;
}

/**
 * Confirmation FORTE pour une action destructrice ou irréversible : la
 * conséquence est écrite en clair et l'utilisateur doit saisir le nom exact
 * de l'objet touché. Annulable à tout moment (Échap).
 */
export async function confirmTyped(options: {
  title: string;
  consequence: string;
  expected: string;
}): Promise<boolean> {
  const typed = await vscode.window.showInputBox({
    title: options.title,
    prompt: l10n.t('{0} Type "{1}" to confirm.', options.consequence, options.expected),
    placeHolder: options.expected,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value === options.expected ? undefined : l10n.t('Type exactly "{0}" to confirm.', options.expected),
  });
  return typed === options.expected;
}

export interface ErrorSink {
  log: vscode.LogOutputChannel;
}

/** Affiche une erreur d'appel : message du serveur (localisé), piste suivante, bouton vers le journal. */
export async function reportError(sink: ErrorSink, action: string, error: unknown): Promise<void> {
  const showOutput = l10n.t('Show output');
  let message: string;
  let severity: 'error' | 'warning' = 'error';
  let extra: string | undefined;

  if (error instanceof RpcError) {
    message = l10n.t('{0}: {1}', action, sanitizeLine(error.message, 400));
    if (error.hint) extra = l10n.t('Next step: {0}', sanitizeLine(error.hint, 200));
    if (error.kind === 'refusal' || error.kind === 'usage') severity = 'warning';
    sink.log.error(
      `${error.method} failed: ${error.code} (${error.kind})${error.hint ? ` — hint: ${sanitizeLine(error.hint, 200)}` : ''}`,
    );
  } else if (error instanceof RequestTimeoutError) {
    message = l10n.t(
      '{0}: no answer within {1} s. The operation may still be running; the view refreshes when it ends.',
      action,
      Math.round(error.timeoutMs / 1000),
    );
    severity = 'warning';
    sink.log.warn(`${error.method} timed out locally after ${error.timeoutMs} ms`);
  } else if (error instanceof ConnectionLostError) {
    message = l10n.t('{0}: Striart is not connected.', action);
    sink.log.error(`${action}: ${error.message}`);
    void vscode.window.showErrorMessage(message, l10n.t('Reconnect'), showOutput).then((choice) => {
      if (choice === l10n.t('Reconnect')) void vscode.commands.executeCommand('striart.reconnect');
      else if (choice === showOutput) sink.log.show(true);
    });
    return;
  } else if (error instanceof ProtocolError) {
    message = l10n.t('{0}: unexpected protocol answer. Update Striart and the extension.', action);
    sink.log.error(`${error.code}: ${error.message}`);
  } else {
    message = l10n.t('{0}: unexpected error.', action);
    sink.log.error(`${action}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = extra ? `${message} ${extra}` : message;
  // Jamais attendue : un message ignoré ne doit pas retenir l'action qui l'a produit (verrou local).
  void (
    severity === 'warning'
      ? vscode.window.showWarningMessage(text, showOutput)
      : vscode.window.showErrorMessage(text, showOutput)
  ).then((choice) => {
    if (choice === showOutput) sink.log.show(true);
  });
}
