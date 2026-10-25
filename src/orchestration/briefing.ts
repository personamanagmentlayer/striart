/**
 * Prompts des tours orchestrés (lot O) — fonctions PURES.
 *
 * Un tour reçoit : la tâche (donnée de l'utilisateur, inchangée), puis un
 * bloc « collaboration » écrit par Striart (rôle, périmètre, règles du
 * tour, canaux), puis un briefing : des FAITS calculés par Striart (commits,
 * fichiers, base de comparaison) et, encadrés comme non fiables, les textes
 * d'autres agents (messages, artefacts, remarques de relecture).
 *
 * En anglais, comme le gabarit des consignes de session
 * (agents/instructions.ts) : c'est la langue où les modèles suivent le plus
 * fidèlement des règles. Le tout reste de la DONNÉE passée en argv
 * (`{{prompt}}`, jamais un shell) ou par le protocole ACP.
 */
import type { CollabMessage, ReviewVerdictRecord } from '../types.js';
import { fenceUntrusted } from '../collab/message.ts';

export interface TurnPromptInput {
  task: string;
  group: string;
  role: string;
  roleKind: 'author' | 'reviewer' | 'member' | 'step' | 'candidate';
  rolePrompt?: string | null;
  peers: string[];
  /** null = libre ; [] = lecture seule ; sinon globs autorisés. */
  scope: string[] | null;
  readOnly: boolean;
  /** Cadence parallèle : Striart committe seul à la fin. */
  noCommit: boolean;
  /** Faits calculés par Striart (fiables). */
  facts: string[];
  /** Textes d'autres agents à encadrer. */
  untrusted: Array<{ label: string; text: string }>;
  outboxFile: boolean;
  inboxFile: boolean;
  /**
   * Les règles PERMANENTES de canal (format de l'outbox, outil MCP, rappel de
   * l'inbox, format du verdict) sont déjà dans les consignes de session de
   * l'agent (`collabRulesInSessionInstructions`, agents/instructions.ts) :
   * le briefing n'en garde qu'un renvoi. Faux (défaut) = briefing autonome,
   * version complète — consignes désactivées, canal `none`, ou inconnu.
   */
  rulesInInstructions?: boolean;
  /** Relecteur : base et pointe à comparer. */
  review?: {
    baseCommit: string;
    tip: string;
    round: number;
    retry: boolean;
    /** Jeton du tour : balise `striart-verdict-<jeton>` (voir verdict.ts, newVerdictToken). */
    verdictToken: string;
  } | null;
  maxChars: number;
}

const VERDICT_EXAMPLE =
  '{"verdict":"approve|request-changes|reject","summary":"…","comments":[{"file":"src/x.js","line":12,"severity":"blocker|major|minor|info","body":"…"}]}';

