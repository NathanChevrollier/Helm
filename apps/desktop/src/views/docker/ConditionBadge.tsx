// Pourquoi un conteneur ne tourne pas (ou tourne mal), en une étiquette : une panne se distingue
// d'un arrêt voulu ou d'une tâche terminée.
import { isFailure, type Container } from "../../lib/api";
import { Badge } from "../../components/ui";

const LABELS: Record<Container["condition"], { label: string; hint: string } | null> = {
  ok: null,
  unhealthy: { label: "healthcheck en échec", hint: "Le conteneur tourne, mais son contrôle de santé échoue." },
  crashLoop: { label: "redémarre en boucle", hint: "Il plante et Docker le relance sans cesse : regarde ses logs." },
  crashed: { label: "planté", hint: "Sorti avec une erreur." },
  outOfMemory: { label: "manque de mémoire", hint: "Tué par le noyau : la mémoire du serveur (ou sa limite) est dépassée." },
  stopped: { label: "arrêté", hint: "Arrêté par un signal (docker stop, kill…) : le plus souvent un arrêt manuel." },
  finished: { label: "terminé", hint: "Sorti normalement (code 0) : tâche finie ou arrêt propre." },
  created: { label: "jamais démarré", hint: "Créé mais pas lancé." },
  paused: { label: "en pause", hint: "Mis en pause (docker pause)." },
};

export default function ConditionBadge({ c, onPurpose, occasional }: { c: Container; onPurpose: boolean; occasional: boolean }) {
  // Un conteneur ancien (moteur qui ne renvoie pas encore la condition) n'affiche rien de plus.
  const info = c.condition ? LABELS[c.condition] : null;
  if (!info) return null;
  const failure = isFailure(c.condition);
  if (!failure && onPurpose) {
    return (
      <Badge tone="muted" title="Arrêté volontairement : cet arrêt n'est pas signalé">
        arrêté volontairement
      </Badge>
    );
  }
  // Tâche ponctuelle terminée : c'est son fonctionnement normal, pas la peine de le redire.
  if (!failure && occasional) return null;
  const code = c.exitCode != null && c.state !== "running" ? ` (code ${c.exitCode})` : "";
  return (
    <Badge tone={failure ? "danger" : "muted"} title={info.hint + code}>
      {info.label}
    </Badge>
  );
}
