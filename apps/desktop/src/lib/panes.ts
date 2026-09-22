// Panneaux de terminal ouverts : serveur, session et dossier courant de chacun.
// Module séparé de TerminalPane : l'importer ne charge pas xterm.
import { create } from "zustand";
import { api } from "./api";
import { useApp } from "./store";
import { track } from "./transfers";

export interface PaneInfo {
  serverId: string;
  termId: number | null;
  /** Session tmux du panneau, si persistante. */
  tmux?: string;
  /** PID du shell simple (annoncé par la séquence OSC 7770 au démarrage). */
  pid?: number;
  /** Dossier annoncé par le shell lui-même (OSC 7) : secours quand le serveur ne répond pas. */
  cwd?: string;
}

interface PanesState {
  panes: Record<string, PaneInfo>;
  /** Dernier panneau ayant eu le focus. */
  active: string | null;
  set: (paneId: string, patch: Partial<PaneInfo> & { serverId?: string }) => void;
  remove: (paneId: string) => void;
  setActive: (paneId: string) => void;
}

export const usePanes = create<PanesState>((set) => ({
  panes: {},
  active: null,
  set: (paneId, patch) =>
    set((s) => ({ panes: { ...s.panes, [paneId]: { ...(s.panes[paneId] ?? { serverId: "", termId: null }), ...patch } } })),
  remove: (paneId) =>
    set((s) => {
      const panes = { ...s.panes };
      delete panes[paneId];
      return { panes, active: s.active === paneId ? null : s.active };
    }),
  setActive: (active) => set({ active }),
}));

/**
 * Dossier courant d'un panneau, demandé au serveur (tmux ou /proc du shell) pour qu'il suive les
 * `cd`. Le dossier annoncé par le shell (OSC 7) ne sert que si la question échoue, car il date du
 * dernier message reçu. `null` quand il reste introuvable (terminal lancé sur une commande,
 * serveur sans /proc, déconnecté…).
 */
export async function paneCwd(paneId: string): Promise<string | null> {
  const p = usePanes.getState().panes[paneId];
  if (!p) return null;
  if (p.tmux || p.pid) {
    try {
      const live = await api.termCwd(p.serverId, p.tmux, p.pid);
      if (live) return live;
    } catch {
      /* serveur momentanément injoignable : on retombe sur ce que le shell avait annoncé */
    }
  }
  return p.cwd ?? null;
}

/**
 * Envoie des fichiers du PC dans le dossier courant du terminal (glisser-déposer, menu).
 * Dossier inconnu : il est demandé, en proposant le dossier personnel.
 */
export async function uploadToPane(paneId: string, localPaths: string[]): Promise<void> {
  const p = usePanes.getState().panes[paneId];
  if (!p || !localPaths.length) return;
  const { ask, notify, servers } = useApp.getState();
  let dir = await paneCwd(paneId);
  if (!dir) {
    const home = await api.fsHome(p.serverId).catch(() => "/");
    const answer = await ask({
      title: "Dossier de destination",
      body: "Helm n'a pas pu lire le dossier courant de ce terminal. Où envoyer les fichiers ?",
      input: { label: "Dossier sur le serveur", initial: home },
      confirmLabel: "Envoyer",
    });
    if (typeof answer !== "string" || !answer.trim()) return;
    dir = answer.trim();
  }
  const target = dir;
  const name = servers.find((s) => s.id === p.serverId)?.name ?? "";
  const n = localPaths.length;
  const label = n > 1 ? `${n} éléments` : (localPaths[0].split(/[\\/]/).pop() ?? "");
  const ok = await track(`Envoi de ${label} vers ${name}:${target}`, (id, onProgress) => api.fsUpload(p.serverId, localPaths, target, id, onProgress));
  if (ok) notify(`${label} envoyé${n > 1 ? "s" : ""} dans ${target}`, "success");
}
