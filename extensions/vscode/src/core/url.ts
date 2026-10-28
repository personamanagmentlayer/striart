/**
 * Un lien de connexion au dashboard n'est ouvert que s'il vise la boucle
 * locale en http, sans identifiants, sur le chemin /auth. Toute autre forme
 * (hôte distant, schéma exotique, URL géante) est refusée : le texte vient
 * d'un process externe et n'est pas supposé correct.
 */
export function safeDashboardUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Pas une URL : refusée.
    return null;
  }
  if (url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
  if (!loopback || url.username || url.password) return null;
  if (url.pathname !== '/auth') return null;
  return url.toString();
}
