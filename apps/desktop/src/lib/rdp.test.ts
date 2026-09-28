import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();
vi.mock("./store", () => ({ useApp: { getState: () => ({ servers: [{ id: "s", name: "hôte" }], notify }) } }));
vi.mock("./api", () => ({
  api: {
    desktopSessionClose: vi.fn(() => Promise.resolve()),
    vmConsoleOpen: vi.fn(() => Promise.reject("cette VM affiche son écran en SPICE, que Zenytt ne sait pas afficher : utilise la console série")),
  },
}));

const { useRdp } = await import("./rdp");

describe("écran d'une VM", () => {
  beforeEach(() => notify.mockClear());

  it("n'ouvre pas l'écran quand la VM n'en a pas, et explique pourquoi", async () => {
    await useRdp.getState().openVm("s", { uuid: "u", name: "spice-test" });
    expect(useRdp.getState().desktop).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("console série"), "error");
  });
});
