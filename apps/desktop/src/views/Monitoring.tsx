import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api, errorMessage, type AgentInfo } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, EmptyState } from "../components/ui";
import Overview from "./monitoring/Overview";
import Processes from "./monitoring/Processes";
import Services from "./monitoring/Services";
import Agent from "./monitoring/Agent";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "processes", label: "Processus" },
  { id: "services", label: "Services" },
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
  const [agent, setAgent] = useState<AgentInfo | null>(null);

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
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(loadAgent, 30_000);
    return () => clearInterval(id);
  }, [ready, loadAgent]);

  if (ready === false) return <EmptyState icon={<Activity size={40} />} title="Non connecté">Connexion au serveur impossible.</EmptyState>;
  if (ready === null) return <EmptyState icon={<Activity size={40} />} title="Connexion…" />;

  const alerts = agent?.status?.activeAlerts.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-border px-6 pt-4">
        <div className="pb-3">
          <h1 className="text-lg font-semibold">{server?.name}</h1>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            {agent?.running ? <Badge tone="ok">agent helmd actif</Badge> : <Badge>mode direct (sans historique)</Badge>}
            {alerts > 0 && <Badge tone="danger">{alerts} alerte(s) en cours</Badge>}
          </div>
        </div>
        <nav className="ml-auto flex self-end">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`border-b-2 px-3 pb-2.5 text-sm transition-colors ${tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-6">
        <div className={tab === "overview" ? "" : "hidden"}>
          <Overview serverId={serverId} agent={agent} visible={tab === "overview"} />
        </div>
        {tab === "processes" && <Processes serverId={serverId} visible />}
        {tab === "services" && <Services serverId={serverId} />}
        {tab === "agent" && <Agent serverId={serverId} agent={agent} reload={loadAgent} />}
      </div>
    </div>
  );
}
