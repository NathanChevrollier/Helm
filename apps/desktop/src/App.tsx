import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Lock, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, ShipWheel, Sparkles, type LucideIcon } from "lucide-react";
import { api } from "./lib/api";
import { useApp, useAppPick } from "./lib/store";
import { SECTIONS, type SectionId } from "./sections";
import { DialogHost, EmptyState, FOCUS_RING, Toasts } from "./components/ui";
import CommandPalette from "./components/CommandPalette";
import LockScreen from "./components/LockScreen";
import ConnectionDoctor from "./components/ConnectionDoctor";
import GuideDialog from "./components/GuideDialog";
import { useLock, watchInactivity } from "./lib/lock";
import { watchAlerts } from "./lib/alerts";
import { watchSync } from "./lib/sync";
import { checkForUpdate } from "./lib/updater";
import { applyTheme } from "./lib/theme";
import { display, matches, shortcutOf } from "./lib/shortcuts";
import { refreshAll, useRefresh } from "./lib/refresh";
import { useAssistant } from "./lib/assistant";
import AssistantPanel from "./components/AssistantPanel";
import HomeView from "./views/Home";

// Chargé à part : xterm pèse un tiers de l'app et n'est pas nécessaire pour afficher l'accueil.
const TerminalView = lazy(() => import("./views/Terminal"));

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
  const { section, setSection, servers, activeServerId, setActiveServer, refreshServers, hydrated, hydrate } = useAppPick("section", "setSection", "servers", "activeServerId", "setActiveServer", "refreshServers", "hydrated", "hydrate");
  const [version, setVersion] = useState<string>();
  const [palette, setPalette] = useState(false);
  // Colonne dépliée ou non : choix retenu d'une session à l'autre.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("helm.rail") !== "closed");
  useEffect(() => {
    try {
      localStorage.setItem("helm.rail", railOpen ? "open" : "closed");
    } catch {
      /* stockage indisponible : la préférence ne sera pas retenue, sans conséquence */
    }
  }, [railOpen]);
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
  useEffect(() => watchAlerts(), []);
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

  const assistantOpen = useAssistant((s) => s.open);
  const themeSetting = useApp((s) => s.settings.theme);
  useEffect(() => applyTheme(themeSetting), [themeSetting]);

  // Ctrl+K : palette de commandes.
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
      if (matches(e, "lock")) {
        e.preventDefault();
        useLock.getState().lock();
        return;
      }
      if (matches(e, "palette")) {
        e.preventDefault();
        setPalette((v) => !v);
      }
      if (matches(e, "assistant")) {
        e.preventDefault();
        const assistant = useAssistant.getState();
        assistant.setOpen(!assistant.open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Aide et Réglages vivent ensemble en bas de la colonne : ce sont les deux entrées « à part ».
  const railSections = SECTIONS.filter((s) => s.id !== "settings" && s.id !== "help");
  const settingsSection = SECTIONS.find((s) => s.id === "settings")!;
  const helpSection = SECTIONS.find((s) => s.id === "help")!;

  return (
    <div className="flex h-full">
      {/* Colonne de navigation : dépliée, les libellés sont écrits ; repliée, ils passent en infobulle. */}
      <nav
        className={`flex shrink-0 flex-col gap-1 border-r border-border bg-rail py-3 transition-[width] ${railOpen ? "w-52 px-2" : "w-[60px] items-center"}`}
        aria-label="Navigation principale"
      >
        <div className={`mb-3 flex items-center ${railOpen ? "gap-2 px-1" : ""}`}>
          <button
            onClick={() => setSection("home")}
            className={`flex size-9 items-center justify-center rounded-lg text-accent hover:bg-hover ${FOCUS_RING}`}
            title="Helm"
            aria-label="Helm, accueil"
          >
            <ShipWheel size={22} />
          </button>
          {railOpen && <span className="text-sm font-semibold">Helm</span>}
          <button
            onClick={() => setRailOpen(!railOpen)}
            title={railOpen ? "Replier la colonne" : "Déplier la colonne"}
            aria-label={railOpen ? "Replier la colonne" : "Déplier la colonne"}
            aria-expanded={railOpen}
            className={`flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg ${FOCUS_RING} ${railOpen ? "ml-auto" : "hidden"}`}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
        {railSections.map((s) => (
          <RailButton key={s.id} label={s.label} icon={s.icon} expanded={railOpen} active={section === s.id} onClick={() => setSection(s.id)} />
        ))}
        <div className="flex-1" />
        {!railOpen && (
          <RailButton label="Déplier la colonne" icon={PanelLeftOpen} expanded={false} active={false} onClick={() => setRailOpen(true)} />
        )}
        {lockConfigured && (
          <RailButton
            label={railOpen ? "Verrouiller" : `Verrouiller (${display(shortcutOf("lock"))})`}
            icon={Lock}
            expanded={railOpen}
            active={false}
            onClick={() => useLock.getState().lock()}
          />
        )}
        <RailButton label={helpSection.label} icon={helpSection.icon} expanded={railOpen} active={section === "help"} onClick={() => setSection("help")} />
        <RailButton label={settingsSection.label} icon={settingsSection.icon} expanded={railOpen} active={section === "settings"} onClick={() => setSection("settings")} />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Serveurs en onglets et barre de commande. */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto" role="group" aria-label="Serveur actif">
            {servers.map((s) => {
              const current = s.id === activeServerId;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveServer(s.id)}
                  title={`${s.username}@${s.host}:${s.port}`}
                  aria-pressed={current}
                  className={`flex h-8 shrink-0 items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors ${
                    current ? "border-border-strong bg-panel font-semibold text-fg" : "border-border text-muted hover:text-fg"
                  }`}
                >
                  <span className={`size-[7px] rounded-full ${s.connected ? "bg-ok" : "bg-muted/40"}`} />
                  {s.name}
                </button>
              );
            })}
            <button
              onClick={() => setSection("servers")}
              title="Ajouter ou gérer les serveurs"
              aria-label="Ajouter ou gérer les serveurs"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border-strong text-muted hover:text-fg"
            >
              <Plus size={15} />
            </button>
          </div>
          <AssistantButton />
          <RefreshButton />
          <button
            onClick={() => setPalette(true)}
            className="flex h-[34px] w-[440px] max-w-[45%] shrink-0 items-center gap-2.5 rounded-lg border border-border bg-panel px-3 text-[13px] text-muted hover:border-border-strong"
          >
            <Search size={15} />
            Rechercher, ouvrir, relancer…
            <kbd className="ml-auto rounded-[5px] border border-border-strong px-1.5 py-px font-mono text-[11px]">{display(shortcutOf("palette"))}</kbd>
          </button>
        </header>

        <main className="relative flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
          {hydrated && (
            <>
              {/* Le terminal reste monté pour ne pas couper les sessions quand on change de section. */}
              <div className={`absolute inset-0 ${section === "terminal" ? "" : "invisible"}`}>
                <Suspense fallback={null}>
                  <TerminalView visible={section === "terminal"} />
                </Suspense>
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
          </div>
          {assistantOpen && <AssistantPanel />}
        </main>

        {/* Barre d'état. */}
        <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-rail px-3.5 text-xs text-muted">
          {active ? (
            <span className="flex items-center gap-1.5">
              <span className={`size-[7px] rounded-full ${active.connected ? "bg-ok" : "bg-muted/40"}`} />
              <span className="font-mono">
                {active.username}@{active.host}:{active.port}
              </span>
              {!active.connected && <span>· non connecté</span>}
            </span>
          ) : (
            <span>Aucun serveur sélectionné</span>
          )}
          <span className="ml-auto font-mono">
            {display(shortcutOf("palette"))} commandes · {display(shortcutOf("termSearch"))} rechercher
          </span>
          {version && <span>Helm v{version}</span>}
        </footer>
      </div>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <GuideDialog />
      <ConnectionDoctor />
      <DialogHost />
      <Toasts />
      {locked && <LockScreen />}
    </div>
  );
}

/** Ouvre le panneau de l'assistant IA. */
function AssistantButton() {
  const { open, setOpen } = useAssistant();
  return (
    <button
      onClick={() => setOpen(!open)}
      title={`Assistant IA (${display(shortcutOf("assistant"))})`}
      aria-label="Assistant IA"
      aria-pressed={open}
      className={`ml-auto flex size-[34px] shrink-0 items-center justify-center rounded-lg border ${open ? "border-accent/60 bg-accent/10 text-accent" : "border-border text-muted hover:border-border-strong hover:text-fg"}`}
    >
      <Sparkles size={15} />
    </button>
  );
}

/** Actualise la page affichée et l'état des serveurs (aussi F5). */
function RefreshButton() {
  const tick = useRefresh((s) => s.tick);
  const [spin, setSpin] = useState(false);
  useEffect(() => {
    if (!tick) return;
    setSpin(true);
    const t = setTimeout(() => setSpin(false), 700);
    return () => clearTimeout(t);
  }, [tick]);
  return (
    <button
      onClick={refreshAll}
      title="Actualiser (F5)"
      aria-label="Actualiser"
      className="flex size-[34px] shrink-0 items-center justify-center rounded-lg border border-border text-muted hover:border-border-strong hover:text-fg"
    >
      <RefreshCw size={15} className={spin ? "animate-spin" : ""} />
    </button>
  );
}

/** Bouton de la colonne : libellé écrit quand elle est dépliée, en infobulle quand elle est repliée. */
function RailButton({
  label,
  icon: Icon,
  active,
  expanded,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={expanded ? undefined : label}
      className={`group relative flex h-10 shrink-0 items-center rounded-[10px] transition-colors ${FOCUS_RING} ${
        expanded ? "w-full gap-2.5 px-2.5" : "w-10 justify-center"
      } ${active ? "bg-panel text-fg ring-1 ring-border-strong" : "text-muted hover:bg-hover hover:text-fg"}`}
    >
      <Icon size={18} className="shrink-0" />
      {expanded ? (
        <span className="min-w-0 truncate text-[13px]">{label}</span>
      ) : (
        <span className="pointer-events-none absolute left-full z-50 ml-2.5 rounded-md border border-border-strong bg-panel px-2 py-1 text-xs whitespace-nowrap text-fg opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
          {label}
        </span>
      )}
    </button>
  );
}
