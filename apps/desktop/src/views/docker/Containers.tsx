import { useMemo, useState } from "react";
import { Cable, FileSearch, FolderInput, FolderPlus, Lock, Pause, Pencil, Play, RotateCw, ScrollText, Search, Square, SquareTerminal, Trash2 } from "lucide-react";
import { api, errorMessage, shellQuote, type ComposeProject, type Container, type ContainerStats, type DockerOverview } from "../../lib/api";
import { useApp, useAppPick } from "../../lib/store";
import { usePolling } from "../../lib/poll";
import { useCachedState } from "../../lib/cache";
import { startDrag } from "../../lib/drag";
import { askFolderName, toggleCollapsed } from "../../components/Folders";
import { tunnelTo, RestrictPortDialog } from "../../components/DockerExtras";
import { DataTable, IconButton, Input, MenuButton, Segmented, Select, StatusDot, useContextMenu, type Column, type MenuItem } from "../../components/ui";
import ContainerDrawer from "./ContainerDrawer";
import { useContainerFolders } from "./shared";

type GroupBy = "project" | "folder" | "none";
type StateFilter = "all" | "running" | "stopped";

export default function Containers({ serverId, data, docker, reload }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void> }) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
  const [stats, setStats] = useCachedState<Record<string, ContainerStats>>(`dockerStats:${serverId}`, {});
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<StateFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try {
      const v = localStorage.getItem("helm.docker.groupBy");
      return v === "folder" || v === "none" ? v : "project";
    } catch {
      return "project";
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restrict, setRestrict] = useState<{ project: ComposeProject; port: number } | null>(null);
  const collapsed = useApp((s) => s.folders.collapsed);
  const folders = useContainerFolders(serverId);
  const portMenu = useContextMenu();

  const setGroup = (g: GroupBy) => {
    setGroupBy(g);
    try {
      localStorage.setItem("helm.docker.groupBy", g);
    } catch {
      /* préférence non retenue */
    }
  };

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

  const groupOf = (c: Container) => (groupBy === "project" ? (c.composeProject ?? "") : groupBy === "folder" ? folders.folderOf(c.name) : "");
  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const list = data.containers.filter(
      (c) =>
        (state === "all" || (state === "running" ? c.state === "running" : c.state !== "running")) &&
        (!f || c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || (c.composeProject ?? "").toLowerCase().includes(f) || c.ports.some((p) => String(p.hostPort).includes(f))),
    );
    if (groupBy === "none") return list;
    // Groupes nommés d'abord (ordre alphabétique), « sans groupe » à la fin.
    return [...list].sort((a, b) => {
      const ga = groupOf(a) || "￿";
      const gb = groupOf(b) || "￿";
      return ga.localeCompare(gb, "fr") || a.name.localeCompare(b.name, "fr");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filter, state, groupBy, folders.folderOf]);


  const act = async (c: Container, action: string) => {
    const labels: Record<string, [string, string?, boolean?]> = {
      restart: ["Redémarrer"],
      stop: ["Arrêter", "Le service rendu par ce conteneur sera interrompu."],
      pause: ["Mettre en pause"],
      unpause: ["Reprendre"],
      start: ["Démarrer"],
      remove: ["Supprimer", "Le conteneur sera supprimé. Ses volumes nommés sont conservés.", true],
    };
    const [label, body, danger] = labels[action] ?? [action];
    if (body && !(await ask({ title: `${label} ${c.name} ?`, body, confirmLabel: label, danger }))) return;
    setBusy(c.id);
    try {
      await api.dockerAction(serverId, c.id, action);
      notify(`${c.name} : ${label.toLowerCase()} OK`, "success");
      if (action === "remove") setSelectedId(null);
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const shell = (c: Container) => openTab(serverId, { title: `${c.name} (shell)`, command: `${docker} exec -it ${shellQuote(c.id)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'` });
  const logs = (c: Container) => openTab(serverId, { title: `${c.name} (logs)`, command: `${docker} logs -f --tail 300 ${shellQuote(c.id)}` });
  const projectOf = (c: Container) => data.projects.find((x) => x.name === c.composeProject);

  const moveItems = (c: Container): MenuItem[] => [
    { heading: "Ranger dans un dossier (local)" },
    ...folders.names.filter((f) => f !== folders.folderOf(c.name)).map((f) => ({ label: f, icon: <FolderInput size={14} />, onClick: () => folders.move([c.name], f) })),
    ...(folders.folderOf(c.name) ? [{ label: "Sortir du dossier", onClick: () => folders.move([c.name], null) }] : []),
    {
      label: "Nouveau dossier…",
      icon: <FolderPlus size={14} />,
      onClick: async () => {
        const name = await askFolderName("Nouveau dossier de conteneurs");
        if (name) folders.move([c.name], name);
      },
    },
  ];

  const rowMenu = (c: Container): MenuItem[] => {
    const running = c.state === "running";
    return [
      ...(running
        ? [
            { label: "Redémarrer", icon: <RotateCw size={14} />, onClick: () => void act(c, "restart") },
            { label: "Arrêter", icon: <Square size={13} />, onClick: () => void act(c, "stop") },
            { label: "Mettre en pause", icon: <Pause size={14} />, onClick: () => void act(c, "pause") },
            { label: "Shell", icon: <SquareTerminal size={14} />, onClick: () => shell(c) },
          ]
        : [{ label: c.state === "paused" ? "Reprendre" : "Démarrer", icon: <Play size={14} />, onClick: () => void act(c, c.state === "paused" ? "unpause" : "start") }]),
      { label: "Logs en direct", icon: <ScrollText size={14} />, onClick: () => logs(c) },
      { label: "Détails et inspect", icon: <FileSearch size={14} />, onClick: () => setSelectedId(c.id) },
      "separator",
      ...moveItems(c),
      ...(!running ? (["separator", { label: "Supprimer…", icon: <Trash2 size={14} />, danger: true, onClick: () => void act(c, "remove") }] as MenuItem[]) : []),
    ];
  };

  const columns: Column<Container>[] = [
    {
      key: "name",
      header: "Conteneur",
      width: "minmax(0,1.3fr)",
      sortValue: (c) => c.name,
      render: (c) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={c.state === "running" ? "ok" : c.state === "paused" || c.state === "restarting" ? "warn" : c.state === "dead" ? "danger" : "muted"} className="size-2!" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{c.name}</span>
            <span className="block truncate text-[11.5px] text-muted">{c.status}</span>
          </span>
        </span>
      ),
    },
    { key: "image", header: "Image", width: "minmax(0,1.1fr)", sortValue: (c) => c.image, render: (c) => <span className="font-mono text-xs text-fg/80" title={c.image}>{c.image}</span> },
    {
      key: "ports",
      header: "Ports",
      width: "minmax(0,1.1fr)",
      render: (c) =>
        c.ports.length === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {c.ports.map((p) => {
              const exposed = p.hostIp === "0.0.0.0" || p.hostIp === "::";
              const project = projectOf(c);
              return (
                <button
                  key={`${p.hostIp}:${p.hostPort}/${p.protocol}`}
                  type="button"
                  title={exposed ? "Exposé sur toutes les interfaces : clic pour les actions" : "Accessible uniquement depuis le serveur : clic pour les actions"}
                  onClick={(e) => {
                    e.stopPropagation();
                    portMenu.open(e, [
                      { heading: `Port ${p.hostPort}` },
                      ...(p.protocol === "tcp" ? [{ label: "Ouvrir un tunnel depuis mon PC", icon: <Cable size={14} />, onClick: () => void tunnelTo(serverId, c, p.hostPort) }] : []),
                      ...(exposed && project ? [{ label: "Restreindre à 127.0.0.1…", icon: <Lock size={14} />, onClick: () => setRestrict({ project, port: p.hostPort }) }] : []),
                    ]);
                  }}
                  className={`inline-flex h-[22px] items-center rounded-md border px-1.5 font-mono text-[11px] ${exposed ? "border-warn/45 text-warn" : "border-border-strong/60 bg-raised text-fg/80"}`}
                >
                  {exposed ? "*" : ""}
                  {p.hostPort}→{p.containerPort}
                </button>
              );
            })}
          </span>
        ),
    },
    {
      key: "cpu",
      header: "CPU",
      width: "100px",
      sortValue: (c) => stats[c.id]?.cpu ?? -1,
      render: (c) => {
        const s = stats[c.id];
        if (!s || c.state !== "running") return <span className="text-faint">—</span>;
        return (
          <span className="flex items-center gap-2">
            <span className="h-1 w-10 overflow-hidden rounded-full bg-hover-strong">
              <span className="block h-full bg-accent" style={{ width: `${Math.min(100, s.cpu)}%` }} />
            </span>
            <span className="text-xs tabular-nums">{s.cpu.toFixed(1)} %</span>
          </span>
        );
      },
    },
    {
      key: "mem",
      header: "Mémoire",
      width: "90px",
      sortValue: (c) => stats[c.id]?.memPercent ?? -1,
      render: (c) => {
        const s = stats[c.id];
        return s && c.state === "running" ? (
          <span className="text-xs text-muted tabular-nums" title={s.memUsage}>
            {s.memUsage.split(" / ")[0]}
          </span>
        ) : (
          <span className="text-faint">—</span>
        );
      },
    },
  ];

  const selected = data.containers.find((c) => c.id === selectedId);
  const groupLabel = (k: string) => (groupBy === "project" ? k || "Sans projet compose" : k || "Sans dossier");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-7 py-2.5">
        <label className="relative w-72">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input className="pl-8" placeholder="Filtrer : nom, image, projet, port" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <Segmented
          label="État"
          value={state}
          onChange={setState}
          options={[
            { value: "all", label: "Tous" },
            { value: "running", label: "En cours" },
            { value: "stopped", label: "Arrêtés" },
          ]}
        />
        <span className="ml-auto text-xs text-muted">Grouper par</span>
        <Select<GroupBy>
          className="w-44"
          value={groupBy}
          onChange={setGroup}
          options={[
            { value: "project", label: "Projet compose" },
            { value: "folder", label: "Dossier (local)" },
            { value: "none", label: "Aucun" },
          ]}
        />
        {groupBy === "folder" && (
          <IconButton
            title="Nouveau dossier de conteneurs"
            onClick={async () => {
              const name = await askFolderName("Nouveau dossier de conteneurs");
              if (name) folders.create(name);
            }}
          >
            <FolderPlus size={15} />
          </IconButton>
        )}
      </div>
      <DataTable
        className="min-h-0 flex-1"
        rows={rows}
        rowKey={(c) => c.id}
        columns={columns}
        rowHeight={48}
        isSelected={(c) => c.id === selectedId}
        onRowClick={(c) => setSelectedId(c.id === selectedId ? null : c.id)}
        onRowMouseDown={groupBy === "folder" ? (c, e) => startDrag(e, c.name, (folder) => folders.move([c.name], folder || null)) : undefined}
        actionsWidth={128}
        rowActions={(c) => (
          <>
            <IconButton size="sm" title="Logs en direct" onClick={() => logs(c)}>
              <ScrollText size={14} />
            </IconButton>
            {c.state === "running" ? (
              <>
                <IconButton size="sm" title="Shell dans le conteneur" onClick={() => shell(c)}>
                  <SquareTerminal size={14} />
                </IconButton>
                <IconButton size="sm" title="Redémarrer" disabled={!!busy} onClick={() => void act(c, "restart")}>
                  <RotateCw size={14} className={busy === c.id ? "animate-spin" : ""} />
                </IconButton>
              </>
            ) : (
              <IconButton size="sm" title={c.state === "paused" ? "Reprendre" : "Démarrer"} disabled={!!busy} onClick={() => void act(c, c.state === "paused" ? "unpause" : "start")}>
                <Play size={14} />
              </IconButton>
            )}
          </>
        )}
        rowMenu={rowMenu}
        groupBy={
          groupBy === "none"
            ? undefined
            : {
                key: groupOf,
                collapsed: (k) => collapsed.includes(`docker:${serverId}:${groupBy}:${k}`),
                header: (k, list) => {
                  const collapseKey = `docker:${serverId}:${groupBy}:${k}`;
                  const isCollapsed = collapsed.includes(collapseKey);
                  const run = list.filter((c) => c.state === "running").length;
                  return (
                    <div data-drop={groupBy === "folder" ? k : undefined} className="flex h-9 items-center gap-2 border-b border-line bg-subtle px-3 text-xs text-muted">
                      <button type="button" onClick={() => toggleCollapsed(collapseKey)} aria-expanded={!isCollapsed} className="flex min-w-0 items-center gap-2">
                        <span className={`inline-block transition-transform ${isCollapsed ? "-rotate-90" : ""}`}>▾</span>
                        <span className={`truncate font-semibold ${k ? "text-fg" : ""}`}>{groupLabel(k)}</span>
                        {groupBy === "project" && k && <span className="truncate font-mono text-[11px] text-faint">{data.projects.find((p) => p.name === k)?.configFiles.split(",")[0]}</span>}
                      </button>
                      <span className="ml-auto">
                        {run} / {list.length} en cours
                      </span>
                      {groupBy === "folder" && k && (
                        <MenuButton
                          size="sm"
                          title={`Dossier ${k}`}
                          items={[
                            {
                              label: "Renommer…",
                              icon: <Pencil size={14} />,
                              onClick: async () => {
                                const next = await askFolderName(`Renommer « ${k} »`, k);
                                if (next && next !== k) folders.rename(k, next);
                              },
                            },
                            { label: "Supprimer le dossier", icon: <Trash2 size={14} />, danger: true, onClick: () => folders.remove(k) },
                          ]}
                        />
                      )}
                    </div>
                  );
                },
              }
        }
        empty={filter || state !== "all" ? "Aucun conteneur ne correspond aux filtres." : "Aucun conteneur sur ce serveur."}
      />
      {portMenu.menu}
      {selected && (
        <ContainerDrawer
          key={selected.id}
          serverId={serverId}
          container={selected}
          stats={stats[selected.id]}
          project={projectOf(selected)}
          onClose={() => setSelectedId(null)}
          onAction={(a) => void act(selected, a)}
          onShell={() => shell(selected)}
          onLogs={() => logs(selected)}
          onTunnel={(port) => void tunnelTo(serverId, selected, port)}
          onRestrict={(port) => {
            const project = projectOf(selected);
            if (project) setRestrict({ project, port });
          }}
        />
      )}
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
    </div>
  );
}
