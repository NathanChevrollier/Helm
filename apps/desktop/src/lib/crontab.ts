// Édition d'une crontab ligne par ligne : ajouter, modifier ou retirer une tâche sans réécrire le
// fichier à la main. Le texte brut reste la référence : commentaires et variables sont conservés.

export interface CronPreset {
  id: string;
  label: string;
  /** Expression cron correspondante (`h` et `m` : heure et minute choisies). */
  expr: (h: number, m: number, dow: number, dom: number) => string;
  /** Champs à demander en plus de la commande. */
  needs: ("time" | "dow" | "dom")[];
}

export const CRON_PRESETS: CronPreset[] = [
  { id: "hourly", label: "Toutes les heures", expr: (_h, m) => `${m} * * * *`, needs: [] },
  { id: "daily", label: "Chaque jour", expr: (h, m) => `${m} ${h} * * *`, needs: ["time"] },
  { id: "weekly", label: "Chaque semaine", expr: (h, m, dow) => `${m} ${h} * * ${dow}`, needs: ["time", "dow"] },
  { id: "monthly", label: "Chaque mois", expr: (h, m, _dow, dom) => `${m} ${h} ${dom} * *`, needs: ["time", "dom"] },
  { id: "5min", label: "Toutes les 5 minutes", expr: () => "*/5 * * * *", needs: [] },
  { id: "reboot", label: "Au démarrage du serveur", expr: () => "@reboot", needs: [] },
  { id: "custom", label: "Expression personnalisée", expr: () => "", needs: [] },
];

export const WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

const pad = (n: number) => String(n).padStart(2, "0");

/** Expression cron en français, pour les formes courantes (sinon `null`). */
export function humanSchedule(expr: string): string | null {
  const e = expr.trim();
  const special: Record<string, string> = {
    "@reboot": "au démarrage du serveur",
    "@hourly": "toutes les heures",
    "@daily": "chaque jour à minuit",
    "@midnight": "chaque jour à minuit",
    "@weekly": "chaque dimanche à minuit",
    "@monthly": "le 1er de chaque mois à minuit",
    "@yearly": "le 1er janvier à minuit",
    "@annually": "le 1er janvier à minuit",
  };
  if (special[e]) return special[e];
  const f = e.split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dow] = f;
  const num = (s: string) => /^\d+$/.test(s);
  const every = /^\*\/(\d+)$/;
  if (every.test(mi) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `toutes les ${mi.match(every)![1]} minutes`;
  if (mi === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "chaque minute";
  if (num(mi) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `toutes les heures à la minute ${mi}`;
  if (num(mi) && every.test(h) && dom === "*" && mon === "*" && dow === "*") return `toutes les ${h.match(every)![1]} heures, à la minute ${mi}`;
  if (!num(mi) || !num(h) || mon !== "*") return null;
  const at = `à ${pad(Number(h))}:${pad(Number(mi))}`;
  if (dom === "*" && dow === "*") return `chaque jour ${at}`;
  if (dom === "*" && num(dow)) return `chaque ${WEEKDAYS[Number(dow) % 7]} ${at}`;
  if (dom === "*" && dow === "1-5") return `du lundi au vendredi ${at}`;
  if (num(dom) && dow === "*") return `le ${dom === "1" ? "1er" : dom} de chaque mois ${at}`;
  return null;
}

/** Vrai si l'expression a une forme valide (5 champs, ou un raccourci @…). */
export function isValidSchedule(expr: string): boolean {
  const e = expr.trim();
  if (/^@(reboot|hourly|daily|midnight|weekly|monthly|yearly|annually)$/.test(e)) return true;
  const f = e.split(/\s+/);
  return f.length === 5 && f.every((x) => /^[\d*/,\-A-Za-z]+$/.test(x));
}

/** Index de la ligne d'une tâche dans le texte brut, ou -1. */
function findLine(lines: string[], schedule: string, command: string): number {
  const sched = schedule.trim().split(/\s+/).join(" ");
  return lines.findIndex((l) => {
    const t = l.trim();
    if (!t || t.startsWith("#")) return false;
    const norm = t.split(/\s+/).join(" ");
    return norm.startsWith(sched + " ") && t.endsWith(command.trim());
  });
}

/**
 * Remplace (ou retire si `next` est `null`) la ligne d'une tâche. Une tâche introuvable est
 * ajoutée à la fin quand `next` est fourni.
 */
export function replaceJob(raw: string, job: { schedule: string; command: string } | null, next: string | null): string {
  const lines = raw.replace(/\n+$/, "").split("\n");
  const i = job ? findLine(lines, job.schedule, job.command) : -1;
  if (i >= 0) {
    if (next === null) lines.splice(i, 1);
    else lines[i] = next;
  } else if (next !== null) {
    if (lines.length === 1 && lines[0] === "") lines[0] = next;
    else lines.push(next);
  }
  return lines.join("\n") + "\n";
}
