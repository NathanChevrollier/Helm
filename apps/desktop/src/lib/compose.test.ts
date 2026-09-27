import { describe, expect, it } from "vitest";
import { composeChoices, composeFileIn, isComposeFile } from "./compose";
import type { ComposeFileInfo, ComposeFileState } from "./api";

const info = (state: ComposeFileState, hasBuild = false): ComposeFileInfo => ({ file: "/opt/app/docker-compose.yml", project: "app", hasBuild, ports: [], busyPorts: [], state });
const project = { name: "app", status: "running(1)", configFiles: "/opt/ancien/docker-compose.yml", missing: true };

describe("compose", () => {
  it("reconnaît les fichiers compose", () => {
    expect(isComposeFile("docker-compose.yml")).toBe(true);
    expect(isComposeFile("Compose.YAML")).toBe(true);
    expect(isComposeFile("docker-compose.override.yml")).toBe(false);
    expect(composeFileIn(["README.md", "compose.yaml", "docker-compose.yml"])).toBe("docker-compose.yml");
    expect(composeFileIn(["README.md"])).toBeUndefined();
  });

  it("propose les actions selon ce qui tourne déjà", () => {
    expect(composeChoices(info({ kind: "invalid", message: "x" }))).toEqual([]);
    expect(composeChoices(info({ kind: "notRunning" }))).toEqual(["launch"]);
    expect(composeChoices(info({ kind: "notRunning" }, true))).toEqual(["launch", "launchBuild"]);
    expect(composeChoices(info({ kind: "same", project, running: true }))).toEqual(["restart", "update", "rebuild", "logs", "stop"]);
    expect(composeChoices(info({ kind: "same", project, running: false }))).toEqual(["start", "down"]);
    expect(composeChoices(info({ kind: "same", project, running: false }, true))).toEqual(["launchBuild", "down"]);
    expect(composeChoices(info({ kind: "conflict", project }))).toEqual(["replace", "launchAs"]);
  });
});
