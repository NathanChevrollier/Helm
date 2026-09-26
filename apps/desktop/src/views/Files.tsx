import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftRight, ArrowUp, Columns2, Download, Eye, EyeOff, File, FileArchive, FileDiff, FilePlus, Folder, FolderOpen,
  FolderPlus, House, Link2, PackageOpen, Pencil, RefreshCw, Search, Shield, SquareTerminal, Star, Trash2, Upload, X,
} from "lucide-react";
import { api, ARCHIVE_EXTENSIONS, errorMessage, formatBytes, shellQuote, type ArchiveFormat, type FsEntry, type Listing } from "../lib/api";
import { track } from "../lib/transfers";
import TransfersBar from "../components/TransfersBar";
import { useAutoRefresh } from "../lib/refresh";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";
import PageLayout from "../components/PageLayout";

const FileEditor = lazy(() => import("../components/FileEditor"));
const FileSearch = lazy(() => import("../components/FileSearch"));
const DiffView = lazy(() => import("../components/DiffView"));

const isDir = (e: FsEntry) => e.kind === "dir" || e.targetIsDir;

/** Extensions reconnues par « Extraire ici » (mêmes formats que côté Rust). */
const ARCHIVE_SUFFIXES = [
  ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar.zst", ".tar", ".zip", ".gz", ".bz2", ".xz", ".zst",
];

const isArchive = (e: FsEntry) => !isDir(e) && ARCHIVE_SUFFIXES.some((x) => e.name.toLowerCase().endsWith(x));

/** Taille maximale d'un fichier comparé dans la fenêtre de différences. */
const MAX_DIFF_SIZE = 2 * 1024 * 1024;

type PaneId = "left" | "right";

/** État partagé des deux panneaux : serveur, dossier courant, glisser en cours. */
interface PanesState {
  cwd: Record<PaneId, { serverId: string; path: string }>;
  /** Incrémenté pour demander à un panneau de se rafraîchir. */
  version: Record<PaneId, number>;
  drag: { from: PaneId; serverId: string; paths: string[]; label: string; x: number; y: number } | null;
  setCwd: (pane: PaneId, serverId: string, path: string) => void;
  bump: (pane: PaneId) => void;
  setDrag: (drag: PanesState["drag"]) => void;
}

const usePanes = create<PanesState>((set) => ({
  cwd: { left: { serverId: "", path: "" }, right: { serverId: "", path: "" } },
  version: { left: 0, right: 0 },
  drag: null,
  setCwd: (pane, serverId, path) => set((s) => ({ cwd: { ...s.cwd, [pane]: { serverId, path } } })),
  bump: (pane) => set((s) => ({ version: { ...s.version, [pane]: s.version[pane] + 1 } })),
  setDrag: (drag) => set({ drag }),
}));

/**
 * Copie des éléments vers l'autre panneau (autre serveur ou autre dossier), en flux via le PC.
 * Demande confirmation avant d'écraser un élément existant.
 */
async function copyToOther(from: PaneId, serverId: string, paths: string[]) {
  const to: PaneId = from === "left" ? "right" : "left";
  const target = usePanes.getState().cwd[to];
  if (!target.serverId || !target.path) return;
  const { servers, ask } = useApp.getState();
  const dstName = servers.find((s) => s.id === target.serverId)?.name ?? "";
  const label = `Copie de ${paths.length} élément(s) vers ${dstName}:${target.path}`;
  let overwrite = false;
  for (;;) {
    let exists: string | null = null;
    const ok = await track(label, (id, onProgress) =>
      api.fsCopyBetween(serverId, paths, target.serverId, target.path, overwrite, id, onProgress).catch((e) => {
        const msg = errorMessage(e);
        if (msg.startsWith("EXISTS:")) exists = msg.slice(7);
        throw e;
      }),
    );
    if (ok || !exists || overwrite) break;
    const confirm = await ask({
      title: "Élément déjà présent",
      body: `« ${exists} » existe déjà sur ${dstName}. Le remplacer ?`,
      confirmLabel: "Remplacer",
      danger: true,
    });
    if (!confirm) break;
    overwrite = true;
  }
  usePanes.getState().bump(to);
}

