import { describe, expect, it } from "vitest";
import type { MeshMemberStatus, MeshNetwork } from "./api";
import { linkState, memberLinks, summary } from "./mesh";

const net: MeshNetwork = {
  id: "n",
  name: "Prod",
  cidr: "10.77.0.0/24",
  members: [
    { serverId: "a", address: "10.77.0.1", publicKey: "KA", endpoint: "51.0.0.1", port: 51820 },
    { serverId: "b", address: "10.77.0.2", publicKey: "KB", endpoint: "95.0.0.2", port: 51820 },
    { serverId: "c", address: "10.77.0.3", publicKey: "KC", endpoint: null, port: 51820 },
  ],
};
const now = 1_790_000_000;
const status = (serverId: string, links: [string, number | null][]): MeshMemberStatus => ({
  serverId,
  error: null,
  status: { networkId: "n", up: true, links: links.map(([publicKey, lastHandshake]) => ({ publicKey, endpoint: null, lastHandshake, rx: 0, tx: 0 })) },
});

describe("réseau privé", () => {
  it("qualifie un lien selon son dernier échange", () => {
    expect(linkState(now - 30, now)).toBe("ok");
    expect(linkState(now - 600, now)).toBe("stale");
    expect(linkState(null, now)).toBe("never");
  });

  it("liste les liens d'un membre vers les autres, y compris ceux absents de sa configuration", () => {
    const links = memberLinks(net, status("a", [["KB", now - 10], ["KC", null]]), now);
    expect(links).toEqual([
      { serverId: "b", state: "ok" },
      { serverId: "c", state: "never" },
    ]);
    expect(memberLinks(net, status("c", [["KA", now - 5]]), now)).toEqual([
      { serverId: "a", state: "ok" },
      { serverId: "b", state: "absent" },
    ]);
  });

  it("compte les liens établis (chaque paire une fois)", () => {
    const statuses = [status("a", [["KB", now - 10], ["KC", now - 20]]), status("b", [["KA", now - 10], ["KC", null]]), status("c", [["KA", now - 20], ["KB", null]])];
    expect(summary(net, statuses, now)).toEqual({ linked: 2, expected: 3 });
  });
});
