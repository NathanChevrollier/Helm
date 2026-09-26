// Tiroir de détail d'un conteneur : ce qu'on cherche d'habitude en enchaînant `docker ps`,
// `docker inspect` et `docker logs` — image, santé, ports, variables, montages, derniers journaux.
import { useEffect, useMemo, useState } from "react";
import { Cable, Eye, EyeOff, Lock, Pause, Play, RotateCw, ScrollText, Square, SquareTerminal, Trash2 } from "lucide-react";
import { api, errorMessage, type ComposeProject, type Container, type ContainerStats } from "../../lib/api";
import { Badge, Button, CodeBlock, Drawer, ErrorState, KeyValue, Loading } from "../../components/ui";
import { stateTone } from "./shared";

type Tab = "summary" | "env" | "mounts" | "inspect";

interface Inspect {
  Created?: string;
  RestartCount?: number;
  Config?: { Env?: string[]; Cmd?: string[] | null; Entrypoint?: string[] | null; WorkingDir?: string; User?: string };
  HostConfig?: { RestartPolicy?: { Name?: string } };
  State?: { Health?: { Status?: string }; StartedAt?: string; ExitCode?: number };
  Mounts?: { Type?: string; Source?: string; Destination?: string; Name?: string; RW?: boolean }[];
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

/** Variables dont la valeur a l'air d'un secret : masquées par défaut. */
const SECRET = /pass|secret|token|key|pwd|credential|auth/i;

export default function ContainerDrawer({
  serverId,
  container: c,
  stats,
  project,
  onClose,
  onAction,
  onShell,
  onLogs,
  onTunnel,
  onRestrict,
}: {
  serverId: string;
  container: Container;
  stats?: ContainerStats;
  project?: ComposeProject;
  onClose: () => void;
  onAction: (action: string) => void;
  onShell: () => void;
  onLogs: () => void;
  onTunnel: (port: number) => void;
  onRestrict: (port: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  const [raw, setRaw] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRaw(null);
    setLogs(null);
    api.dockerInspect(serverId, c.id).then(
      (j) => !cancelled && setRaw(j),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    api.dockerLogs(serverId, c.id, 40).then(
      (l) => !cancelled && setLogs(l),
      () => !cancelled && setLogs(""),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, c.id]);

  const info = useMemo<Inspect | null>(() => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed[0] : parsed) as Inspect;
    } catch {
      return null;
    }
  }, [raw]);

  const running = c.state === "running";
  const env = info?.Config?.Env ?? [];
  const mounts = info?.Mounts ?? [];
  const networks = Object.entries(info?.NetworkSettings?.Networks ?? {});
  const health = info?.State?.Health?.Status;

