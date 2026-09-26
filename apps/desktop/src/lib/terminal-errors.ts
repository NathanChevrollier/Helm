// Détection d'un échec dans ce qui s'affiche au terminal, pour proposer le diagnostic de l'IA.
//
// Helm n'installe rien sur le serveur pour cela : pas de PROMPT_COMMAND à ajouter, pas de shell à
// modifier. Le code de retour n'est donc pas lisible directement — la détection se fait sur le
// texte, à partir des messages d'échec que tous les outils Unix écrivent. C'est une heuristique
// assumée : elle propose un bouton, elle ne conclut rien toute seule.

/** Échec repéré dans le tampon du terminal. */
export interface Failure {
  /** Commande qui a échoué, si l'invite précédente a pu être lue. */
  command: string | null;
  /** Lignes de sortie retenues pour le diagnostic. */
  output: string;
  /** Message qui a déclenché la détection, pour l'infobulle du bouton. */
  reason: string;
}

/**
 * Marqueurs d'échec. Volontairement précis : « error » tout court apparaît dans trop de sorties
 * normales (barres de progression, journaux d'accès nginx) pour servir de signal.
 */
const MARQUEURS: RegExp[] = [
  /\bcommand not found\b|: commande introuvable/i,
  /\bpermission denied\b|permission non accordée/i,
  /\bno such file or directory\b|aucun fichier ou dossier de ce (type|nom)/i,
  /^\s*(fatal|erreur fatale)\s*:/i,
  /^\s*E:\s/,
  /^npm (ERR!|error)/i,
  /^\s*Traceback \(most recent call last\)/,
  /\bsegmentation fault\b|erreur de segmentation/i,
  /\b(connection|connexion) refused\b|connexion refusée/i,
  /\bno route to host\b/i,
  /\bunknown (option|command|flag)\b/i,
  /\boperation not permitted\b/i,
  /\bdisk quota exceeded\b|no space left on device|espace disque insuffisant/i,
  /\bexit(ed with)? (status |code )?[1-9]\d*/i,
  /\bfailed\b.*\b(to|with)\b/i,
  /^\s*(Error|ERROR|Erreur)\b[: ]/,
  /\bnginx: \[emerg\]/,
  /\bJob for .* failed\b/i,
  /\bcould not\b|\bcannot\b|impossible de/i,
  /\bconflict\b.*\bport\b|address already in use|adresse déjà utilisée/i,
  /\bkilled\b$/i,
];

/** Fin d'invite de commande : `… $ ` ou `… # `, éventuellement avec un code couleur déjà retiré. */
const INVITE = /^(?<avant>.*?[^\s@]*@[^\s:]*:[^$#]*|.*?)[$#]\s(?<commande>.+)$/;

/** Lignes de bruit qui n'apportent rien au diagnostic. */
const BRUIT = /^\s*$|^\s*\d+%|^\s*\[[#=\->\s]*\]\s*$/;

/**
 * Cherche le dernier échec dans les lignes affichées (de la plus ancienne à la plus récente).
 * `null` si rien ne ressemble à un échec : le bouton de diagnostic reste alors caché.
 */
export function findLastFailure(lines: string[], maxOutput = 40): Failure | null {
  // Les toutes dernières lignes sont souvent une invite vide qui attend : on repart de la fin.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (BRUIT.test(line)) continue;
    const marqueur = MARQUEURS.find((r) => r.test(line));
    if (!marqueur) continue;

    // Remonter jusqu'à l'invite qui a lancé la commande fautive.
    let start = i;
    let command: string | null = null;
    for (let j = i; j >= 0 && i - j < maxOutput; j--) {
      const m = INVITE.exec(lines[j]);
      if (m?.groups?.commande) {
        command = m.groups.commande.trim();
        start = j + 1;
        break;
      }
      start = j;
    }
    const output = lines
      .slice(start, i + 1)
      .filter((l) => !BRUIT.test(l))
      .slice(-maxOutput)
      .join("\n")
      .trim();
    return { command, output, reason: line.trim().slice(0, 160) };
  }
  return null;
}

/**
 * Question posée à l'assistant. Elle demande explicitement la cause puis la commande de correction,
 * dans cet ordre : c'est ce qu'on veut lire en premier quand une commande vient d'échouer.
 */
export function diagnosePrompt(f: Failure): string {
  const commande = f.command ? `La commande lancée était :\n${f.command}\n\n` : "";
  return (
    `Une commande vient d'échouer dans mon terminal. ${commande}` +
    "Dis-moi d'abord, en une ou deux phrases, pourquoi elle a échoué, puis donne la commande exacte qui corrige le problème. " +
    "Si plusieurs causes sont possibles, donne la plus probable et comment la vérifier. " +
    "Si la correction est risquée (perte de données, coupure de service), dis-le avant la commande."
  );
}
