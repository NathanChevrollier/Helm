import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const { activityLines } = await import("./desktop");

describe("desktop", () => {
  it("ne demande rien quand il n'y a rien à perdre", () => {
    expect(activityLines({ tunnels: 0, transfers: 0, terminals: 0 })).toEqual([]);
  });

  it("liste ce qui s'arrête, au singulier comme au pluriel", () => {
    expect(activityLines({ tunnels: 1, transfers: 2, terminals: 3 })).toEqual([
      "1 tunnel ouvert (les applications qui s'en servent seront coupées)",
      "2 transferts de fichiers en cours",
      "3 terminaux ouverts (les sessions tmux continuent sur le serveur)",
    ]);
  });
});
