import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Box, ChevronDown, ChevronRight, Container as ContainerIcon, FileCode2, FileSearch, Folder, FolderInput, FolderOpen, FolderPlus, Plus,
  Layers, MoreHorizontal, Pause, Play, RefreshCw, RotateCw, ScrollText,
  Cable, Database, GitBranch, Lock, Package, Rocket, Square, SquareTerminal, Trash2, UploadCloud,
} from "lucide-react";
import {
  api, errorMessage, formatBytes, shellQuote, type ComposeProject, type Container, type ContainerStats, type DockerDiskUsage,
  type DockerImage, type DockerOverview, type DockerVolume,
} from "../lib/api";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, Input, Modal } from "../components/ui";
import PageLayout from "../components/PageLayout";
import { deployProject, GithubDeployDialog, RestrictPortDialog, tunnelTo } from "../components/DockerExtras";
import { usePolling } from "../lib/poll";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { askFolderName, toggleCollapsed } from "../components/Folders";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { startDrag } from "../lib/drag";
import type { ComposePreset } from "../components/NewComposeProject";

const FileEditor = lazy(() => import("../components/FileEditor"));
const NewComposeProject = lazy(() => import("../components/NewComposeProject"));
const AppCatalog = lazy(() => import("../components/AppCatalog"));
const DockerRegistries = lazy(() => import("../components/DockerRegistries"));

const TABS = [
  { id: "containers", label: "Conteneurs" },
  { id: "compose", label: "Projets compose" },
  { id: "storage", label: "Images, volumes & nettoyage" },
  { id: "registries", label: "Registres" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function DockerView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<ContainerIcon size={40} />} title="Aucun serveur sélectionné" />;
  return <Docker key={serverId} serverId={serverId} />;
}

/**
 * Dossiers de conteneurs d'un serveur : ceux créés (même vides) et ceux déjà attribués.
 * Le classement est propre à ce PC (il ne change rien sur le serveur).
 */
function useContainerFolders(serverId: string) {
  const assigned = useApp((s) => s.folders.containers[serverId]) ?? {};
  const created = useApp((s) => s.folders.containerFolders[serverId]) ?? [];
  const setFolders = useApp((s) => s.setFolders);
  const names = [...new Set([...created, ...Object.values(assigned)])].filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));

  const move = (containers: string[], folder: string | null) =>
    setFolders((f) => {
      const map = { ...(f.containers[serverId] ?? {}) };
      for (const name of containers) {
        if (folder) map[name] = folder;
        else delete map[name];
      }
      return { ...f, containers: { ...f.containers, [serverId]: map }, containerFolders: folder ? { ...f.containerFolders, [serverId]: [...new Set([...created, folder])] } : f.containerFolders };
    });
  const create = (name: string) => setFolders((f) => ({ ...f, containerFolders: { ...f.containerFolders, [serverId]: [...new Set([...created, name])] } }));
  const rename = (from: string, to: string) =>
    setFolders((f) => {
      const map = Object.fromEntries(Object.entries(f.containers[serverId] ?? {}).map(([k, v]) => [k, v === from ? to : v]));
      const list = [...new Set([...(f.containerFolders[serverId] ?? []).filter((x) => x !== from), to])];
      return { ...f, containers: { ...f.containers, [serverId]: map }, containerFolders: { ...f.containerFolders, [serverId]: list } };
    });
  const remove = (name: string) =>
    setFolders((f) => {
      const map = Object.fromEntries(Object.entries(f.containers[serverId] ?? {}).filter(([, v]) => v !== name));
      return { ...f, containers: { ...f.containers, [serverId]: map }, containerFolders: { ...f.containerFolders, [serverId]: (f.containerFolders[serverId] ?? []).filter((x) => x !== name) } };
    });
  return { names, folderOf: (container: string) => assigned[container] ?? "", move, create, rename, remove };
}