export default function FilesView() {
  const { activeServerId, servers } = useAppPick("activeServerId", "servers");
  const [dual, setDual] = useState(false);
  const [rightServer, setRightServer] = useState<string | null>(null);
  const drag = usePanes((s) => s.drag);

  if (!activeServerId) {
    return <EmptyState icon={<FolderOpen size={40} />} title="Aucun serveur sélectionné">Choisis un serveur dans la liste à gauche.</EmptyState>;
  }
  const right = rightServer && servers.some((s) => s.id === rightServer) ? rightServer : activeServerId;

  return (
    <PageLayout
      context={servers.find((s) => s.id === activeServerId)?.name}
      title="Fichiers"
      subtitle="Explorateur SFTP. Le second panneau sert à copier d'un serveur à l'autre."
      guide="files"
      scroll={false}
    >
      <div className="flex min-h-0 w-full flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <Explorer key={`l-${activeServerId}`} serverId={activeServerId} pane="left" dual={dual} onToggleDual={() => setDual((v) => !v)} />
          </div>
          {dual && (
            <div className="min-w-0 flex-1 border-l border-border">
              <Explorer key={`r-${right}`} serverId={right} pane="right" dual onToggleDual={() => setDual(false)} onServerChange={setRightServer} />
            </div>
          )}
        </div>
        <TransfersBar />
        {drag && (
          <div className="pointer-events-none fixed z-50 rounded-md border border-accent bg-panel px-2 py-1 text-xs shadow-xl" style={{ left: drag.x + 12, top: drag.y + 12 }}>
            {drag.label}
          </div>
        )}
      </div>
    </PageLayout>
  );
}

