import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SECTIONS, type SectionId } from "./sections";

export default function App() {
  const [active, setActive] = useState<SectionId>("servers");
  const [version, setVersion] = useState<string>();
  const section = SECTIONS.find((s) => s.id === active)!;

  useEffect(() => {
    invoke<string>("app_version").then(setVersion).catch(() => setVersion(undefined));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 flex-col gap-1 border-r border-border bg-panel p-3">
          <div className="mb-4 px-2 text-lg font-semibold tracking-tight">Helm</div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={`flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors ${
                id === active ? "bg-accent/15 text-fg" : "text-muted hover:bg-white/5 hover:text-fg"
              }`}
            >
              <Icon size={16} className={id === active ? "text-accent" : undefined} />
              {label}
            </button>
          ))}
        </nav>

        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <section.icon size={40} className="mx-auto mb-4 text-accent" />
            <h1 className="mb-2 text-xl font-semibold">{section.label}</h1>
            <p className="mb-4 text-sm text-muted">{section.description}</p>
            <span className="rounded-full border border-border px-3 py-1 text-xs text-muted">
              Prévu en phase {section.phase}
            </span>
          </div>
        </main>
      </div>

      <footer className="flex h-7 items-center justify-between border-t border-border bg-panel px-3 text-xs text-muted">
        <span>Aucun serveur connecté</span>
        <span>{version ? `Helm v${version}` : "Pont Rust indisponible"}</span>
      </footer>
    </div>
  );
}
