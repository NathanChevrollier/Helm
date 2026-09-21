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
  /** Identifiant stable (survit au redémarrage de l'app). */
  key: string;
  serverId: string;
  title: string;
  /** Commande interactive à lancer à la place du shell (ex. `docker exec -it`). */
  command?: string;
  /** Session tmux du panneau principal (sessions persistantes). */
  tmux?: string;
  /** Écran divisé : session tmux du second panneau, ou "" pour un shell simple. */
  split?: string | null;
}

export interface Settings {
  /** Ouvrir les terminaux dans des sessions tmux persistantes. */
  persistentSessions: boolean;
  /** Serveurs pour lesquels l'installation de tmux a été refusée. */
  tmuxDeclined: Record<string, boolean>;
}

/** Partie de l'état sauvegardée dans helm.json et restaurée au démarrage. */
interface Persisted {
  v: 1;
  section: SectionId;
  tabs: TermTab[];
  activeTab: string | null;
  filesPaths: Record<string, string>;
  settings: Settings;
  recent: string[];
}

interface State {
  hydrated: boolean;
  hydrate: () => Promise<void>;

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

  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;

  tabs: TermTab[];
  activeTab: string | null;
  openTab: (serverId: string, opts?: { title?: string; command?: string; tmux?: string }) => void;
  closeTab: (key: string) => void;
  setActiveTab: (key: string) => void;
  updateTab: (key: string, patch: Partial<TermTab>) => void;

  /** Dernier dossier ouvert dans l'explorateur, par serveur. */
  filesPaths: Record<string, string>;
  setFilesPath: (serverId: string, path: string) => void;

  /** Identifiants des dernières actions de la palette (les plus récentes d'abord). */
  recent: string[];
  pushRecent: (id: string) => void;
}

const ACTIVE_SERVER_KEY = "helm.activeServer";
let toastSeq = 0;

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function newTmuxName(): string {
  return `helm-${newId()}`;
}

function readActiveServer(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SERVER_KEY);
  } catch {
    return null;
  }
}

export const useApp = create<State>((set, get) => ({
  hydrated: false,
  hydrate: async () => {
    try {
      const raw = (await api.uiStateGet()) as Partial<Persisted> | null;
      if (raw && raw.v === 1) {
        set({
          section: raw.section ?? "servers",
          tabs: raw.tabs ?? [],
          activeTab: raw.activeTab ?? null,
          filesPaths: raw.filesPaths ?? {},
          settings: { ...get().settings, ...raw.settings },
          recent: raw.recent ?? [],
        });
      }
    } catch {
      /* état illisible : on repart d'un espace de travail vide */
    }
    set({ hydrated: true });
  },

  section: "home",
  setSection: (section) => set({ section }),

  servers: [],
  refreshServers: async () => {
    const servers = await api.servers();
    const active = get().activeServerId;
    set((s) => ({
      servers,
      activeServerId: active && servers.some((x) => x.id === active) ? active : (servers[0]?.id ?? null),
      // Les onglets d'un serveur supprimé disparaissent.
      tabs: s.tabs.filter((t) => servers.some((x) => x.id === t.serverId)),
    }));
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

  settings: { persistentSessions: true, tmuxDeclined: {} },
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  tabs: [],
  activeTab: null,
  openTab: (serverId, opts = {}) => {
    const { servers, settings } = get();
    const server = servers.find((s) => s.id === serverId);
    const key = newId();
    const title = opts.title ?? server?.name ?? "Terminal";
    // Un shell simple devient persistant ; une commande (logs, exec…) reste éphémère.
    const tmux = opts.tmux ?? (!opts.command && settings.persistentSessions && !settings.tmuxDeclined[serverId] ? newTmuxName() : undefined);
    set((s) => ({ tabs: [...s.tabs, { key, serverId, title, command: opts.command, tmux }], activeTab: key, section: "terminal" }));
  },
  closeTab: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeTab = s.activeTab === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeTab;
      return { tabs, activeTab };
    }),
  setActiveTab: (activeTab) => set({ activeTab }),
  updateTab: (key, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) })),

  filesPaths: {},
  setFilesPath: (serverId, path) => set((s) => ({ filesPaths: { ...s.filesPaths, [serverId]: path } })),

  recent: [],
  pushRecent: (id) => set((s) => ({ recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, 30) })),
}));

// Sauvegarde de l'espace de travail, regroupée pour ne pas écrire à chaque frappe.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastSaved = "";
useApp.subscribe((s) => {
  if (!s.hydrated) return;
  const snapshot: Persisted = {
    v: 1,
    section: s.section,
    tabs: s.tabs,
    activeTab: s.activeTab,
    filesPaths: s.filesPaths,
    settings: s.settings,
    recent: s.recent,
  };
  const json = JSON.stringify(snapshot);
  if (json === lastSaved) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    lastSaved = json;
    void api.uiStateSet(snapshot).catch(() => {});
  }, 500);
});

/**
 * Connecte le serveur en gérant les cas qui demandent l'avis de l'utilisateur :
 * clé d'hôte inconnue ou modifiée, mot de passe absent.
 */
/**
 * `force` : action explicite de l'utilisateur (clic sur Connecter…) ; seule elle relance une
 * connexion suspendue après un échec d'authentification.
 */
export async function ensureConnected(serverId: string, opts: { interactive?: boolean; force?: boolean } = {}): Promise<boolean> {
  const interactive = opts.interactive ?? true;
  const { ask, notify, refreshServers } = useApp.getState();
  const server = () => useApp.getState().servers.find((s) => s.id === serverId);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // Une tentative interactive (clic de l'utilisateur) lève la suspension après un échec d'authentification.
      await api.connect(serverId, opts.force ?? false);
      void refreshServers();
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      // En arrière-plan (reconnexion, vue d'ensemble), on n'ouvre jamais de dialogue.
      if (!interactive) return false;
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
