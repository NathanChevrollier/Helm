import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { ShipWheel } from "lucide-react";
import { api } from "./lib/api";
import { useApp, useAppPick } from "./lib/store";
import type { SectionId } from "./sections";
import { DialogHost, EmptyState, Toasts } from "./components/ui";
import LockScreen from "./components/LockScreen";
import ConnectionDoctor from "./components/ConnectionDoctor";
import Sidebar from "./components/shell/Sidebar";
import Topbar from "./components/shell/Topbar";
import StatusBar from "./components/shell/StatusBar";
import { useRdp } from "./lib/rdp";
import { useLock, watchInactivity } from "./lib/lock";
import { watchAlerts } from "./lib/alerts";
import { watchSync } from "./lib/sync";
import { checkForUpdate } from "./lib/updater";
import { applyTheme } from "./lib/theme";
import { matches } from "./lib/shortcuts";
import { refreshAll } from "./lib/refresh";
import { useAssistant } from "./lib/assistant";
import { useShell } from "./lib/shell";
import { fetchHealth } from "./lib/health";
import { usePolling } from "./lib/poll";

// Fenêtres et panneaux ouverts à la demande : chargés à leur première ouverture, pas au démarrage.
const CommandPalette = lazy(() => import("./components/CommandPalette"));
const AssistantPanel = lazy(() => import("./components/AssistantPanel"));
const GuideDialog = lazy(() => import("./components/GuideDialog"));
const ShortcutsHelp = lazy(() => import("./components/shell/ShortcutsHelp"));
const HomeView = lazy(() => import("./views/Home"));

// Chargé à part : xterm pèse un tiers de l'app et n'est pas nécessaire pour afficher l'accueil.
const TerminalView = lazy(() => import("./views/Terminal"));
// Client RDP : plusieurs méga-octets de WebAssembly, chargés seulement à la première session.
const RemoteDesktopSession = lazy(() => import("./components/RemoteDesktopSession"));
// Client VNC (noVNC) : chargé seulement à la première session VNC.
const VncSession = lazy(() => import("./components/VncSession"));

const VIEWS: Partial<Record<SectionId, ComponentType>> = {
  servers: lazy(() => import("./views/Servers")),
  files: lazy(() => import("./views/Files")),
  monitoring: lazy(() => import("./views/Monitoring")),
  docker: lazy(() => import("./views/Docker")),
  databases: lazy(() => import("./views/Databases")),
  sites: lazy(() => import("./views/Sites")),
  logs: lazy(() => import("./views/Logs")),
  tunnels: lazy(() => import("./views/Tunnels")),
  backups: lazy(() => import("./views/Backups")),
  security: lazy(() => import("./views/Security")),
  help: lazy(() => import("./views/Help")),
  settings: lazy(() => import("./views/Settings")),
};

