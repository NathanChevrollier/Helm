import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const { errorMessage, formatBytes, formatDuration, shellQuote } = await import("./api");

describe("formatage", () => {
  it("durées", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3 h 5 min");
    expect(formatDuration(86400 * 2 + 3600)).toBe("2 j 1 h");
  });

  it("tailles", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(1536)).toBe("1.5 Ko");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 Go");
  });

  it("échappement shell", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("l'app; rm -rf /")).toBe("'l'\\''app; rm -rf /'");
  });

  it("messages d'erreur", () => {
    expect(errorMessage("texte")).toBe("texte");
    expect(errorMessage(new Error("boum"))).toBe("boum");
  });
});
