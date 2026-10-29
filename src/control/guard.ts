/**
 * Garde du plan humain : le Striart Control Protocol (stdio ou HTTP) et
 * l'émission d'un lien de connexion au dashboard sont refusés à un process
 * qui descend d'une session autonome Striart (STRIART_SESSION=1, posé en
 * dernier et non surchargeable par session.js / acp.ts).
 *
 * Sans elle, un agent pourrait lancer `striart api --stdio` et arbitrer ses
 * propres demandes de permission, clore ses tickets ou lever la session
 * principale — exactement ce que l'architecture en trois plans interdit
 * (l'agent parle MCP, jamais le plan humain).
 *
 * Portée ADVISORY, comme la garde de profondeur du MCP : un process du même
 * utilisateur qui efface sa variable d'environnement n'est pas arrêté par
 * elle (voir SECURITY.md, frontière « même utilisateur »).
 */
import { StriartError } from '../errors.ts';

export function assertHumanPlane(env: NodeJS.ProcessEnv = process.env, surface: string): void {
  if (env.STRIART_SESSION !== '1') return;
  throw new StriartError(
    `"${surface}" is the human control plane: refused inside a Striart agent session (STRIART_SESSION=1).`,
    {
      code: 'CONTROL_NESTED_SESSION',
      details: { surface },
      hint: 'Agents talk to Striart through "striart mcp"; run this command from your own terminal.',
    },
  );
}
