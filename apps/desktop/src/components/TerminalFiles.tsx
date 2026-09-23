import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUp, Crosshair, Download, File, Folder, FolderInput, FolderOpen, FolderSync, RefreshCw, TextCursorInput, Upload } from "lucide-react";
import { api, errorMessage, formatBytes, shellQuote, type FsEntry } from "../lib/api";
import { paneCwd, usePanes } from "../lib/panes";
import { track } from "../lib/transfers";
import { useApp, useAppPick } from "../lib/store";
import { usePolling } from "../lib/poll";
import { IconButton, Input } from "./ui";

const FileEditor = lazy(() => import("./FileEditor"));

const isDir = (e: FsEntry) => e.kind === "dir" || e.targetIsDir;

/** Largeur du panneau : réglable à la souris, retenue d'une session à l'autre. */
const WIDTH_KEY = "helm.terminalFiles.width";
const MIN_WIDTH = 200;
const MAX_WIDTH = 900;
const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

function storedWidth(): number {
  const n = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? clampWidth(n) : 288;
}

function parent(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/**
 * Accès rapide aux fichiers du serveur depuis le terminal : suit le dossier courant du shell
 * (cd), permet d'ouvrir, envoyer, télécharger, ou d'insérer un chemin dans la ligne de commande.
 */
export default function TerminalFiles({ paneId, visible }: { paneId: string; visible: boolean }) {
  const { notify, setFilesPath, setSection, setActiveServer } = useAppPick("notify", "setFilesPath", "setSection", "setActiveServer");
  const pane = usePanes((s) => s.panes[paneId]);
  const serverId = pane?.serverId;
  const connected = useApp((s) => s.servers.find((x) => x.id === serverId)?.connected ?? false);
  const [path, setPath] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * Lien entre le shell et le panneau :
   * - `terminal` : le panneau suit les « cd » du terminal (par défaut) ;
   * - `panneau`  : c'est le terminal qui suit la navigation du panneau (il fait le « cd ») ;
   * - `aucun`    : les deux avancent chacun de leur côté.
   */
  const [link, setLink] = useState<"terminal" | "panneau" | "aucun">("terminal");
  const follow = link === "terminal";
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** Dernier dossier vu dans le terminal : on ne suit que ses changements (la navigation manuelle reste). */
  const lastCwd = useRef<string | null>(null);
  const [width, setWidth] = useState(storedWidth);

  // Glissement de la poignée gauche : le panneau est à droite, sa largeur suit le bord de l'écran.
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  /** Navigation venue du panneau : elle coupe le suivi du terminal, ou l'y emmène selon le mode. */
  const goTo = (dir: string) => {
    if (link === "terminal") setLink("aucun");
    if (link === "panneau") cdInTerminal(dir);
    void load(dir);
  };

  const load = useCallback(
    async (dir: string) => {
      if (!serverId) return;
      setLoading(true);
      try {
        const l = await api.fsList(serverId, dir);
        setPath(l.path);
        setInput(l.path);
        setEntries([...l.entries].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name)));
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [serverId],
  );

  const syncWithTerminal = useCallback(
    async (force: boolean) => {
      const cwd = await paneCwd(paneId);
      if (!cwd) {
        if (force) notify("Dossier courant du terminal introuvable (serveur non Linux ou terminal déconnecté).", "info");
        if (path === null && serverId) void load((await api.fsHome(serverId).catch(() => "/")) || "/");
        return;
      }
      if (force || cwd !== lastCwd.current) {
        lastCwd.current = cwd;
        await load(cwd);
      }
    },
    [paneId, path, serverId, load, notify],
  );

  // Changement de panneau actif : on repart de son dossier.
  useEffect(() => {
    lastCwd.current = null;
    setPath(null);
    setEntries([]);
  }, [paneId]);

  // Suit les « cd » du terminal (léger : une commande toutes les 2,5 s, panneau visible seulement).
  usePolling(() => syncWithTerminal(false), 2500, [syncWithTerminal], visible && connected && (follow || path === null));

  const sendToTerminal = (text: string) => {
    const id = usePanes.getState().panes[paneId]?.termId;
    if (id == null) return notify("Le terminal n'est pas connecté.", "info");
    void api.termWrite(id, text);
  };

  /** Ctrl+U : vide la ligne en cours pour qu'un « cd » ne se colle pas à une commande à demi tapée. */
  const cdInTerminal = (dir: string) => sendToTerminal(`\u0015cd ${shellQuote(dir)}\r`);

  const uploadHere = async () => {
    if (!serverId || !path) return;
    const files = await open({ multiple: true, title: `Envoyer dans ${path}` });
    if (!files || !files.length) return;
    const list = Array.isArray(files) ? files : [files];
    const dir = path;
    await track(`Envoi de ${list.length} élément(s) vers ${dir}`, (id, p) => api.fsUpload(serverId, list, dir, id, p));
    if (dir === path) void load(dir);
  };

  const download = async (e: FsEntry) => {
    if (!serverId) return;
    const dir = await open({ directory: true, title: "Dossier de destination" });
    if (typeof dir !== "string") return;
    await track(`Téléchargement de ${e.name}`, async (id, p) => {
      const where = await api.fsDownload(serverId, [e.path], dir, id, p);
      notify(`Téléchargé dans ${where}`, "success");
    });
  };

  if (!serverId) return null;
  const shown = entries.filter((e) => showHidden || !e.name.startsWith("."));

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-border bg-panel" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionner le panneau Fichiers"
        title="Glisser pour redimensionner · double-clic pour la largeur par défaut"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/30"
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWidth(288);
          localStorage.setItem(WIDTH_KEY, "288");
        }}
      />
      <div className="flex items-center gap-0.5 border-b border-border px-2 py-1.5">
        <span className="mr-auto pl-1 text-xs font-semibold tracking-wide text-muted uppercase">Fichiers</span>
        {/* Deux sens possibles, jamais les deux à la fois : sinon chacun tirerait l'autre. */}
        <IconButton
          title={follow ? "Le panneau suit le terminal (cliquer pour arrêter)" : "Faire suivre le terminal par le panneau"}
          aria-pressed={follow}
          className={follow ? "text-accent" : ""}
          onClick={() => {
            const actif = link === "terminal";
            setLink(actif ? "aucun" : "terminal");
            if (!actif) void syncWithTerminal(true);
          }}
        >
          <Crosshair size={14} />
        </IconButton>
        <IconButton
          title={link === "panneau" ? "Le terminal suit le panneau (cliquer pour arrêter)" : "Faire suivre le panneau par le terminal (cd automatique)"}
          aria-pressed={link === "panneau"}
          className={link === "panneau" ? "text-accent" : ""}
          onClick={() => {
            const actif = link === "panneau";
            setLink(actif ? "aucun" : "panneau");
            if (!actif && path) cdInTerminal(path);
          }}
        >
          <FolderSync size={14} />
        </IconButton>
        <IconButton title="Envoyer des fichiers ici" disabled={!path} onClick={() => void uploadHere()}>
          <Upload size={14} />
        </IconButton>
        <IconButton title="Ouvrir dans l'explorateur Fichiers" disabled={!path} onClick={() => {
          if (!path) return;
          setActiveServer(serverId);
          setFilesPath(serverId, path);
          setSection("files");
        }}>
          <FolderOpen size={14} />
        </IconButton>
        <IconButton title="Actualiser" onClick={() => path && void load(path)}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>
      <form
        className="flex items-center gap-1 border-b border-border px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          goTo(input.trim() || "/");
        }}
      >
        <IconButton title="Dossier parent" type="button" disabled={!path || path === "/"} onClick={() => path && goTo(parent(path))}>
          <ArrowUp size={14} />
        </IconButton>
        <Input className="h-7 font-mono text-xs" value={input} onChange={(e) => setInput(e.target.value)} placeholder="/chemin" />
        <IconButton title="Aller à ce dossier dans le terminal (cd)" type="button" disabled={!path} onClick={() => path && cdInTerminal(path)}>
          <FolderInput size={14} />
        </IconButton>
      </form>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {!connected && <p className="p-3 text-xs text-muted">Terminal non connecté.</p>}
        {error && <p className="p-3 text-xs text-danger">{error}</p>}
        {shown.map((e) => (
          <div
            key={e.path}
            className="group flex cursor-default items-center gap-2 px-2 py-[3px] text-[13px] hover:bg-hover"
            onDoubleClick={() => (isDir(e) ? goTo(e.path) : setEditing(e.path))}
            title={isDir(e) ? "Double-clic : ouvrir le dossier" : `${formatBytes(e.size)} · double-clic : éditer`}
          >
            {isDir(e) ? <Folder size={14} className="shrink-0 text-accent" /> : <File size={14} className="shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            <span className="flex opacity-0 group-hover:opacity-100">
              <IconButton title="Insérer le chemin dans la ligne de commande" className="size-6" onClick={() => sendToTerminal(`${shellQuote(e.path)} `)}>
                <TextCursorInput size={13} />
              </IconButton>
              {isDir(e) ? (
                <IconButton title="Ouvrir ce dossier dans le terminal (cd)" className="size-6" onClick={() => cdInTerminal(e.path)}>
                  <FolderInput size={13} />
                </IconButton>
              ) : (
                <IconButton title="Télécharger" className="size-6" onClick={() => void download(e)}>
                  <Download size={13} />
                </IconButton>
              )}
            </span>
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted">
        <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
        Fichiers cachés
        <span className="ml-auto truncate" title="Glisse des fichiers de Windows sur le terminal : ils sont envoyés dans son dossier courant.">
          Glisser sur le terminal : envoi
        </span>
      </label>
      {editing && (
        <Suspense fallback={null}>
          <FileEditor serverId={serverId} path={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
    </aside>
  );
}

