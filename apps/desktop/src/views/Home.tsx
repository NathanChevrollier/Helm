import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { LayoutDashboard, RefreshCw, SquareTerminal } from "lucide-react";
import { useDoctor } from "../components/ConnectionDoctor";
import { api, errorMessage, formatBytes, formatDuration, type AuditEntry, type DashboardSummary, type ServerView } from "../lib/api";
import { ensureConnected, useAppPick } from "../lib/store";
import { usePolling } from "../lib/poll";
import { Button, EmptyState, IconButton } from "../components/ui";
import PageLayout from "../components/PageLayout";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";

/**
 * Colonnes du tableau des serveurs. Chacune garde une largeur minimale : sans elle, les colonnes
 * souples s'écrasaient et les titres se chevauchaient dès que la fenêtre se resserrait.
 */
const ROW_GRID = "grid grid-cols-[minmax(150px,1.3fr)_repeat(3,minmax(104px,1fr))_minmax(130px,1fr)_auto] gap-4 px-4 min-w-[860px]";

const CONCURRENCY = 4;
const REFRESH_MS = 30_000;
const CERT_WARN_DAYS = 21;
const DAY = 86_400;

type Result = DashboardSummary | "loading";

/** Point qui demande une action, affiché dans la colonne « À traiter ». */
interface Todo {
  key: string;
  tone: "warn" | "danger" | "info";
  title: string;
  detail?: ReactNode;
  actions: { label: string; primary?: boolean; run: () => void | Promise<void> }[];
}

