// Dossier courant lu dans l'invite affichée par le terminal. Sert quand le serveur ne peut pas le
// donner : shell root ouvert par `sudo -i` ou `su`, dont /proc est illisible pour l'utilisateur SSH.

/** Invite Debian/Ubuntu par défaut : « alice@vps:/etc/nginx$ », « root@vps:~# ». */
const PROMPT = /(?:^|[\s\])])([a-z_][\w.-]*)@[\w.-]+:(~[\w.-]*(?:\/[^$#]*?)?|\/[^$#]*?)\s?[$#](?:\s|$)/i;

const homeOf = (user: string) => (user === "root" ? "/root" : `/home/${user}`);

/** Dossier indiqué par une ligne d'invite, `null` si la ligne n'en est pas une. */
export function cwdFromPromptLine(line: string): string | null {
  const m = PROMPT.exec(line);
  if (!m) return null;
  const [, user, raw] = m;
  const path = raw.trimEnd();
  if (!path.startsWith("~")) return path;
  // « ~ », « ~/x » : dossier personnel de l'utilisateur de l'invite ; « ~bob/x » : celui de bob.
  const slash = path.indexOf("/");
  const who = path.slice(1, slash < 0 ? undefined : slash) || user;
  const rest = slash < 0 ? "" : path.slice(slash);
  return (homeOf(who) + rest).replace(/\/+$/, "") || "/";
}

/** Dernière invite visible en remontant depuis la ligne du curseur. */
export function cwdFromPrompt(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const cwd = cwdFromPromptLine(lines[i]);
    if (cwd) return cwd;
  }
  return null;
}
