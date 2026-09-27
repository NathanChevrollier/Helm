// Aides de l'installation assistée de la synchronisation.

/** Lettres et chiffres sans ambiguïté à la lecture (pas de 0/O, 1/l/I). */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * Phrase de passe aléatoire à noter : 5 groupes de 5 caractères (≈ 125 bits), séparés par des
 * tirets pour se relire et se recopier sans erreur.
 */
export function generatePassphrase(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(25);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [0, 5, 10, 15, 20].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

/** Nom de domaine complet plausible (au moins un point, caractères autorisés). */
export function validDomain(d: string): boolean {
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d.trim());
}
