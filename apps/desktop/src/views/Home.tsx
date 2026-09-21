import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Box, CheckCircle2, LayoutDashboard, Lock, OctagonAlert, Plug, RefreshCw, Server } from "lucide-react";
import { api, formatBytes, formatDuration, type DashboardSummary, type ServerView } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, EmptyState, IconButton } from "../components/ui";

const CONCURRENCY = 4;
const REFRESH_MS = 30_000;
const CERT_WARN_DAYS = 21;

type Result = DashboardSummary | "loading";

export default function HomeView({ visible }: { visible: boolean }) {
  const { servers, setSection, setActiveServer } = useApp();
  const [results, setResults] = useState<Record<string, Result>>({});
  const [updated, setUpdated] = useState<number | null>(null);
  const running = useRef(false);

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const queue = [...servers];
    setResults((r) => Object.fromEntries(servers.map((s) => [s.id, r[s.id] ?? "loading"])));
    // Au plus 4 serveurs interrogés en même temps.
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const id = s.id;
        const summary = await api.dashboardSummary(id).catch((e) => ({ connected: false, error: String(e) }) as DashboardSummary);
        setResults((r) => ({ ...r, [id]: summary }));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setUpdated(Date.now());
    running.current = false;
  }, [servers]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [visible, refresh]);

  if (servers.length === 0) {
    return (
      <EmptyState icon={<LayoutDashboard size={40} />} title="Bienvenue dans Helm">
        Ajoute ton premier serveur (ou importe tes sessions PuTTY) dans l'onglet Serveurs.
        <div className="mt-4">
          <Button variant="primary" onClick={() => setSection("servers")}>
            Ajouter un serveur
          </Button>
        </div>
      </EmptyState>
    );
  }

  const open = (s: ServerView, section: "monitoring" | "docker" | "sites") => {
    setActiveServer(s.id);
    setSection(section);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Vue d'ensemble</h1>
          <p className="text-sm text-muted">
            {servers.length} serveur(s){updated ? ` · actualisé à ${new Date(updated).toLocaleTimeString("fr-FR")}` : ""}
          </p>
        </div>
        <IconButton title="Actualiser" onClick={() => void refresh()}>
          <RefreshCw size={15} className={running.current ? "animate-spin" : ""} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} result={results[s.id]} onOpen={(section) => open(s, section)} onRetry={() => void refresh()} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Meter({ label, value, detail }: { label: string; value: number | null; detail?: string }) {
  const tone = value == null ? "bg-border" : value >= 90 ? "bg-danger" : value >= 80 ? "bg-warn" : "bg-accent";
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">{value == null ? "…" : `${value.toFixed(0)} %`}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-border">
        <div className={`h-full rounded ${tone}`} style={{ width: `${value ?? 0}%` }} />
      </div>
      {detail && <div className="mt-0.5 text-[11px] text-muted">{detail}</div>}
    </div>
  );
}

function ServerCard({
  server,
  result,
  onOpen,
  onRetry,
}: {
  server: ServerView;
  result: Result | undefined;
  onOpen: (section: "monitoring" | "docker" | "sites") => void;
  onRetry: () => void;
}) {
  const header = (
    <div className="flex items-center gap-2">
      <span className="size-2.5 rounded-full" style={{ background: server.color ?? "#3b82f6" }} />
      <span className="font-medium">{server.name}</span>
      <span className="truncate font-mono text-xs text-muted">{server.host}</span>
    </div>
  );

  if (!result || result === "loading") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
        {header}
        <p className="text-sm text-muted">Interrogation…</p>
      </div>
    );
  }

  if (!result.connected) {
    const needsUser = /NEED_PASSWORD|UNKNOWN_HOST_KEY|HOST_KEY_MISMATCH/.test(result.error ?? "");
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
        {header}
        <div className="flex items-start gap-2 text-sm">
          <Server size={15} className="mt-0.5 shrink-0 text-muted" />
          <span className="text-muted">{needsUser ? "Connexion à valider (mot de passe ou clé du serveur)." : `Injoignable : ${result.error}`}</span>
        </div>
        <Button
          size="sm"
          className="self-start"
          icon={<Plug size={13} />}
          onClick={async () => {
            if (await ensureConnected(server.id)) onRetry();
          }}
        >
          Se connecter
        </Button>
      </div>
    );
  }

  const m = result.metrics;
  const mem = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : null;
  const root = m?.disks.find((d) => d.mount === "/") ?? m?.disks[0];
  const disk = root && root.total ? (root.used / root.total) * 100 : null;
  const now = Date.now() / 1000;
  const expiring = result.certificates.filter((c) => (c.notAfter - now) / 86400 < CERT_WARN_DAYS);
  const healthy = result.alerts.length === 0 && expiring.length === 0 && result.containersStopped === 0;

  return (
    <div className={`flex flex-col gap-3 rounded-lg border bg-panel p-4 ${result.alerts.length ? "border-danger/50" : "border-border"}`}>
      <div className="flex items-start justify-between gap-2">
        {header}
        {healthy ? (
          <Badge tone="ok">
            <CheckCircle2 size={11} className="mr-1" /> OK
          </Badge>
        ) : result.alerts.length ? (
          <Badge tone="danger">{result.alerts.length} alerte(s)</Badge>
        ) : (
          <Badge tone="warn">à surveiller</Badge>
        )}
      </div>

      <button className="grid grid-cols-3 gap-3 text-left" onClick={() => onOpen("monitoring")}>
        <Meter label="CPU" value={m && m.cpuPercent > 0 ? m.cpuPercent : m ? 0 : null} detail={m ? `charge ${m.load[0].toFixed(2)}` : undefined} />
        <Meter label="Mémoire" value={mem} detail={m ? formatBytes(m.memUsed) : undefined} />
        <Meter label="Disque" value={disk} detail={root ? `${formatBytes(root.total - root.used)} libres` : undefined} />
      </button>

      <ul className="flex flex-col gap-1.5 text-xs">
        {result.alerts.map((a) => (
          <li key={a.key} className="flex items-start gap-1.5 text-danger">
            <OctagonAlert size={13} className="mt-0.5 shrink-0" /> {a.title}
          </li>
        ))}
        {result.docker && (
          <li>
            <button className="flex items-center gap-1.5 text-muted hover:text-fg" onClick={() => onOpen("docker")}>
              <Box size={13} />
              {result.containersRunning} conteneur(s) actif(s)
              {result.containersStopped > 0 && (
                <span className="text-warn">
                  · {result.containersStopped} arrêté(s) : {result.stoppedNames.join(", ")}
                </span>
              )}
            </button>
          </li>
        )}
        {expiring.map((c, i) => {
          const days = Math.floor((c.notAfter - now) / 86400);
          return (
            <li key={i}>
              <button className={`flex items-center gap-1.5 ${days < 7 ? "text-danger" : "text-warn"}`} onClick={() => onOpen("sites")}>
                <Lock size={13} />
                {c.domains[0] ?? "certificat"} : {days < 0 ? "expiré" : `expire dans ${days} j`}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2 text-[11px] text-muted">
        {m && <span>en ligne depuis {formatDuration(m.uptimeSecs)}</span>}
        {!result.agent && (
          <span className="flex items-center gap-1">
            <AlertTriangle size={11} /> sans agent : pas d'alertes quand ton PC est éteint
          </span>
        )}
      </div>
    </div>
  );
}
