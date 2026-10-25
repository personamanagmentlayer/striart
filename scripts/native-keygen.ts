#!/usr/bin/env node
// Génère la paire de clés qui signe le manifeste des binaires natifs.
//
// Usage : node scripts/native-keygen.ts --secret-out <fichier> [--scheme <nom>]
//                                        [--rotate]
//                                        (--password-env <VARIABLE> | --unencrypted)
//         (ou : npm run native:keygen -- <options>)
//
// - clé publique → native/keys/<schéma>.pub (versionnée, publiée dans le
//   paquet : c'est elle qui vérifie les binaires au chargement) ; une clé
//   existante n'est remplacée qu'avec --rotate (rotation explicite). Le
//   keyId de la nouvelle clé doit ENSUITE être épinglé dans le code
//   (PINNED_NATIVE_KEY_IDS, src/native.ts) ;
// - clé privée → `--secret-out` : chemin ABSOLU, HORS du dépôt, fichier neuf
//   (jamais écrasé), droits 0600. À stocker aussitôt comme secret de CI
//   (STRIART_NATIVE_SIGNING_KEY), puis à effacer du disque — voir
//   CONTRIBUTING.md, « Composants natifs » ;
// - chiffrement : --password-env <VARIABLE> chiffre la clé privée (scrypt) avec
//   le mot de passe lu dans cette variable d'environnement (jamais en argument) ;
//   --unencrypted écrit la clé EN CLAIR (choix explicite, à réserver à un coffre
//   de secrets). L'un des deux est exigé : pas de clé en clair par omission.
//
// Atomicité : tout est calculé AVANT la première écriture ; la clé publique
// n'est écrite que si la clé privée l'a été, et elle est restaurée si la
// seconde écriture échoue — jamais de paire à moitié créée (une clé privée
// orpheline en clair, une clé publique sans secret).
//
// La clé privée n'est jamais écrite sur stdout ni sur stderr.

import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_SIGNATURE_SCHEME,
  getSignatureScheme,
  publicKeyPath,
  signatureSchemeNames,
} from '../src/native-signature.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Erreur d'outillage : message actionnable, `usage` = sortie 2. */
export class KeygenError extends Error {
  readonly usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.name = 'KeygenError';
    this.usage = usage;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface KeygenOptions {
  /** Racine du dépôt (défaut : celle de ce script) ; la clé publique y est écrite. */
  repoRoot?: string;
  secretOut: string | undefined;
  scheme?: string;
  rotate?: boolean;
  /** Mot de passe de chiffrement de la clé privée ; null = en clair (--unencrypted). */
  password: string | null;
  /** Coût du chiffrement (tests) ; défaut = celui de minisign. */
  kdf?: { opslimit: bigint; memlimit: bigint };
}

export interface KeygenResult {
  keyId: string;
  publicFile: string;
  secretFile: string;
  encrypted: boolean;
}

/**
 * Génère et écrit la paire. Toutes les validations et le calcul précèdent la
 * première écriture ; en cas d'échec de la seconde écriture, la première est
 * annulée (clé privée supprimée, clé publique précédente restaurée).
 */
export async function generateSigningKeys(options: KeygenOptions): Promise<KeygenResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const scheme = getSignatureScheme(options.scheme ?? DEFAULT_SIGNATURE_SCHEME);
  if (!scheme) {
    throw new KeygenError(
      `Schéma inconnu : ${options.scheme} (connus : ${signatureSchemeNames().join(', ')}).`,
      true,
    );
  }
  const { secretOut } = options;
  if (!secretOut || !path.isAbsolute(secretOut)) {
    throw new KeygenError('--secret-out <chemin absolu> est requis (hors du dépôt).', true);
  }
  // Le dossier cible doit exister : son chemin réel tranche « dans le dépôt ? »
  // même à travers un lien.
  const secretDir = await fs.realpath(path.dirname(secretOut)).catch(() => null);
  if (!secretDir) throw new KeygenError(`Dossier absent : ${path.dirname(secretOut)}`);
  if (isInside(secretDir, realpathSync(repoRoot))) {
    throw new KeygenError('La clé privée ne doit jamais être écrite dans le dépôt.', true);
  }
  const secretFile = path.join(secretDir, path.basename(secretOut));
  if (await fs.stat(secretFile).catch(() => null)) {
    throw new KeygenError(`${secretFile} existe déjà : un secret n'est jamais écrasé.`, true);
  }
  const publicFile = path.join(repoRoot, ...publicKeyPath(scheme.name).split('/'));
  const previousPublic = await fs.readFile(publicFile).catch(() => null);
  if (previousPublic !== null && !options.rotate) {
    throw new KeygenError(
      `${publicFile} existe déjà : --rotate pour remplacer la clé (les paquets déjà publiés restent vérifiés par l'ancienne).`,
      true,
    );
  }