  return (
    <Drawer
      modal={false}
      width={520}
      title={
        <span className="flex items-center gap-2">
          <span className={`size-2.5 rounded-full ${running ? "bg-ok" : c.state === "paused" ? "bg-warn" : "bg-muted/50"}`} />
          {c.name}
        </span>
      }
      subtitle={c.status}
      onClose={onClose}
      actions={
        <>
          {running ? (
            <>
              <Button size="sm" icon={<RotateCw size={13} />} onClick={() => onAction("restart")}>
                Redémarrer
              </Button>
              <Button size="sm" icon={<Square size={12} />} onClick={() => onAction("stop")}>
                Arrêter
              </Button>
              <Button size="sm" icon={<Pause size={13} />} onClick={() => onAction("pause")}>
                Pause
              </Button>
              <Button size="sm" icon={<SquareTerminal size={13} />} onClick={onShell}>
                Shell
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon={<Play size={13} />} onClick={() => onAction(c.state === "paused" ? "unpause" : "start")}>
              {c.state === "paused" ? "Reprendre" : "Démarrer"}
            </Button>
          )}
          <Button size="sm" icon={<ScrollText size={13} />} onClick={onLogs}>
            Logs en direct
          </Button>
          {!running && (
            <Button size="sm" variant="danger" className="ml-auto" icon={<Trash2 size={13} />} onClick={() => onAction("remove")}>
              Supprimer
            </Button>
          )}
        </>
      }
      tabs={
        <nav className="flex shrink-0 gap-1 border-b border-border px-3" role="tablist">
          {(
            [
              ["summary", "Résumé"],
              ["env", `Variables${env.length ? ` · ${env.length}` : ""}`],
              ["mounts", `Montages${mounts.length ? ` · ${mounts.length}` : ""}`],
              ["inspect", "Inspect"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`h-9 border-b-2 px-2.5 text-[12.5px] ${tab === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </nav>
      }
    >
      {error && <ErrorState message={error} />}
      {tab === "summary" && (
        <div className="flex flex-col gap-5">
          <KeyValue
            labelWidth={120}
            items={[
              ["Image", <span className="font-mono text-xs">{c.image}</span>],
              ...(c.composeProject ? ([["Projet", `${c.composeProject} · service ${c.composeService ?? "?"}`]] as [React.ReactNode, React.ReactNode][]) : []),
              ["État", <Badge tone={stateTone(c.state)}>{c.state}</Badge>],
              ...(health ? ([["Santé", <Badge tone={health === "healthy" ? "ok" : health === "starting" ? "warn" : "danger"}>{health}</Badge>]] as [React.ReactNode, React.ReactNode][]) : []),
              ["Créé", info?.Created ? new Date(info.Created).toLocaleString("fr-FR") : c.createdAt],
              ["Redémarrages", info ? `${info.RestartCount ?? 0} · politique ${info.HostConfig?.RestartPolicy?.Name || "no"}` : "…"],
              ...(stats && running ? ([["Ressources", `CPU ${stats.cpu.toFixed(1)} % · mémoire ${stats.memUsage} · ${stats.pids} processus`]] as [React.ReactNode, React.ReactNode][]) : []),
              ...(networks.length ? ([["Réseaux", networks.map(([n, v]) => `${n}${v.IPAddress ? ` (${v.IPAddress})` : ""}`).join(", ")]] as [React.ReactNode, React.ReactNode][]) : []),
            ]}
          />
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-muted">Ports publiés</h3>
            {c.ports.length === 0 && <p className="text-[13px] text-faint">Aucun port publié sur le serveur.</p>}
            {c.ports.map((p) => {
              const exposed = p.hostIp === "0.0.0.0" || p.hostIp === "::";
              return (
                <div
                  key={`${p.hostIp}:${p.hostPort}/${p.protocol}`}
                  className={`flex flex-wrap items-center gap-2.5 rounded-xl border px-3 py-2 ${exposed ? "border-warn/35 bg-warn/8" : "border-border bg-subtle"}`}
                >
                  <span className="font-mono text-xs">
                    {p.hostIp}:{p.hostPort} → {p.containerPort}/{p.protocol}
                  </span>
                  {exposed ? <Badge tone="warn">exposé</Badge> : <Badge tone="ok">local seulement</Badge>}
                  <span className="flex-1" />
                  {p.protocol === "tcp" && (
                    <Button size="sm" icon={<Cable size={13} />} onClick={() => onTunnel(p.hostPort)}>
                      Tunnel
                    </Button>
                  )}
                  {exposed && project && (
                    <Button size="sm" icon={<Lock size={13} />} onClick={() => onRestrict(p.hostPort)}>
                      Restreindre à 127.0.0.1
                    </Button>
                  )}
                </div>
              );
            })}
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-muted">Derniers journaux</h3>
            {logs === null ? (
              <Loading rows={4} />
            ) : (
              <pre className="max-h-64 overflow-auto rounded-xl border border-border bg-term p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/85 select-text">
                {logs.trim() || "Aucune sortie récente."}
              </pre>
            )}
          </section>
        </div>
      )}
      {tab === "env" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">Les valeurs qui ressemblent à des secrets sont masquées.</p>
            <Button size="sm" variant="ghost" icon={reveal ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setReveal(!reveal)}>
              {reveal ? "Masquer" : "Tout afficher"}
            </Button>
          </div>
          {!info ? (
            <Loading rows={6} />
          ) : env.length === 0 ? (
            <p className="text-[13px] text-faint">Aucune variable.</p>
          ) : (
            <dl className="flex flex-col divide-y divide-line rounded-xl border border-border">
              {env.map((line) => {
                const i = line.indexOf("=");
                const k = i < 0 ? line : line.slice(0, i);
                const v = i < 0 ? "" : line.slice(i + 1);
                const hide = !reveal && SECRET.test(k) && v.length > 0;
                return (
                  <div key={line} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] gap-3 px-3 py-1.5 font-mono text-[11.5px]">
                    <dt className="truncate text-muted" title={k}>
                      {k}
                    </dt>
                    <dd className="break-all select-text">{hide ? "••••••••" : v}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </div>
      )}
      {tab === "mounts" && (
        <div className="flex flex-col gap-2">
          {!info ? (
            <Loading rows={4} />
          ) : mounts.length === 0 ? (
            <p className="text-[13px] text-faint">Aucun montage.</p>
          ) : (
            mounts.map((m, i) => (
              <div key={i} className="flex flex-col gap-1 rounded-xl border border-border bg-subtle px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge>{m.Type}</Badge>
                  {m.RW === false && <Badge tone="accent">lecture seule</Badge>}
                  <span className="font-mono">{m.Destination}</span>
                </div>
                <div className="truncate font-mono text-faint" title={m.Source}>
                  {m.Name ? `${m.Name} · ` : ""}
                  {m.Source}
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {tab === "inspect" && (raw ? <CodeBlock code={raw} className="max-h-[70vh] overflow-auto" /> : <Loading rows={10} />)}
    </Drawer>
  );
}
