/**
 * Contexte de comptabilité d'un appel : racine du dépôt, agent, tâche.
 *
 * Les appelants du Router/Merger/Memory (orchestrator.js) n'ont pas tous de
 * paramètre pour ces identifiants ; le contexte asynchrone permet à un
 * appelant de les poser UNE fois (`withTokenContext`) pour tout ce que son
 * appel déclenche, sans rien changer à la signature des fonctions
 * intermédiaires. Les paramètres explicites d'`llmGenerate` l'emportent
 * toujours sur le contexte.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TokenContext {
  root?: string | null;
  agent?: string | null;
  taskId?: string | null;
}

const storage = new AsyncLocalStorage<TokenContext>();

export function withTokenContext<T>(ctx: TokenContext, fn: () => Promise<T> | T): Promise<T> | T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...ctx }, fn);
}

export function currentTokenContext(): TokenContext {
  return storage.getStore() ?? {};
}
