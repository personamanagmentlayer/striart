/**
 * Scripts de complétion shell, générés depuis l'arbre RÉEL des commandes
 * commander (jamais une liste tenue à la main qui dériverait).
 *
 * Les valeurs dynamiques (noms d'agents, tickets, profils) viennent de
 * `striart __complete <type>`, qui lit les fichiers de `.striart/` sans
 * lancer git : la complétion reste instantanée.
 */
import type { Command, Option } from 'commander';
import type { Messages } from './i18n/fr.ts';
import { quotePowerShell } from '../terminal.js';

import type { Shell } from './registry.ts';

export type { Shell } from './registry.ts';

/** Nature d'une valeur à compléter. */
type ValueKind = 'agents' | 'tickets' | 'profiles' | 'file' | null;

/**
 * Ce qu'on complète : une nature dynamique (`striart __complete <nature>`) ou
 * une énumération FERMÉE (`.choices()` de commander — source unique, la même
 * liste valide la valeur ET la complète).
 */
type Completable = ValueKind | readonly string[];

/** Une valeur d'énumération est insérée telle quelle dans un script de shell : jeu de caractères fermé. */
const SAFE_CHOICE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function choicesOf(choices: readonly string[] | undefined): readonly string[] | null {
  if (!choices || choices.length === 0) return null;
  const bad = choices.find((c) => !SAFE_CHOICE.test(c));
  if (bad !== undefined) {
    throw new Error(`Enumeration value unsafe in a completion script: ${bad}`);
  }
  return choices;
}

const isChoices = (value: Completable): value is readonly string[] => Array.isArray(value);

/** Même drapeau déclaré par plusieurs commandes : les énumérations s'unissent. */
function mergeCompletable(a: Completable | undefined, b: Completable): Completable {
  if (a === undefined || a === null) return b;
  if (isChoices(a) && isChoices(b)) return [...new Set([...a, ...b])];
  return a;
}

interface OptionSpec {
  flags: string[];
  description: string;
  takesValue: boolean;
  value: Completable;
}

interface CommandSpecForCompletion {
  name: string;
  description: string;
  options: OptionSpec[];
  /** Nature du premier argument positionnel, s'il y en a un. */
  argument: Completable;
}

const OPTION_VALUES: Record<string, ValueKind> = {
  '--agent': 'agents',
  '--after': 'agents',
  '--close': 'tickets',
  '--prepare': 'tickets',
  '--accept-theirs': 'file',
  '--apply': 'tickets',
  '--profile': 'profiles',
};

const ARGUMENT_VALUES: Record<string, ValueKind> = { agent: 'agents', file: 'file' };

function optionSpec(option: Option): OptionSpec {
  const flags = [option.short, option.long].filter((f): f is string => Boolean(f));
  return {
    flags,
    description: option.description,
    takesValue: option.required || option.optional,
    value:
      choicesOf(option.argChoices) ?? (option.long ? OPTION_VALUES[option.long] : null) ?? null,
  };
}

export function describeProgram(program: Command): {
  commands: CommandSpecForCompletion[];
  globalOptions: OptionSpec[];
} {
  const commands = program.commands
    .filter((cmd) => !(cmd as unknown as { _hidden?: boolean })._hidden)
    .map((cmd) => {
      const [first] = cmd.registeredArguments;
      return {
        name: cmd.name(),
        description: cmd.summary() || cmd.description(),
        options: cmd.options.filter((o) => !o.hidden).map(optionSpec),
        argument: first
          ? (choicesOf(first.argChoices) ?? ARGUMENT_VALUES[first.name()] ?? null)
          : null,
      };
    });
  return { commands, globalOptions: program.options.filter((o) => !o.hidden).map(optionSpec) };
}

// ------------------------------------------------------------------ bash

function bashValues(kind: Completable): string {
  if (isChoices(kind)) return `COMPREPLY=( $(compgen -W "${kind.join(' ')}" -- "$cur") )`;
  if (kind === 'file') return 'COMPREPLY=( $(compgen -f -- "$cur") )';
  // Jamais `compgen -W` sur une sortie dynamique : compgen réexpanse chaque
  // mot (substitution de commande comprise). Lecture ligne à ligne et
  // filtrage par préfixe littéral : la valeur reste de la donnée.
  if (kind) return `_striart_values ${kind}`;
  return 'COMPREPLY=()';
}

