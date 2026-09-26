import { lazy, Suspense, useState } from "react";
import { FileCode2, GitBranch, Layers, Package, Play, Plus, Rocket, RotateCw, ScrollText, Square, UploadCloud } from "lucide-react";
import { api, errorMessage, type ComposeProject, type DockerOverview } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, EmptyState, MenuButton, Modal, type MenuItem } from "../../components/ui";
import { deployProject, GithubDeployDialog } from "../../components/DockerExtras";

const FileEditor = lazy(() => import("../../components/FileEditor"));

export default function Compose({ serverId, data, docker, reload, onNew, onCatalog }: { serverId: string; data: DockerOverview; docker: string; reload: () => Promise<void>; onNew: () => void; onCatalog: () => void }) {
  const { ask, notify, openTab } = useAppPick("ask", "notify", "openTab");
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [github, setGithub] = useState<ComposeProject | null>(null);
  if (data.projects.length === 0) {
    return (
      <EmptyState
        icon={<Layers />}
        title="Aucun projet docker compose"
        action={
          <>
            <Button variant="primary" icon={<Plus size={14} />} onClick={onNew}>
              Nouveau projet
            </Button>
            <Button icon={<Package size={14} />} onClick={onCatalog}>
              Catalogue d'applications
            </Button>
          </>
        }
      >
        Les projets lancés avec docker compose apparaîtront ici. Le catalogue propose des applications prêtes à l'emploi (n8n, Uptime Kuma, Vaultwarden…).
      </EmptyState>
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

  const projectItems = (p: ComposeProject, file: string, stopped: boolean): MenuItem[] => [
    { label: "Mettre à jour (pull + up)", icon: <UploadCloud size={14} />, onClick: () => void act(p, "update", "Mettre à jour (pull + up)") },
    ...(stopped ? [] : [{ label: "Démarrer les services manquants (up -d)", icon: <Play size={14} />, onClick: () => void act(p, "up", "Démarrer (up -d)") }]),
    {
      label: "Reconstruire complètement…",
      hint: "down + build + up",
      icon: <RotateCw size={14} />,
      danger: true,
      onClick: () =>
        void act(
          p,
          "rebuild",
          "Reconstruire complètement",
          "Le projet sera arrêté, les images seront récupérées, les services seront reconstruits puis redémarrés. Les volumes nommés sont conservés, mais le service sera indisponible pendant l'opération.",
        ),
    },
    "separator",
    { label: "Éditer le compose.yml", icon: <FileCode2 size={14} />, onClick: () => setEditing(file) },
    { label: "Déploiement depuis GitHub…", icon: <GitBranch size={14} />, onClick: () => setGithub(p) },
    "separator",
    {
      label: "Arrêter et supprimer (down)…",
      icon: <Square size={14} />,
      danger: true,
      onClick: () =>
        void act(p, "down", "Arrêter et supprimer (down)", "Les conteneurs du projet seront arrêtés et supprimés (les volumes nommés sont conservés). Le site sera indisponible."),
    },
  ];

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-4 px-7 py-5">
      {data.projects.map((p) => {
        const file = p.configFiles.split(",")[0];
        const b = (a: string) => busy === `${p.name}:${a}`;
        const services = containersOf(p.name);
        const enMarche = services.filter((c) => c.state === "running").length;
        const arrete = services.length > 0 && enMarche === 0;
        return (
          <div key={p.name} className="flex flex-col overflow-hidden rounded-xl border border-border bg-panel">
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
              <Button
                size="sm"
                variant="primary"
                icon={<Rocket size={12} />}
                title="Nouvelles images, redémarrage, vérification, et retour à la version précédente si elle échoue"
                onClick={() => void deployProject(serverId, p)}
              >
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
              <span className="ml-auto">
                <MenuButton size="sm" title="Autres actions" items={() => projectItems(p, file, arrete)} />
              </span>
            </div>
          </div>
        );
      })}
      {output && (
        <Modal title={output.title} width="max-w-3xl" onClose={() => setOutput(null)}>
          <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-term p-3 font-mono text-xs whitespace-pre-wrap select-text">{output.text}</pre>
        </Modal>
      )}
      {editing && (
        <Suspense fallback={null}>
          <FileEditor serverId={serverId} path={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
      {github && <GithubDeployDialog serverId={serverId} project={github} onClose={() => setGithub(null)} />}
    </div>
  );
}

