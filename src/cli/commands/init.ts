import { initStriart } from '../../init.ts';
import { runDoctor } from '../../doctor.ts';
import type { CommandModule } from '../context.ts';
import { checkDetail, checkHint, checkLabel } from './doctor.ts';

type DoctorReport = Awaited<ReturnType<typeof runDoctor>>;

interface InitData {
  root: string;
  configPath: string | null;
  created: string[];
  alreadyInitialized: boolean;
  /** Constats de `doctor` qui demandent une action (warn/fail), pour enchaîner sans surprise. */
  checks: DoctorReport['checks'];
}

/**
 * `striart init` : initialise puis enchaîne le diagnostic (même source que
 * `striart doctor`) pour signaler AVANT la première commande ce qui la
 * ferait échouer (dépôt sans commit, branche cible absente, LLM…).
 */
export const init: CommandModule<Record<string, never>, InitData> = {
  async execute(ctx) {
    const result = await ctx.out.task(ctx.m.init.working, () => initStriart(ctx.cwd));
    ctx.out.root = result.root;
    const report = await ctx.out.task(ctx.m.init.checking, () => runDoctor(result.root));
    const checks = report.checks.filter(
      (c) => (c.level === 'warn' || c.level === 'fail') && c.id !== 'init',
    );
    return {
      data: { ...result, checks },
      // L'initialisation a réussi ; un prérequis manquant pour la SUITE est
      // signalé, pas compté comme un échec d'init.
      outcome: 'ok',
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.alreadyInitialized && data.created.length === 0) {
      out.line('ok', m.init.alreadyInitialized(out.path(`${data.root}/.striart`)));
    } else {
      out.line('ok', m.init.ready(out.path(`${data.root}/.striart`)));
      for (const item of data.created) out.detail(`+ ${m.init.created(item)}`);
    }
    out.detail(m.init.config(data.configPath ? out.path(data.configPath) : null));
    for (const check of data.checks) {
      out.line(
        check.level === 'fail' ? 'error' : 'warn',
        `${checkLabel(m, check)}${m.levelSeparator}${out.untrusted(checkDetail(m, check))}`,
        checkHint(m, check),
      );
    }
    out.print();
    out.print(`${m.init.nextStep} ${out.code('striart start <agent>')}`);
  },
};
