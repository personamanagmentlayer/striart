import { runDoctor } from '../../doctor.js';
import type { CommandModule } from '../context.ts';
import type { Messages } from '../i18n/index.ts';
import type { Level } from '../output.ts';

type DoctorReport = Awaited<ReturnType<typeof runDoctor>>;

const LEVEL: Record<DoctorReport['checks'][number]['level'], Level> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'error',
  skip: 'skip',
};

/**
 * `striart doctor` : sortie 1 dès qu'un prérequis manque (fail) — un
 * diagnostic qui échoue est un problème d'environnement. Les avertissements
 * ne changent pas le code de sortie mais empêchent le bilan « opérationnel ».
 */
export const doctor: CommandModule<Record<string, never>, DoctorReport> = {
  async execute(ctx) {
    const report = await ctx.out.task(ctx.m.doctor.running, () => runDoctor(ctx.cwd));
    const repo = report.checks.find((c) => c.id === 'repo' && c.level === 'ok');
    if (repo) ctx.out.root = repo.detail;
    return { data: report, outcome: report.healthy ? 'ok' : 'failed' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    out.table(
      [
        {
          key: 'level',
          header: m.doctor.colLevel,
          value: (c) => `${out.glyphs[LEVEL[c.level]]} ${m.levels[LEVEL[c.level]]}`,
          style: (text, c) => out.style(LEVEL[c.level], text),
          priority: 9,
        },
        { key: 'label', header: m.doctor.colCheck, value: (c) => checkLabel(m, c), priority: 8 },
        {
          key: 'detail',
          header: m.doctor.colDetail,
          value: (c) => checkDetail(m, c),
          shrink: { min: 24 },
          priority: 7,
        },
      ],
      data.checks,
    );
    const actions = data.checks.filter((c) => c.hint && (c.level === 'warn' || c.level === 'fail'));
    if (actions.length > 0) {
      out.print();
      out.heading(m.doctor.actions);
      for (const c of actions) {
        out.print(
          `  ${out.glyphs.arrow} ${out.code(checkHint(m, c) ?? '')}  ${out.style('muted', `(${checkLabel(m, c)})`)}`,
        );
      }
    }
    out.print();
    const { fail, warn } = data.summary;
    if (fail > 0) out.line('error', m.doctor.verdictFail(fail, warn));
    else if (warn > 0) out.line('warn', m.doctor.verdictWarn(warn));
    else out.line('ok', m.doctor.verdictOk);
  },
};

type Check = DoctorReport['checks'][number];

/** Libellé, constat et piste dans la langue de l'utilisateur (repli : texte de référence du domaine). */
export function checkLabel(m: Messages, c: Check): string {
  return m.doctorChecks.label(c.id) ?? c.label;
}

export function checkDetail(m: Messages, c: Check): string {
  return m.doctorChecks.detail(c.key, c.params) ?? c.detail;
}

export function checkHint(m: Messages, c: Check): string | null {
  return c.hint === null ? null : (m.doctorChecks.hint(c.key, c.params) ?? c.hint);
}
