/**
 * Autorisation de FERMER des sessions inactives — décision de l'UTILISATEUR,
 * lue dans sa config (`idle.closeRoots`, src/user-config.ts), jamais dans la
 * config du dépôt. Module FEUILLE (aucun import git/process) : `striart doctor`
 * l'importe sans tirer le balayage.
 */
import { isTrustedRoot, readUserConfig } from '../user-config.ts';

/** L'utilisateur a-t-il autorisé la fermeture pour cette racine ? Illisible = non (fail closed). */
export async function closeAuthorization(
  root: string,
): Promise<{ authorized: boolean; error: string | null }> {
  try {
    const user = await readUserConfig();
    return { authorized: await isTrustedRoot(root, user.idle.closeRoots), error: null };
  } catch (error) {
    return { authorized: false, error: (error as { code?: string }).code ?? 'USER_CONFIG_INVALID' };
  }
}
