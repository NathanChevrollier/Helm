import { create } from "zustand";
import { api, errorMessage, type ServerView } from "./api";
import type { SectionId } from "../sections";

export interface DialogRequest {
  title: string;
  body?: string;
  /** Texte affiché en police mono (empreinte, commande…). */
  code?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Si défini, le dialogue demande une saisie (mot de passe si `secret`). */
  input?: { label: string; secret?: boolean; initial?: string };
  resolve: (value: string | boolean | null) => void;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
}

export interface TermTab {
  key: string;
  serverId: string;
  title: string;
  /** Commande interactive à lancer à la place du shell (ex. `docker exec -it`). */
  command?: string;
}

interface State {
  section: SectionId;
  setSection: (s: SectionId) => void;

  servers: ServerView[];
  refreshServers: () => Promise<void>;
  activeServerId: string | null;
  setActiveServer: (id: string | null) => void;

  dialog: DialogRequest | null;
  ask: (req: Omit<DialogRequest, "resolve">) => Promise<string | boolean | null>;
  closeDialog: (value: string | boolean | null) => void;

  toasts: Toast[];
  notify: (message: string, kind?: Toast["kind"]) => void;

  tabs: TermTab[];
  activeTab: string | null;
  openTab: (serverId: string, opts?: { title?: string; command?: string }) => void;
  closeTab: (key: string) => void;
  setActiveTab: (key: string) => void;
}

const ACTIVE_SERVER_KEY = "helm.activeServer";
let toastSeq = 0;
let tabSeq = 0;

function readActiveServer(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SERVER_KEY);
  } catch {
    return null;
  }
}

export const useApp = create<State>((set, get) => ({
  section: "servers",
  setSection: (section) => set({ section }),

  servers: [],
  refreshServers: async () => {
    const servers = await api.servers();
    const active = get().activeServerId;
    set({
      servers,
      activeServerId: active && servers.some((s) => s.id === active) ? active : (servers[0]?.id ?? null),
    });
  },
  activeServerId: readActiveServer(),
  setActiveServer: (id) => {
    try {
      if (id) localStorage.setItem(ACTIVE_SERVER_KEY, id);
    } catch {
      /* stockage indisponible : on garde juste l'état en mémoire */
    }
    set({ activeServerId: id });
  },

  dialog: null,
  ask: (req) => new Promise((resolve) => set({ dialog: { ...req, resolve } })),
  closeDialog: (value) => {
    get().dialog?.resolve(value);
    set({ dialog: null });
  },

  toasts: [],
  notify: (message, kind = "info") => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 8000 : 4000);
  },

  tabs: [],
  activeTab: null,
  openTab: (serverId, opts = {}) => {
    const server = get().servers.find((s) => s.id === serverId);
    const key = `t${++tabSeq}`;
    const title = opts.title ?? server?.name ?? "Terminal";
    set((s) => ({ tabs: [...s.tabs, { key, serverId, title, command: opts.command }], activeTab: key, section: "terminal" }));
  },
  closeTab: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeTab = s.activeTab === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeTab;
      return { tabs, activeTab };
    }),
  setActiveTab: (activeTab) => set({ activeTab }),
}));

/**
 * Connecte le serveur en gérant les cas qui demandent l'avis de l'utilisateur :
 * clé d'hôte inconnue ou modifiée, mot de passe absent.
 */
export async function ensureConnected(serverId: string): Promise<boolean> {
  const { ask, notify, refreshServers } = useApp.getState();
  const server = () => useApp.getState().servers.find((s) => s.id === serverId);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api.connect(serverId);
      void refreshServers();
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.startsWith("UNKNOWN_HOST_KEY:")) {
        const fp = msg.slice("UNKNOWN_HOST_KEY:".length);
        const ok = await ask({
          title: "Nouveau serveur",
          body: `C'est la première connexion à ${server()?.host}. Vérifie que l'empreinte de sa clé correspond bien à celle de ton VPS avant de l'approuver.`,
          code: fp,
          confirmLabel: "Approuver et se connecter",
        });
        if (!ok) return false;
        await api.trustHost(serverId, fp);
        continue;
      }
      if (msg.startsWith("HOST_KEY_MISMATCH:")) {
        const [expected, got] = msg.slice("HOST_KEY_MISMATCH:".length).split("|");
        const ok = await ask({
          title: "⚠ La clé du serveur a changé",
          body: "La clé présentée ne correspond pas à celle enregistrée. C'est normal après une réinstallation du VPS, mais cela peut aussi signaler une attaque. N'accepte que si tu sais pourquoi elle a changé.",
          code: `Attendue : ${expected}\nReçue :   ${got}`,
          confirmLabel: "Accepter la nouvelle clé",
          danger: true,
        });
        if (!ok) return false;
        await api.trustHost(serverId, got);
        continue;
      }
      if (msg.startsWith("NEED_PASSWORD")) {
        const pw = await ask({
          title: `Mot de passe pour ${server()?.username}@${server()?.host}`,
          body: "Il sera enregistré dans le coffre-fort de ton système (Gestionnaire d'identification Windows / Trousseau).",
          input: { label: "Mot de passe", secret: true },
          confirmLabel: "Se connecter",
        });
        if (typeof pw !== "string" || !pw) return false;
        const s = server();
        if (!s) return false;
        await api.saveServer(s, { password: pw });
        continue;
      }
      notify(msg, "error");
      return false;
    }
  }
  return false;
}
