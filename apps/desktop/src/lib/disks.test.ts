import { describe, expect, it } from "vitest";
import { diskCounts, mainDisk, type Disk } from "./api";
import { parseSize } from "../views/monitoring/DiskRuleDialog";

const disk = (mount: string, total: number, used: number, extra: Partial<Disk> = {}): Disk => ({ mount, device: "/dev/x", total, used, ...extra });

describe("disque principal", () => {
  it("prend / quand il compte", () => {
    expect(mainDisk([disk("/data", 900, 1), disk("/", 100, 50)])?.mount).toBe("/");
  });

  it("écarte une racine en lecture seule (hébergement mutualisé)", () => {
    const disks = [disk("/", 1_300_000_000, 1_300_000_000, { readOnly: true }), disk("/home/client", 50e9, 2e9)];
    expect(diskCounts(disks[0])).toBe(false);
    expect(mainDisk(disks)?.mount).toBe("/home/client");
  });

  it("garde un disque à montrer même si rien ne compte", () => {
    expect(mainDisk([disk("/", 10, 10, { ignored: true })])?.mount).toBe("/");
    expect(mainDisk([])).toBeUndefined();
  });
});

describe("taille saisie à la main", () => {
  it("comprend les unités françaises et anglaises, Go par défaut", () => {
    expect(parseSize("50")).toBe(50 * 1024 ** 3);
    expect(parseSize("2,5 Go")).toBe(Math.round(2.5 * 1024 ** 3));
    expect(parseSize("800 Mo")).toBe(800 * 1024 ** 2);
    expect(parseSize("1 TB")).toBe(1024 ** 4);
  });

  it("vide = valeur de df, illisible = erreur", () => {
    expect(parseSize("  ")).toBeNull();
    expect(parseSize("beaucoup")).toBeUndefined();
  });
});
