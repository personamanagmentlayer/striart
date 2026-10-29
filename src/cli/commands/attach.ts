import path from 'node:path';
import { StriartError } from '../../errors.ts';
import type { CommandModule } from '../context.ts';

export interface AttachInput {
  agent: string;
}

/**
 * Attache le terminal courant au pty possédé d'un agent (lancé par `--open`,
 * ou à la main pour rejoindre une session). Possède le terminal en mode raw
 * jusqu'à la fin de la session ; le terminal est TOUJOURS restauré.
 *
 * `root` n'est jamais passé en argument : il est dérivé de la structure
 * connue `root/.striart/agents/<agent>` du répertoire courant, avec
 * vérification stricte (le chemin a pu transiter par une ligne de shell).
 */
export const attach: CommandModule<AttachInput, { action: 'attach'; agent: string }> = {
  async execute(ctx, input) {
    const cwd = path.resolve(ctx.cwd);
    const root = path.resolve(cwd, '..', '..', '..');
    if (path.join(root, '.striart', 'agents', input.agent) !== cwd) {
      throw new StriartError(ctx.m.attach.wrongCwd(cwd), {
        code: 'ATTACH_WRONG_CWD',
        details: { cwd },
        hint: `cd ".striart/agents/${input.agent}"; striart attach ${input.agent}`,
      });
    }
    const { connectAttachClient } = await import('../../pty-attach.ts');
    const { stdin, stdout } = process;
    const wasRaw = Boolean(stdin.isTTY && stdin.isRaw);
    const restore = () => {
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const outcome = await new Promise<'ok' | 'failed'>((resolve) => {
      const conn = connectAttachClient(root, input.agent, {
        cols: stdout.columns,
        rows: stdout.rows,
        onData: (text: string) => stdout.write(text),
        onExit: () => resolve('ok'),
        onError: (error: Error) => {
          restore();
          ctx.out.error(
            ctx.m.attach.failed(input.agent, error.message),
            `striart start ${input.agent} --open`,
          );
          resolve('failed');
        },
      });
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', (chunk: Buffer) => conn.sendRaw(chunk.toString('utf8')));
      stdout.on('resize', () => conn.resize(stdout.columns, stdout.rows));
    });
    restore();
    if (outcome === 'ok') ctx.out.print(`\n${ctx.m.attach.ended}`);
    return { data: { action: 'attach', agent: input.agent }, outcome };
  },
};
