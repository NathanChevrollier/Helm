// Recherche de fichiers et de texte sur le serveur (Ctrl+P dans l'explorateur).
// `find` et `grep` tournent à distance : chercher dans un dossier de plusieurs gigaoctets ne fait
// transiter que les résultats, jamais les fichiers.
import { useEffect, useRef, useState } from "react";
import { File, Folder, Search, Type } from "lucide-react";
import { api, errorMessage, formatBytes, type FsHit, type FsMatch } from "../lib/api";
import { Button, Input, Modal } from "./ui";

type Mode = "name" | "text";

export default function FileSearch({
  serverId,
  root,
  onClose,
  onOpenFolder,
  onOpenFile,
}: {
  serverId: string;
  /** Dossier où commence la recherche (celui affiché par l'explorateur). */
  root: string;
  onClose: () => void;
  /** Aller dans un dossier et le sélectionner. */
  onOpenFolder: (path: string) => void;
  /** Ouvrir un fichier dans l'éditeur, éventuellement sur une ligne donnée. */
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [mode, setMode] = useState<Mode>("name");
  const [query, setQuery] = useState("");
  const [glob, setGlob] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<FsHit[] | null>(null);
  const [matches, setMatches] = useState<FsMatch[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), [mode]);

  const search = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(null);
    setHits(null);
    setMatches(null);
    try {
      if (mode === "name") {
        const r = await api.fsFind(serverId, root, query);
        setHits(r.items);
        setTruncated(r.truncated);
      } else {
        const r = await api.fsGrep(serverId, root, query, glob.trim() || null, caseSensitive, regex);
        setMatches(r.items);
        setTruncated(r.truncated);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const count = hits?.length ?? matches?.length ?? null;

  return (
    <Modal title={`Chercher dans ${root || "/"}`} width="max-w-4xl" onClose={onClose}>
      <div className="mb-3 flex gap-1">
        <Button size="sm" variant={mode === "name" ? "primary" : "outline"} icon={<File size={13} />} onClick={() => setMode("name")}>
          Par nom
        </Button>
        <Button size="sm" variant={mode === "text" ? "primary" : "outline"} icon={<Type size={13} />} onClick={() => setMode("text")}>
          Dans le contenu
        </Button>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            className="flex-1 font-mono text-sm"
            placeholder={mode === "name" ? "nginx.conf, *.log…" : "texte à chercher"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={busy} icon={<Search size={14} />}>
            Chercher
          </Button>
        </div>
        {mode === "text" && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <label className="flex items-center gap-1">
              Fichiers :
              <Input className="!h-7 !w-32 font-mono text-xs" placeholder="*.conf" value={glob} onChange={(e) => setGlob(e.target.value)} />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
              Respecter la casse
            </label>
            <label className="flex items-center gap-1" title="Sinon le texte est cherché littéralement : un point reste un point.">
              <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
              Expression régulière
            </label>
          </div>
        )}
      </form>

      <p className="mt-2 text-xs text-muted">
        {mode === "name"
          ? "La recherche parcourt jusqu'à 10 niveaux de sous-dossiers ; /proc, /sys, node_modules et .git sont ignorés."
          : "grep tourne sur le serveur : les fichiers binaires et les dossiers node_modules, .git sont écartés."}
      </p>

      {error && <pre className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}

      {count !== null && (
        <div className="mt-3 border-t border-border pt-2">
          <p className="mb-1 text-xs text-muted">
            {count} résultat(s){truncated && " · liste tronquée, affine la recherche"}
          </p>
          <div className="max-h-96 overflow-auto">
            {hits?.map((h) => (
              <button
                key={h.path}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-hover"
                onClick={() => {
                  onClose();
                  h.isDir ? onOpenFolder(h.path) : onOpenFile(h.path);
                }}
              >
                {h.isDir ? <Folder size={13} className="shrink-0 text-accent" /> : <File size={13} className="shrink-0 text-muted" />}
                <span className="min-w-0 flex-1 truncate font-mono">{h.path}</span>
                <span className="shrink-0 text-muted tabular-nums">{h.isDir ? "" : formatBytes(h.size)}</span>
              </button>
            ))}
            {matches?.map((m, i) => (
              <button
                key={`${m.path}:${m.line}:${i}`}
                className="flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left text-xs hover:bg-hover"
                onClick={() => {
                  onClose();
                  onOpenFile(m.path, m.line);
                }}
              >
                <span className="truncate font-mono text-muted">
                  {m.path}:{m.line}
                </span>
                <span className="truncate font-mono">{m.text}</span>
              </button>
            ))}
            {count === 0 && <p className="px-2 py-3 text-xs text-muted">Aucun résultat.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}
