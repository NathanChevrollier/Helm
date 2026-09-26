// Actions d'un panneau de terminal, accessibles depuis l'extérieur du panneau (barre d'outils du
// terminal, dock, palette) : rechercher, historique, enregistrer, partager. Chaque TerminalPane
// s'inscrit ici à son montage ; l'état visible (enregistrement, partage) est dans un petit store.
import { create } from "zustand";

export interface PaneActions {
  search: () => void;
  history: () => void;
  toggleRecording: () => Promise<void>;
  /** Ouvre le choix du mode de partage (ou arrête le partage en cours). */
  share: () => void;
}

const registry = new Map<string, PaneActions>();

export function registerPaneActions(paneId: string, actions: PaneActions): () => void {
  registry.set(paneId, actions);
  return () => {
    if (registry.get(paneId) === actions) registry.delete(paneId);
    usePaneStatus.getState().clear(paneId);
  };
}

export function paneActions(paneId: string | null | undefined): PaneActions | undefined {
  return paneId ? registry.get(paneId) : undefined;
}

interface PaneStatus {
  /** Enregistrements en cours : début (ms) et libellé du terminal. */
  recording: Record<string, { since: number; label: string }>;
  shared: Record<string, "view" | "control">;
  setRecording: (paneId: string, v: { since: number; label: string } | null) => void;
  setShared: (paneId: string, mode: "view" | "control" | null) => void;
  clear: (paneId: string) => void;
}

export const usePaneStatus = create<PaneStatus>((set) => ({
  recording: {},
  shared: {},
  setRecording: (paneId, v) =>
    set((s) => {
      const recording = { ...s.recording };
      if (v) recording[paneId] = v;
      else delete recording[paneId];
      return { recording };
    }),
  setShared: (paneId, mode) =>
    set((s) => {
      const shared = { ...s.shared };
      if (mode) shared[paneId] = mode;
      else delete shared[paneId];
      return { shared };
    }),
  clear: (paneId) =>
    set((s) => {
      if (!(paneId in s.recording) && !(paneId in s.shared)) return s;
      const recording = { ...s.recording };
      const shared = { ...s.shared };
      delete recording[paneId];
      delete shared[paneId];
      return { recording, shared };
    }),
}));
