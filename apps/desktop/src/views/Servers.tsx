import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, IdCard, KeyRound, Link2Off, Pencil, Plug, PlugZap, Plus, Server, SquareTerminal, Trash2, Unplug } from "lucide-react";
import { api, errorMessage, type AuthKind, type ServerProfile, type ServerView } from "../lib/api";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";
import { forgetCached } from "../lib/cache";
import { AUTH_LABELS, IdentitiesPanel, IdentitySuggestions, useIdentities } from "../components/Identities";

const SOURCES = [
  ["putty", "PuTTY"],
  ["openssh", "OpenSSH (~/.ssh/config)"],
] as const;

const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];

export default function ServersView() {
  const servers = useApp((s) => s.servers);
  const refresh = useApp((s) => s.refreshServers);
  const [editing, setEditing] = useState<ServerView | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [tab, setTab] = useState<"servers" | "identities">("servers");
  const reloadIdentities = useIdentities((s) => s.reload);
  useEffect(() => {
    void reloadIdentities();
  }, [reloadIdentities]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-border px-6 pt-4">
        <div className="pb-3">
          <h1 className="text-lg font-semibold">Serveurs</h1>
          <p className="text-sm text-muted">Profils de connexion SSH. Les secrets sont gardés dans le coffre-fort du système.</p>
        </div>
        <nav className="ml-auto flex self-end">
          {(
            [
              ["servers", "Serveurs", Server],
              ["identities", "Identifiants", IdCard],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm ${tab === id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>
        {tab === "servers" && (
          <div className="flex gap-2 self-center pb-3">
            <Button icon={<Download size={14} />} onClick={() => setImporting(true)}>
              Importer (PuTTY, OpenSSH)
            </Button>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
              Ajouter un serveur
            </Button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === "identities" ? (
          <IdentitiesPanel />
        ) : servers.length === 0 ? (
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
      {importing && <Import onClose={() => setImporting(false)} onDone={() => void refresh()} />}
    </div>
  );
}

function ServerCard({ server, onEdit }: { server: ServerView; onEdit: () => void }) {
  const { openTab, setActiveServer, activeServerId, refreshServers, notify, ask } = useAppPick("openTab", "setActiveServer", "activeServerId", "refreshServers", "notify", "ask");
  const [busy, setBusy] = useState(false);
  const active = server.id === activeServerId;
  const identity = useIdentities((s) => s.list.find((i) => i.id === server.identityId));

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
    forgetCached(server.id);
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
        {identity ? <Badge tone="accent">{identity.name}</Badge> : <Badge>{AUTH_LABELS[server.authKind]}</Badge>}
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
  const [suggest, setSuggest] = useState(false);
  /** Enregistrer aussi l'utilisateur et son secret dans la banque d'identifiants. */
  const [toBank, setToBank] = useState<string | null>(null);
  const set = <K extends keyof ServerProfile>(k: K, v: ServerProfile[K]) => setP((prev) => ({ ...prev, [k]: v }));
  const others = useApp((s) => s.servers).filter((s) => s.id !== server?.id);
  const identities = useIdentities((s) => s.list);
  const identity = identities.find((i) => i.id === p.identityId);

  const save = async () => {
    setSaving(true);
    try {
      let profile = { ...p, name: p.name.trim() || p.host.trim(), host: p.host.trim(), username: p.username.trim() };
      let secrets = { password: password || undefined, passphrase: passphrase || undefined, sudoPassword: sudo || undefined };
      if (!identity && toBank !== null) {
        // Nouvel identifiant de la banque avec ce qui vient d'être saisi, puis le serveur s'y lie.
        const id = await api.identitySave(
          { id: "", name: toBank.trim() || profile.username, username: profile.username, authKind: profile.authKind, keyPath: profile.keyPath },
          { password: secrets.password, passphrase: secrets.passphrase },
        );
        profile = { ...profile, identityId: id };
        secrets = { password: undefined, passphrase: undefined, sudoPassword: secrets.sudoPassword };
        void useIdentities.getState().reload();
      }
      await api.saveServer(profile, secrets);
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
          <Field label="Utilisateur" hint={identities.length && !identity ? "Clique dans le champ pour choisir un identifiant enregistré." : undefined}>
            {identity ? (
              <div className="flex h-8 items-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-2.5 text-sm">
                <IdCard size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate" title={`Identifiant « ${identity.name} » de la banque`}>
                  {identity.name} <span className="font-mono text-xs text-muted">({identity.username})</span>
                </span>
                <button type="button" title="Délier : saisir l'utilisateur à la main" className="text-muted hover:text-fg" onClick={() => setP((prev) => ({ ...prev, identityId: null }))}>
                  <Link2Off size={13} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input value={p.username} autoComplete="off" onFocus={() => setSuggest(true)} onChange={(e) => set("username", e.target.value)} />
                {suggest && (
                  <IdentitySuggestions
                    filter=""
                    onClose={() => setSuggest(false)}
                    onPick={(i) => {
                      setP((prev) => ({ ...prev, identityId: i.id, username: i.username, authKind: i.authKind, keyPath: i.keyPath ?? null }));
                      setToBank(null);
                      setSuggest(false);
                    }}
                  />
                )}
              </div>
            )}
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="Groupe (optionnel)">
            <Input value={p.group ?? ""} placeholder="prod, perso…" onChange={(e) => set("group", e.target.value || null)} />
          </Field>
        </div>
        {others.length > 0 && (
          <div className="col-span-6">
            <Field label="Serveur de rebond (optionnel)" hint="Pour un serveur joignable seulement à travers un autre (bastion, réseau privé) : équivalent de ssh -J.">
              <select
                className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm"
                value={p.jumpId ?? ""}
                onChange={(e) => set("jumpId", e.target.value || null)}
              >
                <option value="">Aucun : connexion directe</option>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.username}@{s.host})
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {identity ? (
          <p className="col-span-6 rounded-md border border-border bg-bg p-3 text-xs text-muted">
            Authentification de l'identifiant « {identity.name} » ({AUTH_LABELS[identity.authKind]}{identity.authKind === "password" && !identity.hasPassword ? ", demandé à la connexion" : ""}). Modifiable dans l'onglet Identifiants.
          </p>
        ) : (
        <>
        <div className="col-span-6 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Authentification</span>
          <div className="flex gap-1 rounded-md border border-border bg-bg p-1">
            {kinds.map((k) => (
              <button
                type="button"
                key={k.id}
                onClick={() => set("authKind", k.id)}
                className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${p.authKind === k.id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {p.authKind === "password" && (
          <div className="col-span-6">
            <Field label="Mot de passe" hint={keptHint(server?.hasPassword) ?? "Tu peux aussi le laisser vide : il sera demandé à la connexion."}>
              <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
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
        <label className="col-span-6 flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={toBank !== null} onChange={(e) => setToBank(e.target.checked ? `${p.username}@${p.name || p.host}` : null)} />
          Enregistrer aussi dans la banque d'identifiants, sous le nom
          <Input className="!h-7 !w-56 text-xs" disabled={toBank === null} value={toBank ?? ""} onChange={(e) => setToBank(e.target.value)} />
        </label>
        </>
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

/** Import des sessions PuTTY (registre Windows) et des hôtes de ~/.ssh/config (OpenSSH). */
function Import({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const notify = useApp((s) => s.notify);
  const [source, setSource] = useState<"putty" | "openssh">("putty");
  const [sessions, setSessions] = useState<ServerProfile[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    setSessions(null);
    (source === "putty" ? api.puttySessions() : api.sshConfigSessions()).then((list) => {
      setSessions(list);
      setSelected(new Set(list.map((_, i) => i)));
    });
  }, [source]);

  const doImport = async () => {
    if (!sessions) return;
    const chosen = sessions.filter((_, i) => selected.has(i));
    // Les rebonds OpenSSH (ProxyJump) désignent un hôte par son alias : on les relie une fois
    // tous les profils créés (importés maintenant ou déjà présents, par nom).
    const ids = new Map<string, string>(useApp.getState().servers.map((s) => [s.name, s.id]));
    const pending: { id: string; profile: ServerProfile; alias: string }[] = [];
    for (const s of chosen) {
      const alias = s.jumpId?.startsWith("alias:") ? s.jumpId.slice("alias:".length) : null;
      const profile = { ...s, color: COLORS[0], jumpId: null };
      const id = await api.saveServer(profile, {});
      ids.set(s.name, id);
      if (alias) pending.push({ id, profile: { ...profile, id }, alias });
    }
    const unresolved: string[] = [];
    for (const { id, profile, alias } of pending) {
      const jump = ids.get(alias);
      if (jump && jump !== id) await api.saveServer({ ...profile, jumpId: jump }, {});
      else unresolved.push(`${profile.name} → ${alias}`);
    }
    notify(
      `${chosen.length} serveur(s) importé(s).${unresolved.length ? ` Rebond introuvable pour : ${unresolved.join(", ")} (à régler dans le profil).` : ""}`,
      unresolved.length ? "info" : "success",
    );
    onDone();
    onClose();
  };

  return (
    <Modal
      title="Importer des serveurs"
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
      <div className="mb-3 flex gap-1 rounded-md border border-border bg-bg p-1">
        {SOURCES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSource(id)}
            className={`flex-1 rounded px-2 py-1 text-xs ${source === id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {sessions === null ? (
        <p className="text-sm text-muted">Lecture…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted">{source === "putty" ? "Aucune session SSH enregistrée dans PuTTY n'a été trouvée." : "Aucun hôte trouvé dans ~/.ssh/config."}</p>
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
                  {s.jumpId?.startsWith("alias:") && ` via ${s.jumpId.slice(6)}`}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
