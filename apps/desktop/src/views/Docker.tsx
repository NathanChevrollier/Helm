// Docker : conteneurs (avec leur tiroir de détail), projets compose, stockage et nettoyage,
// registres privés. Les actions de création (catalogue, nouveau projet) sont dans l'en-tête.
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Container as ContainerIcon, Package, Plus } from "lucide-react";
import { api, errorMessage, type DockerOverview } from "../lib/api";
import { useApp } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { Badge, Button, EmptyState, ErrorState, Loading } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import type { ComposePreset } from "../components/NewComposeProject";
import Containers from "./docker/Containers";
import Compose from "./docker/Compose";
import Storage from "./docker/Storage";

const NewComposeProject = lazy(() => import("../components/NewComposeProject"));
const AppCatalog = lazy(() => import("../components/AppCatalog"));
const DockerRegistries = lazy(() => import("../components/DockerRegistries"));

type TabId = "containers" | "compose" | "storage" | "registries";

export default function DockerView() {
  return <ServerGate title="Docker" guide="docker">{(serverId) => <Docker key={serverId} serverId={serverId} />}</ServerGate>;
}

function Docker({ serverId }: { serverId: string }) {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [tab, setTab] = useTabIntent<TabId>("docker", "containers");
  const [data, setData] = useCachedState<DockerOverview | null>(`docker:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  /** Projet pré-rempli par le catalogue, en attente de relecture. */
  const [preset, setPreset] = useState<ComposePreset | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.dockerOverview(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh((auto) => (auto ? api.dockerOverview(serverId).then(setData, () => {}) : load()), { serverId });

  const context = server && <ServerContext server={server} />;
  const layout = (children: React.ReactNode, extra?: Partial<React.ComponentProps<typeof PageLayout>>) => (
    <PageLayout title="Docker" context={context} guide={tab === "compose" ? "compose" : "docker"} {...extra}>
      {children}
    </PageLayout>
  );

  if (error && !data) return layout(<div className="p-7"><ErrorState message={error} onRetry={() => void load()} /></div>);
  if (!data) return layout(<div className="p-7"><Loading rows={8} /></div>);
  if (data.access === "unavailable") {
    return layout(
      <EmptyState icon={<ContainerIcon />} title="Docker n'est pas accessible" action={<Button onClick={() => void load()}>Réessayer</Button>}>
        Docker est absent, ou ton utilisateur n'a pas les droits. Ajoute-le au groupe <span className="font-mono">docker</span> ou renseigne le mot de passe sudo dans le profil du serveur.
        {data.version && <pre className="mt-3 text-xs whitespace-pre-wrap">{data.version}</pre>}
      </EmptyState>,
    );
  }

  // En mode sudo, les commandes lancées dans un terminal passent aussi par sudo (le mot de passe y sera demandé).
  const docker = `${data.access === "sudo" ? "sudo " : ""}${data.engine}`;
  const running = data.containers.filter((c) => c.state === "running").length;
  const stopped = data.containers.length - running;

  return (
    <>
      <PageLayout
        title="Docker"
        context={context}
        guide={tab === "compose" ? "compose" : "docker"}
        subtitle={`${data.engine === "podman" ? "Podman" : "Docker"} ${data.version}${data.access === "sudo" ? " · via sudo" : ""}`}
        status={
          <>
            <Badge tone="ok">{running} en cours</Badge>
            {stopped > 0 && <Badge tone="warn">{stopped} arrêté{stopped > 1 ? "s" : ""}</Badge>}
            {error && <Badge tone="danger" title={error}>actualisation en échec</Badge>}
          </>
        }
        tabs={[
          { id: "containers", label: "Conteneurs", count: data.containers.length },
          { id: "compose", label: "Projets compose", count: data.projects.length },
          { id: "storage", label: "Images, volumes et nettoyage" },
          { id: "registries", label: "Registres" },
        ]}
        activeTab={tab}
        onTab={setTab}
        scroll={tab !== "containers"}
        actions={
          <>
            <Button icon={<Package size={14} />} onClick={() => setCatalogOpen(true)}>
              Catalogue d'applications
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
              Nouveau projet
            </Button>
          </>
        }
      >
        {tab === "containers" && <Containers serverId={serverId} data={data} docker={docker} reload={load} />}
        {tab === "compose" && <Compose serverId={serverId} data={data} docker={docker} reload={load} onNew={() => setCreating(true)} onCatalog={() => setCatalogOpen(true)} />}
        {tab === "storage" && <Storage serverId={serverId} />}
        {tab === "registries" && (
          <div className="px-7 py-5">
            <Suspense fallback={<Loading rows={4} />}>
              <DockerRegistries serverId={serverId} />
            </Suspense>
          </div>
        )}
      </PageLayout>
      {catalogOpen && (
        <Suspense fallback={null}>
          <AppCatalog
            onClose={() => setCatalogOpen(false)}
            onDeploy={(p) => {
              // Le catalogue rend les fichiers, la fenêtre de création les montre avant écriture.
              setCatalogOpen(false);
              setPreset(p);
            }}
          />
        </Suspense>
      )}
      {(creating || preset) && (
        <Suspense fallback={null}>
          <NewComposeProject
            serverId={serverId}
            preset={preset}
            onClose={() => {
              setCreating(false);
              setPreset(null);
            }}
            onDone={() => {
              void load();
              setTab("compose");
            }}
          />
        </Suspense>
      )}
    </>
  );
}
