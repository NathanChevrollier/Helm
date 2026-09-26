// Sessions de bureau à distance ouvertes dans Helm (clients RDP et VNC intégrés).
//
// La connexion part toujours du PC : directement, ou à travers un tunnel SSH monté par Helm quand
// la machine n'est joignable que depuis un serveur. Le pont local (côté Rust) parle le protocole
// de passerelle attendu par le client web ; l'interface ne connaît que l'adresse et le jeton.
import { create } from "zustand";
import { api, type DesktopView, type RdpSessionInfo, type VncSessionInfo } from "./api";

/** Étape de la session, pour l'affichage. */
export type RdpState = { kind: "ouverture" } | { kind: "connexion" } | { kind: "connecte" } | { kind: "erreur"; message: string } | { kind: "ferme"; message: string };

interface RdpStore {
  /** Bureau affiché, `null` quand aucune session n'est ouverte. */
  desktop: DesktopView | null;
  session: RdpSessionInfo | null;
  /** Session VNC : l'une ou l'autre est remplie, selon le protocole du bureau. */
  vnc: VncSessionInfo | null;
  state: RdpState;
  open: (desktop: DesktopView) => Promise<void>;
  setState: (state: RdpState) => void;
  close: () => void;
}

export const useRdp = create<RdpStore>((set, get) => ({
  desktop: null,
  session: null,
  vnc: null,
  state: { kind: "ouverture" },

  open: async (desktop) => {
    // Une seule session à la fois : la précédente est refermée proprement (pont et tunnel).
    const ouvert = get().desktop;
    if (ouvert) await api.desktopSessionClose(ouvert.id).catch(() => {});
    set({ desktop, session: null, vnc: null, state: { kind: "ouverture" } });
    try {
      if (desktop.protocol === "vnc") {
        set({ vnc: await api.vncSessionOpen(desktop.id), state: { kind: "connexion" } });
        return;
      }
      const session = await api.desktopSessionOpen(desktop.id);
      set({ session, state: { kind: "connexion" } });
    } catch (e) {
      set({ state: { kind: "erreur", message: e instanceof Error ? e.message : String(e) } });
    }
  },

  setState: (state) => set({ state }),

  close: () => {
    const ouvert = get().desktop;
    if (ouvert) void api.desktopSessionClose(ouvert.id).catch(() => {});
    set({ desktop: null, session: null, vnc: null, state: { kind: "ouverture" } });
  },
}));
