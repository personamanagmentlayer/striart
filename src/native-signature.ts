/**
 * Schémas de signature du manifeste des binaires natifs — registre par nom.
 *
 * Le manifeste (`native-manifest.json`, généré par scripts/pack.ts) porte les
 * empreintes SHA-256 attendues de chaque binaire ; il est signé, et sa
 * signature (`native-manifest.sig.json`) NOMME son schéma. La vérification
 * choisit le vérificateur par ce nom, jamais par défaut implicite : un schéma
 * inconnu est un refus (fail closed), pas un « non vérifié ».
 *
 * Ajouter un schéma (cosign, Authenticode…) = un module qui exporte un
 * `SignatureScheme` + sa ligne dans `SCHEMES` ci-dessous. Rien d'autre ne
 * change : ni src/native.ts, ni le format du manifeste, ni scripts/pack.ts
 * (qui signe par `getSignatureScheme(nom).sign`).
 *
 * La clé publique d'un schéma vit dans le dépôt et dans le paquet publié :
 * `native/keys/<schéma>.pub`. La clé privée n'existe qu'en variable
 * d'environnement de CI (voir CONTRIBUTING.md) — jamais dans le dépôt.
 */
import { minisign } from './native-signature-minisign.ts';

/** Matériel de signature d'un schéma, lu depuis l'environnement de CI. */
export interface SigningSecret {
  /** Contenu de la clé privée (format propre au schéma). */
  key: string;
  /** Mot de passe de la clé, si elle est chiffrée. */
  password: string | null;
}

export interface KeyPairOptions {
  password?: string | null;
  /** Coût du KDF (schémas à clé chiffrée) ; défaut = celui de l'outil de référence. */
  kdf?: { opslimit: bigint; memlimit: bigint };
}

export interface SignatureScheme {
  /** Nom stable, inscrit dans le fichier de signature (`[a-z0-9-]+`). */
  readonly name: string;
  /**
   * Vérifie `signature` sur `data` avec `publicKey`. Rend l'identifiant de la
   * clé qui a signé ; LÈVE (Error) si la signature est invalide, mal formée
   * ou d'une autre clé — jamais un booléen ignorable.
   */
  verify(data: Buffer, signature: string, publicKey: string): { keyId: string };
  /**
   * Signe `data` (scripts/pack.ts). `fileName` alimente les métadonnées
   * signées du schéma quand il en a. Lève si la clé ne correspond pas à
   * `publicKey` : une archive signée d'une autre clé serait invérifiable.
   */
  sign(
    data: Buffer,
    secret: SigningSecret,
    publicKey: string,
    fileName: string,
  ): { signature: string; keyId: string };
  /**
   * Nouvelle paire de clés. Sans option : clé privée en clair, JETABLE
   * (scripts/pack.ts --ephemeral-signing-key : archive de vérification locale
   * ou de CI sans accès au secret de release). Avec `password` : clé privée
   * chiffrée (scripts/native-keygen.ts) ; `kdf` règle le coût du chiffrement
   * (tests).
   */
  generateKeyPair(options?: KeyPairOptions): { publicKey: string; secret: SigningSecret };
}

const SCHEMES: readonly SignatureScheme[] = [minisign];

/** Schéma utilisé par défaut par scripts/pack.ts (surchargeable : --signing-scheme). */
export const DEFAULT_SIGNATURE_SCHEME = minisign.name;

export const SCHEME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function signatureSchemeNames(): string[] {
  return SCHEMES.map((scheme) => scheme.name);
}

/** Schéma enregistré sous ce nom, ou null (l'appelant décide du refus). */
export function getSignatureScheme(name: string): SignatureScheme | null {
  if (!SCHEME_NAME_RE.test(name)) return null;
  return SCHEMES.find((scheme) => scheme.name === name) ?? null;
}

/** Chemin (relatif à la racine du paquet) de la clé publique d'un schéma. */
export function publicKeyPath(schemeName: string): string {
  if (!SCHEME_NAME_RE.test(schemeName)) {
    throw new Error(`invalid signature scheme name: ${schemeName}`);
  }
  return `native/keys/${schemeName}.pub`;
}
