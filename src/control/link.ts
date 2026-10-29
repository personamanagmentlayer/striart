/**
 * Émission d'un lien de connexion au dashboard par un AUTRE process que le
 * serveur (`striart dashboard --link`, le parent d'un `--daemon`) : lit le
 * fichier de jeton de l'instance (vérifié privé), contrôle que l'instance
 * vit encore, et signe un code à usage unique. Le jeton ne quitte jamais ce
 * process ; seul le lien (éphémère, non rejouable) est rendu.
 */
import { StriartError } from '../errors.ts';
import { isProcessAlive } from '../process-tree.ts';
import { mintSignInCode, readTokenFile } from './auth.ts';

export interface SignInLink {
  url: string;
  signInUrl: string;
  expiresAt: string;
  port: number;
}

export async function issueSignInLink(
  root: string,
  port: number,
  ttlMs: number,
): Promise<SignInLink> {
  const instance = await readTokenFile(root, port);
  if (!isProcessAlive(instance.pid)) {
    throw new StriartError(`The dashboard that listened on port ${port} is no longer running.`, {
      code: 'CONTROL_INSTANCE_NOT_FOUND',
      details: { port, pid: instance.pid },
      hint: 'striart dashboard --daemon',
    });
  }
  const { code, expiresAt } = mintSignInCode(instance.token, { port, ttlMs });
  // Nom d'hôte propre à l'instance (S-I4) : le cookie de session y est host-only.
  const url = `http://${instance.hostname ?? 'localhost'}:${port}`;
  return { url, signInUrl: `${url}/auth?code=${code}`, expiresAt, port };
}

/** Port d'une adresse publiée par le daemon (`http://localhost:3456`), sinon null. */
export function portOfUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    // Adresse illisible : pas de port exploitable.
    return null;
  }
}