function stateTone(state: string) {
  return state === "running" ? "ok" : state === "restarting" || state === "paused" ? "warn" : state === "dead" ? "danger" : "muted";
}

function Docker({ serverId }: { serverId: string }) {
  const { notify } = useAppPick("notify");
  const [tab, setTab] = useState<TabId>("containers");
  const [data, setData] = useCachedState<DockerOverview | null>(`docker:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!(await ensureConnected(serverId))) {
        setError("Non connecté.");
        return;
      }
      setData(await api.dockerOverview(serverId));
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
  useAutoRefresh((auto) => (auto ? api.dockerOverview(serverId).then(setData, () => {}) : load()), { serverId });

  if (error) return <EmptyState icon={<ContainerIcon size={40} />} title="Docker indisponible">{error}</EmptyState>;
  if (!data) return <EmptyState icon={<ContainerIcon size={40} />} title="Chargement…" />;
  if (data.access === "unavailable") {
    return (
      <EmptyState icon={<ContainerIcon size={40} />} title="Docker n'est pas accessible">
        Docker est absent, ou ton utilisateur n'a pas les droits. Ajoute-le au groupe <span className="font-mono">docker</span> ou renseigne le mot de passe sudo dans le profil du serveur.
        {data.version && <pre className="mt-3 text-xs whitespace-pre-wrap">{data.version}</pre>}
      </EmptyState>
    );
  }

  // En mode sudo, les commandes lancées dans un terminal passent aussi par sudo (le mot de passe y sera demandé).
  const docker = `${data.access === "sudo" ? "sudo " : ""}${data.engine}`;
  const running = data.containers.filter((c) => c.state === "running").length;

  return (
    <PageLayout
      title="Docker"
      guide={tab === "compose" ? "compose" : "docker"}
      subtitle={
        <span className="flex items-center gap-2">
          <Badge>v{data.version}</Badge>
          <Badge tone="ok">{running} en cours</Badge>
          <Badge>{data.containers.length - running} arrêté(s)</Badge>
          {data.access === "sudo" && <Badge tone="warn">via sudo</Badge>}
        </span>
      }
      tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
      activeTab={tab}
      onTab={setTab}
      actions={
        <IconButton title="Actualiser" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      }
    >
      <div className="p-6">
        {tab === "containers" && <Containers serverId={serverId} data={data} docker={docker} reload={load} />}
        {tab === "compose" && <Compose serverId={serverId} data={data} docker={docker} reload={load} />}
        {tab === "storage" && <Storage serverId={serverId} notify={notify} />}
        {tab === "registries" && (
          <Suspense fallback={<p className="text-sm text-muted">Chargement…</p>}>
            <DockerRegistries serverId={serverId} />
          </Suspense>
        )}
      </div>
    </PageLayout>
  );
}

function Containers({ serverId, data, docker, reload }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void> }) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
  const [stats, setStats] = useCachedState<Record<string, ContainerStats>>(`dockerStats:${serverId}`, {});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [inspect, setInspect] = useState<{ name: string; json: string } | null>(null);
  const [restrict, setRestrict] = useState<{ project: ComposeProject; port: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; container: string } | null>(null);
  const collapsed = useApp((s) => s.folders.collapsed);
  const folders = useContainerFolders(serverId);

  // `docker stats` prend souvent 2 à 3 s : le hook évite d'empiler les appels.
  usePolling(
    () =>
      api
        .dockerStats(serverId)
        .then((list) => setStats(Object.fromEntries(list.map((s) => [s.id, s]))))
        .catch(() => {}),
    5000,
    [serverId],
  );

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    return data.containers.filter((c) => !f || c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || (c.composeProject ?? "").includes(f));
  }, [data, filter]);

  const act = async (c: Container, action: string, label: string, confirm?: { body: string; danger?: boolean }) => {
    if (confirm) {
      const ok = await ask({ title: `${label} ${c.name} ?`, body: confirm.body, confirmLabel: label, danger: confirm.danger });
      if (!ok) return;
    }
    setBusy(c.id);
    try {
      await api.dockerAction(serverId, c.id, action);
      notify(`${c.name} : ${label.toLowerCase()} OK`, "success");
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  // Un dossier par section, plus les conteneurs hors dossier à la fin.
  const sections = [...folders.names, ""].map((name) => ({ name, items: rows.filter((c) => folders.folderOf(c.name) === name) })).filter((s) => s.name || s.items.length || !folders.names.length);

  const moveMenu = (container: string): MenuItem[] => [
    ...folders.names.filter((f) => f !== folders.folderOf(container)).map((f) => ({ label: f, icon: <FolderInput size={14} />, onClick: () => folders.move([container], f) })),
    ...(folders.folderOf(container) ? [{ label: "Sortir du dossier", onClick: () => folders.move([container], null) }] : []),
    {
      label: "Nouveau dossier…",
      icon: <FolderPlus size={14} />,
      onClick: async () => {
        const name = await askFolderName("Nouveau dossier de conteneurs");
        if (name) folders.move([container], name);
      },
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input className="!w-72" placeholder="Filtrer (nom, image, projet)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button
          size="sm"
          icon={<FolderPlus size={13} />}
          onClick={async () => {
            const name = await askFolderName("Nouveau dossier de conteneurs");
            if (name) folders.create(name);
          }}
        >
          Nouveau dossier
        </Button>
        <span className="text-xs text-muted">Glisse un conteneur sur un dossier pour l'y ranger (classement local, rien ne change sur le serveur).</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Conteneur</th>
              <th className="px-3 py-2 font-medium">Image</th>
              <th className="px-3 py-2 font-medium">État</th>
              <th className="px-3 py-2 font-medium">Ports publiés</th>
              <th className="px-3 py-2 text-right font-medium">CPU</th>
              <th className="px-3 py-2 text-right font-medium">Mémoire</th>
              <th className="w-56" />
            </tr>
          </thead>
          {sections.map((section) => {
            const key = `docker:${serverId}:${section.name}`;
            const folded = collapsed.includes(key);
            return (
          <tbody key={section.name || "-"}>
            {(folders.names.length > 0 || section.name) && (
              <tr className="border-t border-border/50 bg-hover-soft" data-drop={section.name}>
                <td colSpan={7} className="px-2 py-1.5">
                  <span className="flex items-center gap-2 text-xs">
                    <button className="flex items-center gap-2" onClick={() => toggleCollapsed(key)}>
                      {folded ? <ChevronRight size={13} className="text-muted" /> : <ChevronDown size={13} className="text-muted" />}
                      {section.name ? <Folder size={13} className="text-accent" /> : <FolderOpen size={13} className="text-muted" />}
                      <span className={section.name ? "font-medium" : "text-muted"}>{section.name || "Sans dossier"}</span>
                      <span className="text-muted">{section.items.length}</span>
                    </button>
                    {section.name && (
                      <span className="flex gap-1 text-muted">
                        <button
                          className="hover:text-fg"
                          title="Renommer"
                          onClick={async () => {
                            const next = await askFolderName(`Renommer « ${section.name} »`, section.name);
                            if (next && next !== section.name) folders.rename(section.name, next);
                          }}
                        >
                          renommer
                        </button>
                        <button className="hover:text-fg" title="Supprimer le dossier" onClick={() => folders.remove(section.name)}>
                          supprimer
                        </button>
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            )}
            {!folded && section.items.map((c) => {
              const s = stats[c.id];
              const isRunning = c.state === "running";
              return (
                <tr
                  key={c.id}
                  className="group border-t border-border/50 hover:bg-hover-soft"
                  onMouseDown={(e) => startDrag(e, c.name, (folder) => folders.move([c.name], folder || null))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, container: c.name });
                  }}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.name}</div>
                    {c.composeProject && <div className="text-xs text-muted">{c.composeProject} · {c.composeService}</div>}
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-xs text-muted" title={c.image}>{c.image}</td>
                  <td className="px-3 py-2">
                    <Badge tone={stateTone(c.state)}>{c.state}</Badge>
                    <div className="mt-0.5 text-[11px] text-muted">{c.status}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {c.ports.length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      c.ports.map((p) => {
                        const project = data.projects.find((x) => x.name === c.composeProject);
                        return (
                          <div key={`${p.hostPort}/${p.protocol}`} className="group/port flex items-center gap-1">
                            <span title={p.hostIp === "0.0.0.0" ? "Exposé sur toutes les interfaces (accessible depuis Internet si le pare-feu le permet)" : "Accessible uniquement en local"}>
                              <span className={p.hostIp === "0.0.0.0" ? "text-warn" : "text-muted"}>{p.hostIp === "0.0.0.0" ? "*" : p.hostIp}</span>:{p.hostPort} → {p.containerPort}
                            </span>
                            {p.protocol === "tcp" && (
                              <button className="invisible rounded p-0.5 text-muted group-hover/port:visible hover:text-fg" title="Accéder depuis mon PC (tunnel)" onClick={() => void tunnelTo(serverId, c, p.hostPort)}>
                                <Cable size={12} />
                              </button>
                            )}
                            {p.hostIp === "0.0.0.0" && project && (
                              <button className="rounded p-0.5 text-warn hover:text-fg" title="Restreindre au serveur (127.0.0.1)" onClick={() => setRestrict({ project, port: p.hostPort })}>
                                <Lock size={12} />
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">{s && isRunning ? `${s.cpu.toFixed(1)} %` : ""}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums" title={s?.memUsage}>{s && isRunning ? s.memUsage.split(" / ")[0] : ""}</td>
                  <td className="px-2 py-1 text-right">
                    <span className={`inline-flex ${busy === c.id ? "" : "opacity-60 group-hover:opacity-100"}`}>
                      {isRunning ? (
                        <>
                          <IconButton title="Redémarrer" disabled={!!busy} onClick={() => void act(c, "restart", "Redémarrer")}>
                            <RotateCw size={14} className={busy === c.id ? "animate-spin" : ""} />
                          </IconButton>
                          <IconButton title="Arrêter" disabled={!!busy} onClick={() => void act(c, "stop", "Arrêter", { body: "Le service rendu par ce conteneur sera interrompu." })}>
                            <Square size={13} />
                          </IconButton>
                          <IconButton title="Mettre en pause" disabled={!!busy} onClick={() => void act(c, "pause", "Mettre en pause")}>
                            <Pause size={14} />
                          </IconButton>
                          <IconButton
                            title="Shell dans le conteneur"
                            onClick={() => openTab(serverId, { title: `${c.name} (shell)`, command: `${docker} exec -it ${shellQuote(c.id)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'` })}
                          >
                            <SquareTerminal size={14} />
                          </IconButton>
                        </>
                      ) : c.state === "paused" ? (
                        <IconButton title="Reprendre" disabled={!!busy} onClick={() => void act(c, "unpause", "Reprendre")}>
                          <Play size={14} />
                        </IconButton>
                      ) : (
                        <IconButton title="Démarrer" disabled={!!busy} onClick={() => void act(c, "start", "Démarrer")}>
                          <Play size={14} />
                        </IconButton>
                      )}
                      <IconButton title="Logs en direct" onClick={() => openTab(serverId, { title: `${c.name} (logs)`, command: `${docker} logs -f --tail 300 ${shellQuote(c.id)}` })}>
                        <ScrollText size={14} />
                      </IconButton>
                      <IconButton
                        title="Inspecter"
                        onClick={async () => {
                          try {
                            setInspect({ name: c.name, json: await api.dockerInspect(serverId, c.id) });
                          } catch (e) {
                            notify(errorMessage(e), "error");
                          }
                        }}
                      >
                        <FileSearch size={14} />
                      </IconButton>
                      {!isRunning && (
                        <IconButton title="Supprimer" disabled={!!busy} onClick={() => void act(c, "remove", "Supprimer", { body: "Le conteneur sera supprimé. Ses volumes nommés sont conservés.", danger: true })}>
                          <Trash2 size={14} />
                        </IconButton>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
            );
          })}
        </table>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={moveMenu(menu.container)} onClose={() => setMenu(null)} />}
      {restrict && (
        <RestrictPortDialog
          serverId={serverId}
          project={restrict.project}
          port={restrict.port}
          onClose={() => setRestrict(null)}
          onDone={() => {
            setRestrict(null);
            void reload();
          }}
        />
      )}
      {inspect && (
        <Modal title={`Inspection de ${inspect.name}`} width="max-w-5xl" onClose={() => setInspect(null)}>
          <pre className="h-[65vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs select-text">{inspect.json}</pre>
        </Modal>
      )}
    </div>
  );
}

