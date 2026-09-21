import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Skull, X } from "lucide-react";
import { api, errorMessage, formatBytes, formatDuration, type Process } from "../../lib/api";
import { useApp } from "../../lib/store";
import { IconButton, Input } from "../../components/ui";

type SortKey = "cpu" | "mem" | "rss" | "pid" | "elapsed" | "name";

export default function Processes({ serverId, visible }: { serverId: string; visible: boolean }) {
  const { ask, notify } = useApp();
  const [list, setList] = useState<Process[]>([]);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("cpu");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.processes(serverId));
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setLoading(false);
    }
  }, [serverId, notify]);

  useEffect(() => {
    if (!visible) return;
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load, visible]);

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const filtered = list.filter((p) => !f || p.command.toLowerCase().includes(f) || p.user.toLowerCase().includes(f) || String(p.pid) === f);
    const dir = sort === "name" || sort === "pid" ? 1 : -1;
    return [...filtered].sort((a, b) => (a[sort] < b[sort] ? -dir : a[sort] > b[sort] ? dir : 0));
  }, [list, filter, sort]);

  const kill = async (p: Process, force: boolean) => {
    const ok = await ask({
      title: force ? `Forcer l'arrêt de ${p.name} (PID ${p.pid}) ?` : `Arrêter ${p.name} (PID ${p.pid}) ?`,
      body: force
        ? "SIGKILL tue le processus immédiatement, sans lui laisser le temps de se terminer proprement."
        : "SIGTERM demande au processus de s'arrêter proprement.",
      code: p.command,
      confirmLabel: force ? "Forcer (SIGKILL)" : "Arrêter (SIGTERM)",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.kill(serverId, p.pid, force);
      notify(`Signal envoyé à ${p.pid}`, "success");
      void load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>
      <button className={`hover:text-fg ${sort === k ? "text-fg" : ""}`} onClick={() => setSort(k)}>
        {children}
        {sort === k && " ↓"}
      </button>
    </th>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input className="!w-72" placeholder="Filtrer (commande, utilisateur, PID)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="text-xs text-muted">{rows.length} processus · actualisé toutes les 5 s</span>
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs text-muted">
            <tr>
              <Th k="pid">PID</Th>
              <th className="px-3 py-2 font-medium">Utilisateur</th>
              <Th k="cpu" right>CPU</Th>
              <Th k="mem" right>Mém.</Th>
              <Th k="rss" right>RSS</Th>
              <Th k="elapsed" right>Durée</Th>
              <Th k="name">Commande</Th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid} className="group border-t border-border/50 hover:bg-white/[0.03]">
                <td className="px-3 py-1.5 font-mono text-xs text-muted tabular-nums">{p.pid}</td>
                <td className="px-3 py-1.5 text-xs">{p.user}</td>
                <td className={`px-3 py-1.5 text-right text-xs tabular-nums ${p.cpu >= 50 ? "text-warn" : ""}`}>{p.cpu.toFixed(1)} %</td>
                <td className="px-3 py-1.5 text-right text-xs tabular-nums">{p.mem.toFixed(1)} %</td>
                <td className="px-3 py-1.5 text-right text-xs text-muted tabular-nums">{formatBytes(p.rss)}</td>
                <td className="px-3 py-1.5 text-right text-xs text-muted tabular-nums">{formatDuration(p.elapsed)}</td>
                <td className="max-w-0 px-3 py-1.5">
                  <div className="truncate font-mono text-xs select-text" title={p.command}>
                    {p.command}
                  </div>
                </td>
                <td className="px-2 py-1 text-right">
                  <span className="invisible inline-flex group-hover:visible">
                    <IconButton title="Arrêter (SIGTERM)" onClick={() => void kill(p, false)}>
                      <X size={14} />
                    </IconButton>
                    <IconButton title="Forcer l'arrêt (SIGKILL)" onClick={() => void kill(p, true)}>
                      <Skull size={14} />
                    </IconButton>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
