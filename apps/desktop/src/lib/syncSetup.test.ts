import { describe, expect, it } from "vitest";
import { generatePassphrase, validDomain } from "./syncSetup";

describe("syncSetup", () => {
  it("génère une phrase de passe lisible et différente à chaque fois", () => {
    const a = generatePassphrase();
    expect(a).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
    // Sur un seul tirage, un caractère ambigu passerait souvent inaperçu : on en vérifie 500.
    const many = Array.from({ length: 500 }, () => generatePassphrase()).join("");
    expect(many).not.toMatch(/[01ilo]/);
    expect(generatePassphrase()).not.toBe(a);
    expect(generatePassphrase(() => new Uint8Array(25))).toBe("aaaaa-aaaaa-aaaaa-aaaaa-aaaaa");
  });

  it("valide un sous-domaine", () => {
    expect(validDomain("sync.chevrolliernathan.fr")).toBe(true);
    expect(validDomain("localhost")).toBe(false);
    expect(validDomain("sync..fr")).toBe(false);
    expect(validDomain("https://sync.fr")).toBe(false);
  });
});