function Explorer({
  serverId,
  pane,
  dual,
  onToggleDual,
  onServerChange,
}: {
  serverId: string;
  pane: PaneId;
  dual: boolean;
  onToggleDual: () => void;
  onServerChange?: (id: string) => void;
}) {
  const { notify, ask, openTab, servers, filesPaths, setFilesPath, addBookmark, removeBookmark, renameBookmark, settings, setSettings } = useAppPick("notify", "ask", "openTab", "servers", "filesPaths", "setFilesPath", "addBookmark", "removeBookmark", "renameBookmark", "settings", "setSettings");
  const bookmarks = useApp((s) => s.bookmarks[serverId]) ?? [];
  const root = useRef<HTMLDivElement>(null);
  const version = usePanes((s) => s.version[pane]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const showHidden = settings.showHiddenFiles;
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [chmodOf, setChmodOf] = useState<FsEntry | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [miniTerminalOpen, setMiniTerminalOpen] = useState(false);
  const [miniCommand, setMiniCommand] = useState("");
  const [miniOutput, setMiniOutput] = useState<string[]>([]);
  const [miniHistory, setMiniHistory] = useState<string[]>([]);
  const [miniHistoryIndex, setMiniHistoryIndex] = useState(-1);
  const [miniRunning, setMiniRunning] = useState(false);
  const miniInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Ligne a montrer a l'ouverture de l'editeur, venue d'un resultat de recherche. */
  const [editingLine, setEditingLine] = useState<number | undefined>(undefined);
  /** Compression en cours de préparation : les éléments choisis. */
  const [archiving, setArchiving] = useState<string[] | null>(null);
  /** Comparaison de deux fichiers : leurs chemins et leur contenu. */
  const [diff, setDiff] = useState<{ left: string; right: string; original: string; modified: string } | null>(null);

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
        usePanes.getState().setCwd(pane, serverId, l.path);
        if (pane === "left") setFilesPath(serverId, l.path);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [serverId, pane, setFilesPath],
  );

  // Reprend le dernier dossier ouvert sur ce serveur (panneau principal).
  useEffect(() => {
    void load(pane === "left" ? (filesPaths[serverId] ?? "") : "");
    // Chargement initial uniquement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Rafraîchissement demandé par l'autre panneau (après une copie vers celui-ci).
  const cwdRef = useRef("");

  const cwd = listing?.path ?? "";
  cwdRef.current = cwd;
  const refresh = () => void load(cwd);
  const runMiniCommand = async () => {
    const command = miniCommand.trim();
    if (!command || !cwd || miniRunning) return;
    setMiniRunning(true);
    setMiniHistory((history) => [command, ...history.filter((item) => item !== command)].slice(0, 50));
    setMiniHistoryIndex(-1);
    setMiniOutput((output) => [...output, `$ ${command}`]);
    setMiniCommand("");
    try {
      const result = await api.fsExec(serverId, cwd, command);
      const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
      setMiniOutput((lines) => [...lines, output || `(code ${result.exitCode})`].slice(-100));
    } catch (e) {
      setMiniOutput((lines) => [...lines, errorMessage(e)].slice(-100));
    } finally {
      setMiniRunning(false);
      miniInputRef.current?.focus();
    }
  };
  useEffect(() => {
    if (version > 0) void load(cwdRef.current);
  }, [version, load]);
  useAutoRefresh(
    async (auto) => {
      if (!cwdRef.current) return;
      if (!auto) return load(cwdRef.current);
      const dir = cwdRef.current;
      const l = await api.fsList(serverId, dir).catch(() => null);
      if (!l || cwdRef.current !== dir) return;
      setListing(l);
      setSelected((sel) => new Set([...sel].filter((p) => l.entries.some((e) => e.path === p))));
    },
    { serverId },
  );

  // Dossier demandé depuis ailleurs (palette Ctrl+K, raccourci) alors que l'explorateur est déjà ouvert.
  const requested = pane === "left" ? filesPaths[serverId] : undefined;
  useEffect(() => {
    if (requested && cwdRef.current && requested !== cwdRef.current) void load(requested);
  }, [requested, load]);
  const join = (name: string) => (cwd.endsWith("/") ? cwd + name : `${cwd}/${name}`);
  const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

  const entries = useMemo(() => {
    const list = listing?.entries ?? [];
    const f = filter.toLowerCase();
    return list.filter((e) => (showHidden || !e.name.startsWith(".")) && (!f || e.name.toLowerCase().includes(f)));
  }, [listing, showHidden, filter]);

  const selectedEntries = entries.filter((e) => selected.has(e.path));

  const upload = async (paths: string[]) => {
    if (!paths.length || !cwd) return;
    const dir = cwd;
    await track(`Envoi de ${paths.length} élément(s) vers ${dir}`, (id, p) => api.fsUpload(serverId, paths, dir, id, p));
    if (dir === cwd) refresh();
  };

  const download = async (items: FsEntry[]) => {
    if (!items.length) return;
    const dir = await open({ directory: true, title: "Dossier de destination" });
    if (typeof dir !== "string") return;
    await track(`Téléchargement de ${items.length} élément(s)`, async (id, p) => {
      const where = await api.fsDownload(serverId, items.map((i) => i.path), dir, id, p);
      notify(`Téléchargé dans ${where}`, "success");
    });
  };

  // Glisser-déposer depuis l'explorateur Windows.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (useApp.getState().section !== "files") return;
        if (event.payload.type === "over" || event.payload.type === "enter" || event.payload.type === "drop") {
          const { x, y } = event.payload.position;
          const el = document.elementFromPoint(x / window.devicePixelRatio, y / window.devicePixelRatio);
          const mine = !!el && root.current?.contains(el);
          if (!mine) {
            setDragOver(false);
            return;
          }
        }
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
    if (isDir(e)) return void load(e.path);
    setEditingLine(undefined);
    setEditing(e.path);
  };

  const onRowMouseDown = (ev: React.MouseEvent, e: FsEntry) => {
    if (!dual || ev.button !== 0) return;
    const start = { x: ev.clientX, y: ev.clientY };
    const paths = selected.has(e.path) ? [...selected] : [e.path];
    const { setDrag } = usePanes.getState();
    let dragging = false;
    const move = (m: MouseEvent) => {
      if (!dragging && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
      dragging = true;
      setDrag({ from: pane, serverId, paths, label: paths.length > 1 ? `${paths.length} éléments` : e.name, x: m.clientX, y: m.clientY });
    };
    const up = (m: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      if (!dragging) return;
      const target = document.elementFromPoint(m.clientX, m.clientY)?.closest("[data-pane]")?.getAttribute("data-pane");
      if (target && target !== pane) void copyToOther(pane, serverId, paths);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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

  /** Compresse la sélection sur le serveur, sans qu'un octet transite par le PC. */
  const archive = async (paths: string[], name: string, format: ArchiveFormat) => {
    setArchiving(null);
    const dest = join(name);
    try {
      const size = await api.fsArchive(serverId, paths, dest, format);
      notify(`Archive créée : ${name} (${formatBytes(size)})`, "success");
      refresh();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Extrait une archive dans le dossier courant, après avoir montré ce qu'elle contient. */
  const extract = async (e: FsEntry) => {
    const inside = await api.fsArchiveList(serverId, e.path).catch(() => [] as string[]);
    const ok = await ask({
      title: `Extraire ${e.name} ici`,
      body:
        inside.length > 0
          ? `${inside.length} élément(s) seront déposés dans ${cwd}. Les fichiers de même nom seront remplacés.`
          : `Le contenu sera déposé dans ${cwd}. Les fichiers de même nom seront remplacés.`,
      code: inside.slice(0, 40).join("\n") || undefined,
      confirmLabel: "Extraire",
    });
    if (!ok) return;
    await act(() => api.fsExtract(serverId, e.path, cwd));
  };

  /** Compare deux fichiers du serveur côte à côte dans Monaco. */
  const compare = async (a: FsEntry, b: FsEntry) => {
    const tooBig = [a, b].find((x) => x.size > MAX_DIFF_SIZE);
    if (tooBig) return notify(`« ${tooBig.name} » est trop gros pour être comparé (plus de ${formatBytes(MAX_DIFF_SIZE)}).`, "error");
    try {
      const [original, modified] = await Promise.all([api.fsRead(serverId, a.path), api.fsRead(serverId, b.path)]);
      setDiff({ left: a.path, right: b.path, original, modified });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const crumbs = cwd.split("/").filter(Boolean);
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;
  /** Exactement deux fichiers sélectionnés : la comparaison a un sens. */
  const pair = selectedEntries.length === 2 && selectedEntries.every((e) => !isDir(e)) ? selectedEntries : null;

  return (
    <div ref={root} data-pane={pane} className="relative flex h-full flex-col" onKeyDown={(e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Delete") void remove(selectedEntries);
      if (e.key === "F2" && single) void rename(single);
      if (e.key === "Backspace") void load(parentOf(cwd));
      if (e.key === "F5") refresh();
      // Ctrl+P : chercher un fichier ou du texte dans toute l'arborescence.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }} tabIndex={-1}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        {onServerChange && (
          <select
            className="mr-1 h-8 max-w-40 rounded-md border border-border bg-bg px-2 text-xs"
            value={serverId}
            onChange={(e) => onServerChange(e.target.value)}
            aria-label="Serveur du panneau"
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <IconButton title="Dossier parent" onClick={() => void load(parentOf(cwd))} disabled={cwd === "/"}>
          <ArrowUp size={15} />
        </IconButton>
        <IconButton title="Dossier personnel" onClick={() => void load("")}>
          <House size={15} />
        </IconButton>
        <IconButton
          title={bookmarks.some((b) => b.path === cwd) ? "Retirer ce dossier des raccourcis" : "Ajouter ce dossier aux raccourcis"}
          className={bookmarks.some((b) => b.path === cwd) ? "text-warn" : ""}
          disabled={!cwd}
          onClick={() => (bookmarks.some((b) => b.path === cwd) ? removeBookmark(serverId, cwd) : addBookmark(serverId, cwd))}
        >
          <Star size={15} fill={bookmarks.some((b) => b.path === cwd) ? "currentColor" : "none"} />
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
        <IconButton title="Chercher un fichier ou du texte dans l'arborescence (Ctrl+P)" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
        </IconButton>
        <IconButton
          title={miniTerminalOpen ? "Fermer le mini terminal" : "Ouvrir le mini terminal dans ce dossier"}
          className={miniTerminalOpen ? "text-accent" : ""}
          aria-pressed={miniTerminalOpen}
          onClick={() => {
            setMiniTerminalOpen((open) => !open);
            setTimeout(() => miniInputRef.current?.focus(), 0);
          }}
        >
          <SquareTerminal size={15} />
        </IconButton>
        <IconButton title={showHidden ? "Masquer les fichiers cachés" : "Afficher les fichiers cachés"} onClick={() => setSettings({ showHiddenFiles: !showHidden })}>
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </IconButton>
        <IconButton title={dual ? "Fermer le double panneau" : "Double panneau (copie entre serveurs)"} className={dual ? "text-accent" : ""} onClick={onToggleDual}>
          <Columns2 size={15} />
        </IconButton>
      </div>

      {miniTerminalOpen && (
        <div className="shrink-0 border-b border-border bg-panel px-3 py-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void runMiniCommand();
            }}
          >
            <span className="shrink-0 font-mono text-xs text-accent" title={cwd}>
              {cwd || "…"} $
            </span>
            <Input
              ref={miniInputRef}
              className="h-8 flex-1 font-mono text-xs"
              value={miniCommand}
              disabled={!cwd || miniRunning}
              placeholder={cwd ? "Entrer une commande…" : "Chargement du dossier…"}
              onChange={(event) => setMiniCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const next = event.key === "ArrowUp" ? Math.min(miniHistoryIndex + 1, miniHistory.length - 1) : Math.max(miniHistoryIndex - 1, -1);
                setMiniHistoryIndex(next);
                setMiniCommand(next < 0 ? "" : (miniHistory[next] ?? ""));
              }}
              aria-label={`Commande dans ${cwd}`}
            />
            <Button size="sm" type="submit" variant="primary" loading={miniRunning} disabled={!cwd || !miniCommand.trim()}>
              Exécuter
            </Button>
          </form>
          {miniOutput.length > 0 && (
            <pre className="mt-2 max-h-32 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{miniOutput.join("\n")}</pre>
          )}
        </div>
      )}

      {bookmarks.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5" aria-label="Raccourcis">
          <Star size={12} className="mr-1 shrink-0 text-warn" fill="currentColor" />
          {bookmarks.map((b) => (
            <span
              key={b.path}
              className={`group flex shrink-0 items-center rounded-md border text-xs ${b.path === cwd ? "border-accent/50 bg-accent/10 text-fg" : "border-border text-muted hover:text-fg"}`}
            >
              <button
                className="flex items-center gap-1 py-0.5 pr-1 pl-2"
                title={`${b.path} · double-clic pour renommer`}
                onClick={() => void load(b.path)}
                onDoubleClick={async () => {
                  const name = await ask({ title: "Renommer le raccourci", body: b.path, input: { label: "Nom", initial: b.name }, confirmLabel: "Renommer" });
                  if (typeof name === "string" && name.trim()) renameBookmark(serverId, b.path, name.trim());
                }}
              >
                <Folder size={12} /> {b.name}
              </button>
              <button className="invisible px-1 text-muted group-hover:visible hover:text-danger" title="Retirer le raccourci" onClick={() => removeBookmark(serverId, b.path)}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden font-mono text-xs text-muted">
          <button className="rounded px-1 hover:bg-hover hover:text-fg" onClick={() => void load("/")}>/</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <button className="truncate rounded px-1 hover:bg-hover hover:text-fg" onClick={() => void load("/" + crumbs.slice(0, i + 1).join("/"))}>
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
            {entries.length} élément(s) · double-clic pour ouvrir · glisse des fichiers ici pour les envoyer{dual ? " ou vers l'autre panneau pour les copier" : ""}
          </span>
        ) : (
        <>
          <span className="mr-2 text-muted">{selectedEntries.length} sélectionné(s)</span>
          {dual && (
            <Button size="sm" variant="ghost" icon={<ArrowLeftRight size={13} />} onClick={() => void copyToOther(pane, serverId, selectedEntries.map((e) => e.path))}>
              Copier vers l'autre panneau
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void download(selectedEntries)}>Télécharger</Button>
          {single && !isDir(single) && (
            <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => { setEditingLine(undefined); setEditing(single.path); }}>Éditer</Button>
          )}
          {single && isDir(single) && !bookmarks.some((b) => b.path === single.path) && (
            <Button size="sm" variant="ghost" icon={<Star size={13} />} onClick={() => addBookmark(serverId, single.path)}>
              Raccourci
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<FileArchive size={13} />} onClick={() => setArchiving(selectedEntries.map((e) => e.path))}>
            Compresser
          </Button>
          {single && isArchive(single) && (
            <Button size="sm" variant="ghost" icon={<PackageOpen size={13} />} onClick={() => void extract(single)}>
              Extraire ici
            </Button>
          )}
          {pair && (
            <Button size="sm" variant="ghost" icon={<FileDiff size={13} />} onClick={() => void compare(pair[0], pair[1])}>
              Comparer
            </Button>
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
                  onMouseDown={(ev) => onRowMouseDown(ev, e)}
                  onClick={(ev) => onRowClick(ev, e)}
                  onDoubleClick={() => activate(e)}
                  className={`cursor-default border-b border-border/40 ${selected.has(e.path) ? "bg-accent/15" : "hover:bg-hover-soft"}`}
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

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10">
          <div className="rounded-lg bg-panel px-4 py-3 text-sm shadow-xl">Déposer pour envoyer dans <span className="font-mono">{cwd}</span></div>
        </div>
      )}

      {editing && (
        <Suspense fallback={null}>
          <FileEditor
            serverId={serverId}
            path={editing}
            line={editingLine}
            onClose={() => {
              setEditing(null);
              setEditingLine(undefined);
            }}
          />
        </Suspense>
      )}
      {chmodOf && <ChmodDialog entry={chmodOf} onClose={() => setChmodOf(null)} onApply={(mode) => act(() => api.fsChmod(serverId, chmodOf.path, mode))} />}
      {searchOpen && (
        <Suspense fallback={null}>
          <FileSearch
            serverId={serverId}
            root={cwd}
            onClose={() => setSearchOpen(false)}
            onOpenFolder={(path) => void load(path)}
            onOpenFile={(path, line) => {
              // Le dossier du fichier est ouvert derrière l'éditeur : refermer laisse au bon endroit.
              void load(parentOf(path)).then(() => {
                setEditingLine(line);
                setEditing(path);
              });
            }}
          />
        </Suspense>
      )}
      {archiving && <ArchiveDialog paths={archiving} onClose={() => setArchiving(null)} onCreate={archive} />}
      {diff && (
        <Modal title={`${diff.left.split("/").pop()} ↔ ${diff.right.split("/").pop()}`} width="max-w-[95vw]" onClose={() => setDiff(null)}>
          <p className="mb-2 font-mono text-[11px] text-muted">
            {diff.left} ↔ {diff.right}
          </p>
          <div className="h-[70vh]">
            <Suspense fallback={<p className="text-xs text-muted">Chargement du comparateur…</p>}>
              <DiffView original={diff.original} modified={diff.modified} language="plaintext" theme={useApp.getState().settings.theme === "light" ? "vs" : "vs-dark"} />
            </Suspense>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Choix du nom et du format avant de compresser une sélection côté serveur. */
function ArchiveDialog({
  paths,
  onClose,
  onCreate,
}: {
  paths: string[];
  onClose: () => void;
  onCreate: (paths: string[], name: string, format: ArchiveFormat) => Promise<void>;
}) {
  const [format, setFormat] = useState<ArchiveFormat>("targz");
  const [name, setName] = useState("");
  // Le nom proposé vient du serveur : même règle que celle appliquée à la compression.
  useEffect(() => {
    let cancelled = false;
    void api.fsArchiveName(paths, format).then((n) => !cancelled && setName(n));
    return () => {
      cancelled = true;
    };
  }, [paths, format]);

  const FORMATS: { id: ArchiveFormat; label: string; hint: string }[] = [
    { id: "targz", label: "tar.gz", hint: "attendu partout sous Linux, conserve droits et liens" },
    { id: "zip", label: "zip", hint: "s'ouvre sans rien installer sous Windows" },
    { id: "tarzst", label: "tar.zst", hint: "plus rapide et plus compact, demande zstd sur le serveur" },
  ];

  return (
    <Modal
      title={`Compresser ${paths.length > 1 ? `${paths.length} éléments` : paths[0].split("/").pop()}`}
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={!name.trim()} onClick={() => void onCreate(paths, name.trim(), format)}>
          Compresser
        </Button>
      }
    >
      <p className="mb-3 text-xs text-muted">
        La compression a lieu sur le serveur : aucun octet ne transite par ton PC. L'archive est déposée dans le dossier affiché.
      </p>
      <div className="mb-3 flex flex-col gap-1">
        {FORMATS.map((f) => (
          <label key={f.id} className="flex items-center gap-2 text-sm">
            <input type="radio" name="format" checked={format === f.id} onChange={() => setFormat(f.id)} />
            <span className="font-mono">{f.label}</span>
            <span className="text-xs text-muted">— {f.hint}</span>
          </label>
        ))}
      </div>
      <Field label="Nom de l'archive" hint={`Extension attendue : .${ARCHIVE_EXTENSIONS[format]}`}>
        <Input className="font-mono text-sm" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Modal>
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
