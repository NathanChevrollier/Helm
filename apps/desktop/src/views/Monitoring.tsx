import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api, errorMessage, type AgentInfo } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, EmptyState } from "../components/ui";
import PageLayout from "../components/PageLayout";
import Overview from "./monitoring/Overview";
import Processes from "./monitoring/Processes";
import Services from "./monitoring/Services";
import Agent from "./monitoring/Agent";
import ScheduleView from "./monitoring/Schedule";
import { usePolling } from "../lib/poll";
import { useCachedState } from "../lib/cache";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "processes", label: "Processus" },
  { id: "services", label: "Services" },
  { id: "schedule", label: "Tâches planifiées" },
  { id: "agent", label: "Agent & alertes" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function MonitoringView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<Activity size={40} />} title="Aucun serveur sélectionné" />;
  return <Monitoring key={serverId} serverId={serverId} />;
}

function Monitoring({ serverId }: { serverId: string }) {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [tab, setTab] = useState<TabId>("overview");
  const [ready, setReady] = useState<boolean | null>(null);
  const [agent, setAgent] = useCachedState<AgentInfo | null>(`agent:${serverId}`, null);

  const loadAgent = useCallback(async () => {
    try {
      setAgent(await api.agentInfo(serverId));
    } catch (e) {
      setAgent({ installed: false, running: false, status: null, error: errorMessage(e) });
    }
  }, [serverId]);

  useEffect(() => {
    void ensureConnected(serverId).then((ok) => {
      setReady(ok);
      if (ok) void loadAgent();
    });
  }, [serverId, loadAgent]);

  // Rafraîchit l'état des alertes toutes les 30 s.
  usePolling(loadAgent, 30_000, [loadAgent], !!ready);

  if (ready === false) return <EmptyState icon={<Activity size={40} />} title="Non connecté">Connexion au serveur impossible.</EmptyState>;
  if (ready === null) return <EmptyState icon={<Activity size={40} />} title="Connexion…" />;

  const alerts = agent?.status?.activeAlerts.length ?? 0;

  return (
    <PageLayout
      context={server?.name}
      title="Supervision"
      guide="agent"
      subtitle={
        <span className="flex items-center gap-2">
          {agent?.running ? <Badge tone="ok">agent helmd actif</Badge> : <Badge>mode direct (sans historique)</Badge>}
          {alerts > 0 && <Badge tone="danger">{alerts} alerte(s) en cours</Badge>}
        </span>
      }
      tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
      activeTab={tab}
      onTab={setTab}
    >
      <div className="overflow-x-hidden p-6">
        <div className={tab === "overview" ? "" : "hidden"}>
          <Overview serverId={serverId} agent={agent} visible={tab === "overview"} />
        </div>
        {tab === "processes" && <Processes serverId={serverId} visible />}
        {tab === "services" && <Services serverId={serverId} />}
        {tab === "schedule" && <ScheduleView serverId={serverId} />}
        {tab === "agent" && <Agent serverId={serverId} agent={agent} reload={loadAgent} />}
      </div>
    </PageLayout>
  );
}