function bash(spec: ReturnType<typeof describeProgram>, header: string): string {
  const names = spec.commands.map((c) => c.name).join(' ');
  const globals = spec.globalOptions.flatMap((o) => o.flags).join(' ');
  const valueOptions = new Map<string, Completable>();
  for (const c of spec.commands)
    for (const o of c.options)
      if (o.takesValue)
        for (const f of o.flags)
          valueOptions.set(f, mergeCompletable(valueOptions.get(f), o.value));
  const prevCases = [...valueOptions]
    .map(([flag, kind]) => `    ${flag}) ${bashValues(kind)}; return ;;`)
    .join('\n');
  const cmdCases = spec.commands
    .map((c) => {
      const opts = [
        ...c.options.flatMap((o) => o.flags),
        ...spec.globalOptions.flatMap((o) => o.flags),
      ].join(' ');
      return `    ${c.name})\n      if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W "${opts}" -- "$cur") ); else ${bashValues(c.argument)}; fi ;;`;
    })
    .join('\n');
  return `${header}
_striart_values() {
  local value
  COMPREPLY=()
  while IFS= read -r value; do
    [[ "$value" == "$cur"* ]] && COMPREPLY+=("$value")
  done < <(striart __complete "$1" 2>/dev/null)
}
_striart() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names} ${globals}" -- "$cur") )
    return
  fi
  case "$prev" in
${prevCases}
  esac
  case "\${COMP_WORDS[1]}" in
${cmdCases}
  esac
}
complete -F _striart striart
`;
}

// ------------------------------------------------------------------- zsh

function zshEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, `'\\''`)
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function zshAction(kind: Completable): string {
  if (isChoices(kind)) return `(${kind.join(' ')})`;
  if (kind === 'file') return '_files';
  if (kind) return `{_striart_values ${kind}}`;
  return ' ';
}

function zsh(spec: ReturnType<typeof describeProgram>, header: string): string {
  const described = spec.commands
    .map((c) => `    '${zshEscape(c.name)}:${zshEscape(c.description)}'`)
    .join('\n');
  const cases = spec.commands
    .map((c) => {
      const args = [...c.options, ...spec.globalOptions].map((o) => {
        const value = o.takesValue ? `:value:${zshAction(o.value)}` : '';
        const tail = `[${zshEscape(o.description)}]${value}`;
        // Plusieurs drapeaux : l'expansion {-x,--long} reste HORS des guillemets.
        return o.flags.length > 1
          ? `        {${o.flags.join(',')}}'${tail}'`
          : `        '${o.flags[0]}${tail}'`;
      });
      if (c.argument) args.push(`        '1:value:${zshAction(c.argument)}'`);
      return `    ${c.name})\n      _arguments -s \\\n${args.join(' \\\n')} ;;`;
    })
    .join('\n');
  return `#compdef striart
${header}
_striart_values() {
  local -a values
  values=(\${(f)"$(striart __complete $1 2>/dev/null)"})
  compadd -a values
}
_striart() {
  local -a commands
  commands=(
${described}
  )
  if (( CURRENT == 2 )); then
    _describe 'commande' commands
    return
  fi
  local cmd=\${words[2]}
  shift words
  (( CURRENT-- ))
  case $cmd in
${cases}
  esac
}
compdef _striart striart
`;
}

// ------------------------------------------------------------------ fish

function fishEscape(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function fish(spec: ReturnType<typeof describeProgram>, header: string): string {
  const lines = [header, 'complete -c striart -f'];
  for (const c of spec.commands) {
    lines.push(
      `complete -c striart -n __fish_use_subcommand -a ${fishEscape(c.name)} -d ${fishEscape(c.description)}`,
    );
    for (const o of c.options) {
      const parts = [`complete -c striart -n '__fish_seen_subcommand_from ${c.name}'`];
      for (const flag of o.flags)
        parts.push(flag.startsWith('--') ? `-l ${flag.slice(2)}` : `-s ${flag.slice(1)}`);
      if (o.takesValue) parts.push('-r');
      if (isChoices(o.value)) parts.push(`-a '${o.value.join(' ')}'`);
      else if (o.value === 'file') parts.push('-F');
      else if (o.value) parts.push(`-a '(striart __complete ${o.value} 2>/dev/null)'`);
      parts.push(`-d ${fishEscape(o.description)}`);
      lines.push(parts.join(' '));
    }
    if (isChoices(c.argument))
      lines.push(
        `complete -c striart -n '__fish_seen_subcommand_from ${c.name}' -a '${c.argument.join(' ')}'`,
      );
    else if (c.argument === 'file')
      lines.push(`complete -c striart -n '__fish_seen_subcommand_from ${c.name}' -F`);
    else if (c.argument) {
      lines.push(
        `complete -c striart -n '__fish_seen_subcommand_from ${c.name}' -a '(striart __complete ${c.argument} 2>/dev/null)'`,
      );
    }
  }
  for (const o of spec.globalOptions) {
    const parts = ['complete -c striart'];
    for (const flag of o.flags)
      parts.push(flag.startsWith('--') ? `-l ${flag.slice(2)}` : `-s ${flag.slice(1)}`);
    parts.push(`-d ${fishEscape(o.description)}`);
    lines.push(parts.join(' '));
  }
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------ PowerShell

/**
 * Texte en ASCII pur. Windows PowerShell 5.1 lit un script sans BOM dans la
 * page de code ANSI : les octets UTF-8 de « → » (E2 86 92) y deviennent
 * « â†’ », et 0x92 est… une apostrophe typographique, qui ferme la chaîne
 * (constaté à l'analyse réelle). Le script de complétion PowerShell est donc
 * entièrement ASCII, quel que soit l'encodage par lequel il transite.
 */
export function toAscii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/→/g, '->')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[  ]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?');
}

