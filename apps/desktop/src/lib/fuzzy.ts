// Recherche approximative pour l'historique du terminal (Ctrl+R) : les lettres tapées doivent
// apparaître dans l'ordre, pas forcément côte à côte — « dcps » trouve « docker compose ps ».
//
// Le score récompense ce qui rend un résultat évident à l'œil : une correspondance en début de mot,
// des lettres qui se suivent, et une commande courte. La fréquence et la date, elles, sont
// ajoutées par l'appelant : elles ne dépendent pas du texte cherché.

/** Résultat d'une correspondance : son score et les positions à surligner. */
export interface Match {
  score: number;
  /** Index des caractères retenus dans le texte, dans l'ordre. */
  positions: number[];
}

/** Un caractère qui ouvre un mot : début de chaîne, ou précédé d'un séparateur. */
function startsWord(text: string, i: number): boolean {
  if (i === 0) return true;
  return /[\s\-_/.:=|&;]/.test(text[i - 1]);
}

/**
 * Cherche `query` dans `text`, sans tenir compte de la casse. `null` si une lettre manque.
 *
 * L'algorithme est glouton (première occurrence utilisable de chaque lettre) : ce n'est pas
 * l'appariement optimal, mais il est linéaire, et sur des commandes de quelques dizaines de
 * caractères la différence ne se voit pas.
 */
export function fuzzyMatch(text: string, query: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;

  for (const letter of q) {
    if (letter === " ") continue;
    const at = t.indexOf(letter, from);
    if (at === -1) return null;
    positions.push(at);
    // Lettres consécutives : c'est ce qui distingue « dock » de « d…o…c…k » éparpillés.
    if (at === previous + 1) score += 8;
    if (startsWord(text, at)) score += 12;
    if (at === 0) score += 10;
    previous = at;
    from = at + 1;
  }
  // Une commande courte qui contient la recherche est plus probablement celle qu'on veut.
  score += Math.max(0, 30 - text.length / 4);
  // Et un bloc compact vaut mieux qu'une correspondance étalée sur toute la ligne.
  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= Math.max(0, span - q.replace(/ /g, "").length);
  return { score, positions };
}

/** Élément classable : son texte, sa fréquence et sa dernière utilisation. */
export interface Rankable {
  command: string;
  count: number;
  last: number | null;
}

/** Élément classé, avec les positions à surligner. */
export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Classe des commandes pour la recherche inversée : la correspondance d'abord, puis les habitudes
 * (une commande tapée vingt fois passe devant une commande tapée une fois) et la fraîcheur.
 * Une recherche vide garde l'ordre reçu du serveur, déjà trié par date.
 */
export function rankCommands<T extends Rankable>(items: T[], query: string, now = Date.now()): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const m = query.trim() ? fuzzyMatch(item.command, query) : { score: 0, positions: [] };
    if (!m) continue;
    // La fréquence compte, mais avec un rendement décroissant : la 50e répétition ne doit pas
    // écraser une correspondance nettement meilleure.
    const frequency = Math.log2(1 + item.count) * 6;
    // Fraîcheur : pleine le jour même, nulle au-delà d'un mois.
    const ageDays = item.last ? (now / 1000 - item.last) / 86400 : 60;
    const freshness = Math.max(0, 15 - ageDays / 2);
    out.push({ item, score: m.score + frequency + freshness, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score || a.item.command.length - b.item.command.length);
  return out;
}
