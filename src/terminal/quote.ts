import { StriartError } from '../errors.ts';

/**
 * Grammaires de citation des lanceurs de terminal. Chaque élément d'argv est
 * cité selon la grammaire de la cible qui le recevra, jamais interpolé dans
 * une chaîne libre. Module sans effet de bord, partagé par `terminal.js`
 * (façade), les lanceurs (`launchers.ts`), Warp (`warp.ts`) et
 * l'installation des hooks (`src/hooks/install.ts`).
 */

/** Caractères qu'aucune grammaire de lanceur ne sait représenter sur une ligne. */
export const UNREPRESENTABLE = /[\0\r\n]/;

/** Refus (TERMINAL_UNSAFE) d'une valeur qu'aucun lanceur ne sait transmettre. */
export function assertRepresentable(values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value !== 'string' || UNREPRESENTABLE.test(value)) {
      throw new StriartError(
        "Ouverture de terminal refusée : un chemin ou un argument contient un saut de ligne ou un caractère nul, qu'aucun lanceur de terminal ne sait transmettre.",
        { code: 'TERMINAL_UNSAFE', details: {} },
      );
    }
  }
}

/** Littéral PowerShell entre guillemets simples (apostrophes typographiques comprises). */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** Littéral POSIX sh entre guillemets simples (bash, zsh, dash : la barre oblique inverse y est littérale). */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Littéral fish entre guillemets simples. fish n'est PAS POSIX : dans ses
 * guillemets simples `\\` et `\'` sont des échappements — `quotePosix` y
 * déformait toute valeur contenant une barre oblique inverse (un `\` suivi
 * d'une apostrophe devenait une apostrophe littérale et rouvrait le guillemet,
 * S-M12). Ici `\` est doublée puis `'` précédée de `\`.
 */
export function quoteFish(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Citation d'une valeur dans une ligne « à copier » ou tapée dans un shell,
 * selon le shell qui la recevra. Jamais de guillemets doubles hors cmd :
 * bash, zsh, fish et PowerShell y expansent `$…` et les substitutions de
 * commande.
 *  - shell connu (`pwsh`, `bash`, `cmd`…) : sa grammaire ;
 *  - inconnu : PowerShell sous Windows, POSIX ailleurs.
 * cmd n'offre aucune citation sans expansion de `%VAR%` ; entre guillemets
 * doubles rien ne s'y exécute, seule une variable peut s'y développer.
 */
export function quoteForShell(
  value: string,
  { shell, platform = process.platform }: { shell: string | null; platform?: NodeJS.Platform },
): string {
  if (shell === 'pwsh' || shell === 'powershell') return quotePowerShell(value);
  if (shell === 'fish') return quoteFish(value);
  if (shell === 'cmd') return `"${value.replace(/"/g, '""')}"`;
  if (shell === null && platform === 'win32') return quotePowerShell(value);
  return quotePosix(value);
}

/** Littéral de chaîne AppleScript. */
export function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Windows Terminal découpe ses propres arguments sur `;` (sauf `\;`). */
export function escapeForWt(value: string): string {
  return value.replace(/;/g, '\\;');
}

/** Ligne PowerShell qui exécute argv tel quel (opérateur d'appel `&`). */
export function powerShellCommandLine(argv: readonly string[]): string {
  return `& ${argv.map(quotePowerShell).join(' ')}`;
}

/** Ligne fish qui exécute argv tel quel. */
export function fishCommandLine(argv: readonly string[]): string {
  return argv.map(quoteFish).join(' ');
}

/** Ligne POSIX (sh, bash, zsh) qui exécute argv tel quel. */
export function posixCommandLine(argv: readonly string[]): string {
  return argv.map(quotePosix).join(' ');
}

/**
 * Windows PowerShell 5.1 (le `powershell` par défaut) retire les guillemets
 * doubles internes en passant des arguments à un programme natif — vérifié
 * par exécution réelle. Un nom de fichier Windows ne peut pas contenir `"` :
 * refuser est sans perte, déformer en silence ne l'est pas.
 */
export function assertNoDoubleQuoteForWindowsPowerShell(argv: readonly string[]): void {
  if (argv.some((arg) => arg.includes('"'))) {
    throw new StriartError(
      'Ouverture de terminal refusée : un argument contient un guillemet double, que Windows PowerShell 5.1 ne transmet pas fidèlement.',
      { code: 'TERMINAL_UNSAFE', details: {} },
    );
  }
}
