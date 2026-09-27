// Fichiers docker compose ouverts depuis l'explorateur : reconnaissance du fichier et actions
// proposées selon ce que Docker fait déjà du projet.
import type { ComposeFileInfo } from "./api";

/** Noms de fichiers que `docker compose` lit par défaut. */
const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export function isComposeFile(name: string): boolean {
  return COMPOSE_NAMES.includes(name.toLowerCase());
}

/** Fichier compose d'un dossier, d'après son contenu (le premier nom reconnu par Docker). */
export function composeFileIn(names: string[]): string | undefined {
  return COMPOSE_NAMES.find((n) => names.includes(n));
}

export type ComposeChoice =
  | "launch"
  | "launchBuild"
  | "restart"
  | "update"
  | "rebuild"
  | "stop"
  | "start"
  | "down"
  | "logs"
  | "replace"
  | "launchAs";

/** Actions proposées, dans l'ordre d'affichage, selon la situation du fichier. */
export function composeChoices(info: ComposeFileInfo): ComposeChoice[] {
  const build = info.hasBuild;
  switch (info.state.kind) {
    case "invalid":
      return [];
    case "notRunning":
      return build ? ["launch", "launchBuild"] : ["launch"];
    case "same":
      return info.state.running
        ? ["restart", "update", "rebuild", "logs", "stop"]
        : [build ? "launchBuild" : "start", "down"];
    case "conflict":
      return ["replace", "launchAs"];
  }
}
