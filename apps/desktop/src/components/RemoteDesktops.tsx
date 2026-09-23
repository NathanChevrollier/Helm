import { useEffect, useState } from "react";
import { Cable, ExternalLink, IdCard, Link2Off, Monitor, MonitorPlay, Pencil, Plus, Trash2 } from "lucide-react";
import { create } from "zustand";
import { api, errorMessage, type DesktopView, type RemoteDesktop } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "./ui";
import { IdentitySuggestions, useIdentities } from "./Identities";
import { useRdp } from "../lib/rdp";

const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];

export const useDesktops = create<{ list: DesktopView[]; reload: () => Promise<void> }>((set) => ({
  list: [],
  reload: async () => set({ list: await api.desktops() }),
}));

/** Ouvre un bureau à distance (connecte d'abord le serveur de rebond, avec ses dialogues). */
export async function launchDesktop(d: RemoteDesktop) {
  const { notify } = useApp.getState();
  try {
    if (d.viaServerId && !(await ensureConnected(d.viaServerId, { force: true }))) return;
    notify(await api.desktopLaunch(d.id), "success");
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

/** Onglet « Bureaux à distance » de la page Serveurs. */
export function DesktopsPanel() {
  const { list, reload } = useDesktops();
  const servers = useApp((s) => s.servers);
  const identities = useIdentities((s) => s.list);
  const [editing, setEditing] = useState<DesktopView | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (d: DesktopView) => {
    const { ask, notify } = useApp.getState();
    if (!(await ask({ title: `Supprimer « ${d.name} » ?`, body: "Le profil et son mot de passe enregistré sont supprimés de ce PC.", confirmLabel: "Supprimer", danger: true }))) return;
    try {
      await api.desktopDelete(d.id);
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          Bureaux à distance Windows (RDP), ouverts dans la Connexion Bureau à distance du système. Via un serveur SSH, Helm ouvre un tunnel le temps de la session : le port 3389 n'a jamais besoin d'être exposé sur Internet.
        </p>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
          Nouveau bureau
        </Button>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<Monitor size={40} />} title="Aucun bureau à distance">
          Ajoute un PC ou un serveur Windows joignable en RDP, directement ou à travers un de tes serveurs.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {list.map((d) => {
            const via = servers.find((s) => s.id === d.viaServerId);
            const identity = identities.find((i) => i.id === d.identityId);
            return (
              <div key={d.id} className="group rounded-lg border border-border bg-panel p-4">
                <div className="mb-3 flex items-start gap-3">
                  <Monitor size={16} className="mt-0.5 shrink-0" style={{ color: d.color ?? COLORS[0] }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{d.name}</div>
                    <div className="truncate font-mono text-xs text-muted">
                      {identity ? identity.username : d.username || "?"}@{d.host}
                      {d.port !== 3389 && `:${d.port}`}
                    </div>
                  </div>
                  <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
                    <IconButton title="Modifier" onClick={() => setEditing(d)}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton title="Supprimer" onClick={() => void remove(d)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {via ? <Badge tone="accent">via {via.name}</Badge> : <Badge>direct</Badge>}
                  {identity && <Badge tone="accent">{identity.name}</Badge>}
                  {d.fullscreen ? <Badge>plein écran</Badge> : <Badge>{d.width ?? 1600}×{d.height ?? 900}</Badge>}
                  {d.redirectDrives && <Badge>disques partagés</Badge>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {/* Dans Helm par défaut : le client externe reste accessible juste à côté. */}
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!d.hasPassword}
                    title={d.hasPassword ? undefined : "Enregistre un mot de passe pour ouvrir la session dans Helm"}
                    icon={<MonitorPlay size={13} />}
                    onClick={() => void useRdp.getState().open(d)}
                  >
                    Se connecter
                  </Button>
                  <Button
                    size="sm"
                    loading={busy === d.id}
                    icon={<ExternalLink size={13} />}
                    title="Ouvrir avec le client du système (mstsc, FreeRDP…)"
                    onClick={async () => {
                      setBusy(d.id);
                      await launchDesktop(d);
                      setBusy(null);
                    }}
                  >
                    Client du système
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editing && (
        <DesktopForm
          desktop={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function emptyDesktop(): RemoteDesktop {
  return { id: "", name: "", host: "", port: 3389, username: "", domain: null, identityId: null, viaServerId: null, fullscreen: false, width: 1600, height: 900, multimon: false, redirectDrives: false, color: COLORS[0] };
}

function DesktopForm({ desktop, onClose, onSaved }: { desktop: DesktopView | null; onClose: () => void; onSaved: () => void }) {
  const notify = useApp((s) => s.notify);
  const servers = useApp((s) => s.servers);
  const identities = useIdentities((s) => s.list);
  const [d, setD] = useState<RemoteDesktop>(desktop ? { ...desktop } : emptyDesktop());
  const [password, setPassword] = useState("");
  const [suggest, setSuggest] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof RemoteDesktop>(k: K, v: RemoteDesktop[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const identity = identities.find((i) => i.id === d.identityId);

  const save = async () => {
    setSaving(true);
    try {
      await api.desktopSave(d, password || undefined);
      onSaved();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={desktop ? `Modifier ${desktop.name}` : "Nouveau bureau à distance"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} disabled={!d.host.trim()} onClick={() => void save()}>
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
            <Input value={d.name} placeholder="PC du bureau" onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
        </div>
        <div className="col-span-4">
          <Field label="Hôte" hint={d.viaServerId ? "Adresse vue depuis le serveur de rebond (IP du réseau local, par exemple)." : undefined}>
            <Input value={d.host} placeholder="192.168.1.20 ou pc.exemple.fr" onChange={(e) => set("host", e.target.value)} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Port">
            <Input type="number" value={d.port} onChange={(e) => set("port", Number(e.target.value) || 3389)} />
          </Field>
        </div>
        <div className="col-span-6">
          <Field label="Passer par un serveur SSH (recommandé hors du réseau local)">
            <select className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm" value={d.viaServerId ?? ""} onChange={(e) => set("viaServerId", e.target.value || null)}>
              <option value="">Non : connexion directe</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.host})
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="Utilisateur">
            {identity ? (
              <div className="flex h-8 items-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-2.5 text-sm">
                <IdCard size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  {identity.name} <span className="font-mono text-xs text-muted">({identity.username})</span>
                </span>
                <button type="button" title="Délier" className="text-muted hover:text-fg" onClick={() => set("identityId", null)}>
                  <Link2Off size={13} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input value={d.username} autoComplete="off" onFocus={() => setSuggest(true)} onChange={(e) => set("username", e.target.value)} />
                {suggest && (
                  <IdentitySuggestions
                    filter=""
                    onClose={() => setSuggest(false)}
                    onPick={(i) => {
                      setD((prev) => ({ ...prev, identityId: i.id, username: i.username }));
                      setSuggest(false);
                    }}
                  />
                )}
              </div>
            )}
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="Domaine (optionnel)">
            <Input value={d.domain ?? ""} placeholder="MAISON" onChange={(e) => set("domain", e.target.value || null)} />
          </Field>
        </div>
        {!identity && (
          <div className="col-span-6">
            <Field label="Mot de passe" hint={desktop?.hasPassword ? "Déjà enregistré : laisse vide pour le conserver." : "Optionnel : sinon Windows le demandera."}>
              <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="col-span-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={d.fullscreen} onChange={(e) => set("fullscreen", e.target.checked)} />
            Plein écran
          </label>
          {!d.fullscreen && (
            <span className="flex items-center gap-1.5">
              <Input className="!h-7 !w-20" type="number" value={d.width ?? 1600} onChange={(e) => set("width", Number(e.target.value) || null)} />×
              <Input className="!h-7 !w-20" type="number" value={d.height ?? 900} onChange={(e) => set("height", Number(e.target.value) || null)} />
            </span>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={d.multimon} onChange={(e) => set("multimon", e.target.checked)} />
            Tous les écrans
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={d.redirectDrives} onChange={(e) => set("redirectDrives", e.target.checked)} />
            Partager mes disques
          </label>
        </div>
        {d.viaServerId && (
          <p className="col-span-6 flex items-start gap-2 rounded-md border border-border bg-bg p-3 text-xs text-muted">
            <Cable size={14} className="mt-px shrink-0" />
            Un tunnel SSH local est ouvert à chaque connexion vers {d.host || "l'hôte"}:{d.port}, puis refermé à la fermeture de la fenêtre Bureau à distance.
          </p>
        )}
        <div className="col-span-6 flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Couleur</span>
          {COLORS.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => set("color", c)}
              className={`size-5 rounded-full ring-offset-2 ring-offset-panel ${d.color === c ? "ring-2 ring-fg" : ""}`}
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
