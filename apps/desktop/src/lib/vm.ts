// Règles d'affichage des machines virtuelles : libellés, actions permises, confirmations.
import type { Vm, VmAction, VmDetail, VmState, VmStats } from "./api";

export function stateLabel(state: VmState): { label: string; tone: "ok" | "warn" | "muted" | "danger" } {
  switch (state) {
    case "running":
      return { label: "En marche", tone: "ok" };
    case "paused":
      return { label: "En pause", tone: "warn" };
    case "suspended":
      return { label: "En veille", tone: "warn" };
    case "shutdown":
      return { label: "Arrêt en cours", tone: "warn" };
    case "crashed":
      return { label: "Plantée", tone: "danger" };
    case "shutOff":
      return { label: "Éteinte", tone: "muted" };
    default:
      return { label: "Inconnu", tone: "muted" };
  }
}

/** Actions proposées selon l'état, dans l'ordre d'affichage (la plus courante d'abord). */
export function allowedActions(vm: Vm): VmAction[] {
  const auto: VmAction = vm.autostart ? "autostartOff" : "autostartOn";
  switch (vm.state) {
    case "running":
      return ["shutdown", "reboot", "suspend", "forceOff", auto];
    case "paused":
      return ["resume", "forceOff", auto];
    case "crashed":
      return ["forceOff", "start", auto];
    case "shutdown":
      return ["forceOff", auto];
    default:
      return ["start", auto];
  }
}

/** Forcer l'arrêt revient à couper le courant : toujours confirmé. */
export function needsConfirmation(action: VmAction): boolean {
  return action === "forceOff";
}

export function formatMemory(kib: number): string {
  const mo = kib / 1024;
  if (mo < 1024) return `${Math.round(mo)} Mo`;
  return `${(mo / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Go`;
}

/** Mémoire d'une VM : utilisée / attribuée quand elle tourne et que l'activité est connue. */
export function memoryText(vm: Vm, stats: VmStats | undefined): string {
  const max = formatMemory(vm.memoryKib);
  return vm.state === "running" && stats?.memoryUsedKib != null ? `${formatMemory(stats.memoryUsedKib)} / ${max}` : max;
}

/** Fichiers supprimés avec la VM (même règle que le serveur) : ni ISO, ni disque partagé ou en lecture seule. */
export function removableDiskFiles(detail: Pick<VmDetail, "disks">): string[] {
  return detail.disks.filter((d) => d.device === "disk" && !d.shared && d.source).map((d) => d.source!);
}