/** Littéral PowerShell ASCII : même citation que les onglets de terminal. */
const psString = (text: string): string => quotePowerShell(toAscii(text));

/** Nature PowerShell d'une valeur : `choices:a,b` pour une énumération, sinon la nature dynamique. */
const psKind = (kind: Completable): string =>
  isChoices(kind) ? `choices:${kind.join(',')}` : (kind ?? '');

function powershell(spec: ReturnType<typeof describeProgram>, header: string): string {
  const commands = spec.commands
    .map((c) => `    @{ Name = ${psString(c.name)}; Description = ${psString(c.description)} }`)
    .join('\n');
  const options = spec.commands
    .map((c) => {
      const flags = [...c.options, ...spec.globalOptions]
        .flatMap((o) => o.flags)
        .map(psString)
        .join(', ');
      return `    ${psString(c.name)} = @(${flags})`;
    })
    .join('\n');
  const valueOptions = new Map<string, Completable>();
  for (const c of spec.commands)
    for (const o of c.options)
      if (o.takesValue && o.value)
        for (const f of o.flags)
          valueOptions.set(f, mergeCompletable(valueOptions.get(f), o.value));
  const values = [...valueOptions]
    .map(([flag, kind]) => `    ${psString(flag)} = ${psString(psKind(kind))}`)
    .join('\n');
  const args = spec.commands
    .filter((c) => c.argument && c.argument !== 'file')
    .map((c) => `    ${psString(c.name)} = ${psString(psKind(c.argument))}`)
    .join('\n');
  return `${toAscii(header)}
Register-ArgumentCompleter -Native -CommandName striart -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(
${commands}
  )
  $options = @{
${options}
  }
  $valueOptions = @{
${values}
  }
  $argumentValues = @{
${args}
  }
  $words = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($wordToComplete -ne '' -and $words.Count -gt 0) { $words = $words[0..($words.Count - 2)] }
  if ($words.Count -le 1) {
    $commands | Where-Object { $_.Name -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_.Name, $_.Name, 'ParameterValue', $_.Description)
    }
    return
  }
  $command = $words[1]
  $previous = $words[-1]
  $kind = $valueOptions[$previous]
  if (-not $kind -and -not $wordToComplete.StartsWith('-') -and $words.Count -eq 2) { $kind = $argumentValues[$command] }
  if ($kind -and $kind.StartsWith('choices:')) {
    $kind.Substring(8).Split(',') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    return
  }
  if ($kind) {
    & striart __complete $kind 2>$null | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    return
  }
  $options[$command] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
  }
}
`;
}

const INSTALL: Record<Shell, string> = {
  bash: 'striart completion bash >> ~/.bashrc',
  zsh: 'striart completion zsh > "${fpath[1]}/_striart"',
  fish: 'striart completion fish > ~/.config/fish/completions/striart.fish',
  powershell: 'striart completion powershell >> $PROFILE',
};

export function completionScript(shell: Shell, program: Command, m: Messages): string {
  const spec = describeProgram(program);
  const header = m.completion.header(shell === 'powershell' ? 'PowerShell' : shell, INSTALL[shell]);
  switch (shell) {
    case 'bash':
      return bash(spec, header);
    case 'zsh':
      return zsh(spec, header);
    case 'fish':
      return fish(spec, header);
    case 'powershell':
      return powershell(spec, header);
  }
}
