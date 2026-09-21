import { useCallback, useEffect, useState } from "react";
import { Cable, Copy, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { api, errorMessage, type TunnelDef, type TunnelView } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";

export default function TunnelsView() {
  const { servers, notify, ask, activeServerId } = useApp();
  const [list, setList] = useState<TunnelView[]>([]);
  const [editing, setEditing] = useState<TunnelDef | null>(null);

  const load = useCallback(() => void api.tunnels().then(setList), []);
  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
    load();
  };

  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "serveur supprimé";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Tunnels SSH</h1>
          <p className="text-sm text-muted">Accède depuis ton PC à un service du serveur (base de données, interface d'admin…) sans l'exposer sur Internet.</p>
        </div>
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!servers.length}
          onClick={async () => {
            const port = await api.tunnelFreePort(13306);
            setEditing({ id: "", serverId: activeServerId ?? servers[0].id, name: "", localPort: port, remoteHost: "127.0.0.1", remotePort: 3306, autoStart: false });
          }}
        >
          Nouveau tunnel
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {list.length === 0 ? (
          <EmptyState icon={<Cable size={40} />} title="Aucun tunnel">
            Exemple : ta base MySQL écoute sur le port 3306 du serveur. Un tunnel la rend accessible sur <span className="font-mono">127.0.0.1:13306</span> de ton PC, chiffrée par SSH, sans ouvrir de port sur Internet.
          </EmptyState>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-panel text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Nom</th>
                  <th className="px-3 py-2 font-medium">Sur ton PC</th>
                  <th className="px-3 py-2 font-medium">Vers (depuis le serveur)</th>
                  <th className="px-3 py-2 font-medium">État</th>
                  <th className="w-40" />
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} className="border-t border-border/50">
                    <td className="px-3 py-2">
                      <div className="font-medium">{t.name || `${t.remoteHost}:${t.remotePort}`}</div>
                      <div className="text-xs text-muted">{serverName(t.serverId)}{t.autoStart ? " · démarre avec Helm" : ""}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">127.0.0.1:{t.localPort}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">
                      {t.remoteHost}:{t.remotePort}
                    </td>
                    <td className="px-3 py-2">
                      {t.running ? <Badge tone="ok">actif · {t.activeConnections} connexion(s)</Badge> : <Badge>arrêté</Badge>}
                      {t.lastError && <div className="mt-1 max-w-72 truncate text-[11px] text-danger" title={t.lastError}>{t.lastError}</div>}
                    </td>
                    <td className="px-2 text-right">
                      {t.running ? (
                        <IconButton title="Arrêter" onClick={() => void run(() => api.tunnelStop(t.id))}>
                          <Square size={13} />
                        </IconButton>
                      ) : (
                        <IconButton title="Démarrer" onClick={() => void run(() => api.tunnelStart(t.id))}>
                          <Play size={14} />
                        </IconButton>
                      )}
                      <IconButton
                        title="Copier l'adresse locale"
                        onClick={() => {
                          void navigator.clipboard.writeText(`127.0.0.1:${t.localPort}`);
                          notify("Adresse copiée", "success");
                        }}
                      >
                        <Copy size={13} />
                      </IconButton>
                      <IconButton title="Modifier" onClick={() => setEditing(t)}>
                        <Pencil size={13} />
                      </IconButton>
                      <IconButton
                        title="Supprimer"
                        onClick={async () => {
                          if (await ask({ title: `Supprimer le tunnel « ${t.name || t.localPort} » ?`, confirmLabel: "Supprimer", danger: true })) {
                            await run(() => api.tunnelDelete(t.id));
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-muted">
          Les tunnels n'écoutent que sur 127.0.0.1 : ils ne sont pas accessibles depuis le réseau de ton PC. La connexion SSH s'ouvre à la première utilisation.
        </p>
      </div>
      {editing && (
        <TunnelForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async (id, start) => {
            setEditing(null);
            if (start) await run(() => api.tunnelStart(id));
            else load();
          }}
        />
      )}
    </div>
  );
}

export function TunnelForm({ initial, onClose, onSaved }: { initial: TunnelDef; onClose: () => void; onSaved: (id: string, start: boolean) => void }) {
  const { servers, notify } = useApp();
  const [t, setT] = useState(initial);
  const set = <K extends keyof TunnelDef>(k: K, v: TunnelDef[K]) => setT((x) => ({ ...x, [k]: v }));
  const save = async (start: boolean) => {
    try {
      const id = await api.tunnelSave(t);
      onSaved(id, start);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };
  return (
    <Modal
      title={t.id ? "Modifier le tunnel" : "Nouveau tunnel"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => void save(false)}>
            Enregistrer
          </Button>
          <Button variant="primary" onClick={() => void save(true)}>
            Enregistrer et démarrer
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Nom">
            <Input value={t.name} onChange={(e) => set("name", e.target.value)} placeholder="MySQL nexus" autoFocus />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Serveur">
            <select className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm" value={t.serverId} onChange={(e) => set("serverId", e.target.value)}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Hôte, vu depuis le serveur" hint="127.0.0.1 pour un service du serveur, ou l'IP d'un conteneur.">
          <Input className="font-mono" value={t.remoteHost} onChange={(e) => set("remoteHost", e.target.value)} />
        </Field>
        <Field label="Port distant">
          <Input type="number" value={t.remotePort} onChange={(e) => set("remotePort", Number(e.target.value))} />
        </Field>
        <Field label="Port local sur ton PC" hint="Tu te connecteras à 127.0.0.1 sur ce port.">
          <Input type="number" value={t.localPort} onChange={(e) => set("localPort", Number(e.target.value))} />
        </Field>
        <label className="flex items-center gap-2 self-center text-sm">
          <input type="checkbox" checked={t.autoStart} onChange={(e) => set("autoStart", e.target.checked)} />
          Démarrer au lancement de Helm
        </label>
      </div>
    </Modal>
  );
}