  // 1. Tout le calcul, y compris l'auto-contrôle, AVANT toute écriture.
  const pair = scheme.generateKeyPair({
    password: options.password,
    ...(options.kdf ? { kdf: options.kdf } : {}),
  });
  const probe = Buffer.from('keygen self-check');
  const { keyId } = scheme.verify(
    probe,
    scheme.sign(probe, pair.secret, pair.publicKey, 'self-check').signature,
    pair.publicKey,
  );

  // 2. Écritures : la clé privée d'abord (`wx` : jamais d'écrasement), puis la
  // publique ; si la publique échoue, la privée est retirée.
  await fs.writeFile(secretFile, pair.secret.key, { flag: 'wx', mode: 0o600 });
  try {
    await fs.mkdir(path.dirname(publicFile), { recursive: true });
    await fs.writeFile(publicFile, pair.publicKey);
  } catch (error) {
    await fs.rm(secretFile, { force: true });
    if (previousPublic !== null)
      await fs.writeFile(publicFile, previousPublic).catch(() => undefined);
    throw new KeygenError(
      `Écriture de la clé publique impossible (${(error as Error).message}) : rien n'a été créé.`,
    );
  }
  return { keyId, publicFile, secretFile, encrypted: options.password !== null };
}

async function main(): Promise<void> {
  const fail = (error: unknown): never => {
    const usage = error instanceof KeygenError && error.usage;
    process.stderr.write(`✖ ${(error as Error).message}\n`);
    process.exit(usage ? 2 : 1);
  };
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        'secret-out': { type: 'string' },
        scheme: { type: 'string', default: DEFAULT_SIGNATURE_SCHEME },
        rotate: { type: 'boolean', default: false },
        'password-env': { type: 'string' },
        unencrypted: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    return fail(new KeygenError((error as Error).message, true));
  }
  let password: string | null = null;
  if (values['password-env'] !== undefined && values.unencrypted) {
    return fail(new KeygenError('--password-env et --unencrypted sont incompatibles.', true));
  }
  if (values['password-env'] !== undefined) {
    password = process.env[values['password-env']] ?? '';
    if (password === '') {
      return fail(
        new KeygenError(`La variable ${values['password-env']} est vide ou absente.`, true),
      );
    }
  } else if (!values.unencrypted) {
    return fail(
      new KeygenError(
        'Chiffrer la clé privée (--password-env <VARIABLE>) ou accepter explicitement le clair (--unencrypted) : pas de clé en clair par omission.',
        true,
      ),
    );
  }
  try {
    const result = await generateSigningKeys({
      secretOut: values['secret-out'],
      scheme: values.scheme,
      rotate: values.rotate,
      password,
    });
    process.stderr.write(
      `Clé ${values.scheme} ${result.keyId} générée${result.encrypted ? ' (clé privée chiffrée)' : ' (clé privée EN CLAIR)'}.\n` +
        `  publique : ${result.publicFile} (à commiter)\n` +
        `  privée   : ${result.secretFile} (droits 0600)\n` +
        '  → la stocker comme secret de CI STRIART_NATIVE_SIGNING_KEY (contenu du fichier),\n' +
        '    puis effacer le fichier du disque.\n' +
        `  → épingler ${result.keyId} dans PINNED_NATIVE_KEY_IDS (src/native.ts), dans le même commit.\n`,
    );
    process.stdout.write(`${result.keyId}\n`);
  } catch (error) {
    fail(error);
  }
}

function isEntryPoint(): boolean {
  const flag = (import.meta as { main?: unknown }).main;
  if (typeof flag === 'boolean') return flag;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Chemin d'entrée illisible : ce n'est pas nous.
    return false;
  }
}

if (isEntryPoint()) await main();
