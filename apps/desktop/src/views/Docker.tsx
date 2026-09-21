import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Box, Container as ContainerIcon, FileCode2, FileSearch, Layers, Pause, Play, RefreshCw, RotateCw, ScrollText,
  Square, SquareTerminal, Trash2, UploadCloud,
} from "lucide-react";
import {
  api, errorMessage, shellQuote, type ComposeProject, type Container, type ContainerStats, type DockerDiskUsage,
  type DockerImage, type DockerOverview,
} from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, Input, Modal } from "../components/ui";

const FileEditor = lazy(() => import("../components/FileEditor"));

const TABS = [
  { id: "containers", label: "Conteneurs" },
  { id: "compose", label: "Projets compose" },
  { id: "storage", label: "Images & nettoyage" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function DockerView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<ContainerIcon size={40} />} title="Aucun serveur sélectionné" />;
  return <Docker key={serverId} serverId={serverId} />;
}

function stateTone(state: string) {
  return state === "running" ? "ok" : state === "restarting" || state === "paused" ? "warn" : state === "dead" ? "danger" : "muted";
}

function Docker({ serverId }: { serverId: string }) {
  const { notify } = useApp();
  const [tab, setTab] = useState<TabId>("containers");
  const [data, setData] = useState<DockerOverview | null>(null);
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
  const docker = data.access === "sudo" ? "sudo docker" : "docker";
  const running = data.containers.filter((c) => c.state === "running").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-border px-6 pt-4">
        <div className="pb-3">
          <h1 className="text-lg font-semibold">Docker</h1>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            <Badge>v{data.version}</Badge>
            <Badge tone="ok">{running} en cours</Badge>
            <Badge>{data.containers.length - running} arrêté(s)</Badge>
            {data.access === "sudo" && <Badge tone="warn">via sudo</Badge>}
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
          <IconButton title="Actualiser" className="mb-1.5 ml-2" onClick={() => void load()}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </IconButton>
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === "containers" && <Containers serverId={serverId} data={data} docker={docker} reload={load} />}
        {tab === "compose" && <Compose serverId={serverId} data={data} docker={docker} reload={load} />}
        {tab === "storage" && <Storage serverId={serverId} notify={notify} />}
      </div>
    </div>
  );
}

function Containers({ serverId, data, docker, reload }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void> }) {
  const { ask, notify, openTab } = useApp();
  const [stats, setStats] = useState<Record<string, ContainerStats>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [inspect, setInspect] = useState<{ name: string; json: string } | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .dockerStats(serverId)
        .then((list) => !stop && setStats(Object.fromEntries(list.map((s) => [s.id, s]))))
        .catch(() => {});
    void load();
    const id = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [serverId]);

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

  return (
    <div className="flex flex-col gap-3">
      <Input className="!w-72" placeholder="Filtrer (nom, image, projet)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
          <tbody>
            {rows.map((c) => {
              const s = stats[c.id];
              const isRunning = c.state === "running";
              return (
                <tr key={c.id} className="group border-t border-border/50 hover:bg-white/[0.03]">
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
                      c.ports.map((p) => (
                        <div key={`${p.hostPort}/${p.protocol}`} title={p.hostIp === "0.0.0.0" ? "Exposé sur toutes les interfaces (accessible depuis Internet si le pare-feu le permet)" : "Accessible uniquement en local"}>
                          <span className={p.hostIp === "0.0.0.0" ? "text-warn" : "text-muted"}>{p.hostIp === "0.0.0.0" ? "*" : p.hostIp}</span>:{p.hostPort} → {p.containerPort}
                        </div>
                      ))
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
        </table>
      </div>
      {inspect && (
        <Modal title={`Inspection de ${inspect.name}`} width="max-w-5xl" onClose={() => setInspect(null)}>
          <pre className="h-[65vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs select-text">{inspect.json}</pre>
        </Modal>
      )}
    </div>
  );
}

function Compose({ serverId, data, docker, reload }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void> }) {
  const { ask, notify, openTab } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  if (data.projects.length === 0) {
    return <EmptyState icon={<Layers size={36} />} title="Aucun projet docker compose">Les projets lancés avec docker compose apparaîtront ici.</EmptyState>;
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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-4">
      {data.projects.map((p) => {
        const file = p.configFiles.split(",")[0];
        const b = (a: string) => busy === `${p.name}:${a}`;
        return (
          <div key={p.name} className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  <Layers size={15} className="text-accent" />
                  {p.name}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted" title={p.configFiles}>{file}</div>
              </div>
              <Badge tone={p.status.startsWith("running") ? "ok" : "muted"}>{p.status}</Badge>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {containersOf(p.name).map((c) => (
                <span key={c.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-xs">
                  <span className={`size-1.5 rounded-full ${c.state === "running" ? "bg-ok" : "bg-muted"}`} />
                  {c.composeService ?? c.name}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" icon={<Play size={12} />} loading={b("up")} onClick={() => void act(p, "up", "Démarrer (up -d)")}>Up</Button>
              <Button size="sm" icon={<UploadCloud size={12} />} loading={b("update")} onClick={() => void act(p, "update", "Mettre à jour (pull + up)")}>Mettre à jour</Button>
              <Button size="sm" icon={<RotateCw size={12} />} loading={b("restart")} onClick={() => void act(p, "restart", "Redémarrer")}>Redémarrer</Button>
              <Button size="sm" icon={<ScrollText size={12} />} onClick={async () => openTab(serverId, { title: `${p.name} (logs)`, command: (await api.composeCommand(p, "logs -f --tail 200")).replace(/^docker /, `${docker} `) })}>
                Logs
              </Button>
              <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => setEditing(file)}>Éditer</Button>
              <Button size="sm" variant="danger" icon={<Square size={12} />} loading={b("down")} onClick={() => void act(p, "down", "Arrêter et supprimer (down)", "Les conteneurs du projet seront arrêtés et supprimés (les volumes nommés sont conservés). Le site sera indisponible.")}>
                Down
              </Button>
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
    </div>
  );
}

function Storage({ serverId, notify }: { serverId: string; notify: (m: string, k?: "info" | "error" | "success") => void }) {
  const ask = useApp((s) => s.ask);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [usage, setUsage] = useState<DockerDiskUsage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.dockerStorage(serverId);
      setImages(s.images);
      setUsage(s.usage);
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
      </div>
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
              <tr key={i.id + i.tag} className="group border-t border-border/50 hover:bg-white/[0.03]">
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
