import { useEffect, useState } from "react";
import { Braces, Pencil, Plus, Trash2 } from "lucide-react";
import { focusedTerminal } from "../lib/focus";
import { api, type Snippet } from "../lib/api";
import { fillVars, hasVars, parseVars, type SnippetVar } from "../lib/snippet-vars";
import { useApp } from "../lib/store";
import { Button, Field, IconButton, Input, Modal } from "./ui";

export default function SnippetsPanel() {
  const notify = useApp((s) => s.notify);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const reload = () => void api.snippets().then(setSnippets);
  useEffect(reload, []);

  /** Fragment paramétrable en attente de ses valeurs. */
  const [asking, setAsking] = useState<Snippet | null>(null);

  const send = (command: string) => {
    if (focusedTerminal.id == null) {
      notify("Clique d'abord dans un terminal connecté.", "info");
      return;
    }
    void api.termWrite(focusedTerminal.id, command + "\r");
  };

  const run = (s: Snippet) => {
    // Un fragment à variables demande ses valeurs avant de partir : c'est tout l'intérêt de
    // « docker logs -f --tail {{lignes:100}} {{conteneur}} » plutôt qu'une commande figée.
    if (hasVars(s.command)) {
      if (focusedTerminal.id == null) return notify("Clique d'abord dans un terminal connecté.", "info");
      return setAsking(s);
    }
    send(s.command);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">Fragments</span>
        <IconButton title="Nouveau fragment" onClick={() => setEditing({ id: "", name: "", command: "" })}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {snippets.length === 0 && (
          <p className="p-2 text-xs text-muted">
            Enregistre ici les commandes que tu tapes souvent. Un clic les envoie au terminal actif. Écris{" "}
            <span className="font-mono">{"{{nom:défaut}}"}</span> pour qu'un paramètre soit demandé avant l'envoi.
          </p>
        )}
        {snippets.map((s) => (
          <div key={s.id} className="group flex items-center rounded-md hover:bg-hover">
            <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => run(s)} title={s.command}>
              <div className="flex items-center gap-1 truncate text-sm">
                {hasVars(s.command) && (
                  <span title="Demande des paramètres">
                    <Braces size={11} className="shrink-0 text-accent" />
                  </span>
                )}
                <span className="truncate">{s.name}</span>
              </div>
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
          title={editing.id ? "Modifier le fragment" : "Nouveau fragment"}
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
            <Field
              label="Commande"
              hint={
                <>
                  <span className="font-mono">{"{{conteneur}}"}</span> ou <span className="font-mono">{"{{lignes:100}}"}</span> sera demandé avant
                  l'envoi, avec sa valeur par défaut déjà remplie.
                </>
              }
            >
              <Input
                className="font-mono"
                value={editing.command}
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                placeholder="docker logs -f --tail {{lignes:100}} {{conteneur}}"
              />
            </Field>
            {hasVars(editing.command) && (
              <p className="text-xs text-muted">
                Paramètres détectés : <span className="font-mono">{parseVars(editing.command).map((v) => v.name).join(", ")}</span>
              </p>
            )}
          </div>
        </Modal>
      )}
      {asking && <SnippetForm snippet={asking} onClose={() => setAsking(null)} onRun={(command) => {
        setAsking(null);
        send(command);
      }} />}
    </aside>
  );
}

/** Saisie des paramètres d'un fragment avant son envoi, avec l'aperçu de la commande finale. */
function SnippetForm({ snippet, onClose, onRun }: { snippet: Snippet; onClose: () => void; onRun: (command: string) => void }) {
  const vars: SnippetVar[] = parseVars(snippet.command);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(vars.map((v) => [v.name, v.default])));
  const final = fillVars(snippet.command, values);

  return (
    <Modal
      title={snippet.name}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={() => onRun(final)}>
          Envoyer au terminal
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onRun(final);
        }}
      >
        {vars.map((v, i) => (
          <Field key={v.name} label={v.name} hint={v.default ? `Par défaut : ${v.default}` : undefined}>
            <Input
              className="font-mono text-sm"
              value={values[v.name] ?? ""}
              placeholder={v.default}
              onChange={(e) => setValues((old) => ({ ...old, [v.name]: e.target.value }))}
              autoFocus={i === 0}
            />
          </Field>
        ))}
        {/* La commande finale est montrée avant l'envoi : rien ne part dans le terminal à l'aveugle. */}
        <div>
          <p className="mb-1 text-xs text-muted">Commande envoyée</p>
          <pre className="rounded-md border border-border bg-bg p-2 font-mono text-xs break-all whitespace-pre-wrap select-text">{final}</pre>
        </div>
      </form>
    </Modal>
  );
}