function Compose({ serverId, data, docker, reload }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void> }) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [github, setGithub] = useState<ComposeProject | null>(null);
  const [creating, setCreating] = useState(false);
  /** Projet pré-rempli par le catalogue, en attente de relecture. */
  const [preset, setPreset] = useState<ComposePreset | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ project: ComposeProject; file: string; x: number; y: number } | null>(null);

  const newProjectButton = (
    <>
      <Button icon={<Package size={13} />} onClick={() => setCatalogOpen(true)}>
        Catalogue
      </Button>
      <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
        Nouveau projet
      </Button>
    </>
  );
  const creator = (
    <>
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
            onDone={() => void reload()}
          />
        </Suspense>
      )}
    </>
  );

  if (data.projects.length === 0) {
    return (
      <>
        <EmptyState icon={<Layers size={36} />} title="Aucun projet docker compose">
          Les projets lancés avec docker compose apparaîtront ici.
          <div className="mt-3 flex justify-center">{newProjectButton}</div>
        </EmptyState>
        {creator}
      </>
    );
  }

  const act = async (p: ComposeProject, action: string, label: string, danger?: string) => {
    if (danger) {
      const ok = await ask({ title: `${label} « ${p.name} » ?`, body: danger, confirmLabel: label, danger: true });
      if (!ok) return;
    }
    setBusy(`${p.name}:${action}`);
    try {
      const out = await api.composeAction(serverId, p, action);
      setOutput({ title: `${p.name} — ${label}`, text: out || "Terminé." });
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const containersOf = (name: string) => data.containers.filter((c) => c.composeProject === name);

  return (
    <>
    <div className="mb-4 flex items-center justify-between">
      <span className="text-sm text-muted">{data.projects.length} projet(s) compose sur ce serveur.</span>
      {newProjectButton}
    </div>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-4">
      {data.projects.map((p) => {
        const file = p.configFiles.split(",")[0];
        const b = (a: string) => busy === `${p.name}:${a}`;
        const services = containersOf(p.name);
        const enMarche = services.filter((c) => c.state === "running").length;
        const arrete = services.length > 0 && enMarche === 0;
        return (
          <div key={p.name} className="flex flex-col overflow-hidden rounded-lg border border-border bg-panel">
            <div className="flex items-start gap-2 border-b border-border px-4 py-3">
              <Layers size={15} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="truncate font-mono text-xs text-muted" title={p.configFiles}>
                  {file}
                </div>
              </div>
              <Badge tone={arrete ? "muted" : enMarche === services.length ? "ok" : "warn"}>
                {services.length > 0 ? `${enMarche}/${services.length} en cours` : p.status}
              </Badge>
            </div>

            {/* Les services en liste plutôt qu'en pastilles : on y lit l'état, l'image et les ports. */}
            <ul className="flex flex-col divide-y divide-border/60">
              {services.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                  <span className={`size-1.5 shrink-0 rounded-full ${c.state === "running" ? "bg-ok" : "bg-muted"}`} />
                  <span className="min-w-0 flex-1 truncate">{c.composeService ?? c.name}</span>
                  <span className="hidden truncate font-mono text-[11px] text-muted sm:block">{c.image.split("@")[0]}</span>
                  {c.ports.length > 0 && (
                    <span className="shrink-0 font-mono text-[11px] text-muted">{c.ports.map((x) => `${x.hostPort}→${x.containerPort}`).join(" ")}</span>
                  )}
                </li>
              ))}
              {services.length === 0 && <li className="px-4 py-2 text-[13px] text-muted">Aucun conteneur en cours pour ce projet.</li>}
            </ul>

            {/* Deux actions courantes en clair, le reste rangé derrière « … ». */}
            <div className="mt-auto flex items-center gap-1.5 border-t border-border px-4 py-2.5">
              <Button size="sm" variant="primary" icon={<Rocket size={12} />} onClick={() => void deployProject(serverId, p)}>
                Déployer
              </Button>
              {arrete ? (
                <Button size="sm" icon={<Play size={12} />} loading={b("up")} onClick={() => void act(p, "up", "Démarrer (up -d)")}>
                  Démarrer
                </Button>
              ) : (
                <Button size="sm" icon={<RotateCw size={12} />} loading={b("restart")} onClick={() => void act(p, "restart", "Redémarrer")}>
                  Redémarrer
                </Button>
              )}
              <Button
                size="sm"
                icon={<ScrollText size={12} />}
                onClick={async () =>
                  openTab(serverId, {
                    title: `${p.name} (logs)`,
                    command: (await api.composeCommand(p, "logs -f --tail 200")).replace(/^docker /, `${docker} `),
                  })
                }
              >
                Logs
              </Button>
              <IconButton
                title="Autres actions"
                className="ml-auto"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setProjectMenu({ project: p, file, x: Math.max(8, r.right - 240), y: r.bottom + 4 });
                }}
              >
                <MoreHorizontal size={16} />
              </IconButton>
            </div>
          </div>
        );
      })}
      {output && (
        <Modal title={output.title} width="max-w-3xl" onClose={() => setOutput(null)}>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{output.text}</pre>
        </Modal>
      )}
      {editing && (
        <Suspense fallback={null}>
          <FileEditor serverId={serverId} path={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
      {github && <GithubDeployDialog serverId={serverId} project={github} onClose={() => setGithub(null)} />}
      {projectMenu && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          onClose={() => setProjectMenu(null)}
          items={[
            {
              label: "Mettre à jour (pull + up)",
              icon: <UploadCloud size={14} />,
              onClick: () => void act(projectMenu.project, "update", "Mettre à jour (pull + up)"),
            },
            {
              label: "Reconstruire complètement (down + pull + build + up)",
              icon: <RotateCw size={14} />,
              danger: true,
              onClick: () =>
                void act(
                  projectMenu.project,
                  "rebuild",
                  "Reconstruire complètement",
                  "Le projet sera arrêté, les images seront récupérées, les services seront reconstruits puis redémarrés. Les volumes nommés sont conservés, mais le service sera indisponible pendant l'opération.",
                ),
            },
            { label: "Redémarrer", icon: <RotateCw size={14} />, onClick: () => void act(projectMenu.project, "restart", "Redémarrer") },
            "separator",
            { label: "Éditer le compose.yml", icon: <FileCode2 size={14} />, onClick: () => setEditing(projectMenu.file) },
            { label: "Déploiement depuis GitHub…", icon: <GitBranch size={14} />, onClick: () => setGithub(projectMenu.project) },
            "separator",
            {
              label: "Arrêter et supprimer (down)",
              icon: <Square size={14} />,
              danger: true,
              onClick: () =>
                void act(
                  projectMenu.project,
                  "down",
                  "Arrêter et supprimer (down)",
                  "Les conteneurs du projet seront arrêtés et supprimés (les volumes nommés sont conservés). Le site sera indisponible.",
                ),
            },
          ]}
        />
      )}
    </div>
    {creator}
    </>
  );
}

