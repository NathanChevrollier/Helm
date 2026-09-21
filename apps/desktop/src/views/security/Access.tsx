import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { api, errorMessage, type ServerUser } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, EmptyState, IconButton } from "../../components/ui";

export default function Access({ serverId }: { serverId: string }) {
  const { ask, notify } = useApp();
  const [users, setUsers] = useState<ServerUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await api.accessUsers(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addKey = async (user: string) => {
    const key = await ask({
      title: `Autoriser une clé SSH pour ${user}`,
      body: "Colle la clé PUBLIQUE (une ligne commençant par ssh-ed25519, ssh-rsa ou ecdsa-…). Jamais la clé privée.",
      input: { label: "Clé publique" },
      confirmLabel: "Autoriser",
    });
    if (typeof key !== "string" || !key.trim()) return;
    try {
      await api.accessAddKey(serverId, user, key.trim());
      notify(`Clé ajoutée pour ${user}`, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  if (error) return <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>;
  if (!users) return <EmptyState icon={<UserRound size={36} className="animate-pulse" />} title="Lecture des comptes…" />;

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted">
        Comptes pouvant se connecter (root et utilisateurs avec un shell) et clés SSH autorisées.
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>
      {users.map((u) => (
        <section key={u.name} className="rounded-lg border border-border bg-panel">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <UserRound size={14} />
            <span className="font-medium">{u.name}</span>
            {u.admin && (
              <Badge tone={u.uid === 0 ? "danger" : "warn"}>
                <ShieldCheck size={11} className="mr-1" /> {u.uid === 0 ? "root" : "sudo"}
              </Badge>
            )}
            <span className="text-xs text-muted">
              {u.home} · {u.shell} · dernière connexion : {u.lastLogin || "inconnue"}
            </span>
            <Button size="sm" className="ml-auto" icon={<Plus size={13} />} onClick={() => void addKey(u.name)}>
              Clé
            </Button>
          </header>
          {u.keys.length === 0 ? (
            <p className="px-4 py-2.5 text-sm text-muted">Aucune clé SSH : connexion par mot de passe uniquement (si autorisée).</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {u.keys.map((k) => (
                <li key={k.line} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <KeyRound size={14} className={k.current ? "text-accent" : "text-muted"} />
                  <span className="w-28 font-mono text-xs">{k.algorithm}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{k.comment || <span className="text-muted">(sans commentaire)</span>}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">{k.fingerprint}</span>
                    {k.options && <span className="block truncate font-mono text-[11px] text-warn">{k.options}</span>}
                  </span>
                  {k.current && <Badge tone="accent">clé de Helm</Badge>}
                  {!k.current && (
                    <IconButton
                      title="Retirer cette clé"
                      onClick={async () => {
                        const ok = await ask({
                          title: `Retirer cette clé de ${u.name} ?`,
                          body: "La personne ou la machine qui l'utilise ne pourra plus se connecter. Une copie de l'ancien fichier est gardée (authorized_keys.helm-avant).",
                          code: `${k.algorithm} ${k.fingerprint} ${k.comment}`,
                          confirmLabel: "Retirer",
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await api.accessRemoveKey(serverId, u.name, k.line);
                          notify("Clé retirée", "success");
                          await load();
                        } catch (e) {
                          notify(errorMessage(e), "error");
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
