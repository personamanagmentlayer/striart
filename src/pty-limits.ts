/**
 * Bornes de l'hôte de pty natif, source UNIQUE côté Node (config.js,
 * native.ts) : miroir de native/striart-native/src/pty_host/mod.rs
 * (`MIN_CLIENT_QUEUE_BYTES`, `min_client_queue_bytes`, `MAX_INITIAL_BYTES`).
 * Sans dépendance : importable au démarrage de n'importe quelle commande.
 */

/** Taille d'un morceau de sortie lu puis diffusé (octets) — `OUTPUT_CHUNK_BYTES`. */
export const PTY_OUTPUT_CHUNK_BYTES = 8 * 1024;
/** Marge d'une frame `data` au-delà du base64 (JSON, newline). */
const FRAME_OVERHEAD_BYTES = 64;

/** Plus grande frame `data` sur le fil : base64 du morceau (+3 octets UTF-8 reportés). */
export const PTY_MAX_DATA_FRAME_BYTES =
  Math.ceil((PTY_OUTPUT_CHUNK_BYTES + 3) / 3) * 4 + FRAME_OVERHEAD_BYTES;

/** Plancher absolu de la file d'un client. */
export const PTY_MIN_CLIENT_QUEUE_BYTES = 32 * 1024;

/**
 * File minimale d'un client pour un rejeu de `replayBytes` : le rejeu part en
 * UNE frame à l'attache (base64, ×4/3), puis la file doit encore accueillir
 * au moins deux frames de sortie — sinon le client est évincé dès la première
 * sortie, en boucle de reconnexion.
 */
export function ptyMinClientQueueBytes(replayBytes: number): number {
  return Math.max(
    PTY_MIN_CLIENT_QUEUE_BYTES,
    Math.ceil(replayBytes / 3) * 4 + FRAME_OVERHEAD_BYTES + 2 * PTY_MAX_DATA_FRAME_BYTES,
  );
}

/**
 * Plus longue commande initiale (octets UTF-8). Windows : elle voyage dans la
 * ligne de commande de l'hôte (32 767 caractères au total).
 */
export function ptyMaxInitialBytes(platform: string = process.platform): number {
  return platform === 'win32' ? 16 * 1024 : 64 * 1024;
}
