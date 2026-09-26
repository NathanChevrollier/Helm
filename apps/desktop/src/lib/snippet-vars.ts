// Fragments paramétrables : `docker logs -f --tail {{lignes:100}} {{conteneur}}`.
//
// Un fragment n'est plus une commande figée : les `{{…}}` sont demandés avant l'envoi, avec leur
// valeur par défaut déjà remplie. Le remplacement est purement textuel et se fait ici, côté
// interface — la commande part ensuite dans le terminal comme si elle avait été tapée.

/** Variable déclarée dans un fragment. */
export interface SnippetVar {
  /** Nom affiché dans le formulaire. */
  name: string;
  /** Valeur proposée, tirée de `{{nom:valeur}}` ; chaîne vide s'il n'y en a pas. */
  default: string;
}

/**
 * `{{nom}}` ou `{{nom:valeur par défaut}}`. Le nom exclut `:` et `}` ; la valeur par défaut prend
 * tout le reste, deux-points compris, ce qui laisse écrire `{{cible:127.0.0.1:8080}}`.
 */
const MOTIF = /\{\{([^:}]+)(?::([^}]*))?\}\}/g;

/** Variables d'un fragment, dans leur ordre d'apparition et sans doublon. */
export function parseVars(command: string): SnippetVar[] {
  const out: SnippetVar[] = [];
  for (const m of command.matchAll(MOTIF)) {
    const name = m[1].trim();
    if (!name || out.some((v) => v.name === name)) continue;
    out.push({ name, default: (m[2] ?? "").trim() });
  }
  return out;
}

/** Le fragment attend-il des paramètres ? */
export function hasVars(command: string): boolean {
  return parseVars(command).length > 0;
}

/**
 * Remplace chaque `{{…}}` par la valeur saisie. Une variable laissée vide reprend sa valeur par
 * défaut ; si elle n'en a pas, le `{{…}}` disparaît — mieux vaut une commande incomplète, que
 * l'utilisateur voit et corrige, qu'un `{{conteneur}}` envoyé tel quel au shell.
 */
export function fillVars(command: string, values: Record<string, string>): string {
  return command
    .replace(MOTIF, (_whole, rawName: string, rawDefault?: string) => {
      const name = rawName.trim();
      const saisie = values[name];
      if (saisie !== undefined && saisie !== "") return saisie;
      return (rawDefault ?? "").trim();
    })
    .trim();
}
