import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const { comboOf, isAppShortcut, matches } = await import("./shortcuts");
const { useApp } = await import("./store");

const key = (code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ type: "keydown", code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false }) as KeyboardEvent;

describe("raccourcis", () => {
  it("combinaisons indépendantes de la disposition du clavier", () => {
    expect(comboOf(key("KeyK", { ctrl: true }))).toBe("Ctrl+K");
    expect(comboOf(key("Tab", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+Tab");
    expect(comboOf(key("ShiftLeft", { shift: true }))).toBeNull();
  });

  it("valeurs par défaut et personnalisées", () => {
    expect(matches(key("KeyK", { ctrl: true }), "palette")).toBe(true);
    useApp.getState().setSettings({ shortcuts: { palette: "Ctrl+Shift+P" } });
    expect(matches(key("KeyK", { ctrl: true }), "palette")).toBe(false);
    expect(matches(key("KeyP", { ctrl: true, shift: true }), "palette")).toBe(true);
    expect(isAppShortcut(key("KeyP", { ctrl: true, shift: true }))).toBe(true);
    expect(isAppShortcut(key("KeyC", { ctrl: true }))).toBe(false);
  });
});
