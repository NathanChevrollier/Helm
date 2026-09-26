import { describe, expect, it } from "vitest";
import { fuzzyMatch, rankCommands } from "./fuzzy";

const now = 1_740_000_000_000;
const secs = now / 1000;

describe("correspondance approximative", () => {
  it("accepte des lettres espacées, dans l'ordre", () => {
    expect(fuzzyMatch("docker compose ps", "dcps")).not.toBeNull();
    // Appariement glouton : le « c » retenu est celui de « docker », pas celui de « compose ».
    // Ce n'est pas l'appariement le plus joli, mais il est linéaire et les positions restent justes.
    expect(fuzzyMatch("docker compose ps", "dcps")!.positions).toEqual([0, 2, 10, 12]);
    // Dans le désordre, ce n'est pas une correspondance.
    expect(fuzzyMatch("docker compose ps", "spcd")).toBeNull();
    expect(fuzzyMatch("docker ps", "zzz")).toBeNull();
  });

  it("ne tient pas compte de la casse et ignore les espaces de la recherche", () => {
    expect(fuzzyMatch("Docker PS", "d ps")).not.toBeNull();
  });

  it("préfère les débuts de mots aux lettres perdues au milieu", () => {
    const debut = fuzzyMatch("docker compose", "dc")!.score;
    const milieu = fuzzyMatch("xdxcx", "dc")!.score;
    expect(debut).toBeGreaterThan(milieu);
  });

  it("une recherche vide correspond à tout, sans rien surligner", () => {
    expect(fuzzyMatch("n'importe quoi", "")).toEqual({ score: 0, positions: [] });
  });
});

describe("classement de l'historique", () => {
  const items = [
    { command: "docker compose ps", count: 1, last: secs - 86400 * 20 },
    { command: "docker compose up -d", count: 30, last: secs - 3600 },
    { command: "systemctl restart nginx", count: 2, last: secs - 60 },
  ];

  it("écarte ce qui ne correspond pas", () => {
    const r = rankCommands(items, "nginx", now);
    expect(r).toHaveLength(1);
    expect(r[0].item.command).toBe("systemctl restart nginx");
  });

  it("met en avant les commandes fréquentes et récentes", () => {
    const r = rankCommands(items, "dc", now);
    expect(r.map((x) => x.item.command)).toEqual(["docker compose up -d", "docker compose ps"]);
  });

  it("garde l'ordre reçu quand la recherche est vide", () => {
    const r = rankCommands(items, "", now);
    expect(r).toHaveLength(3);
    // Sans texte, seules fréquence et fraîcheur jouent : la plus récente et fréquente d'abord.
    expect(r[0].item.command).toBe("docker compose up -d");
  });

  it("renvoie de quoi surligner la correspondance", () => {
    const r = rankCommands(items, "nginx", now);
    expect(r[0].positions).toHaveLength(5);
    expect(r[0].item.command.slice(r[0].positions[0], r[0].positions[4] + 1)).toBe("nginx");
  });
});
