import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const { hashPassword, verifyPassword } = await import("./lock");

describe("mot de passe de verrouillage", () => {
  it("vérifie le bon mot de passe et refuse les autres", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored.startsWith("pbkdf2$200000$")).toBe(true);
    expect(stored).not.toContain("correct horse");
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("Correct horse", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("sel aléatoire : deux empreintes du même mot de passe diffèrent", async () => {
    expect(await hashPassword("x".repeat(8))).not.toBe(await hashPassword("x".repeat(8)));
  });

  it("refuse une empreinte malformée", async () => {
    expect(await verifyPassword("a", "n'importe quoi")).toBe(false);
  });
});
