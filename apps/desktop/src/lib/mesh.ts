// Réseau privé : état des liens WireGuard entre membres, à partir de `wg show` sur chaque serveur.
import type { MeshMemberStatus, MeshNetwork } from "./api";

/** WireGuard renouvelle l'échange toutes les 2 minutes quand le lien vit : au-delà de 3, il est tombé. */
const FRESH_SECONDS = 180;

export type LinkState = "ok" | "stale" | "never";

export function linkState(lastHandshake: number | null, nowSec: number): LinkState {
  if (lastHandshake == null) return "never";
  return nowSec - lastHandshake <= FRESH_SECONDS ? "ok" : "stale";
}

/** Liens d'un membre vers chacun des autres ; « absent » : pair pas dans sa configuration (deux NAT). */
export function memberLinks(network: MeshNetwork, status: MeshMemberStatus | undefined, nowSec: number): { serverId: string; state: LinkState | "absent" }[] {
  const byKey = new Map((status?.status?.links ?? []).map((l) => [l.publicKey, l]));
  return network.members
    .filter((m) => m.serverId !== status?.serverId)
    .map((m) => {
      const link = byKey.get(m.publicKey);
      return { serverId: m.serverId, state: link ? linkState(link.lastHandshake, nowSec) : "absent" };
    });
}

/** Paires reliées (vues d'un côté ou de l'autre) sur le nombre de paires possibles. */
export function summary(network: MeshNetwork, statuses: MeshMemberStatus[], nowSec: number): { linked: number; expected: number } {
  const n = network.members.length;
  const linked = new Set<string>();
  for (const s of statuses) {
    for (const l of memberLinks(network, s, nowSec)) {
      if (l.state === "ok") linked.add([s.serverId, l.serverId].sort().join("|"));
    }
  }
  return { linked: linked.size, expected: (n * (n - 1)) / 2 };
}
