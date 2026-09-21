import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp, Download, Eye, EyeOff, File, FilePlus, Folder, FolderOpen, FolderPlus, House, Link2, Pencil,
  RefreshCw, Shield, SquareTerminal, Trash2, Upload,
} from "lucide-react";
import { api, errorMessage, formatBytes, shellQuote, type FsEntry, type Listing, type Progress } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";

const FileEditor = lazy(() => import("../components/FileEditor"));

interface Transfer {
  id: number;
  label: string;
  progress: Progress | null;
  state: "running" | "done" | "error";
  message?: string;
}
let transferSeq = 0;

const isDir = (e: FsEntry) => e.kind === "dir" || e.targetIsDir;

export default function FilesView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) {
    return <EmptyState icon={<FolderOpen size={40} />} title="Aucun serveur sélectionné">Choisis un serveur dans la liste à gauche.</EmptyState>;
  }
  return <Explorer key={serverId} serverId={serverId} />;
}

function Explorer({ serverId }: { serverId: string }) {
  const { notify, ask, openTab } = useApp();
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [chmodOf, setChmodOf] = useState<FsEntry | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        if (!(await ensureConnected(serverId))) {
          setError("Non connecté.");
          return;
        }
        const target = path || (await api.fsHome(serverId));
        const l = await api.fsList(serverId, target);
        setListing(l);
        setPathInput(l.path);
        setSelected(new Set());
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const cwd = listing?.path ?? "";
  const refresh = () => void load(cwd);
  const join = (name: string) => (cwd.endsWith("/") ? cwd + name : `${cwd}/${name}`);
  const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

  const entries = useMemo(() => {
    const list = listing?.entries ?? [];
    const f = filter.toLowerCase();
    return list.filter((e) => (showHidden || !e.name.startsWith(".")) && (!f || e.name.toLowerCase().includes(f)));
  }, [listing, showHidden, filter]);

  const selectedEntries = entries.filter((e) => selected.has(e.path));

  const track = async (label: string, run: (onProgress: (p: Progress) => void) => Promise<unknown>) => {
    const id = ++transferSeq;
    setTransfers((t) => [...t, { id, label, progress: null, state: "running" }]);
    const update = (patch: Partial<Transfer>) => setTransfers((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      await run((progress) => update({ progress }));
      update({ state: "done" });
      setTimeout(() => setTransfers((t) => t.filter((x) => x.id !== id)), 4000);
    } catch (e) {
      update({ state: "error", message: errorMessage(e) });
    }
  };

  const upload = async (paths: string[]) => {
    if (!paths.length || !cwd) return;
    const dir = cwd;
    await track(`Envoi de ${paths.length} élément(s) vers ${dir}`, (p) => api.fsUpload(serverId, paths, dir, p));
    if (dir === cwd) refresh();
  };

  const download = async (items: FsEntry[]) => {
    if (!items.length) return;
    const dir = await open({ directory: true, title: "Dossier de destination" });
    if (typeof dir !== "string") return;
    await track(`Téléchargement de ${items.length} élément(s)`, async (p) => {
      const where = await api.fsDownload(serverId, items.map((i) => i.path), dir, p);
      notify(`Téléchargé dans ${where}`, "success");
    });
  };

  // Glisser-déposer depuis l'explorateur Windows.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (useApp.getState().section !== "files") return;
        if (event.payload.type === "over" || event.payload.type === "enter") setDragOver(true);
        else if (event.payload.type === "leave") setDragOver(false);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          void upload(event.payload.paths);
        }
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
    // `upload` dépend du dossier courant : on se réabonne quand il change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const activate = (e: FsEntry) => {
    if (isDir(e)) void load(e.path);
    else setEditing(e.path);
  };

  const onRowClick = (ev: React.MouseEvent, e: FsEntry) => {
    const next = new Set(ev.ctrlKey || ev.metaKey ? selected : []);
    if (ev.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.path === anchor);
      const b = entries.findIndex((x) => x.path === e.path);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(entries[i].path);
    } else if (next.has(e.path) && (ev.ctrlKey || ev.metaKey)) {
      next.delete(e.path);
    } else {
      next.add(e.path);
      setAnchor(e.path);
    }
    setSelected(next);
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const newItem = async (kind: "dir" | "file") => {
    const name = await ask({
      title: kind === "dir" ? "Nouveau dossier" : "Nouveau fichier",
      input: { label: "Nom" },
      confirmLabel: "Créer",
    });
    if (typeof name !== "string" || !name.trim()) return;
    await act(() => (kind === "dir" ? api.fsMkdir(serverId, join(name.trim())) : api.fsCreate(serverId, join(name.trim()))));
  };

  const rename = async (e: FsEntry) => {
    const name = await ask({ title: `Renommer ${e.name}`, input: { label: "Nouveau nom", initial: e.name }, confirmLabel: "Renommer" });
    if (typeof name !== "string" || !name.trim() || name === e.name) return;
    await act(() => api.fsRename(serverId, e.path, join(name.trim())));
  };

  const remove = async (items: FsEntry[]) => {
    if (!items.length) return;
    const ok = await ask({
      title: `Supprimer ${items.length > 1 ? `${items.length} éléments` : `« ${items[0].name} »`} ?`,
      body: "Suppression définitive sur le serveur. Les dossiers sont supprimés avec tout leur contenu.",
      code: items.map((i) => i.path).join("\n"),
      confirmLabel: "Supprimer définitivement",
      danger: true,
    });
    if (ok) await act(() => api.fsRemove(serverId, items.map((i) => i.path)));
  };

  const crumbs = cwd.split("/").filter(Boolean);
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;

  return (
    <div className="relative flex h-full flex-col" onKeyDown={(e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Delete") void remove(selectedEntries);
      if (e.key === "F2" && single) void rename(single);
      if (e.key === "Backspace") void load(parentOf(cwd));
      if (e.key === "F5") refresh();
    }} tabIndex={-1}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <IconButton title="Dossier parent" onClick={() => void load(parentOf(cwd))} disabled={cwd === "/"}>
          <ArrowUp size={15} />
        </IconButton>
        <IconButton title="Dossier personnel" onClick={() => void load("")}>
          <House size={15} />
        </IconButton>
        <IconButton title="Actualiser (F5)" onClick={refresh}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
        <form
          className="mx-2 flex min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void load(pathInput.trim() || "/");
          }}
        >
          <Input className="font-mono text-xs" value={pathInput} onChange={(e) => setPathInput(e.target.value)} aria-label="Chemin" />
        </form>
        <Input className="!w-44" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <IconButton title={showHidden ? "Masquer les fichiers cachés" : "Afficher les fichiers cachés"} onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </IconButton>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden font-mono text-xs text-muted">
          <button className="rounded px-1 hover:bg-white/5 hover:text-fg" onClick={() => void load("/")}>/</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <button className="truncate rounded px-1 hover:bg-white/5 hover:text-fg" onClick={() => void load("/" + crumbs.slice(0, i + 1).join("/"))}>
                {c}
              </button>
              {i < crumbs.length - 1 && <span>/</span>}
            </span>
          ))}
        </nav>
        <Button size="sm" variant="ghost" icon={<FolderPlus size={13} />} onClick={() => void newItem("dir")}>Dossier</Button>
        <Button size="sm" variant="ghost" icon={<FilePlus size={13} />} onClick={() => void newItem("file")}>Fichier</Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Upload size={13} />}
          onClick={async () => {
            const files = await open({ multiple: true, title: "Fichiers à envoyer" });
            if (files) void upload(Array.isArray(files) ? files : [files]);
          }}
        >
          Envoyer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<SquareTerminal size={13} />}
          onClick={() => openTab(serverId, { title: cwd, command: `cd ${shellQuote(cwd)} && exec "$SHELL" -l` })}
        >
          Terminal ici
        </Button>
      </div>

      {/* Barre toujours présente : sa hauteur fixe évite que les lignes bougent entre deux clics. */}
      <div className={`flex h-10 shrink-0 items-center gap-1 border-b border-border px-3 text-xs ${selectedEntries.length ? "bg-accent/5" : ""}`}>
        {selectedEntries.length === 0 ? (
          <span className="text-muted">
            {entries.length} élément(s) · double-clic pour ouvrir · glisse des fichiers ici pour les envoyer
          </span>
        ) : (
        <>
          <span className="mr-2 text-muted">{selectedEntries.length} sélectionné(s)</span>
          <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void download(selectedEntries)}>Télécharger</Button>
          {single && !isDir(single) && (
            <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(single.path)}>Éditer</Button>
          )}
          {single && <Button size="sm" variant="ghost" onClick={() => void rename(single)}>Renommer (F2)</Button>}
          {single && <Button size="sm" variant="ghost" icon={<Shield size={13} />} onClick={() => setChmodOf(single)}>Permissions</Button>}
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void remove(selectedEntries)}>Supprimer</Button>
        </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto select-none" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
        {error ? (
          <EmptyState icon={<Folder size={36} />} title="Impossible d'ouvrir ce dossier">{error}</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">Nom</th>
                <th className="w-24 px-3 py-1.5 text-right font-medium">Taille</th>
                <th className="w-40 px-3 py-1.5 font-medium">Modifié</th>
                <th className="w-28 px-3 py-1.5 font-medium">Droits</th>
                <th className="w-32 px-3 py-1.5 font-medium">Propriétaire</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.path}
                  onClick={(ev) => onRowClick(ev, e)}
                  onDoubleClick={() => activate(e)}
                  className={`cursor-default border-b border-border/40 ${selected.has(e.path) ? "bg-accent/15" : "hover:bg-white/[0.03]"}`}
                >
                  <td className="px-3 py-1">
                    <span className="flex items-center gap-2">
                      {e.kind === "symlink" ? (
                        <Link2 size={15} className={e.targetIsDir ? "text-accent" : "text-muted"} />
                      ) : isDir(e) ? (
                        <Folder size={15} className="text-accent" />
                      ) : (
                        <File size={15} className="text-muted" />
                      )}
                      <span className="truncate">{e.name}</span>
                    </span>
                  </td>
                  <td className="px-3 py-1 text-right text-xs text-muted tabular-nums">{isDir(e) ? "" : formatBytes(e.size)}</td>
                  <td className="px-3 py-1 text-xs text-muted tabular-nums">
                    {e.modified ? new Date(e.modified * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : ""}
                  </td>
                  <td className="px-3 py-1 font-mono text-xs text-muted">{e.permissions}</td>
                  <td className="px-3 py-1 text-xs text-muted">{e.owner}{e.group && e.group !== e.owner ? `:${e.group}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!error && listing && entries.length === 0 && <p className="p-6 text-center text-sm text-muted">Dossier vide</p>}
      </div>

      {transfers.length > 0 && (
        <div className="shrink-0 border-t border-border bg-panel px-3 py-2">
          {transfers.map((t) => {
            const pct = t.progress && t.progress.total ? Math.round((t.progress.done / t.progress.total) * 100) : null;
            return (
              <div key={t.id} className="flex items-center gap-3 py-1 text-xs">
                <span className="w-72 truncate">{t.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded bg-border">
                  <div
                    className={`h-full transition-all ${t.state === "error" ? "bg-danger" : t.state === "done" ? "bg-ok" : "bg-accent"}`}
                    style={{ width: t.state === "done" ? "100%" : `${pct ?? 5}%` }}
                  />
                </div>
                <span className="w-64 truncate text-muted">
                  {t.state === "error" ? t.message : t.state === "done" ? "Terminé" : t.progress ? `${t.progress.file.split(/[\\/]/).pop()} · ${formatBytes(t.progress.done)}` : "…"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10">
          <div className="rounded-lg bg-panel px-4 py-3 text-sm shadow-xl">Déposer pour envoyer dans <span className="font-mono">{cwd}</span></div>
        </div>
      )}

      {editing && (
        <Suspense fallback={null}>
          <FileEditor serverId={serverId} path={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
      {chmodOf && <ChmodDialog entry={chmodOf} onClose={() => setChmodOf(null)} onApply={(mode) => act(() => api.fsChmod(serverId, chmodOf.path, mode))} />}
    </div>
  );
}

function ChmodDialog({ entry, onClose, onApply }: { entry: FsEntry; onClose: () => void; onApply: (mode: number) => Promise<void> }) {
  const [mode, setMode] = useState(entry.mode & 0o777);
  const who = [
    ["Propriétaire", 6],
    ["Groupe", 3],
    ["Autres", 0],
  ] as const;
  const perms = [
    ["Lecture", 4],
    ["Écriture", 2],
    ["Exécution", 1],
  ] as const;
  return (
    <Modal
      title={`Permissions de ${entry.name}`}
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          onClick={async () => {
            await onApply(mode | (entry.mode & 0o7000));
            onClose();
          }}
        >
          Appliquer
        </Button>
      }
    >
      <table className="mb-4 w-full text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th />
            {perms.map(([label]) => <th key={label} className="pb-2 font-medium">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {who.map(([label, shift]) => (
            <tr key={label}>
              <td className="py-1.5 text-muted">{label}</td>
              {perms.map(([p, bit]) => (
                <td key={p} className="text-center">
                  <input
                    type="checkbox"
                    aria-label={`${label} ${p}`}
                    checked={(mode & (bit << shift)) !== 0}
                    onChange={(e) => setMode((m) => (e.target.checked ? m | (bit << shift) : m & ~(bit << shift)))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Field label="Mode octal">
        <Input
          className="font-mono"
          value={mode.toString(8).padStart(3, "0")}
          onChange={(e) => /^[0-7]{0,3}$/.test(e.target.value) && setMode(parseInt(e.target.value || "0", 8))}
        />
      </Field>
    </Modal>
  );
}
