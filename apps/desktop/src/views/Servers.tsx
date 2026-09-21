import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, KeyRound, Pencil, Plug, PlugZap, Plus, Server, SquareTerminal, Trash2, Unplug } from "lucide-react";
import { api, errorMessage, type AuthKind, type ServerProfile, type ServerView } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";

const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];

export default function ServersView() {
  const servers = useApp((s) => s.servers);
  const refresh = useApp((s) => s.refreshServers);
  const [editing, setEditing] = useState<ServerView | "new" | null>(null);
  const [importing, setImporting] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Serveurs</h1>
          <p className="text-sm text-muted">Profils de connexion SSH. Les secrets sont gardés dans le coffre-fort du système.</p>
        </div>
        <div className="flex gap-2">
          <Button icon={<Download size={14} />} onClick={() => setImporting(true)}>
            Importer depuis PuTTY
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
            Ajouter un serveur
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {servers.length === 0 ? (
          <EmptyState icon={<Server size={40} />} title="Aucun serveur">
            Ajoute ton VPS, ou importe directement tes sessions PuTTY existantes.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
            {servers.map((s) => (
              <ServerCard key={s.id} server={s} onEdit={() => setEditing(s)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ServerForm
          server={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {importing && <PuttyImport onClose={() => setImporting(false)} onDone={() => void refresh()} />}
    </div>
  );
}

function ServerCard({ server, onEdit }: { server: ServerView; onEdit: () => void }) {
  const { openTab, setActiveServer, activeServerId, refreshServers, notify, ask } = useApp();
  const [busy, setBusy] = useState(false);
  const active = server.id === activeServerId;

  const connect = async () => {
    setBusy(true);
    setActiveServer(server.id);
    if (await ensureConnected(server.id, { force: true })) notify(`Connecté à ${server.name}`, "success");
    setBusy(false);
  };

  const remove = async () => {
    const ok = await ask({
      title: `Supprimer « ${server.name} » ?`,
      body: "Le profil et ses secrets enregistrés seront supprimés. Rien n'est modifié sur le serveur.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    await api.deleteServer(server.id);
    void refreshServers();
  };

  return (
    <div
      className={`group rounded-lg border bg-panel p-4 transition-colors ${active ? "border-accent/60" : "border-border hover:border-muted/40"}`}
      onClick={() => setActiveServer(server.id)}
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: server.color ?? COLORS[0] }} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{server.name}</div>
          <div className="truncate font-mono text-xs text-muted">
            {server.username}@{server.host}
            {server.port !== 22 && `:${server.port}`}
          </div>
        </div>
        <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton title="Modifier" onClick={onEdit}>
            <Pencil size={14} />
          </IconButton>
          <IconButton title="Supprimer" onClick={remove}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {server.connected ? <Badge tone="ok">connecté</Badge> : <Badge>hors ligne</Badge>}
        <Badge>{server.authKind === "password" ? "mot de passe" : server.authKind === "key" ? "clé privée" : "agent SSH"}</Badge>
        {server.group && <Badge tone="accent">{server.group}</Badge>}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={<SquareTerminal size={13} />}
          onClick={async (e) => {
            e.stopPropagation();
            setActiveServer(server.id);
            setBusy(true);
            const ok = await ensureConnected(server.id, { force: true });
            setBusy(false);
            if (ok) openTab(server.id);
          }}
        >
          Terminal
        </Button>
        {server.connected ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Unplug size={13} />}
            onClick={async () => {
              await api.disconnect(server.id);
              void refreshServers();
            }}
          >
            Déconnecter
          </Button>
        ) : (
          <Button size="sm" variant="ghost" loading={busy} icon={<Plug size={13} />} onClick={connect}>
            Connecter
          </Button>
        )}
      </div>
    </div>
  );
}

function emptyProfile(): ServerProfile {
  return { id: "", name: "", host: "", port: 22, username: "root", authKind: "password", keyPath: null, color: COLORS[0], group: null };
}

function ServerForm({ server, onClose, onSaved }: { server: ServerView | null; onClose: () => void; onSaved: () => void }) {
  const notify = useApp((s) => s.notify);
  const [p, setP] = useState<ServerProfile>(server ? { ...server } : emptyProfile());
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [sudo, setSudo] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ServerProfile>(k: K, v: ServerProfile[K]) => setP((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const profile = { ...p, name: p.name.trim() || p.host.trim(), host: p.host.trim(), username: p.username.trim() };
      await api.saveServer(profile, {
        password: password || undefined,
        passphrase: passphrase || undefined,
        sudoPassword: sudo || undefined,
      });
      onSaved();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const pickKey = async () => {
    const file = await open({ title: "Choisir une clé privée", multiple: false, directory: false });
    if (typeof file === "string") set("keyPath", file);
  };

  const kinds: { id: AuthKind; label: string }[] = [
    { id: "password", label: "Mot de passe" },
    { id: "key", label: "Clé privée" },
    { id: "agent", label: "Agent SSH / Pageant" },
  ];
  const keptHint = (has: boolean | undefined) => (has ? "Déjà enregistré : laisse vide pour le conserver." : undefined);

  return (
    <Modal
      title={server ? `Modifier ${server.name}` : "Nouveau serveur"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} onClick={save} disabled={!p.host || !p.username}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-6 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="col-span-6">
          <Field label="Nom">
            <Input value={p.name} placeholder="Mon VPS" onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
        </div>
        <div className="col-span-4">
          <Field label="Hôte">
            <Input value={p.host} placeholder="vps.exemple.fr ou 51.xx.xx.xx" onChange={(e) => set("host", e.target.value)} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Port">
            <Input type="number" value={p.port} onChange={(e) => set("port", Number(e.target.value) || 22)} />
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="Utilisateur">
            <Input value={p.username} onChange={(e) => set("username", e.target.value)} />
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="Groupe (optionnel)">
            <Input value={p.group ?? ""} placeholder="prod, perso…" onChange={(e) => set("group", e.target.value || null)} />
          </Field>
        </div>

        <div className="col-span-6 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Authentification</span>
          <div className="flex gap-1 rounded-md border border-border bg-bg p-1">
            {kinds.map((k) => (
              <button
                type="button"
                key={k.id}
                onClick={() => set("authKind", k.id)}
                className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${p.authKind === k.id ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {p.authKind === "password" && (
          <div className="col-span-6">
            <Field label="Mot de passe" hint={keptHint(server?.hasPassword) ?? "Tu peux aussi le laisser vide : il sera demandé à la connexion."}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        )}
        {p.authKind === "key" && (
          <>
            <div className="col-span-6">
              <Field label="Clé privée" hint="Formats OpenSSH et PuTTY (.ppk) acceptés.">
                <div className="flex gap-2">
                  <Input value={p.keyPath ?? ""} placeholder="~/.ssh/id_ed25519" onChange={(e) => set("keyPath", e.target.value)} />
                  <Button type="button" icon={<KeyRound size={14} />} onClick={pickKey}>
                    Parcourir
                  </Button>
                </div>
              </Field>
            </div>
            <div className="col-span-6">
              <Field label="Passphrase (si la clé est chiffrée)" hint={keptHint(server?.hasPassphrase)}>
                <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
              </Field>
            </div>
          </>
        )}
        {p.authKind === "agent" && (
          <p className="col-span-6 rounded-md border border-border bg-bg p-3 text-xs text-muted">
            Helm utilisera les clés chargées dans l'agent OpenSSH de Windows ou dans Pageant (PuTTY).
          </p>
        )}

        <div className="col-span-6">
          <Field
            label="Mot de passe sudo (optionnel)"
            hint={keptHint(server?.hasSudoPassword) ?? "Utilisé pour les actions d'administration (nginx, services…) si tu ne te connectes pas en root."}
          >
            <Input type="password" value={sudo} onChange={(e) => setSudo(e.target.value)} />
          </Field>
        </div>

        <div className="col-span-6 flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Couleur</span>
          {COLORS.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => set("color", c)}
              className={`size-5 rounded-full ring-offset-2 ring-offset-panel ${p.color === c ? "ring-2 ring-fg" : ""}`}
              style={{ background: c }}
              aria-label={`Couleur ${c}`}
            />
          ))}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PuttyImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const notify = useApp((s) => s.notify);
  const [sessions, setSessions] = useState<ServerProfile[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    api.puttySessions().then((list) => {
      setSessions(list);
      setSelected(new Set(list.map((_, i) => i)));
    });
  }, []);

  const doImport = async () => {
    if (!sessions) return;
    const chosen = sessions.filter((_, i) => selected.has(i));
    for (const s of chosen) await api.saveServer({ ...s, color: COLORS[0] }, {});
    notify(`${chosen.length} serveur(s) importé(s). Le mot de passe sera demandé à la première connexion.`, "success");
    onDone();
    onClose();
  };

  return (
    <Modal
      title="Importer depuis PuTTY"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" onClick={doImport} disabled={!selected.size} icon={<PlugZap size={14} />}>
            Importer {selected.size || ""}
          </Button>
        </>
      }
    >
      {sessions === null ? (
        <p className="text-sm text-muted">Lecture des sessions PuTTY…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted">Aucune session SSH enregistrée dans PuTTY n'a été trouvée.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sessions.map((s, i) => (
            <li key={i}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
                <input
                  type="checkbox"
                  checked={selected.has(i)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(i);
                    else next.delete(i);
                    setSelected(next);
                  }}
                />
                <span className="flex-1 text-sm">{s.name}</span>
                <span className="font-mono text-xs text-muted">
                  {s.username}@{s.host}:{s.port}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
