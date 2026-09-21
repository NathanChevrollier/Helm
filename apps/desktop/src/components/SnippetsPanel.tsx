import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { focusedTerminal } from "./TerminalPane";
import { api, type Snippet } from "../lib/api";
import { useApp } from "../lib/store";
import { Button, Field, IconButton, Input, Modal } from "./ui";

export default function SnippetsPanel() {
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
          <div key={s.id} className="group flex items-center rounded-md hover:bg-hover">
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
