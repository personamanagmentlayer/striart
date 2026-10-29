/**
 * Documents virtuels en lecture seule (schéma `striart-doc:`) : diffs d'agent,
 * versions d'un ticket (BASE/OURS/THEIRS/tentative LLM), journaux. Le contenu
 * vit en mémoire (borné), n'est jamais écrit sur le disque et ne déclenche
 * aucune invite d'enregistrement.
 */
import * as vscode from 'vscode';

export const DOC_SCHEME = 'striart-doc';
const MAX_DOCS = 64;

export class VirtualDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly registration: vscode.Disposable;
  private counter = 0;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DOC_SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  /** Enregistre un contenu et rend son URI. `name` ne sert qu'à l'onglet (extension = coloration). */
  put(group: string, name: string, content: string): vscode.Uri {
    this.counter += 1;
    const safeGroup = group.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
    const safeName = name.replace(/[^A-Za-z0-9_.\-/]/g, '_').slice(0, 200);
    const uri = vscode.Uri.from({ scheme: DOC_SCHEME, path: `/${safeGroup}/${safeName}`, query: String(this.counter) });
    this.docs.set(uri.toString(), content);
    while (this.docs.size > MAX_DOCS) {
      const oldest = this.docs.keys().next().value;
      if (oldest === undefined) break;
      this.docs.delete(oldest);
    }
    return uri;
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
    this.docs.clear();
  }
}
