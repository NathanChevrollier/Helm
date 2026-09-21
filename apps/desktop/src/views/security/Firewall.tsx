import { useCallback, useEffect, useState } from "react";
import { BrickWall, Globe, Lock, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, errorMessage, type FwState } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, EmptyState, IconButton, Input } from "../../components/ui";

const STATUS = {
  open: { label: "exposé", tone: "warn" },
  blocked: { label: "bloqué", tone: "ok" },
  local: { label: "local", tone: "muted" },
} as const;

export default function Firewall({ serverId }: { serverId: string }) {
  const { ask, notify } = useApp();
  const [state, setState] = useState<FwState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState("");
  const [proto, setProto] = useState("tcp");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api.fwState(serverId));
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

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify(ok, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  if (error) return <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>;
  if (!state) return <EmptyState icon={<BrickWall size={36} className="animate-pulse" />} title="Lecture du pare-feu…" />;

  const exposed = state.exposures.filter((e) => e.status === "open");

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <div className="flex items-center gap-2 text-sm">
        <BrickWall size={15} className="text-muted" />
        {state.kind === "none" ? (
          <span className="text-warn">Aucun pare-feu détecté (ni ufw, ni firewalld). L'onglet Audit propose d'activer ufw.</span>
        ) : (
          <span>
            {state.kind} <Badge tone={state.active ? "ok" : "danger"}>{state.active ? "actif" : "inactif"}</Badge>
            {state.defaults && <span className="ml-2 text-xs text-muted">Par défaut : {state.defaults}</span>}
          </span>
        )}
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>

      <section className="rounded-lg border border-border bg-panel">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Globe size={14} />
          <span className="font-medium">Ports en écoute</span>
          <span className="text-xs text-muted">· {exposed.length} joignable(s) depuis Internet</span>
        </header>
        <table className="w-full text-sm">
          <tbody>
            {state.exposures.map((e) => (
              <tr key={`${e.proto}${e.port}${e.public}`} className="border-t border-border/50 align-top first:border-t-0">
                <td className="w-24 px-4 py-2 font-mono text-xs">
                  {e.port}/{e.proto}
                </td>
                <td className="w-24 px-2 py-2">
                  <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                </td>
                <td className="w-44 px-2 py-2 text-xs">{e.owner || "?"}</td>
                <td className={`px-2 py-2 text-xs ${e.docker && e.status === "open" && state.active ? "text-warn" : "text-muted"}`}>{e.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {state.kind === "ufw" && (
        <section className="rounded-lg border border-border bg-panel">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Lock size={14} />
            <span className="font-medium">Règles ufw</span>
            {state.sshPorts.length > 0 && <span className="text-xs text-muted">· SSH sur le port {state.sshPorts.join(", ")} (règles protégées)</span>}
          </header>
          {state.rules.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Aucune règle.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {state.rules.map((r) => (
                <li key={r.num} className="flex items-center gap-3 px-4 py-1.5 text-sm">
                  <span className="w-8 text-xs text-muted">#{r.num}</span>
                  <span className="w-56 font-mono text-xs">{r.to}</span>
                  <Badge tone={r.action.startsWith("ALLOW") || r.action.startsWith("LIMIT") ? "ok" : "danger"}>{r.action}</Badge>
                  <span className="text-xs text-muted">depuis {r.from}</span>
                  <IconButton
                    className="ml-auto"
                    title="Supprimer la règle"
                    onClick={async () => {
                      if (await ask({ title: `Supprimer la règle #${r.num} ?`, code: `${r.to}  ${r.action}  ${r.from}`, confirmLabel: "Supprimer", danger: true }))
                        void run(() => api.fwDelete(serverId, r.num), `Règle #${r.num} supprimée`);
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-center gap-2 border-t border-border px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              const p = Number(port);
              if (!Number.isInteger(p) || p < 1 || p > 65535) return notify("Port invalide.", "error");
              void run(() => api.fwAllow(serverId, p, proto), `Port ${p}/${proto} ouvert`).then(() => setPort(""));
            }}
          >
            <span className="text-sm">Ouvrir un port :</span>
            <Input className="!w-24 font-mono" placeholder="8080" value={port} onChange={(e) => setPort(e.target.value)} />
            <select className="h-8 rounded-md border border-border bg-bg px-2 text-sm" value={proto} onChange={(e) => setProto(e.target.value)}>
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </select>
            <Button size="sm" icon={<Plus size={13} />} type="submit" disabled={!port}>
              Autoriser
            </Button>
          </form>
        </section>
      )}

      {state.kind === "firewalld" && state.raw && (
        <section className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-2 font-medium">Configuration firewalld (lecture seule)</h2>
          <pre className="overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap">{state.raw}</pre>
        </section>
      )}
    </div>
  );
}