function Storage({ serverId, notify }: { serverId: string; notify: (m: string, k?: "info" | "error" | "success") => void }) {
  const ask = useApp((s) => s.ask);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [usage, setUsage] = useState<DockerDiskUsage[]>([]);
  const [volumes, setVolumes] = useState<DockerVolume[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.dockerStorage(serverId);
      setImages(s.images);
      setUsage(s.usage);
      // Les volumes arrivent à part : leur taille est mesurée avec `du`, ce qui peut prendre
      // quelques secondes et n'a pas à retarder l'affichage des images.
      api.dockerVolumes(serverId).then(setVolumes, () => setVolumes([]));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [serverId, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const prune = async (what: string, label: string, body: string) => {
    const ok = await ask({ title: label, body, confirmLabel: "Nettoyer", danger: true });
    if (!ok) return;
    setBusy(what);
    try {
      const out = await api.dockerPrune(serverId, what);
      notify(out.trim().split("\n").pop() || "Nettoyage terminé", "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const labels: Record<string, string> = { Images: "Images", Containers: "Conteneurs", "Local Volumes": "Volumes", "Build Cache": "Cache de build" };
  /** Volumes qu'aucun conteneur n'utilise : ce sont eux que le nettoyage supprimerait. */
  const orphans = (volumes ?? []).filter((v) => v.orphan);
  const reclaimable = orphans.reduce((n, v) => n + v.size, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {usage.map((u) => (
          <div key={u.kind} className="rounded-lg border border-border bg-panel px-4 py-3">
            <div className="text-xs text-muted">{labels[u.kind] ?? u.kind}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{u.size}</div>
            <div className="text-xs text-muted">{u.totalCount} au total · {u.active} utilisé(s) · récupérable : {u.reclaimable}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={busy === "images"} onClick={() => void prune("images", "Supprimer les images orphelines ?", "Supprime les images sans tag et inutilisées (restes d'anciennes versions). Sans risque pour les conteneurs existants.")}>
          Images orphelines
        </Button>
        <Button size="sm" loading={busy === "build-cache"} onClick={() => void prune("build-cache", "Vider le cache de build ?", "Les prochains builds seront plus lents, le temps de reconstruire le cache.")}>
          Cache de build
        </Button>
        <Button size="sm" loading={busy === "containers"} onClick={() => void prune("containers", "Supprimer les conteneurs arrêtés ?", "Tous les conteneurs arrêtés seront supprimés définitivement.")}>
          Conteneurs arrêtés
        </Button>
        <Button size="sm" variant="danger" loading={busy === "images-all"} onClick={() => void prune("images-all", "Supprimer toutes les images inutilisées ?", "Supprime toutes les images qui ne sont utilisées par aucun conteneur, même taguées. Elles devront être re-téléchargées si besoin.")}>
          Toutes les images inutilisées
        </Button>
        {orphans.length > 0 && (
          <Button
            size="sm"
            variant="danger"
            loading={busy === "volumes"}
            onClick={() =>
              void prune(
                "volumes",
                `Supprimer ${orphans.length} volume(s) orphelin(s) ?`,
                `Environ ${formatBytes(reclaimable)} seront libérés. Ces volumes ne sont utilisés par aucun conteneur, même arrêté — mais leurs données seront perdues définitivement :\n\n${orphans
                  .map((v) => `· ${v.name} (${formatBytes(v.size)})`)
                  .join("\n")}`,
              )
            }
          >
            Volumes orphelins ({formatBytes(reclaimable)})
          </Button>
        )}
      </div>

      <VolumesTable
        volumes={volumes}
        onRemove={async (v) => {
          const ok = await ask({
            title: `Supprimer le volume ${v.name} ?`,
            body: `Ses données (${formatBytes(v.size)}) seront perdues définitivement. Docker refuse si un conteneur l'utilise encore.`,
            confirmLabel: "Supprimer",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.dockerRemoveVolume(serverId, v.name);
            notify(`Volume ${v.name} supprimé.`, "success");
            await load();
          } catch (e) {
            notify(errorMessage(e), "error");
          }
        }}
      />
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Image</th>
              <th className="px-3 py-2 font-medium">Tag</th>
              <th className="px-3 py-2 font-medium">ID</th>
              <th className="px-3 py-2 text-right font-medium">Taille</th>
              <th className="px-3 py-2 font-medium">Créée</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {images.map((i) => (
              <tr key={i.id + i.tag} className="group border-t border-border/50 hover:bg-hover-soft">
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-2"><Box size={14} className="text-muted" />{i.repository}</span>
                </td>
                <td className="px-3 py-1.5 font-mono text-xs">{i.tag}</td>
                <td className="px-3 py-1.5 font-mono text-xs text-muted">{i.id.replace("sha256:", "").slice(0, 12)}</td>
                <td className="px-3 py-1.5 text-right text-xs tabular-nums">{i.size}</td>
                <td className="px-3 py-1.5 text-xs text-muted">{i.createdSince}</td>
                <td className="px-2 text-right">
                  <IconButton
                    title="Supprimer l'image"
                    className="invisible group-hover:visible"
                    onClick={async () => {
                      const ok = await ask({ title: `Supprimer ${i.repository}:${i.tag} ?`, confirmLabel: "Supprimer", danger: true, body: "Refusé par Docker si un conteneur l'utilise." });
                      if (!ok) return;
                      try {
                        await api.dockerRemoveImage(serverId, i.tag !== "<none>" ? `${i.repository}:${i.tag}` : i.id);
                        await load();
                      } catch (e) {
                        notify(errorMessage(e), "error");
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Volumes du serveur : ce qui les utilise, leur taille, et ceux que plus rien ne réclame. */
function VolumesTable({ volumes, onRemove }: { volumes: DockerVolume[] | null; onRemove: (v: DockerVolume) => void }) {
  if (volumes === null) return <p className="text-xs text-muted">Mesure de la taille des volumes…</p>;
  if (volumes.length === 0) return <p className="text-xs text-muted">Aucun volume Docker.</p>;
  // Les orphelins d'abord, puis du plus gros au plus petit : l'espace à récupérer est en haut.
  const sorted = [...volumes].sort((a, b) => Number(b.orphan) - Number(a.orphan) || b.size - a.size);
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-panel text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Volume</th>
            <th className="px-3 py-2 text-right font-medium">Taille</th>
            <th className="px-3 py-2 font-medium">Utilisé par</th>
            <th className="w-12" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => (
            <tr key={v.name} className={`group border-t border-border/50 hover:bg-hover-soft ${v.orphan ? "bg-warn/5" : ""}`}>
              <td className="px-3 py-1.5">
                <span className="flex items-center gap-2">
                  <Database size={14} className={v.orphan ? "text-warn" : "text-muted"} />
                  <span className="truncate font-mono text-xs" title={v.mountpoint}>
                    {v.name}
                  </span>
                  {v.orphan && <Badge tone="warn">orphelin</Badge>}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right text-xs tabular-nums">{v.size ? formatBytes(v.size) : "—"}</td>
              <td className="px-3 py-1.5 text-xs text-muted">{v.usedBy.length > 0 ? v.usedBy.join(", ") : "personne"}</td>
              <td className="px-2 text-right">
                <IconButton title="Supprimer le volume" className="invisible group-hover:visible" onClick={() => onRemove(v)}>
                  <Trash2 size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
