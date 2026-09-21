import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { useApp } from "./lib/store";
import { SECTIONS } from "./sections";
import { DialogHost, EmptyState, Toasts } from "./components/ui";
import ServersView from "./views/Servers";
import TerminalView from "./views/Terminal";

export default function App() {
  const { section, setSection, servers, activeServerId, setActiveServer, refreshServers } = useApp();
  const [version, setVersion] = useState<string>();
  const active = servers.find((s) => s.id === activeServerId);
  const current = SECTIONS.find((s) => s.id === section)!;

  useEffect(() => {
    api.version().then(setVersion).catch(() => setVersion(undefined));
    void refreshServers();
  }, [refreshServers]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
          <div className="px-4 pt-4 pb-3 text-lg font-semibold tracking-tight">Helm</div>
          <div className="px-3 pb-3">
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
          <div className="flex flex-col gap-0.5 px-3">
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
          {/* Le terminal reste monté pour ne pas couper les sessions quand on change de section. */}
          <div className={`absolute inset-0 ${section === "terminal" ? "" : "invisible"}`}>
            <TerminalView visible={section === "terminal"} />
          </div>
          {section !== "terminal" && (
            <div className="absolute inset-0 bg-bg">
              {section === "servers" ? (
                <ServersView />
              ) : (
                <EmptyState icon={<current.icon size={40} />} title={current.label}>
                  {current.description}
                </EmptyState>
              )}
            </div>
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
        <span>{version ? `Helm v${version}` : ""}</span>
      </footer>

      <DialogHost />
      <Toasts />
    </div>
  );
}
