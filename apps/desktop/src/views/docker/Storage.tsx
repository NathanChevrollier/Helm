import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Database, Search, Trash2 } from "lucide-react";
import { api, errorMessage, formatBytes, type DockerDiskUsage, type DockerImage, type DockerVolume } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, Card, DataTable, IconButton, Input, Loading, Section, StatTile } from "../../components/ui";

const LABELS: Record<string, string> = { Images: "Images", Containers: "Conteneurs", "Local Volumes": "Volumes", "Build Cache": "Cache de build" };

export default function Storage({ serverId }: { serverId: string }) {
  const ask = useApp((s) => s.ask);
  const notify = useApp((s) => s.notify);
  const [images, setImages] = useState<DockerImage[] | null>(null);
  const [usage, setUsage] = useState<DockerDiskUsage[]>([]);
  const [volumes, setVolumes] = useState<DockerVolume[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

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

  /** Volumes qu'aucun conteneur n'utilise : ce sont eux que le nettoyage supprimerait. */
  const orphans = (volumes ?? []).filter((v) => v.orphan);
  const reclaimable = orphans.reduce((n, v) => n + v.size, 0);
  const shownImages = useMemo(() => {
    const f = filter.toLowerCase();
    return (images ?? []).filter((i) => !f || `${i.repository}:${i.tag}`.toLowerCase().includes(f));
  }, [images, filter]);

  const removeImage = async (i: DockerImage) => {
    const ok = await ask({ title: `Supprimer ${i.repository}:${i.tag} ?`, confirmLabel: "Supprimer", danger: true, body: "Refusé par Docker si un conteneur l'utilise." });
    if (!ok) return;
    try {
      await api.dockerRemoveImage(serverId, i.tag !== "<none>" ? `${i.repository}:${i.tag}` : i.id);
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const removeVolume = async (v: DockerVolume) => {
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
  };

  return (
    <div className="flex flex-col gap-6 px-7 py-5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
        {usage.length === 0 && <Loading rows={1} />}
        {usage.map((u) => (
          <StatTile
            key={u.kind}
            label={LABELS[u.kind] ?? u.kind}
            value={u.size}
            hint={`${u.totalCount} au total · ${u.active} utilisé(s) · ${u.reclaimable} récupérable`}
            tone={/^0(\.0+)?\s*B|^0B/.test(u.reclaimable) ? "muted" : "warn"}
          />
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <div>
            <h3 className="text-[13px] font-semibold">Nettoyage sans risque</h3>
            <p className="text-xs text-muted">Rien d'utilisé par un conteneur n'est touché.</p>
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
          </div>
        </Card>
        <Card tone="danger" className="flex flex-col gap-3">
          <div>
            <h3 className="text-[13px] font-semibold text-danger">Nettoyage destructif</h3>
            <p className="text-xs text-muted">Libère le plus d'espace ; ce qui est supprimé devra être re-téléchargé ou est perdu.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy === "images-all"}
              onClick={() => void prune("images-all", "Supprimer toutes les images inutilisées ?", "Supprime toutes les images qui ne sont utilisées par aucun conteneur, même taguées. Elles devront être re-téléchargées si besoin.")}
            >
              Toutes les images inutilisées
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={orphans.length === 0}
              loading={busy === "volumes"}
              onClick={() =>
                void prune(
                  "volumes",
                  `Supprimer ${orphans.length} volume(s) orphelin(s) ?`,
                  `Environ ${formatBytes(reclaimable)} seront libérés. Ces volumes ne sont utilisés par aucun conteneur, même arrêté — mais leurs données seront perdues définitivement :\n\n${orphans.map((v) => `· ${v.name} (${formatBytes(v.size)})`).join("\n")}`,
                )
              }
            >
              Volumes orphelins{orphans.length ? ` (${formatBytes(reclaimable)})` : ""}
            </Button>
          </div>
        </Card>
      </div>

      <Section title="Volumes" count={volumes?.length} description={orphans.length ? `${orphans.length} orphelin(s)` : undefined}>
        {volumes === null ? (
          <Loading label="Mesure de la taille des volumes…" />
        ) : (
          <Card padded={false} className="overflow-hidden">
            <DataTable
              rows={volumes}
              rowKey={(v) => v.name}
              initialSort={{ key: "size", dir: "desc" }}
              columns={[
                {
                  key: "name",
                  header: "Volume",
                  sortValue: (v) => `${v.orphan ? 0 : 1}${v.name}`,
                  render: (v) => (
                    <span className="flex min-w-0 items-center gap-2">
                      <Database size={14} className={v.orphan ? "shrink-0 text-warn" : "shrink-0 text-muted"} />
                      <span className="truncate font-mono text-xs" title={v.mountpoint}>
                        {v.name}
                      </span>
                      {v.orphan && <Badge tone="warn">orphelin</Badge>}
                    </span>
                  ),
                },
                { key: "size", header: "Taille", width: "100px", align: "right", sortValue: (v) => v.size, render: (v) => <span className="text-xs tabular-nums">{v.size ? formatBytes(v.size) : "—"}</span> },
                { key: "usedBy", header: "Utilisé par", width: "minmax(0,0.8fr)", render: (v) => <span className="text-xs text-muted">{v.usedBy.length > 0 ? v.usedBy.join(", ") : "personne"}</span> },
              ]}
              rowMenu={(v) => [{ label: "Supprimer le volume…", icon: <Trash2 size={14} />, danger: true, onClick: () => void removeVolume(v) }]}
              empty="Aucun volume Docker."
            />
          </Card>
        )}
      </Section>

      <Section
        title="Images"
        count={images?.length}
        actions={
          <label className="relative w-60">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <Input className="pl-8" size_="sm" placeholder="Filtrer les images" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        }
      >
        {images === null ? (
          <Loading rows={5} />
        ) : (
          <Card padded={false} className="overflow-hidden">
            <DataTable
              rows={shownImages}
              rowKey={(i) => i.id + i.tag}
              columns={[
                {
                  key: "repo",
                  header: "Image",
                  sortValue: (i) => i.repository,
                  render: (i) => (
                    <span className="flex min-w-0 items-center gap-2">
                      <Box size={14} className="shrink-0 text-muted" />
                      <span className="truncate">{i.repository}</span>
                    </span>
                  ),
                },
                { key: "tag", header: "Tag", width: "140px", sortValue: (i) => i.tag, render: (i) => <span className="font-mono text-xs">{i.tag}</span> },
                { key: "id", header: "ID", width: "120px", render: (i) => <span className="font-mono text-xs text-muted">{i.id.replace("sha256:", "").slice(0, 12)}</span> },
                { key: "size", header: "Taille", width: "90px", align: "right", sortValue: (i) => parseSize(i.size), render: (i) => <span className="text-xs tabular-nums">{i.size}</span> },
                { key: "created", header: "Créée", width: "130px", render: (i) => <span className="text-xs text-muted">{i.createdSince}</span> },
              ]}
              actionsWidth={48}
              rowActions={(i) => (
                <IconButton size="sm" title="Supprimer l'image" onClick={() => void removeImage(i)}>
                  <Trash2 size={14} />
                </IconButton>
              )}
              empty={filter ? "Aucune image ne correspond." : "Aucune image."}
            />
          </Card>
        )}
      </Section>
    </div>
  );
}

/** « 1.2GB », « 340MB » → octets, pour trier les tailles renvoyées en texte par Docker. */
function parseSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([kKMGT]?)B?$/);
  if (!m) return 0;
  const mult: Record<string, number> = { "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(m[1]) * (mult[m[2]] ?? 1);
}
