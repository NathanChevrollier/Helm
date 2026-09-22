import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, OctagonAlert } from "lucide-react";
import { api, errorMessage, formatBytes, formatDuration, type AgentInfo, type HistoryPoint, type Metrics } from "../../lib/api";
import TimeChart from "../../components/TimeChart";
import { usePolling } from "../../lib/poll";
import { useCachedState } from "../../lib/cache";

const RANGES = [
  { id: "live", label: "Direct", secs: 0 },
  { id: "1h", label: "1 h", secs: 3600 },
  { id: "24h", label: "24 h", secs: 86400 },
  { id: "7d", label: "7 j", secs: 7 * 86400 },
  { id: "30d", label: "30 j", secs: 30 * 86400 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const LIVE_POINTS = 150;
const pct = (v: number) => `${v.toFixed(0)} %`;
const rate = (v: number) => `${formatBytes(v)}/s`;

type Level = "ok" | "warn" | "crit";
function level(v: number, warn = 80, crit = 90): Level {
  return v >= crit ? "crit" : v >= warn ? "warn" : "ok";
}

function Tile({ label, value, detail, lvl }: { label: string; value: string; detail?: string; lvl?: Level }) {
  const icon =
    lvl === "crit" ? <OctagonAlert size={14} className="text-danger" /> : lvl === "warn" ? <AlertTriangle size={14} className="text-warn" /> : null;
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3">
      <div className="flex items-center justify-between text-xs text-muted">
        {label}
        {icon && (
          <span className="flex items-center gap-1">
            {icon}
            {lvl === "crit" ? "critique" : "élevé"}
          </span>
        )}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 truncate text-xs text-muted">{detail}</div>}
    </div>
  );
}

function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export default function Overview({ serverId, agent, visible }: { serverId: string; agent: AgentInfo | null; visible: boolean }) {
  const [live, setLive] = useCachedState<Metrics[]>(`live:${serverId}`, []);
  const [range, setRange] = useState<RangeId>("live");
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const serverRef = useRef(serverId);
  serverRef.current = serverId;
  const agentOk = !!agent?.running;

  // Relevés directs toutes les 2 s tant que la vue est affichée.
  usePolling(
    async () => {
      const current = serverId;
      try {
        const m = await api.metrics(serverId);
        if (current !== serverRef.current) return;
        setLive((prev) => [...prev, m].slice(-LIVE_POINTS));
        setError(null);
      } catch (e) {
        if (current === serverRef.current) setError(errorMessage(e));
      }
    },
    2000,
    [serverId],
    visible,
  );

  useEffect(() => {
    const r = RANGES.find((x) => x.id === range)!;
    if (!r.secs || !agentOk) {
      setHistory(null);
      return;
    }
    let stop = false;
    const load = () =>
      api
        .agentHistory(serverId, r.secs)
        .then((h) => !stop && setHistory(h))
        .catch((e) => !stop && setError(errorMessage(e)));
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [serverId, range, agentOk]);

  // Le premier relevé direct n'a pas de CPU calculé : on l'écarte des graphiques.
  const points: HistoryPoint[] = useMemo(() => {
    if (history) return history;
    return live.slice(1).map((m) => ({
      t: m.timestamp,
      cpu: m.cpuPercent,
      mem: m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0,
      disk: Math.max(0, ...m.disks.map((d) => (d.total ? (d.used / d.total) * 100 : 0))),
      load: m.load[0],
      rx: m.netRxRate,
      tx: m.netTxRate,
    }));
  }, [history, live]);

  const times = useMemo(() => points.map((p) => p.t), [points]);
  const cpuSeries = useMemo(() => [{ label: "CPU", values: points.map((p) => p.cpu) }], [points]);
  const memSeries = useMemo(() => [{ label: "Mémoire", values: points.map((p) => p.mem) }], [points]);
  const netSeries = useMemo(
    () => [
      { label: "Réception", values: points.map((p) => p.rx) },
      { label: "Émission", values: points.map((p) => p.tx) },
    ],
    [points],
  );
  const loadSeries = useMemo(() => [{ label: "Charge 1 min", values: points.map((p) => p.load) }], [points]);

  const m = live[live.length - 1];
  const prevOk = live.length > 1;
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const rootDisk = m?.disks.find((d) => d.mount === "/") ?? m?.disks[0];
  const diskPct = rootDisk && rootDisk.total ? (rootDisk.used / rootDisk.total) * 100 : 0;

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <Tile label="CPU" value={prevOk ? pct(m.cpuPercent) : "…"} detail={m ? `${m.cpuCount} cœurs` : undefined} lvl={prevOk ? level(m.cpuPercent) : undefined} />
        <Tile label="Mémoire" value={m ? pct(memPct) : "…"} detail={m ? `${formatBytes(m.memUsed)} / ${formatBytes(m.memTotal)}` : undefined} lvl={m ? level(memPct) : undefined} />
        <Tile
          label={`Disque ${rootDisk?.mount ?? ""}`}
          value={rootDisk ? pct(diskPct) : "…"}
          detail={rootDisk ? `${formatBytes(rootDisk.used)} / ${formatBytes(rootDisk.total)}` : undefined}
          lvl={rootDisk ? level(diskPct, 80, 90) : undefined}
        />
        <Tile
          label="Charge"
          value={m ? m.load[0].toFixed(2) : "…"}
          detail={m ? `5 min ${m.load[1].toFixed(2)} · 15 min ${m.load[2].toFixed(2)}` : undefined}
          lvl={m ? level(m.load[0] / Math.max(m.cpuCount, 1) * 100, 100, 200) : undefined}
        />
        <Tile label="Réseau" value={prevOk ? `↓ ${rate(m.netRxRate)}` : "…"} detail={prevOk ? `↑ ${rate(m.netTxRate)}` : undefined} />
        <Tile label="En ligne depuis" value={m ? formatDuration(m.uptimeSecs) : "…"} />
      </div>

      <div className="flex items-center gap-1 self-end rounded-md border border-border bg-panel p-1">
        {RANGES.map((r) => (
          <button
            key={r.id}
            disabled={r.secs > 0 && !agentOk}
            title={r.secs > 0 && !agentOk ? "Installe l'agent helmd pour conserver l'historique" : undefined}
            onClick={() => setRange(r.id)}
            className={`rounded px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${range === r.id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="CPU">
          <TimeChart times={times} series={cpuSeries} format={pct} max={100} />
        </Panel>
        <Panel title="Mémoire">
          <TimeChart times={times} series={memSeries} format={pct} max={100} />
        </Panel>
        <Panel
          title="Réseau"
          right={
            <div className="flex gap-3 text-xs text-muted">
              <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-3 rounded bg-[#3987e5]" />Réception</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-3 rounded bg-[#d95926]" />Émission</span>
            </div>
          }
        >
          <TimeChart times={times} series={netSeries} format={rate} />
        </Panel>
        <Panel title="Charge système (1 min)">
          <TimeChart times={times} series={loadSeries} format={(v) => v.toFixed(2)} />
        </Panel>
      </div>

      {m && m.disks.length > 0 && (
        <Panel title="Disques">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Point de montage</th>
                <th className="pb-2 font-medium">Périphérique</th>
                <th className="w-1/3 pb-2 font-medium">Occupation</th>
                <th className="pb-2 text-right font-medium">Utilisé / total</th>
              </tr>
            </thead>
            <tbody>
              {m.disks.map((d) => {
                const p = d.total ? (d.used / d.total) * 100 : 0;
                const lv = level(p);
                return (
                  <tr key={d.mount} className="border-t border-border/50">
                    <td className="py-2 font-mono text-xs">{d.mount}</td>
                    <td className="py-2 font-mono text-xs text-muted">{d.device}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded bg-border">
                          <div className={`h-full rounded ${lv === "crit" ? "bg-danger" : lv === "warn" ? "bg-warn" : "bg-accent"}`} style={{ width: `${p}%` }} />
                        </div>
                        <span className="w-10 text-right text-xs tabular-nums">{pct(p)}</span>
                      </div>
                    </td>
                    <td className="py-2 text-right text-xs text-muted tabular-nums">
                      {formatBytes(d.used)} / {formatBytes(d.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}

      {agent?.status && (
        <Panel title="Alertes">
          {agent.status.activeAlerts.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <CheckCircle2 size={15} className="text-ok" /> Aucune alerte en cours.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {agent.status.activeAlerts.map((a) => (
                <li key={a.key} className="flex items-start gap-2 text-sm">
                  <OctagonAlert size={15} className="mt-0.5 shrink-0 text-danger" />
                  <div>
                    <div>{a.title}</div>
                    <div className="text-xs text-muted">
                      {a.message} · depuis {new Date(a.since).toLocaleString("fr-FR")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
