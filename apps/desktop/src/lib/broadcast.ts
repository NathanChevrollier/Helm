// Diffusion de la saisie : ce qui est tapé dans un terminal ciblé est envoyé à tous les terminaux ciblés.
import { create } from "zustand";
import { api } from "./api";
import { useApp } from "./store";

/** Commandes qui demandent une confirmation avant d'être validées sur plusieurs terminaux. */
const DANGEROUS =
  /(^|[\s;&|])(rm\s+-[a-z]*(rf|fr)[a-z]*|mkfs(\.\w+)?|dd\s+if=|shutdown|reboot|poweroff|halt|init\s+[06]|systemctl\s+(stop|disable|poweroff|reboot|halt)|docker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune))|chmod\s+-R\s+777|chown\s+-R|:\(\)\s*\{|>\s*\/dev\/sd|userdel|apt(-get)?\s+(remove|purge))/i;

interface Pane {
  termId: number | null;
  label: string;
}

interface BroadcastState {
  active: boolean;
  /** Identifiants de panneaux ciblés (`<onglet>:<index>`). */
  targets: string[];
  panes: Record<string, Pane>;
  setActive: (active: boolean, targets?: string[]) => void;
  register: (paneId: string, pane: Pane) => void;
  unregister: (paneId: string) => void;
}

export const useBroadcast = create<BroadcastState>((set) => ({
  active: false,
  targets: [],
  panes: {},
  setActive: (active, targets) => set((s) => ({ active, targets: targets ?? s.targets })),
  register: (paneId, pane) => set((s) => ({ panes: { ...s.panes, [paneId]: pane } })),
  unregister: (paneId) =>
    set((s) => {
      const panes = { ...s.panes };
      delete panes[paneId];
      return { panes, targets: s.targets.filter((t) => t !== paneId) };
    }),
}));

/** Ligne en cours de saisie (approximation suffisante pour détecter une commande dangereuse). */
let line = "";
let confirming = false;

function targetIds(): number[] {
  const { targets, panes } = useBroadcast.getState();
  return targets.map((t) => panes[t]?.termId).filter((id): id is number => id != null);
}

function sendAll(data: string) {
  for (const id of targetIds()) void api.termWrite(id, data);
}

/** Vrai si le panneau participe à la diffusion en cours. */
export function isBroadcasting(paneId: string): boolean {
  const s = useBroadcast.getState();
  return s.active && s.targets.includes(paneId);
}

/** Envoie la saisie à tous les panneaux ciblés, en retenant l'Entrée d'une commande dangereuse. */
export async function broadcastInput(data: string) {
  if (confirming) return;
  if (data.startsWith("\x1b")) {
    sendAll(data);
    return;
  }
  let pending = "";
  for (const ch of data) {
    if (ch === "\r") {
      const cmd = line.trim();
      line = "";
      if (DANGEROUS.test(cmd)) {
        sendAll(pending);
        pending = "";
        confirming = true;
        const ok = await useApp.getState().ask({
          title: "Commande sensible diffusée",
          body: `Cette commande va être exécutée sur ${targetIds().length} terminaux en même temps.`,
          code: cmd,
          confirmLabel: "Exécuter partout",
          danger: true,
        });
        confirming = false;
        // Refus : on efface la ligne (Ctrl+U) sur tous les terminaux.
        sendAll(ok ? "\r" : "\x15");
        continue;
      }
      pending += ch;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
    else if (ch === "\x15" || ch === "\x03") line = "";
    else if (ch >= " ") line += ch;
    pending += ch;
  }
  // Les séquences d'échappement (flèches…) passent telles quelles, sans toucher la ligne.
  if (pending) sendAll(pending);
}
