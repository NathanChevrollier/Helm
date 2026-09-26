// Supervision : ressources en direct ou sur l'historique de l'agent, processus, services,
// tâches planifiées, et l'agent helmd avec ses alertes.
import { useCallback, useMemo, useState } from "react";
import { api, errorMessage, type AgentInfo } from "../lib/api";
import { useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { Badge, Segmented } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import Overview, { RANGES, type RangeId } from "./monitoring/Overview";
import Processes from "./monitoring/Processes";
import Services from "./monitoring/Services";
import Agent from "./monitoring/Agent";
import ScheduleView from "./monitoring/Schedule";
import { usePolling } from "../lib/poll";
import { useCachedState } from "../lib/cache";

type TabId = "overview" | "processes" | "services" | "schedule" | "agent";

export default function MonitoringView() {
  return <ServerGate title="Supervision" guide="agent">{(serverId) => <Monitoring key={serverId} serverId={serverId} />}</ServerGate>;
}

function Monitoring({ serverId }: { serverId: string }) {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [tab, setTab] = useTabIntent<TabId>("monitoring", "overview");
  const [range, setRange] = useState<RangeId>("live");
  const [agent, setAgent] = useCachedState<AgentInfo | null>(`agent:${serverId}`, null);
  const [counts, setCounts] = useState<{ processes?: number; services?: number; jobs?: number }>({});
  // Compteurs des onglets, remontés par chaque vue (fonctions stables : pas de boucle de rendu).
  const onCount = useMemo(() => {
    const make = (k: "processes" | "services" | "jobs") => (n: number) => setCounts((c) => (c[k] === n ? c : { ...c, [k]: n }));
    return { processes: make("processes"), services: make("services"), jobs: make("jobs") };
  }, []);

  const loadAgent = useCallback(async () => {
    try {
      setAgent(await api.agentInfo(serverId));
    } catch (e) {
      setAgent({ installed: false, running: false, status: null, error: errorMessage(e) });
    }
  }, [serverId]);

  // État de l'agent et des alertes, relu toutes les 30 s.
  usePolling(loadAgent, 30_000, [loadAgent]);

  const alerts = agent?.status?.activeAlerts.length ?? 0;
  const agentOk = !!agent?.running;

  return (
    <PageLayout
      context={server && <ServerContext server={server} />}
      title="Supervision"
      guide={tab === "schedule" ? "schedule" : "agent"}
      subtitle={agentOk ? `agent helmd ${agent?.status?.version ?? ""} actif · historique 30 jours` : "mode direct : mesures en temps réel, sans historique"}
      status={alerts > 0 ? <Badge tone="danger">{alerts} alerte{alerts > 1 ? "s" : ""} en cours</Badge> : undefined}
      actions={
        tab === "overview" ? (
          <Segmented
            label="Période"
            value={range}
            onChange={setRange}
            options={RANGES.map((r) => ({
              value: r.id,
              label: r.label,
              disabled: r.secs > 0 && !agentOk,
              title: r.secs > 0 && !agentOk ? "Installe l'agent helmd (onglet Alertes et agent) pour conserver l'historique" : undefined,
            }))}
          />
        ) : undefined
      }
      tabs={[
        { id: "overview", label: "Vue d'ensemble" },
        { id: "processes", label: "Processus", count: counts.processes },
        { id: "services", label: "Services", count: counts.services },
        { id: "schedule", label: "Tâches planifiées", count: counts.jobs },
        { id: "agent", label: "Alertes et agent", count: alerts || undefined, tone: alerts ? "danger" : undefined },
      ]}
      activeTab={tab}
      onTab={setTab}
      scroll={tab !== "processes" && tab !== "services"}
    >
      <div className={tab === "overview" ? "px-7 py-5" : "hidden"}>
        <Overview serverId={serverId} agent={agent} visible={tab === "overview"} range={range} onOpenAgent={() => setTab("agent")} />
      </div>
      {tab === "processes" && <Processes serverId={serverId} visible onCount={onCount.processes} />}
      {tab === "services" && <Services serverId={serverId} onCount={onCount.services} />}
      {tab === "schedule" && (
        <div className="px-7 py-5">
          <ScheduleView serverId={serverId} onCount={onCount.jobs} />
        </div>
      )}
      {tab === "agent" && (
        <div className="px-7 py-5">
          <Agent serverId={serverId} agent={agent} reload={loadAgent} />
        </div>
      )}
    </PageLayout>
  );
}