export default function App() {
  const { section, activeServerId, refreshServers, hydrated, hydrate } = useAppPick("section", "activeServerId", "refreshServers", "hydrated", "hydrate");
  const [version, setVersion] = useState<string>();
  const paletteOpen = useShell((s) => s.paletteOpen);
  const View = VIEWS[section];
  // Le terminal n'est monté qu'une fois utile (onglets restaurés, ou première visite) ; ensuite il
  // reste monté pour ne pas couper les sessions quand on change de section.
  const hasTabs = useApp((s) => s.tabs.length > 0);
  const [terminalMounted, setTerminalMounted] = useState(false);
  useEffect(() => {
    if (hydrated && (hasTabs || section === "terminal")) setTerminalMounted(true);
  }, [hydrated, hasTabs, section]);
  const guideDialogOpen = useApp((s) => !!s.guide && !s.guideInPage);
  const shortcutsOpen = useShell((s) => s.shortcutsOpen);
  const rdpOuvert = useRdp((s) => s.desktop !== null);
  const rdpVnc = useRdp((s) => s.desktop?.protocol === "vnc");

  useEffect(() => {
    api.version().then(setVersion).catch(() => setVersion(undefined));
    // Profils d'abord (les onglets restaurés en dépendent), puis l'espace de travail sauvegardé.
    // Les deux lectures partent en même temps ; seule leur application suit cet ordre.
    const saved = api.uiStateGet();
    saved.catch(() => {}); // erreur traitée par hydrate

    void refreshServers()
      .catch(() => {})
      .then(() => hydrate(saved));
    // Fichier de configuration illisible au démarrage : on prévient au lieu de repartir de zéro en silence.
    void api.storeWarning().then((w) => {
      if (w) void useApp.getState().ask({ title: "Configuration récupérée", body: w, confirmLabel: "Compris" });
    });
  }, [refreshServers, hydrate]);

  // Verrouillage : état initial, puis surveillance de l'inactivité.
  const locked = useLock((s) => s.locked);
  useEffect(() => {
    void useLock.getState().refresh();
    return watchInactivity(() => useApp.getState().settings.lockMinutes);
  }, []);
  useEffect(() => watchAlerts(), []);
  // Une fois l'app affichée et au repos, précharge les écrans les plus ouverts : leur première
  // ouverture devient instantanée sans alourdir le démarrage.
  useEffect(() => {
    if (!hydrated) return;
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const id = window.setTimeout(
      () =>
        idle(() => {
          for (const load of [() => import("./views/Terminal"), () => import("./views/Servers"), () => import("./views/Home"), () => import("./components/CommandPalette")]) {
            void load().catch(() => {});
          }
        }),
      2000,
    );
    return () => window.clearTimeout(id);
  }, [hydrated]);
  // Réglages partagés avec les autres PC (si la synchronisation est configurée).
  useEffect(() => (hydrated ? watchSync() : undefined), [hydrated]);
  // Nouvelle version sur GitHub : vérifiée quelques secondes après le démarrage (pas en dev).
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const t = setTimeout(() => void checkForUpdate(), 5000);
    return () => clearTimeout(t);
  }, []);
  // État de connexion des serveurs (pastilles), relu au rythme de l'actualisation automatique.
  const autoRefreshSecs = useApp((s) => s.settings.autoRefreshSecs);
  useEffect(() => {
    if (autoRefreshSecs <= 0) return;
    const id = setInterval(() => {
      if (!document.hidden) void useApp.getState().refreshServers().catch(() => {});
    }, autoRefreshSecs * 1000);
    return () => clearInterval(id);
  }, [autoRefreshSecs]);
  // Santé du serveur actif (badges de la barre latérale), seulement s'il est déjà connecté.
  const activeConnected = useApp((s) => s.servers.find((x) => x.id === s.activeServerId)?.connected ?? false);
  usePolling(() => (activeServerId ? fetchHealth(activeServerId, 30_000) : undefined), 60_000, [activeServerId], activeConnected);

  const assistantOpen = useAssistant((s) => s.open);
  const themeSetting = useApp((s) => s.settings.theme);
  useEffect(() => applyTheme(themeSetting), [themeSetting]);

  // Raccourcis globaux.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Pas de rechargement de la fenêtre : il couperait les terminaux (et ne doit rien déverrouiller).
      // F5 / Ctrl+R actualisent plutôt les données affichées.
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.code === "KeyR")) {
        e.preventDefault();
        if (!useLock.getState().locked && !e.repeat) refreshAll();
        return;
      }
      if (useLock.getState().locked) return;
      const shell = useShell.getState();
      if (matches(e, "lock")) {
        e.preventDefault();
        useLock.getState().lock();
      } else if (matches(e, "palette")) {
        e.preventDefault();
        if (shell.paletteOpen) shell.closePalette();
        else shell.openPalette();
      } else if (matches(e, "switcher")) {
        e.preventDefault();
        shell.setSwitcherOpen(!shell.switcherOpen);
      } else if (matches(e, "shortcutsHelp")) {
        e.preventDefault();
        shell.setShortcutsOpen(!shell.shortcutsOpen);
      } else if (matches(e, "assistant")) {
        e.preventDefault();
        const assistant = useAssistant.getState();
        assistant.setOpen(!assistant.open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar version={version} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="relative flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            {hydrated && (
              <>
                {/* Le terminal reste monté pour ne pas couper les sessions quand on change de section. */}
                {terminalMounted && (
                  <div className={`absolute inset-0 ${section === "terminal" ? "" : "invisible"}`}>
                    <Suspense fallback={null}>
                      <TerminalView visible={section === "terminal"} />
                    </Suspense>
                  </div>
                )}
                {section === "home" && (
                  <div className="absolute inset-0 bg-bg">
                    <Suspense fallback={null}>
                      <HomeView visible />
                    </Suspense>
                  </div>
                )}
                {View && (
                  <div className="absolute inset-0 bg-bg">
                    <Suspense fallback={<EmptyState icon={<ShipWheel className="animate-spin" />} title="Chargement…" />}>
                      <View />
                    </Suspense>
                  </div>
                )}
              </>
            )}
          </div>
          {assistantOpen && (
            <Suspense fallback={null}>
              <AssistantPanel />
            </Suspense>
          )}
          {rdpOuvert && (
            <Suspense fallback={null}>
              {rdpVnc ? <VncSession /> : <RemoteDesktopSession />}
            </Suspense>
          )}
        </main>
        <StatusBar />
      </div>

      <Suspense fallback={null}>
        {paletteOpen && <CommandPalette onClose={() => useShell.getState().closePalette()} />}
        {shortcutsOpen && <ShortcutsHelp />}
        {guideDialogOpen && <GuideDialog />}
      </Suspense>
      <ConnectionDoctor />
      <DialogHost />
      <Toasts />
      {locked && <LockScreen />}
    </div>
  );
}