export default function HomeView({ visible }: { visible: boolean }) {
  const { servers, setSection, setActiveServer, openTab, notify } = useAppPick("servers", "setSection", "setActiveServer", "openTab", "notify");
  const [results, setResults] = useCachedState<Record<string, Result>>("home:results", {});
  const [activity, setActivity] = useCachedState<AuditEntry[]>("home:activity", []);
  const ids = servers.map((s) => s.id).join(",");
  const running = useRef(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setLoading(true);
    const queue = ids.split(",").filter(Boolean);
    setResults((r) => Object.fromEntries(queue.map((id) => [id, r[id] ?? "loading"])));
    // Au plus 4 serveurs interrogés en même temps.
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const summary = await api.dashboardSummary(id).catch((e) => ({ connected: false, error: String(e) }) as DashboardSummary);
        setResults((r) => ({ ...r, [id]: summary }));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    void api.auditList(6).then(setActivity).catch(() => {});
    running.current = false;
    setLoading(false);
    // Dépend des seuls identifiants : un serveur qui se connecte ne relance pas tout le tour.
  }, [ids]);

  usePolling(refresh, REFRESH_MS, [refresh], visible);
  useAutoRefresh(refresh, { auto: false, enabled: visible });
  useEffect(() => {
    void api.auditList(6).then(setActivity).catch(() => {});
  }, []);

  if (servers.length === 0) {
    return (
      <EmptyState icon={<LayoutDashboard size={40} />} title="Bienvenue dans Helm">
        Ajoute ton premier serveur (ou importe tes sessions PuTTY et OpenSSH) dans Serveurs.
        <div className="mt-4">
          <Button variant="primary" onClick={() => setSection("servers")}>
            Ajouter un serveur
          </Button>
        </div>
      </EmptyState>
    );
  }

  const go = (s: ServerView, section: "monitoring" | "docker" | "sites" | "security") => {
    setActiveServer(s.id);
    setSection(section);
  };
  const summaries = servers.map((s) => ({ server: s, r: results[s.id] })).filter((x): x is { server: ServerView; r: DashboardSummary } => !!x.r && x.r !== "loading");
  const online = summaries.filter((x) => x.r.connected);
  const running_ = online.reduce((n, x) => n + x.r.containersRunning, 0);
  const stopped = online.reduce((n, x) => n + x.r.containersStopped, 0);
  const alerts = online.reduce((n, x) => n + x.r.alerts.length, 0);
  const now = Date.now() / 1000;

  // Tout ce qui demande une action, du plus urgent au moins urgent.
  const todos: Todo[] = [];
  for (const { server: s, r } of summaries) {
    if (!r.connected) {
      const auth = /AUTH_BLOCKED|Authentification échouée/.test(r.error ?? "");
      const needsUser = /NEED_PASSWORD|UNKNOWN_HOST_KEY|HOST_KEY_MISMATCH/.test(r.error ?? "");
      todos.push({
        key: `down:${s.id}`,
        tone: "danger",
        title: needsUser ? `${s.name} : connexion à valider` : auth ? `${s.name} : authentification refusée` : `${s.name} injoignable`,
        detail: auth ? "Helm ne réessaie plus tout seul, pour ne pas déclencher fail2ban." : needsUser ? undefined : r.error?.replace(/^.*?: /, ""),
        actions: [
          { label: "Se connecter", primary: true, run: async () => void ((await ensureConnected(s.id, { force: true })) && refresh()) },
          ...(auth || needsUser ? [] : [{ label: "Diagnostiquer", run: () => useDoctor.getState().open(s.id) }]),
        ],
      });
      continue;
    }
    for (const a of r.alerts) {
      todos.push({ key: `alert:${s.id}:${a.key}`, tone: "danger", title: `${s.name} : ${a.title}`, actions: [{ label: "Monitoring", run: () => go(s, "monitoring") }] });
    }
    if (r.containersStopped > 0) {
      todos.push({
        key: `stopped:${s.id}`,
        tone: "warn",
        title: `${r.containersStopped} conteneur${r.containersStopped > 1 ? "s" : ""} arrêté${r.containersStopped > 1 ? "s" : ""} sur ${s.name}`,
        detail: <span className="font-mono text-xs leading-relaxed">{r.stoppedNames.join(" · ")}</span>,
        actions: [
          {
            label: "Relancer",
            primary: true,
            run: async () => {
              try {
                for (const name of r.stoppedNames) await api.dockerAction(s.id, name, "start");
                notify(`${r.stoppedNames.length} conteneur(s) relancé(s) sur ${s.name}`, "success");
              } catch (e) {
                notify(errorMessage(e), "error");
              }
              void refresh();
            },
          },
          { label: "Docker", run: () => go(s, "docker") },
        ],
      });
    }
    for (const c of r.certificates.filter((c) => (c.notAfter - now) / DAY < CERT_WARN_DAYS)) {
      const days = Math.floor((c.notAfter - now) / DAY);
      todos.push({
        key: `cert:${s.id}:${c.domains[0]}`,
        tone: days < 7 ? "danger" : "warn",
        title: `${c.domains[0] ?? "Certificat"} : ${days < 0 ? "certificat expiré" : `certificat expire dans ${days} j`}`,
        actions: [{ label: "Sites", run: () => go(s, "sites") }],
      });
    }
  }
  const noAgent = online.filter((x) => !x.r.agent).map((x) => x.server.name);
  if (noAgent.length) {
    todos.push({
      key: "agent",
      tone: "info",
      title: `Pas d'agent sur ${noAgent.join(" et ")}`,
      detail: "Aucune alerte quand ton PC est éteint.",
      actions: [{ label: "Installer l'agent", run: () => go(online.find((x) => !x.r.agent)!.server, "monitoring") }],
    });
  }

  return (
    <PageLayout
      title="Vue d'ensemble"
      subtitle={`${servers.length} serveur${servers.length > 1 ? "s" : ""} · actualisation automatique`}
      scroll={false}
      actions={
        <IconButton title="Actualiser" onClick={() => void refresh()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      }
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
      <section className="flex min-h-0 flex-col gap-[18px] overflow-auto px-6 py-[22px]">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
          <Kpi label="Serveurs en ligne" value={online.length} total={servers.length} />
          <Kpi label="Conteneurs actifs" value={running_} />
          <Kpi label="Conteneurs arrêtés" value={stopped} tone={stopped ? "warn" : undefined} />
          <Kpi label="Alertes actives" value={alerts} tone={alerts ? "danger" : undefined} />
        </div>

        {/* Le tableau défile horizontalement plutôt que d'écraser ses colonnes : les titres restaient
            lisibles en large, mais se chevauchaient dès que la fenêtre se resserrait. */}
        <div className="overflow-x-auto rounded-[10px] border border-border bg-panel">
          <div className={`${ROW_GRID} border-b border-border py-2.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase`}>
            <span>Serveur</span>
            <span>CPU</span>
            <span>Mémoire</span>
            <span>Disque</span>
            <span>Conteneurs</span>
            <span />
          </div>
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} result={results[s.id]} onOpen={(section) => go(s, section)} onTerminal={() => openTab(s.id)} />
          ))}
        </div>
      </section>

      <aside className="flex min-h-0 flex-col gap-3.5 overflow-auto border-l border-border px-5 py-[22px]" aria-label="À traiter">
        <h2 className="text-sm font-semibold">À traiter</h2>
        {todos.length === 0 && <p className="rounded-[10px] border border-border bg-panel p-3.5 text-[13px] text-muted">Rien à signaler : tout tourne normalement.</p>}
        {todos.map((t) => (
          <div
            key={t.key}
            className={`flex flex-col gap-2 rounded-[10px] border p-3.5 text-[13px] ${
              t.tone === "danger" ? "border-danger/40 bg-danger/10" : t.tone === "warn" ? "border-warn/40 bg-warn/10" : "border-border bg-panel"
            }`}
          >
            <div className={`font-semibold ${t.tone === "danger" ? "text-danger" : t.tone === "warn" ? "text-warn" : ""}`}>{t.title}</div>
            {t.detail && <div className="text-muted">{t.detail}</div>}
            <div className="flex flex-wrap gap-2">
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => void a.run()}
                  className={`h-[30px] rounded-[7px] px-3 text-xs font-medium ${
                    a.primary ? (t.tone === "warn" ? "bg-warn text-[#1a1406]" : "bg-accent text-accent-fg") : "border border-border-strong hover:bg-hover"
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        ))}

        <h2 className="mt-2.5 text-sm font-semibold">Activité récente</h2>
        {activity.length === 0 ? (
          <p className="text-xs text-muted">Aucune action enregistrée pour l'instant.</p>
        ) : (
          <ul className="flex flex-col gap-2.5 text-xs">
            {activity.map((a, i) => (
              <li key={i} className="flex min-w-0 gap-2.5" title={`${a.action} ${a.detail}${a.error ? ` : ${a.error}` : ""}`}>
                <span className="shrink-0 font-mono text-muted/80">{new Date(a.t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                <span className={`min-w-0 truncate ${a.ok ? "text-muted" : "text-danger"}`}>
                  <span className="text-fg">{a.serverName}</span> · {actionLabel(a.action)}
                  {a.ok ? "" : " (échec)"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <button onClick={() => setSection("settings")} className="self-start text-xs text-accent hover:underline">
          Tout le journal →
        </button>
      </aside>
      </div>
    </PageLayout>
  );
}

/** Libellé lisible d'une action du journal (le détail complet reste dans l'infobulle et le journal). */
const ACTIONS: Record<string, string> = {
  "ssh.trust_host": "clé du serveur approuvée",
  "tmux.install": "installation de tmux",
  "tmux.kill": "session tmux fermée",
  "file.write": "fichier modifié",
  "nginx.write": "configuration nginx appliquée",
  "fail2ban.unban": "IP débloquée",
  "fail2ban.ignoreip": "exceptions fail2ban modifiées",
  "firewall.allow": "port ouvert dans le pare-feu",
  "firewall.delete": "règle de pare-feu supprimée",
  "ssh.key.add": "clé SSH ajoutée",
  "ssh.key.remove": "clé SSH retirée",
  "crontab.save": "crontab modifiée",
  "timer.run": "tâche planifiée lancée",
};

function actionLabel(action: string): string {
  return ACTIONS[action] ?? action.replace(/[._]/g, " ");
}

function Kpi({ label, value, total, tone }: { label: string; value: number; total?: number; tone?: "warn" | "danger" }) {
  const color = tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "";
  return (
    <div className={`rounded-[10px] border bg-panel px-4 py-3.5 ${tone === "warn" ? "border-warn/40" : tone === "danger" ? "border-danger/40" : "border-border"}`}>
      <div className={`text-xs ${tone ? color : "text-muted"}`}>{label}</div>
      <div className={`mt-1 font-mono text-[26px] font-semibold ${color}`}>
        {value}
        {total !== undefined && <span className="text-muted/70">/{total}</span>}
      </div>
    </div>
  );
}

function Bar({ label, sub, value }: { label: string; sub?: string; value: number | null }) {
  const tone = value == null ? "bg-border" : value >= 90 ? "bg-danger" : value >= 80 ? "bg-warn" : "bg-accent";
  return (
    <div className="min-w-0">
      <div className="font-mono text-[13px]">{label}</div>
      <div className="mt-1.5 h-1 rounded-sm bg-hover-strong">
        <div className={`h-1 rounded-sm ${tone}`} style={{ width: `${Math.max(1, value ?? 0)}%` }} />
      </div>
      {sub && <div className="mt-1 truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function ServerRow({
  server,
  result,
  onOpen,
  onTerminal,
}: {
  server: ServerView;
  result: Result | undefined;
  onOpen: (section: "monitoring" | "docker" | "sites" | "security") => void;
  onTerminal: () => void;
}) {
  const name = (
    <div className="min-w-0">
      <div className="flex items-center gap-2 font-semibold">
        <span className={`size-[7px] shrink-0 rounded-full ${result && result !== "loading" && result.connected ? "bg-ok" : "bg-muted/40"}`} />
        <span className="truncate">{server.name}</span>
      </div>
      <div className="mt-0.5 truncate font-mono text-xs text-muted">{server.host}</div>
    </div>
  );
  const grid = `${ROW_GRID} items-center border-b border-border/60 py-3.5 text-[13px] last:border-b-0`;

  if (!result || result === "loading" || !result.connected) {
    return (
      <div className={grid}>
        {name}
        <span className="col-span-4 text-muted">
          {!result || result === "loading" ? "Interrogation…" : `Non connecté${result.error ? ` · ${result.error.replace(/^.*?: /, "").slice(0, 90)}` : ""}`}
        </span>
        <div className="flex justify-end">
          <button onClick={onTerminal} className="h-7 rounded-[7px] border border-border-strong px-2.5 text-xs hover:bg-hover">
            Terminal
          </button>
        </div>
      </div>
    );
  }

  const m = result.metrics;
  const mem = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : null;
  const root = m?.disks.find((d) => d.mount === "/") ?? m?.disks[0];
  const disk = root && root.total ? (root.used / root.total) * 100 : null;
  return (
    <div className={grid}>
      <button className="text-left" onClick={() => onOpen("monitoring")} title={m ? `En ligne depuis ${formatDuration(m.uptimeSecs)}` : undefined}>
        {name}
      </button>
      <Bar label={m ? `${m.cpuPercent.toFixed(0)} %` : "…"} sub={m ? `charge ${m.load[0].toFixed(2)}` : undefined} value={m ? m.cpuPercent : null} />
      <Bar label={m && mem != null ? `${mem.toFixed(0)} %` : "…"} sub={m ? formatBytes(m.memUsed) : undefined} value={mem} />
      <Bar label={root && disk != null ? `${disk.toFixed(0)} %` : "…"} sub={root ? `${formatBytes(root.total - root.used)} libres` : undefined} value={disk} />
      <button className="text-left font-mono" onClick={() => onOpen("docker")} disabled={!result.docker}>
        {result.docker ? (
          <>
            {result.containersRunning}
            {result.containersStopped > 0 && <span className="text-warn"> · {result.containersStopped} arrêté(s)</span>}
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
      </button>
      <div className="flex justify-end">
        <button onClick={onTerminal} className="flex h-7 items-center gap-1.5 rounded-[7px] border border-border-strong px-2.5 text-xs hover:bg-hover">
          <SquareTerminal size={12} /> Terminal
        </button>
      </div>
    </div>
  );
}
