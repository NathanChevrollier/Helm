import { useEffect, useState } from "react";
import { Columns2, Pencil, Plus, ScrollText, SquareTerminal, Trash2, X } from "lucide-react";
import TerminalPane, { focusedTerminal } from "../components/TerminalPane";
import { api, type Snippet } from "../lib/api";
import { useApp } from "../lib/store";
import { Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";

export default function TerminalView({ visible }: { visible: boolean }) {
  const { tabs, activeTab, setActiveTab, closeTab, openTab, activeServerId, servers } = useApp();
  const [split, setSplit] = useState<Record<string, boolean>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [showSnippets, setShowSnippets] = useState(false);
  const current = tabs.find((t) => t.key === activeTab);

  // Raccourcis : Ctrl+Shift+T nouvel onglet, Ctrl+Shift+W fermer.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.code === "KeyT" && activeServerId) {
        e.preventDefault();
        openTab(current?.serverId ?? activeServerId);
      } else if (e.code === "KeyW" && activeTab) {
        e.preventDefault();
        closeTab(activeTab);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, activeServerId, activeTab, current, openTab, closeTab]);

  const serverOf = (id: string) => servers.find((s) => s.id === id);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-panel">
        <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          {tabs.map((t) => {
            const s = serverOf(t.serverId);
            const active = t.key === activeTab;
            return (
              <div
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
                className={`group flex max-w-56 min-w-32 cursor-pointer items-center gap-2 border-r border-border px-3 text-xs ${active ? "bg-bg text-fg" : "text-muted hover:text-fg"}`}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: s?.color ?? "#3b82f6" }} />
                <span className="flex-1 truncate" title={titles[t.key] ?? t.title}>
                  {t.title}
                </span>
                <button
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-white/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.key);
                  }}
                  aria-label="Fermer l'onglet"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <IconButton
            title="Nouveau terminal (Ctrl+Shift+T)"
            className="m-1"
            disabled={!activeServerId}
            onClick={() => activeServerId && openTab(current?.serverId ?? activeServerId)}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="flex items-center gap-1 px-2">
          <IconButton
            title="Diviser l'écran"
            disabled={!current}
            className={current && split[current.key] ? "text-accent" : ""}
            onClick={() => current && setSplit((s) => ({ ...s, [current.key]: !s[current.key] }))}
          >
            <Columns2 size={15} />
          </IconButton>
          <IconButton title="Snippets" className={showSnippets ? "text-accent" : ""} onClick={() => setShowSnippets((v) => !v)}>
            <ScrollText size={15} />
          </IconButton>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {tabs.length === 0 && (
            <EmptyState icon={<SquareTerminal size={40} />} title="Aucun terminal ouvert">
              {activeServerId ? (
                <Button variant="primary" className="mt-2" onClick={() => openTab(activeServerId)}>
                  Ouvrir un terminal sur {serverOf(activeServerId)?.name}
                </Button>
              ) : (
                "Ajoute d'abord un serveur dans l'onglet Serveurs."
              )}
            </EmptyState>
          )}
          {tabs.map((t) => {
            const show = visible && t.key === activeTab;
            return (
              <div key={t.key} className={`absolute inset-0 flex ${t.key === activeTab ? "" : "invisible"}`}>
                <div className="min-w-0 flex-1">
                  <TerminalPane
                    serverId={t.serverId}
                    command={t.command}
                    visible={show}
                    onTitle={(title) => setTitles((x) => ({ ...x, [t.key]: title }))}
                  />
                </div>
                {split[t.key] && (
                  <div className="min-w-0 flex-1 border-l border-border">
                    <TerminalPane serverId={t.serverId} visible={show} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {showSnippets && <SnippetsPanel />}
      </div>
    </div>
  );
}

function SnippetsPanel() {
  const notify = useApp((s) => s.notify);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const reload = () => void api.snippets().then(setSnippets);
  useEffect(reload, []);

  const run = (s: Snippet) => {
    if (focusedTerminal.id == null) {
      notify("Clique d'abord dans un terminal connecté.", "info");
      return;
    }
    void api.termWrite(focusedTerminal.id, s.command + "\r");
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">Snippets</span>
        <IconButton title="Nouveau snippet" onClick={() => setEditing({ id: "", name: "", command: "" })}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {snippets.length === 0 && (
          <p className="p-2 text-xs text-muted">Enregistre ici les commandes que tu tapes souvent. Un clic les envoie au terminal actif.</p>
        )}
        {snippets.map((s) => (
          <div key={s.id} className="group flex items-center rounded-md hover:bg-white/5">
            <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => run(s)} title={s.command}>
              <div className="truncate text-sm">{s.name}</div>
              <div className="truncate font-mono text-[11px] text-muted">{s.command}</div>
            </button>
            <div className="hidden pr-1 group-hover:flex">
              <IconButton title="Modifier" onClick={() => setEditing(s)}>
                <Pencil size={12} />
              </IconButton>
              <IconButton
                title="Supprimer"
                onClick={async () => {
                  await api.deleteSnippet(s.id);
                  reload();
                }}
              >
                <Trash2 size={12} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <Modal
          title={editing.id ? "Modifier le snippet" : "Nouveau snippet"}
          onClose={() => setEditing(null)}
          footer={
            <Button
              variant="primary"
              disabled={!editing.command.trim()}
              onClick={async () => {
                await api.saveSnippet({ ...editing, name: editing.name.trim() || editing.command.trim() });
                setEditing(null);
                reload();
              }}
            >
              Enregistrer
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            <Field label="Nom">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Logs nginx" autoFocus />
            </Field>
            <Field label="Commande">
              <Input
                className="font-mono"
                value={editing.command}
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                placeholder="tail -f /var/log/nginx/error.log"
              />
            </Field>
          </div>
        </Modal>
      )}
    </aside>
  );
}
