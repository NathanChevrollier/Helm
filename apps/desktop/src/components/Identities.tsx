import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { IdCard, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { create } from "zustand";
import { api, errorMessage, type AuthKind, type Identity, type IdentityView } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "./ui";

/** Banque d'identifiants, partagée par la liste et les formulaires de serveurs. */
export const useIdentities = create<{ list: IdentityView[]; reload: () => Promise<void> }>((set) => ({
  list: [],
  reload: async () => set({ list: await api.identities() }),
}));

export const AUTH_LABELS: Record<AuthKind, string> = { password: "mot de passe", key: "clé privée", agent: "agent SSH" };

/** Ligne d'un identifiant, comme dans un gestionnaire de mots de passe : nom, utilisateur, secret masqué. */
function IdentityLine({ i }: { i: IdentityView }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <IdCard size={15} className="shrink-0 text-muted" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{i.name}</span>
        <span className="block truncate font-mono text-[11px] text-muted">
          {i.username}, {i.authKind === "password" ? (i.hasPassword ? "••••••••" : "mot de passe demandé") : AUTH_LABELS[i.authKind]}
        </span>
      </span>
    </span>
  );
}

/**
 * Menu déroulant des identifiants sous le champ « Utilisateur » d'un serveur : un clic lie le
 * serveur à l'identifiant (utilisateur et secrets pris dans la banque).
 */
export function IdentitySuggestions({ filter, onPick, onClose }: { filter: string; onPick: (i: IdentityView) => void; onClose: () => void }) {
  const list = useIdentities((s) => s.list);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  const f = filter.trim().toLowerCase();
  const shown = list.filter((i) => !f || i.name.toLowerCase().includes(f) || i.username.toLowerCase().includes(f));
  if (!shown.length) return null;
  return (
    <div ref={ref} className="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-auto rounded-lg border border-border-strong bg-panel py-1 shadow-2xl">
      {shown.map((i) => (
        <button
          type="button"
          key={i.id}
          className="flex w-full items-center px-3 py-1.5 text-left hover:bg-hover-strong"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(i)}
        >
          <IdentityLine i={i} />
        </button>
      ))}
    </div>
  );
}

/** Onglet « Identifiants » de la page Serveurs. */
export function IdentitiesPanel() {
  const { list, reload } = useIdentities();
  const { notify, ask } = useApp.getState();
  const [editing, setEditing] = useState<IdentityView | "new" | null>(null);
  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (i: IdentityView) => {
    const ok = await ask({ title: `Supprimer « ${i.name} » ?`, body: "L'identifiant et ses secrets seront supprimés de ce PC.", confirmLabel: "Supprimer", danger: true });
    if (!ok) return;
    try {
      await api.identityDelete(i.id);
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="max-w-2xl text-sm text-muted">
          Enregistre une fois un utilisateur et son mot de passe (ou sa clé), puis choisis-le dans le profil de chaque serveur qui l'utilise. Le changer ici le change partout. Les secrets restent dans le coffre-fort du système.
        </p>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
          Nouvel identifiant
        </Button>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<IdCard size={40} />} title="Aucun identifiant">
          Par exemple « root du VPS », « admin Unraid »… Ils apparaîtront sous le champ Utilisateur des serveurs.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {list.map((i) => (
            <div key={i.id} className="group flex items-center gap-3 rounded-lg border border-border bg-panel p-3">
              <div className="min-w-0 flex-1">
                <IdentityLine i={i} />
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge>{AUTH_LABELS[i.authKind]}</Badge>
                  {i.usedBy.length > 0 ? <Badge tone="accent">{i.usedBy.length} serveur(s)</Badge> : <Badge>inutilisé</Badge>}
                </div>
              </div>
              <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
                <IconButton title="Modifier" onClick={() => setEditing(i)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton title={i.usedBy.length ? `Utilisé par ${i.usedBy.join(", ")}` : "Supprimer"} disabled={i.usedBy.length > 0} onClick={() => void remove(i)}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <IdentityForm
          identity={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
            void useApp.getState().refreshServers();
          }}
        />
      )}
    </>
  );
}

export function IdentityForm({ identity, onClose, onSaved }: { identity: IdentityView | null; onClose: () => void; onSaved: (id: string) => void }) {
  const notify = useApp((s) => s.notify);
  const [p, setP] = useState<Identity>(identity ? { id: identity.id, name: identity.name, username: identity.username, authKind: identity.authKind, keyPath: identity.keyPath } : { id: "", name: "", username: "root", authKind: "password", keyPath: null });
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Identity>(k: K, v: Identity[K]) => setP((prev) => ({ ...prev, [k]: v }));
  const kept = (has: boolean | undefined) => (has ? "Déjà enregistré : laisse vide pour le conserver." : undefined);

  const save = async () => {
    setSaving(true);
    try {
      const id = await api.identitySave(p, { password: password || undefined, passphrase: passphrase || undefined });
      onSaved(id);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={identity ? `Modifier ${identity.name}` : "Nouvel identifiant"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} disabled={!p.username.trim()} onClick={() => void save()}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Nom">
            <Input value={p.name} placeholder="root du VPS" onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
          <Field label="Utilisateur">
            <Input value={p.username} onChange={(e) => set("username", e.target.value)} />
          </Field>
        </div>
        <div className="flex gap-1 rounded-md border border-border bg-bg p-1">
          {(Object.keys(AUTH_LABELS) as AuthKind[]).map((k) => (
            <button
              type="button"
              key={k}
              onClick={() => set("authKind", k)}
              className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-colors ${p.authKind === k ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
            >
              {AUTH_LABELS[k]}
            </button>
          ))}
        </div>
        {p.authKind === "password" && (
          <Field label="Mot de passe" hint={kept(identity?.hasPassword) ?? "Laisse vide pour qu'il soit demandé à la première connexion."}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        {p.authKind !== "password" && (
          <Field label={p.authKind === "key" ? "Clé privée" : "Clé à utiliser dans l'agent (optionnel)"} hint="Formats OpenSSH et PuTTY (.ppk) acceptés.">
            <div className="flex gap-2">
              <Input value={p.keyPath ?? ""} placeholder="~/.ssh/id_ed25519" onChange={(e) => set("keyPath", e.target.value || null)} />
              <Button
                type="button"
                icon={<KeyRound size={14} />}
                onClick={async () => {
                  const file = await open({ title: "Choisir une clé privée", multiple: false, directory: false });
                  if (typeof file === "string") set("keyPath", file);
                }}
              >
                Parcourir
              </Button>
            </div>
          </Field>
        )}
        {p.authKind === "key" && (
          <Field label="Passphrase (si la clé est chiffrée)" hint={kept(identity?.hasPassphrase)}>
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
