// Registres d'images privés : identifiants rangés dans le coffre de Helm, connexion d'un serveur
// en un clic. Le jeton ne quitte le coffre que pour l'entrée standard de `docker login`.
import { useCallback, useEffect, useState } from "react";
import { KeyRound, LogIn, LogOut, Pencil, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage, type Registry, type RegistryKind, type RegistrySession, type RegistryView } from "../lib/api";
import { useAppPick } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal, Select } from "./ui";

const KINDS: { id: RegistryKind; label: string; server: string; user: string }[] = [
  { id: "dockerhub", label: "Docker Hub", server: "docker.io", user: "Nom d'utilisateur Docker Hub" },
  { id: "ghcr", label: "GitHub Packages", server: "ghcr.io", user: "Nom d'utilisateur GitHub" },
  { id: "gitlab", label: "GitLab", server: "registry.gitlab.com", user: "Nom du jeton de déploiement" },
  { id: "ecr", label: "AWS ECR", server: "", user: "Identifiant de clé d'accès (AKIA…)" },
  { id: "custom", label: "Autre registre", server: "", user: "Utilisateur" },
];

const kindOf = (id: RegistryKind) => KINDS.find((k) => k.id === id) ?? KINDS[4];

/** Même normalisation que côté Rust, pour comparer une adresse enregistrée à une session. */
const norm = (s: string) => s.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "").replace(/\/$/, "");
/** Docker Hub apparaît sous plusieurs noms selon la version de Docker. */
const same = (a: string, b: string) => {
  const hub = ["docker.io", "index.docker.io", "registry-1.docker.io"];
  return norm(a) === norm(b) || (hub.includes(norm(a)) && hub.includes(norm(b)));
};

