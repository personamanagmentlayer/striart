/**
 * Garde du champ `command` d'une tâche de plan (v1 et v2, source unique).
 *
 * `command` désigne l'outil d'un agent SUPERVISÉ : Striart le TAPE dans le
 * shell interactif du pty de l'agent. Un plan est une donnée (SECURITY.md) —
 * il peut venir d'une issue, d'une PR ou d'un dépôt cloné — donc `command`
 * ne peut pas être une ligne de shell : seuls passent un NOM d'exécutable
 * (résolu par le PATH de l'utilisateur), sans chemin, espace, opérateur,
 * substitution ni option. Les options d'un outil se posent dans la config de
 * l'utilisateur (`agentCommand`, de confiance) ou dans un `profile` (mode
 * autonome, argv sans shell).
 */
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function isExecutableName(value: string): boolean {
  return EXECUTABLE_NAME.test(value);
}
