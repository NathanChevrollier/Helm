import { describe, expect, it } from "vitest";
import { allowedActions, formatMemory, memoryText, needsConfirmation, removableDiskFiles, stateLabel } from "./vm";
import type { Vm } from "./api";

const vm = (state: Vm["state"], autostart = false): Vm => ({ uuid: "u", name: "n", state, vcpus: 1, memoryKib: 1048576, autostart, persistent: true });

describe("vm", () => {
  it("propose les actions permises selon l'état", () => {
    expect(allowedActions(vm("shutOff"))).toEqual(["start", "autostartOn"]);
    expect(allowedActions(vm("running", true))).toEqual(["shutdown", "reboot", "suspend", "forceOff", "autostartOff"]);
    expect(allowedActions(vm("paused"))).toEqual(["resume", "forceOff", "autostartOn"]);
    expect(allowedActions(vm("crashed"))).toEqual(["forceOff", "start", "autostartOn"]);
  });

  it("libellés et confirmations", () => {
    expect(stateLabel("running")).toEqual({ label: "En marche", tone: "ok" });
    expect(stateLabel("shutOff")).toEqual({ label: "Éteinte", tone: "muted" });
    expect(needsConfirmation("forceOff")).toBe(true);
    expect(needsConfirmation("start")).toBe(false);
  });

  it("formate la mémoire", () => {
    expect(formatMemory(1048576)).toBe("1 Go");
    expect(formatMemory(131072)).toBe("128 Mo");
    expect(formatMemory(1572864)).toBe("1,5 Go");
  });

  it("montre la mémoire utilisée en direct pour une VM en marche", () => {
    const stats = { uuid: "u", cpuPercent: 3, memoryUsedKib: 94208 };
    expect(memoryText(vm("running"), stats)).toBe("92 Mo / 1 Go");
    expect(memoryText(vm("running"), undefined)).toBe("1 Go");
    expect(memoryText(vm("shutOff"), stats)).toBe("1 Go");
  });

  it("ne propose de supprimer que les disques propres à la VM", () => {
    const disk = (device: string, source: string | null, shared = false) => ({ target: "x", device, source, format: null, shared });
    const detail = { disks: [disk("disk", "/v/own.qcow2"), disk("cdrom", "/iso/debian.iso"), disk("disk", "/v/shared.img", true), disk("disk", null)] };
    expect(removableDiskFiles(detail)).toEqual(["/v/own.qcow2"]);
  });
});
