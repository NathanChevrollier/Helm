import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Lock, Search, ShipWheel } from "lucide-react";
import { api } from "./lib/api";
import { useApp } from "./lib/store";
import { SECTIONS, type SectionId } from "./sections";
import { DialogHost, EmptyState, Toasts } from "./components/ui";
import CommandPalette from "./components/CommandPalette";
import LockScreen from "./components/LockScreen";
import ConnectionDoctor from "./components/ConnectionDoctor";
import { useLock, watchInactivity } from "./lib/lock";
import HomeView from "./views/Home";
import TerminalView from "./views/Terminal";

const VIEWS: Partial<Record<SectionId, ComponentType>> = {
  servers: lazy(() => import("./views/Servers")),
  files: lazy(() => import("./views/Files")),
  monitoring: lazy(() => import("./views/Monitoring")),
  docker: lazy(() => import("./views/Docker")),
  sites: lazy(() => import("./views/Sites")),
  logs: lazy(() => import("./views/Logs")),
  tunnels: lazy(() => import("./views/Tunnels")),
  backups: lazy(() => import("./views/Backups")),
  security: lazy(() => import("./views/Security")),
  settings: lazy(() => import("./views/Settings")),
};

export default function App() {
  const { section, setSection, servers, activeServerId, setActiveServer, refreshServers, hydrated, hydrate } = useApp();
  const [version, setVersion] = useState<string>();
  const [palette, setPalette] = useState(false);
  const active = servers.find((s) => s.id === activeServerId);
  const View = VIEWS[section];

  useEffect(() => {
    api.version().then(setVersion).catch(() => setVersion(undefined));
    // Profils d'abord (les onglets restaurés en dépendent), puis l'espace de travail sauvegardé.
    void refreshServers().then(hydrate);
    // Fichier de configuration illisible au démarrage : on prévient au lieu de repartir de zéro en silence.
    void api.storeWarning().then((w) => {
      if (w) void useApp.getState().ask({ title: "Configuration récupérée", body: w, confirmLabel: "Compris" });
    });
  }, [refreshServers, hydrate]);

  // Verrouillage : état initial, puis surveillance de l'inactivité.
  const locked = useLock((s) => s.locked);
  const lockConfigured = useLock((s) => s.configured);
  useEffect(() => {
    void useLock.getState().refresh();
    return watchInactivity(() => useApp.getState().settings.lockMinutes);
  }, []);

  // Ctrl+K : palette de commandes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useLock.getState().locked) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyL") {
        e.preventDefault();
        useLock.getState().lock();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyK") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
          <div className="flex items-center gap-2 px-4 pt-4 pb-3 text-lg font-semibold tracking-tight">
            <ShipWheel size={20} className="text-accent" />
            Helm
          </div>
          <div className="px-3 pb-2">
            <select
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
              value={activeServerId ?? ""}
              onChange={(e) => setActiveServer(e.target.value || null)}
              aria-label="Serveur actif"
            >
              {servers.length === 0 && <option value="">Aucun serveur</option>}
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.connected ? "● " : "○ "}
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="px-3 pb-3">
            <button
              onClick={() => setPalette(true)}
              className="flex h-8 w-full items-center gap-2 rounded-md border border-border px-2 text-xs text-muted hover:text-fg"
            >
              <Search size={13} />
              Rechercher une action
              <kbd className="ml-auto rounded border border-border px-1 font-sans text-[10px]">Ctrl K</kbd>
            </button>
          </div>
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-3 pb-3">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  id === section ? "bg-accent/15 text-fg" : "text-muted hover:bg-white/5 hover:text-fg"
                }`}
              >
                <Icon size={16} className={id === section ? "text-accent" : undefined} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <main className="relative min-w-0 flex-1">
          {hydrated && (
            <>
              {/* Le terminal reste monté pour ne pas couper les sessions quand on change de section. */}
              <div className={`absolute inset-0 ${section === "terminal" ? "" : "invisible"}`}>
                <TerminalView visible={section === "terminal"} />
              </div>
              {section === "home" && (
                <div className="absolute inset-0 bg-bg">
                  <HomeView visible />
                </div>
              )}
              {View && (
                <div className="absolute inset-0 bg-bg">
                  <Suspense fallback={<EmptyState icon={<ShipWheel size={32} className="animate-spin" />} title="Chargement…" />}>
                    <View />
                  </Suspense>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-panel px-3 text-xs text-muted">
        <span className="flex items-center gap-2">
          {active ? (
            <>
              <span className={`size-2 rounded-full ${active.connected ? "bg-ok" : "bg-muted/50"}`} />
              {active.name} — {active.username}@{active.host}
            </>
          ) : (
            "Aucun serveur sélectionné"
          )}
        </span>
        <span className="flex items-center gap-3">
          {lockConfigured && (
            <button className="flex items-center gap-1 hover:text-fg" title="Verrouiller Helm (Ctrl+Maj+L)" onClick={() => useLock.getState().lock()}>
              <Lock size={11} /> Verrouiller
            </button>
          )}
          {version ? `Helm v${version}` : ""}
        </span>
      </footer>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <ConnectionDoctor />
      <DialogHost />
      <Toasts />
      {locked && <LockScreen />}
    </div>
  );
}
