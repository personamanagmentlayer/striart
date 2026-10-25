import { StriartError } from './errors.js';

/**
 * Évaluation JS des motifs `secretPatterns` (syntaxe gitignore) sur des
 * chemins qui n'existent plus dans l'index — l'historique, pour
 * `scanHistoricalSecrets` (S-I3). Les fichiers TRACKÉS ne passent jamais par
 * ici : leur exclusion est calculée par git lui-même (`ls-files --exclude`),
 * donc par le même moteur que celui du sparse-checkout.
 *
 * Sémantique gitignore reproduite :
 *  - un motif sans `/` (hors `/` final) matche le nom à toute profondeur ;
 *  - un `/` initial ou intermédiaire ancre le motif à la racine du dépôt ;
 *  - `/` final : ne désigne qu'un dossier (donc tout ce qu'il contient) ;
 *  - `**` : en tête, au milieu (zéro dossier ou plus) ou en fin de motif (tout le contenu) ;
 *  - `*`, `?`, `[...]` (jamais à travers un `/`), `\x` littéral ;
 *  - un chemin est désigné si le motif désigne lui-même OU l'un de ses dossiers parents.
 * La casse est ignorée : sur un système de fichiers insensible à la casse
 * (Windows, macOS) `.ENV` EST `.env`, et un faux positif ne fait que
 * refuser (fail closed), jamais laisser passer.
 *
 * Non supporté, donc REFUSÉ : la négation `!` (le sparse-checkout inverse la
 * sienne) et le commentaire `#`.
 */

export function assertSecretPatternSyntax(pattern: string): void {
  if (
    pattern.startsWith('!') ||
    pattern.startsWith('#') ||
    /[\0\r\n]/.test(pattern) ||
    pattern.trim().length === 0
  ) {
    throw new StriartError(
      `secretPatterns: motif non supporté ${JSON.stringify(pattern)} (ni négation "!", ni commentaire "#", ni vide, ni saut de ligne).`,
      {
        code: 'SECRET_PATTERN_INVALID',
        hint: 'Corrige secretPatterns dans striart.config.',
        details: { pattern },
      },
    );
  }
}

function translateSegment(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (c === '\\' && i + 1 < segment.length) {
      i += 1;
      out += segment[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '*') {
      while (segment[i + 1] === '*') i += 1;
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = segment.indexOf(']', i + 2);
      if (end === -1) {
        out += '\\[';
      } else {
        let body = segment.slice(i + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      out += c.replace(/[.+^${}()|\]\\]/g, '\\$&');
    }
  }
  return out;
}

export interface CompiledSecretPattern {
  re: RegExp;
  dirOnly: boolean;
}

export function compileSecretPattern(pattern: string): CompiledSecretPattern {
  assertSecretPatternSyntax(pattern);
  let p = pattern.trim();
  const dirOnly = p.endsWith('/');
  p = p.replace(/\/+$/, '');
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  const segments = p.split('/');
  let src = '';
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === '**') {
      src += last ? '.*' : '(?:.*/)?';
    } else {
      src += translateSegment(segment) + (last ? '' : '/');
    }
  });
  return { re: new RegExp(anchored ? `^${src}$` : `^(?:.*/)?${src}$`, 'i'), dirOnly };
}

/** `file` (chemin relatif à la racine, `/`) est-il désigné par ce motif, lui ou un de ses dossiers ? */
export function secretPatternMatches(compiled: CompiledSecretPattern, file: string): boolean {
  const parts = file.split('/');
  let prefix = '';
  for (let i = 0; i < parts.length; i += 1) {
    prefix = i === 0 ? parts[0] : `${prefix}/${parts[i]}`;
    const isFile = i === parts.length - 1;
    if (isFile && compiled.dirOnly) continue;
    if (compiled.re.test(prefix)) return true;
  }
  return false;
}
