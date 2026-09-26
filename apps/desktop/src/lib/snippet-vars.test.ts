import { describe, expect, it } from "vitest";
import { fillVars, hasVars, parseVars } from "./snippet-vars";

describe("fragments paramétrables", () => {
  it("lit les variables et leurs valeurs par défaut", () => {
    const vars = parseVars("docker logs -f --tail {{lignes:100}} {{conteneur}}");
    expect(vars).toEqual([
      { name: "lignes", default: "100" },
      { name: "conteneur", default: "" },
    ]);
    expect(hasVars("docker ps")).toBe(false);
  });

  it("ne demande pas deux fois la même variable", () => {
    expect(parseVars("cp {{fichier}} {{fichier}}.bak")).toHaveLength(1);
  });

  it("accepte des deux-points dans la valeur par défaut", () => {
    expect(parseVars("curl {{cible:127.0.0.1:8080}}")).toEqual([{ name: "cible", default: "127.0.0.1:8080" }]);
  });

  it("remplit la commande avec les valeurs saisies", () => {
    const cmd = "docker logs -f --tail {{lignes:100}} {{conteneur}}";
    expect(fillVars(cmd, { lignes: "20", conteneur: "nginx" })).toBe("docker logs -f --tail 20 nginx");
    // Une valeur laissée vide reprend la valeur par défaut.
    expect(fillVars(cmd, { lignes: "", conteneur: "nginx" })).toBe("docker logs -f --tail 100 nginx");
  });

  it("n'envoie jamais un {{…}} au shell", () => {
    // Sans valeur ni défaut, le marqueur disparaît : la commande est visiblement incomplète,
    // ce qui vaut mieux qu'un « {{conteneur}} » pris pour un argument par le shell.
    expect(fillVars("docker logs {{conteneur}}", {})).toBe("docker logs");
    expect(fillVars("echo {{a}}{{b}}", {})).not.toContain("{{");
  });

  it("laisse les commandes sans variable intactes", () => {
    expect(fillVars("systemctl status nginx", {})).toBe("systemctl status nginx");
  });
});