export default function DockerRegistries({ serverId }: { serverId: string }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const [list, setList] = useState<RegistryView[] | null>(null);
  const [sessions, setSessions] = useState<RegistrySession[] | null>(null);
  const [editing, setEditing] = useState<{ registry: Registry; secret: string; hint: string; hasSecret: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.registries());
      setSessions(await api.registrySessions(serverId).catch(() => []));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [serverId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    try {
      await api.registrySave(editing.registry, editing.secret.trim() || null);
      setEditing(null);
      notify("Registre enregistré.", "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const login = async (r: RegistryView) => {
    setBusy(r.id);
    try {
      notify(`${r.name} : ${await api.registryLogin(serverId, r.id)}`, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const logout = async (server: string) => {
    const ok = await ask({
      title: `Déconnecter ce serveur de ${server} ?`,
      body: "Docker efface son jeton. Les images déjà téléchargées restent ; un prochain pull d'image privée échouera tant que le serveur ne sera pas reconnecté.",
      confirmLabel: "Déconnecter",
    });
    if (!ok) return;
    try {
      await api.registryLogout(serverId, server);
      notify(`Déconnecté de ${server}.`, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const remove = async (r: RegistryView) => {
    const ok = await ask({
      title: `Supprimer le registre ${r.name} ?`,
      body: "Son jeton est retiré du coffre de Helm. Les serveurs déjà connectés le restent : utilise « Déconnecter » pour effacer le jeton côté serveur.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    await api.registryDelete(r.id).catch((e) => notify(errorMessage(e), "error"));
    await load();
  };

  const unknownSessions = (sessions ?? []).filter((s) => !(list ?? []).some((r) => same(r.server, s.server)));
  const plaintext = (sessions ?? []).some((s) => !s.helper);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-sm text-muted">
          Les identifiants sont rangés dans le coffre du système, pas dans la configuration de Helm. À la connexion, le jeton part sur l'entrée standard de{" "}
          <span className="font-mono">docker login</span> : il n'apparaît jamais dans une ligne de commande visible des autres utilisateurs du serveur.
        </p>
        <Button
          variant="primary"
          icon={<Plus size={13} />}
          onClick={() => setEditing({ registry: { id: "", name: "", kind: "ghcr", server: "ghcr.io", username: "" }, secret: "", hint: "", hasSecret: false })}
        >
          Ajouter un registre
        </Button>
      </div>

      {plaintext && (
        <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" />
          <span>
            Sur ce serveur, Docker garde les jetons dans <span className="font-mono">~/.docker/config.json</span>, simplement encodés en base64 (aucun
            « credential helper »). Utilise des jetons <strong>en lecture seule</strong>, limités au pull, plutôt que le mot de passe de ton compte.
          </span>
        </div>
      )}

      {list === null ? (
        <p className="text-sm text-muted">Chargement…</p>
      ) : list.length === 0 ? (
        <EmptyState icon={<KeyRound size={36} />} title="Aucun registre privé">
          Ajoute Docker Hub, GitHub Packages, GitLab, AWS ECR ou ton propre registre pour que ce serveur puisse tirer des images privées.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Registre</th>
                <th className="px-3 py-2 font-medium">Adresse</th>
                <th className="px-3 py-2 font-medium">Utilisateur</th>
                <th className="px-3 py-2 font-medium">Ce serveur</th>
                <th className="w-44" />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const session = (sessions ?? []).find((s) => same(s.server, r.server));
                return (
                  <tr key={r.id} className="group border-t border-border/50 hover:bg-hover-soft">
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        {r.name}
                        <Badge>{kindOf(r.kind).label}</Badge>
                        {!r.hasSecret && <Badge tone="warn">sans jeton</Badge>}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.server}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-muted">{r.username}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {session ? (
                        <span className="flex items-center gap-1 text-ok">
                          {session.helper ? <ShieldCheck size={12} /> : <ShieldAlert size={12} className="text-warn" />} connecté
                        </span>
                      ) : (
                        <span className="text-muted">non connecté</span>
                      )}
                    </td>
                    <td className="px-2 text-right">
                      <span className="flex items-center justify-end gap-1">
                        {session ? (
                          <Button size="sm" variant="ghost" icon={<LogOut size={13} />} onClick={() => void logout(r.server)}>
                            Déconnecter
                          </Button>
                        ) : (
                          <Button size="sm" icon={<LogIn size={13} />} loading={busy === r.id} disabled={!r.hasSecret} onClick={() => void login(r)}>
                            Connecter
                          </Button>
                        )}
                        <IconButton
                          title="Modifier"
                          onClick={() => setEditing({ registry: { id: r.id, name: r.name, kind: r.kind, server: r.server, username: r.username }, secret: "", hint: r.secretHint, hasSecret: r.hasSecret })}
                        >
                          <Pencil size={13} />
                        </IconButton>
                        <IconButton title="Supprimer" onClick={() => void remove(r)}>
                          <Trash2 size={13} />
                        </IconButton>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {unknownSessions.length > 0 && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-xs text-muted">Ce serveur est aussi connecté à des registres que Helm ne gère pas :</p>
          <ul className="flex flex-col gap-1">
            {unknownSessions.map((s) => (
              <li key={s.server} className="flex items-center gap-2 text-xs">
                <span className="font-mono">{s.server}</span>
                {!s.helper && <Badge tone="warn">jeton en clair</Badge>}
                <Button size="sm" variant="ghost" icon={<LogOut size={12} />} onClick={() => void logout(s.server)}>
                  Déconnecter
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing && <RegistryForm value={editing} onChange={setEditing} onClose={() => setEditing(null)} onSave={() => void save()} />}
    </div>
  );
}

function RegistryForm({
  value,
  onChange,
  onClose,
  onSave,
}: {
  value: { registry: Registry; secret: string; hint: string; hasSecret: boolean };
  onChange: (v: { registry: Registry; secret: string; hint: string; hasSecret: boolean }) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { registry, secret } = value;
  const kind = kindOf(registry.kind);
  const set = (patch: Partial<Registry>) => onChange({ ...value, registry: { ...registry, ...patch } });

  return (
    <Modal
      title={registry.id ? `Modifier ${registry.name}` : "Nouveau registre"}
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={!registry.username.trim() || (!registry.id && !secret.trim())} onClick={onSave}>
          Enregistrer
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Type">
          <Select<RegistryKind>
            value={registry.kind}
            onChange={(v) => {
              const k = kindOf(v);
              set({ kind: k.id, server: k.server });
            }}
            options={KINDS.map((k) => ({ value: k.id, label: k.label }))}
          />
        </Field>
        <Field label="Nom" hint="Pour t'y retrouver ; l'adresse sert par défaut.">
          <Input value={registry.name} placeholder={registry.server || "Mon registre"} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field
          label="Adresse du registre"
          hint={registry.kind === "ecr" ? "<compte>.dkr.ecr.<région>.amazonaws.com — le client aws doit être installé sur le serveur." : undefined}
        >
          <Input
            className="font-mono text-sm"
            value={registry.server}
            placeholder={registry.kind === "ecr" ? "123456789012.dkr.ecr.eu-west-3.amazonaws.com" : "registry.exemple.fr"}
            onChange={(e) => set({ server: e.target.value })}
          />
        </Field>
        <Field label={kind.user}>
          <Input className="font-mono text-sm" value={registry.username} onChange={(e) => set({ username: e.target.value })} />
        </Field>
        <Field
          label={registry.kind === "ecr" ? "Clé secrète AWS" : "Jeton d'accès"}
          hint={value.hasSecret ? "Laisse vide pour garder le jeton enregistré." : value.hint || "Un jeton en lecture seule suffit pour tirer des images."}
        >
          <Input className="font-mono text-sm" type="password" value={secret} onChange={(e) => onChange({ ...value, secret: e.target.value })} autoComplete="off" />
        </Field>
      </div>
    </Modal>
  );
}
