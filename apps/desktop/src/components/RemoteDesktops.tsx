import { useEffect, useState } from "react";
import { Cable, ExternalLink, IdCard, Link2Off, Monitor, MonitorPlay, Pencil, Plus, Trash2 } from "lucide-react";
import { create } from "zustand";
import { api, errorMessage, type DesktopProtocol, type DesktopView, type RemoteDesktop } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "./ui";
import { IdentitySuggestions, useIdentities } from "./Identities";
import { useRdp } from "../lib/rdp";

const COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];

/** Port par défaut de chaque protocole (même règle que côté Rust). */
const DEFAULT_PORT: Record<DesktopProtocol, number> = { rdp: 3389, vnc: 5900, spice: 5900 };
const protocolOf = (d: RemoteDesktop): DesktopProtocol => d.protocol ?? "rdp";

export const useDesktops = create<{ list: DesktopView[]; reload: () => Promise<void> }>((set) => ({
  list: [],
  reload: async () => set({ list: await api.desktops() }),
}));

/**
 * Ouvre un bureau à distance (connecte d'abord le serveur de rebond, avec ses dialogues) : le VNC
 * dans le client intégré, le RDP et le SPICE dans le client du système.
 */
export async function launchDesktop(d: DesktopView) {
  const { notify } = useApp.getState();
  try {
    if (d.viaServerId && !(await ensureConnected(d.viaServerId, { force: true }))) return;
    if (protocolOf(d) === "vnc") return void (await useRdp.getState().open(d));
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
          Bureaux Windows (RDP) et Linux, Raspberry Pi ou macOS (VNC), ouverts dans Helm ; consoles de VM QEMU/KVM (SPICE) dans remote-viewer. Via un serveur SSH, Helm ouvre un tunnel le temps de la session : ni le port 3389 ni le 5900 n'ont besoin d'être exposés sur Internet.
        </p>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
          Nouveau bureau
        </Button>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<Monitor size={40} />} title="Aucun bureau à distance">
          Ajoute un PC Windows (RDP) ou un bureau Linux, un Raspberry Pi, un Mac (VNC), directement ou à travers un de tes serveurs.
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
                      {d.port !== DEFAULT_PORT[protocolOf(d)] && `:${d.port}`}
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
                  <Badge tone={protocolOf(d) === "rdp" ? "muted" : "ok"}>{protocolOf(d).toUpperCase()}</Badge>
                  {via ? <Badge tone="accent">via {via.name}</Badge> : protocolOf(d) !== "rdp" ? <Badge tone="warn">direct, non chiffré</Badge> : <Badge>direct</Badge>}
                  {identity && <Badge tone="accent">{identity.name}</Badge>}
                  {protocolOf(d) === "rdp" && (d.fullscreen ? <Badge>plein écran</Badge> : <Badge>{d.width ?? 1600}×{d.height ?? 900}</Badge>)}
                  {protocolOf(d) === "rdp" && d.redirectDrives && <Badge>disques partagés</Badge>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {/* Dans Helm par défaut : le client externe reste accessible juste à côté. */}
                  {protocolOf(d) === "spice" ? (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === d.id}
                      icon={<ExternalLink size={13} />}
                      title="Ouvre la console dans remote-viewer (virt-viewer), à travers le tunnel SSH le cas échéant"
                      onClick={async () => {
                        setBusy(d.id);
                        await launchDesktop(d);
                        setBusy(null);
                      }}
                    >
                      Ouvrir la console
                    </Button>
                  ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={protocolOf(d) === "rdp" && !d.hasPassword}
                    title={protocolOf(d) === "rdp" && !d.hasPassword ? "Enregistre un mot de passe pour ouvrir la session dans Helm" : undefined}
                    icon={<MonitorPlay size={13} />}
                    onClick={() => void useRdp.getState().open(d)}
                  >
                    Se connecter
                  </Button>
                  )}
                  {protocolOf(d) === "rdp" && (
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
                  )}
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
  return { id: "", name: "", protocol: "rdp", host: "", port: 3389, username: "", domain: null, identityId: null, viaServerId: null, fullscreen: false, width: 1600, height: 900, multimon: false, redirectDrives: false, color: COLORS[0] };
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
  const protocol = protocolOf(d);

  /** Changer de protocole remet le port par défaut, sauf s'il a été personnalisé. */
  const setProtocol = (p: DesktopProtocol) =>
    setD((prev) => ({ ...prev, protocol: p, port: prev.port === DEFAULT_PORT[protocolOf(prev)] ? DEFAULT_PORT[p] : prev.port }));

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
        <div className="col-span-4">
          <Field label="Nom">
            <Input value={d.name} placeholder="PC du bureau" onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Protocole">
            <select className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm" value={protocol} onChange={(e) => setProtocol(e.target.value as DesktopProtocol)}>
              <option value="rdp">RDP (Windows, xrdp)</option>
              <option value="vnc">VNC (Linux, Mac, Pi)</option>
              <option value="spice">SPICE (VM QEMU/KVM)</option>
            </select>
          </Field>
        </div>
        <div className="col-span-4">
          <Field label="Hôte" hint={d.viaServerId ? "Adresse vue depuis le serveur de rebond (IP du réseau local, par exemple)." : undefined}>
            <Input value={d.host} placeholder="192.168.1.20 ou pc.exemple.fr" onChange={(e) => set("host", e.target.value)} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Port">
            <Input type="number" value={d.port} onChange={(e) => set("port", Number(e.target.value) || DEFAULT_PORT[protocol])} />
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
        <div className={protocol === "rdp" ? "col-span-3" : "col-span-6"}>
          <Field label={protocol === "vnc" ? "Utilisateur (seulement si la machine en demande un, macOS par exemple)" : protocol === "spice" ? "Utilisateur (inutilisé en SPICE)" : "Utilisateur"}>
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
        {protocol === "rdp" && (
          <div className="col-span-3">
            <Field label="Domaine (optionnel)">
              <Input value={d.domain ?? ""} placeholder="MAISON" onChange={(e) => set("domain", e.target.value || null)} />
            </Field>
          </div>
        )}
        {!identity && (
          <div className="col-span-6">
            <Field
              label={protocol === "vnc" ? "Mot de passe VNC" : protocol === "spice" ? "Mot de passe SPICE" : "Mot de passe"}
              hint={
                desktop?.hasPassword
                  ? "Déjà enregistré : laisse vide pour le conserver."
                  : protocol === "vnc"
                    ? "Celui du serveur VNC (8 caractères au plus pour l'authentification VNC classique)."
                    : protocol === "spice"
                      ? "Celui de la console SPICE de la VM, s'il y en a un."
                      : "Optionnel : sinon Windows le demandera."
              }
            >
              <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        )}
        {protocol === "rdp" && (
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
        )}
        {protocol === "spice" && (
          <p className="col-span-6 rounded-md border border-border bg-bg p-3 text-xs text-muted">
            SPICE s'ouvre dans remote-viewer (paquet virt-viewer), le client de référence : à installer sur ce PC. Pour une VM Proxmox, le VNC intégré à
            Helm suffit souvent — c'est ce qu'utilise sa console web.
          </p>
        )}
        {protocol !== "rdp" && !d.viaServerId && (
          <p className="col-span-6 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
            {protocol === "spice" ? "SPICE sans TLS" : "VNC"} ne chiffre généralement ni l'écran ni le mot de passe. Hors de ton réseau local, choisis un serveur SSH ci-dessus : la session passera
            alors dans un tunnel chiffré, et le port 5900 n'aura pas à être ouvert.
          </p>
        )}
        {d.viaServerId && (
          <p className="col-span-6 flex items-start gap-2 rounded-md border border-border bg-bg p-3 text-xs text-muted">
            <Cable size={14} className="mt-px shrink-0" />
            Un tunnel SSH local est ouvert à chaque connexion vers {d.host || "l'hôte"}:{d.port}, puis refermé à la fin de la session.
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