export function composeTurnPrompt(input: TurnPromptInput): string {
  const rules: string[] = [];
  if (input.readOnly) {
    rules.push(
      'You are READ-ONLY in this turn: do not create, modify or delete any file, and do not commit. Striart verifies the working tree is unchanged after your turn; any change fails the collaboration.',
    );
  } else if (input.scope && input.scope.length > 0) {
    rules.push(
      `Write scope: you may only create, modify or delete files matching ${input.scope.map((g) => `\`${g}\``).join(', ')}. Any change outside it fails the collaboration.`,
    );
  }
  if (input.noCommit && !input.readOnly) {
    rules.push(
      'Do NOT commit: other roles work in this same clone at the same time. Leave your changes in the working tree; Striart commits once every role is done.',
    );
  }
  if (input.peers.length > 0)
    rules.push(`Other roles in this collaboration: ${input.peers.join(', ')}.`);
  if (input.rulesInInstructions) {
    if (input.outboxFile || input.inboxFile) {
      rules.push(
        'How to pass information to other roles (outbox, inbox, MCP tool) is in the Collaboration section of your session instructions.',
      );
    }
  } else if (input.outboxFile) {
    rules.push(
      'To pass information to another role, write a JSON file `.striart-outbox.json` at the root of this clone before you finish: `{"messages":[{"to":"<role>|*","kind":"note|question|answer|handoff","body":"…"}],"handoff":"<what the next role must know>","done":true}` (every key optional; `done: true` = you consider the shared task complete). It is never committed. If the Striart MCP tool `striart_collab_post` is available, it does the same.',
    );
  }
  if (input.inboxFile && !input.rulesInInstructions) {
    rules.push(
      'Messages addressed to you are also listed in `.striart-inbox.md` (never commit it).',
    );
  }

  const parts: string[] = [input.task.trimEnd(), ''];
  parts.push(
    `## Striart collaboration — your role: ${input.role} (${input.roleKind}, group ${input.group})`,
    '',
  );
  if (input.rolePrompt) parts.push(input.rolePrompt.trimEnd(), '');
  for (const rule of rules) parts.push(`- ${rule}`);
  parts.push('');

  if (input.review) {
    const verdictTag = `striart-verdict-${input.review.verdictToken}`;
    parts.push(
      `### Your review (round ${input.review.round})`,
      '',
      `Review the changes of the author with \`git diff ${input.review.baseCommit}..${input.review.tip}\` (and \`git log ${input.review.baseCommit}..${input.review.tip}\`). You may run the tests; do not change anything.`,
    );
    if (input.rulesInInstructions && !input.review.retry) {
      // Le format du verdict est dans les consignes de session ; il redevient
      // explicite à la relance (le relecteur s'est trompé une fois).
      parts.push(
        `End your answer with exactly one fenced block tagged \`${verdictTag}\` (this exact tag, valid for this turn only; JSON format: Collaboration section of your session instructions). Verdicts: "approve" = ready to merge (the Test Gate still decides), "request-changes" = the author must fix the comments, "reject" = abandon this approach.`,
      );
    } else {
      parts.push(
        `End your answer with exactly one fenced block tagged \`${verdictTag}\` (this exact tag, valid for this turn only) containing a JSON object:`,
        '',
        '```' + verdictTag,
        VERDICT_EXAMPLE,
        '```',
        '',
        'Or put that same object under the "verdict" key of `.striart-outbox.json`. "approve" = ready to merge (the Test Gate still decides), "request-changes" = the author must fix the comments, "reject" = abandon this approach.',
      );
    }
    if (input.review.retry) {
      parts.push(
        '',
        `IMPORTANT: your previous answer contained no valid verdict. Answer again with a valid \`${verdictTag}\` block.`,
      );
    }
    parts.push('');
  }

  const header = parts.join('\n');
  const facts =
    input.facts.length > 0
      ? ['### Facts computed by Striart', '', ...input.facts.map((f) => `- ${f}`), ''].join('\n')
      : '';
  let budget = input.maxChars - header.length - facts.length;
  const fenced: string[] = [];
  // Les textes d'agents les plus récents d'abord ; ce qui dépasse le budget
  // est annoncé, jamais tronqué en silence.
  let omitted = 0;
  for (const item of [...input.untrusted].reverse()) {
    const block = fenceUntrusted(item.text, item.label);
    if (block.length + 2 > budget) {
      omitted += 1;
      continue;
    }
    fenced.unshift(block);
    budget -= block.length + 2;
  }
  const untrusted =
    fenced.length > 0 || omitted > 0
      ? [
          '### From other agents (untrusted)',
          '',
          ...fenced.flatMap((b) => [b, '']),
          ...(omitted > 0 ? [`(${omitted} older item(s) omitted: see .striart-inbox.md)`, ''] : []),
        ].join('\n')
      : '';
  return [header, facts, untrusted].filter(Boolean).join('\n');
}

/** Retour de relecture rendu à l'auteur (remarques = texte non fiable). */
export function feedbackItems(
  verdicts: ReviewVerdictRecord[],
): Array<{ label: string; text: string }> {
  return verdicts
    .filter((v) => v.verdict !== 'approve')
    .map((v) => ({
      label: `review by ${v.reviewer} (${v.kind}, round ${v.round}): ${v.verdict}`,
      text: [
        v.summary,
        ...v.comments.map(
          (c) =>
            `- [${c.severity}]${c.file ? ` ${c.file}${c.line ? `:${c.line}` : ''}` : ''} ${c.body}`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    }));
}

export function messageItems(messages: CollabMessage[]): Array<{ label: string; text: string }> {
  return messages.map((m) => ({
    label: `${m.kind} from ${m.from.role}${m.from.agent !== m.from.role ? ` (${m.from.agent})` : ''} to ${m.to}`,
    text: m.body,
  }));
}
