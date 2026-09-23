import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUp, CheckCircle2, DatabaseBackup, File, Folder, OctagonAlert, Play, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage, formatBytes, type BackupConfig, type BackupOverview, type DbSource, type Snapshot, type SnapshotNode } from "../lib/api";
import { track } from "../lib/transfers";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";
import PageLayout from "../components/PageLayout";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";

export default function BackupsView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<DatabaseBackup size={40} />} title="Aucun serveur sélectionné" />;
  return <Backups key={serverId} serverId={serverId} />;
}

function Backups({ serverId }: { serverId: string }) {
  const { notify, openTab } = useAppPick("notify", "openTab");
  const [data, setData] = useCachedState<BackupOverview | null>(`backups:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [checkOut, setCheckOut] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (!(await ensureConnected(serverId))) throw new Error("Non connecté.");
      setData(await api.backupOverview(serverId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh(load, { serverId, auto: false });

  if (error) return <EmptyState icon={<DatabaseBackup size={40} />} title="Sauvegardes indisponibles">{error}</EmptyState>;
  if (!data) return <EmptyState icon={<DatabaseBackup size={40} />} title="Chargement…" />;

  const { status } = data;
  const configured = !!status.config;
  const last = status.last;

  return (
    <PageLayout
      title="Sauvegardes"
      subtitle="Chiffrées et dédupliquées avec restic, planifiées chaque jour. Bases exportées sans arrêt du service."
      guide="backups"
      actions={
        <>
          {configured && (
            <>
              <Button size="sm" icon={<ShieldCheck size={13} />} onClick={async () => setCheckOut(await api.backupCheck(serverId).catch(errorMessage))}>
                Vérifier le dépôt
              </Button>
              <Button
                size="sm"
                icon={<Play size={13} />}
                onClick={() => openTab(serverId, { title: "Sauvegarde", command: "sudo /etc/helm-backup/run.sh; echo; echo 'Tu peux fermer cet onglet.'; exec \"$SHELL\" -l" })}
              >
                Sauvegarder maintenant
              </Button>
            </>
          )}
          <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
            {configured ? "Modifier la configuration" : "Configurer les sauvegardes"}
          </Button>
        </>
      }
    >
      <div className="p-6">
        {!configured ? (
          <EmptyState icon={<DatabaseBackup size={40} />} title="Aucune sauvegarde configurée">
            Détecté sur ce serveur : {data.databases.length} base(s) de données et {data.volumes.length} volume(s) Docker. Configure une sauvegarde quotidienne en quelques clics.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
              <div className="rounded-lg border border-border bg-panel px-4 py-3">
                <div className="text-xs text-muted">Dernière sauvegarde</div>
                {last ? (
                  <div className={`mt-1 flex items-center gap-2 font-medium ${last.ok ? "" : "text-danger"}`}>
                    {last.ok ? <CheckCircle2 size={15} className="text-ok" /> : <OctagonAlert size={15} />}
                    {new Date(last.finishedAt * 1000).toLocaleString("fr-FR")}
                  </div>
                ) : (
                  <div className="mt-1 text-sm text-muted">Pas encore exécutée</div>
                )}
                {last && <div className="mt-0.5 truncate text-xs text-muted" title={last.message}>{last.message}</div>}
              </div>
              <div className="rounded-lg border border-border bg-panel px-4 py-3">
                <div className="text-xs text-muted">Prochaine exécution</div>
                <div className="mt-1 font-medium">{status.nextRun ?? `chaque jour à ${status.config!.schedule}`}</div>
              </div>
              <div className="rounded-lg border border-border bg-panel px-4 py-3">
                <div className="text-xs text-muted">Destination</div>
                <div className="mt-1 truncate font-medium">{status.config!.destination.kind === "s3" ? `S3 · ${status.config!.destination.bucket}` : status.config!.destination.path}</div>
                <div className="text-xs text-muted">
                  Rétention : {status.config!.keepDaily} j · {status.config!.keepWeekly} sem · {status.config!.keepMonthly} mois
                </div>
              </div>
            </div>
            {status.config!.destination.kind === "local" && (
              <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs">
                Les sauvegardes sont sur le serveur lui-même : elles protègent des erreurs (fichier supprimé, mise à jour ratée), pas de la perte du serveur. Ajoute un stockage S3 pour une copie hors du VPS.
              </p>
            )}
            <SnapshotsBrowser serverId={serverId} databases={status.config!.databases} notify={notify} />
          </div>
        )}
      </div>
      {editing && (
        <ConfigForm
          serverId={serverId}
          data={data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      {checkOut && (
        <Modal title="Vérification du dépôt" width="max-w-3xl" onClose={() => setCheckOut(null)}>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{checkOut}</pre>
        </Modal>
      )}
    </PageLayout>
  );
}

function SnapshotsBrowser({ serverId, databases, notify }: { serverId: string; databases: DbSource[]; notify: (m: string, k?: "info" | "error" | "success") => void }) {
  const ask = useApp((s) => s.ask);
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [current, setCurrent] = useState<Snapshot | null>(null);
  const [path, setPath] = useState("/");
  const [nodes, setNodes] = useState<SnapshotNode[] | null>(null);
  const [restored, setRestored] = useState<{ node: SnapshotNode; at: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.backupSnapshots(serverId).then(setSnaps, (e) => {
      setSnaps([]);
      notify(errorMessage(e), "error");
    });
  }, [serverId, notify]);

  useEffect(() => {
    if (!current) return;
    setNodes(null);
    api.backupList(serverId, current.short_id, path).then(setNodes, (e) => notify(errorMessage(e), "error"));
  }, [serverId, current, path, notify]);

  const restore = async (node: SnapshotNode) => {
    setBusy(true);
    try {
      const at = await api.backupRestore(serverId, current!.short_id, node.path);
      setRestored({ node, at });
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const dbOf = (node: SnapshotNode) => databases.find((d) => node.name === `${d.container}.sql`);

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium">Sauvegardes disponibles</h2>
      <div className="grid grid-cols-[260px_1fr] gap-4">
        <div className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-panel">
          {snaps === null && <p className="p-3 text-sm text-muted">Chargement…</p>}
          {snaps?.length === 0 && <p className="p-3 text-sm text-muted">Aucune sauvegarde pour l'instant.</p>}
          {snaps?.map((s) => (
            <button
              key={s.short_id}
              onClick={() => {
                setCurrent(s);
                setPath("/");
              }}
              className={`block w-full border-b border-border/50 px-3 py-2 text-left text-sm hover:bg-hover ${current?.short_id === s.short_id ? "bg-accent/15" : ""}`}
            >
              {new Date(s.time).toLocaleString("fr-FR")}
              <span className="block font-mono text-[11px] text-muted">{s.short_id}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-panel">
          {!current ? (
            <p className="p-4 text-sm text-muted">Choisis une sauvegarde pour parcourir son contenu.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <IconButton title="Dossier parent" disabled={path === "/"} onClick={() => setPath(path.replace(/\/[^/]+\/?$/, "") || "/")}>
                  <ArrowUp size={14} />
                </IconButton>
                <span className="truncate font-mono text-xs">{path}</span>
              </div>
              <div className="max-h-[45vh] overflow-auto">
                {nodes === null && <p className="p-3 text-sm text-muted">Lecture…</p>}
                {nodes?.map((n) => (
                  <div key={n.path} className="group flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-sm">
                    {n.kind === "dir" ? <Folder size={14} className="text-accent" /> : <File size={14} className="text-muted" />}
                    {n.kind === "dir" ? (
                      <button className="flex-1 truncate text-left hover:underline" onClick={() => setPath(n.path)}>
                        {n.name}
                      </button>
                    ) : (
                      <span className="flex-1 truncate">{n.name}</span>
                    )}
                    {n.kind !== "dir" && <span className="text-xs text-muted tabular-nums">{formatBytes(n.size)}</span>}
                    <Button size="sm" variant="ghost" className="invisible group-hover:visible" icon={<RotateCcw size={12} />} loading={busy} onClick={() => void restore(n)}>
                      Restaurer
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {restored && (
        <Modal title={`« ${restored.node.name} » restauré`} width="max-w-2xl" onClose={() => setRestored(null)}>
          <div className="flex flex-col gap-3 text-sm">
            <p>
              Restauré dans un dossier temporaire du serveur : <span className="font-mono text-xs select-text">{restored.at}</span>. Rien n'a encore été remplacé.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={async () => {
                  const dir = await open({ directory: true, title: "Dossier de destination" });
                  if (typeof dir !== "string") return;
                  const staged = await api.backupStageDownload(serverId, restored.at);
                  await track(`Téléchargement de ${restored.node.name}`, (id, p) => api.fsDownload(serverId, [staged], dir, id, p));
                  notify(`Téléchargé dans ${dir}`, "success");
                }}
              >
                Télécharger sur mon PC
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const ok = await ask({
                    title: `Remettre en place ${restored.node.path} ?`,
                    body: "La version actuelle sera d'abord renommée (…helm-avant-restauration-<date>), puis la version sauvegardée copiée à sa place. Un service qui utilise ce fichier devra peut-être être redémarré.",
                    confirmLabel: "Remettre en place",
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    const aside = await api.backupPutBack(serverId, restored.at, restored.node.path);
                    notify(`Remis en place. Ancienne version : ${aside}`, "success");
                    setRestored(null);
                  } catch (e) {
                    notify(errorMessage(e), "error");
                  }
                }}
              >
                Remettre en place
              </Button>
              {dbOf(restored.node) && (
                <Button
                  variant="danger"
                  onClick={async () => {
                    const db = dbOf(restored.node)!;
                    const ok = await ask({
                      title: `Réimporter dans ${db.container} ?`,
                      body: "Le dump va être rejoué dans la base : les tables présentes dans la sauvegarde seront remplacées par leur contenu sauvegardé. Fais d'abord une sauvegarde de l'état actuel si besoin.",
                      confirmLabel: "Réimporter",
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api.backupImportDump(serverId, restored.at, db);
                      notify(`Base ${db.container} réimportée`, "success");
                      setRestored(null);
                    } catch (e) {
                      notify(errorMessage(e), "error");
                    }
                  }}
                >
                  Réimporter dans la base
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function ConfigForm({ serverId, data, onClose, onSaved }: { serverId: string; data: BackupOverview; onClose: () => void; onSaved: () => void }) {
  const notify = useApp((s) => s.notify);
  const [c, setC] = useState<BackupConfig>(
    data.status.config ?? { ...data.defaultConfig, volumes: data.volumes, databases: data.databases },
  );
  const [s3Secret, setS3Secret] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ log: string; generatedPassword: string | null } | null>(null);
  const [newPath, setNewPath] = useState("");
  const set = <K extends keyof BackupConfig>(k: K, v: BackupConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const s3 = c.destination.kind === "s3" ? c.destination : null;
  const allDbs = [...data.databases, ...c.databases.filter((d) => !data.databases.some((x) => x.container === d.container))];
  const allVols = [...new Set([...data.volumes, ...c.volumes])];

  const save = async () => {
    setSaving(true);
    try {
      setDone(await api.backupSave(serverId, c, password || undefined, s3Secret || undefined));
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <Modal title="Sauvegardes configurées" width="max-w-2xl" onClose={onSaved} footer={<Button variant="primary" onClick={onSaved}>Terminé</Button>}>
        <div className="flex flex-col gap-3 text-sm">
          {done.generatedPassword && (
            <div className="rounded-md border border-warn/50 bg-warn/10 p-3">
              <p className="font-medium">Mot de passe de chiffrement : note-le en lieu sûr.</p>
              <p className="mt-1 text-xs text-muted">Sans lui, les sauvegardes sont illisibles, y compris pour toi. Une copie est gardée dans le coffre-fort de ce PC.</p>
              <pre className="mt-2 rounded bg-bg p-2 font-mono text-xs select-all">{done.generatedPassword}</pre>
            </div>
          )}
          <pre className="max-h-60 overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap">{done.log}</pre>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Configuration des sauvegardes"
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Save size={14} />} loading={saving} onClick={() => void save()}>
            Enregistrer et planifier
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Destination</span>
          <div className="flex gap-1 rounded-md border border-border bg-bg p-1">
            <button
              className={`flex-1 rounded px-2 py-1 text-xs ${!s3 ? "bg-accent text-accent-fg" : "text-muted"}`}
              onClick={() => set("destination", { kind: "local", path: "/var/backups/helm/restic" })}
            >
              Dossier du serveur
            </button>
            <button
              className={`flex-1 rounded px-2 py-1 text-xs ${s3 ? "bg-accent text-accent-fg" : "text-muted"}`}
              onClick={() => set("destination", { kind: "s3", endpoint: "https://", bucket: "", prefix: "", accessKeyId: "" })}
            >
              Stockage S3 (hors du serveur)
            </button>
          </div>
          {c.destination.kind === "local" ? (
            <Field label="Dossier">
              <Input className="font-mono text-xs" value={c.destination.path} onChange={(e) => set("destination", { kind: "local", path: e.target.value })} />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Endpoint S3" hint="Ex. https://s3.fr-par.scw.cloud, https://s3.eu-central-003.backblazeb2.com">
                  <Input className="font-mono text-xs" value={s3!.endpoint} onChange={(e) => set("destination", { ...s3!, endpoint: e.target.value })} />
                </Field>
              </div>
              <Field label="Bucket">
                <Input value={s3!.bucket} onChange={(e) => set("destination", { ...s3!, bucket: e.target.value })} />
              </Field>
              <Field label="Préfixe (optionnel)">
                <Input value={s3!.prefix} onChange={(e) => set("destination", { ...s3!, prefix: e.target.value })} placeholder="vps" />
              </Field>
              <Field label="Access key ID">
                <Input value={s3!.accessKeyId} onChange={(e) => set("destination", { ...s3!, accessKeyId: e.target.value })} />
              </Field>
              <Field label="Secret access key" hint={data.status.config?.destination.kind === "s3" ? "Laisser vide pour conserver la clé actuelle." : undefined}>
                <Input type="password" value={s3Secret} onChange={(e) => setS3Secret(e.target.value)} />
              </Field>
            </div>
          )}
        </section>

        <section className="grid grid-cols-4 gap-3">
          <Field label="Heure quotidienne">
            <Input type="time" value={c.schedule} onChange={(e) => set("schedule", e.target.value)} />
          </Field>
          <Field label="Garder (jours)">
            <Input type="number" value={c.keepDaily} onChange={(e) => set("keepDaily", Number(e.target.value))} />
          </Field>
          <Field label="Garder (semaines)">
            <Input type="number" value={c.keepWeekly} onChange={(e) => set("keepWeekly", Number(e.target.value))} />
          </Field>
          <Field label="Garder (mois)">
            <Input type="number" value={c.keepMonthly} onChange={(e) => set("keepMonthly", Number(e.target.value))} />
          </Field>
        </section>

        <section className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs font-medium text-muted">Bases de données (export cohérent, sans arrêt)</span>
            <div className="mt-1 flex flex-col gap-1">
              {allDbs.length === 0 && <span className="text-xs text-muted">Aucun conteneur MySQL/MariaDB/PostgreSQL détecté.</span>}
              {allDbs.map((d) => (
                <label key={d.container} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={c.databases.some((x) => x.container === d.container)}
                    onChange={(e) => set("databases", e.target.checked ? [...c.databases, d] : c.databases.filter((x) => x.container !== d.container))}
                  />
                  {d.container} <Badge>{d.kind}</Badge>
                </label>
              ))}
            </div>
          </div>
          <div>
            <span className="text-xs font-medium text-muted">Volumes Docker</span>
            <div className="mt-1 flex max-h-40 flex-col gap-1 overflow-auto">
              {allVols.length === 0 && <span className="text-xs text-muted">Aucun volume nommé.</span>}
              {allVols.map((v) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={c.volumes.includes(v)} onChange={(e) => set("volumes", e.target.checked ? [...c.volumes, v] : c.volumes.filter((x) => x !== v))} />
                  <span className="truncate font-mono text-xs">{v}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <section>
          <span className="text-xs font-medium text-muted">Dossiers</span>
          <div className="mt-1 flex flex-col gap-1">
            {c.paths.map((p) => (
              <div key={p} className="flex items-center gap-2">
                <span className="flex-1 font-mono text-xs">{p}</span>
                <IconButton title="Retirer" onClick={() => set("paths", c.paths.filter((x) => x !== p))}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
            <div className="flex gap-2">
              <Input className="font-mono text-xs" placeholder="/srv/mon-app/uploads" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
              <Button
                size="sm"
                icon={<Plus size={12} />}
                disabled={!newPath.startsWith("/")}
                onClick={() => {
                  set("paths", [...new Set([...c.paths, newPath.trim()])]);
                  setNewPath("");
                }}
              >
                Ajouter
              </Button>
            </div>
          </div>
        </section>

        <Field
          label="Mot de passe de chiffrement (optionnel)"
          hint={
            data.status.config
              ? "Laisser vide pour conserver le mot de passe actuel."
              : "Laisser vide pour en générer un solide automatiquement (il te sera affiché une fois)."
          }
        >
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {!data.status.restic && <p className="text-xs text-muted">restic n'est pas installé : il le sera automatiquement (paquet officiel de ta distribution).</p>}
        <div className="flex justify-end">
          <IconButton title="Recharger" onClick={() => setC(data.status.config ?? { ...data.defaultConfig, volumes: data.volumes, databases: data.databases })}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
      </div>
    </Modal>
  );
}
