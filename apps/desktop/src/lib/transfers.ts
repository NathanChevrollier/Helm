// Transferts de fichiers en cours, partagés par les panneaux de l'explorateur, et annulables.
import { create } from "zustand";
import { api, errorMessage, type Progress } from "./api";

export interface Transfer {
  id: number;
  label: string;
  progress: Progress | null;
  state: "running" | "done" | "error" | "cancelled";
  message?: string;
}

interface TransfersState {
  list: Transfer[];
  update: (id: number, patch: Partial<Transfer>) => void;
  remove: (id: number) => void;
}

export const useTransfers = create<TransfersState>((set) => ({
  list: [],
  update: (id, patch) =>
    set((s) => ({
      list: s.list.some((t) => t.id === id) ? s.list.map((t) => (t.id === id ? { ...t, ...patch } : t)) : [...s.list, { id, label: "", progress: null, state: "running", ...patch }],
    })),
  remove: (id) => set((s) => ({ list: s.list.filter((t) => t.id !== id) })),
}));

let seq = Date.now() % 1_000_000;

/** Lance un transfert suivi. `run` reçoit l'identifiant (pour l'annulation) et le callback de progression. */
export async function track(label: string, run: (id: number, onProgress: (p: Progress) => void) => Promise<unknown>): Promise<boolean> {
  const id = ++seq;
  const { update, remove } = useTransfers.getState();
  update(id, { label, state: "running", progress: null });
  try {
    await run(id, (progress) => update(id, { progress }));
    update(id, { state: "done" });
    setTimeout(() => remove(id), 4000);
    return true;
  } catch (e) {
    const msg = errorMessage(e);
    if (msg.includes("CANCELLED")) {
      update(id, { state: "cancelled", message: "Annulé" });
      setTimeout(() => remove(id), 4000);
    } else {
      update(id, { state: "error", message: msg });
    }
    return false;
  }
}

export function cancel(id: number) {
  void api.fsCancel(id);
}
