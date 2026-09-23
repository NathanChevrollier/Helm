import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Pause, Play, ScrollText, Search, Square, Trash2, X } from "lucide-react";
import { api, errorMessage, type LogSource } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, Input } from "../components/ui";
import PageLayout from "../components/PageLayout";

const MAX_LINES = 20_000;
const SHOWN = 2_000;
/** Couleurs des étiquettes de source (texte des lignes toujours en couleur neutre). */
const TAG_COLORS = ["#3987e5", "#d95926", "#1baf7a", "#c98500", "#d55181", "#9085e9", "#e66767", "#39c5cf"];
const ERROR_RE = /\b(error|err|fatal|crit|critical|emerg|alert|panic|exception|failed|échec)\b|\s5\d\d\s/i;
const WARN_RE = /\b(warn|warning|avertissement)\b|\s4\d\d\s/i;

interface Line {
  id: number;
  source: number;
  text: string;
  at: number;
}

export default function LogsView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<ScrollText size={40} />} title="Aucun serveur sélectionné" />;
  return <Logs key={serverId} serverId={serverId} />;
}

function Logs({ serverId }: { serverId: string }) {
  const notify = useApp((s) => s.notify);
  const serverName = useApp((s) => s.servers.find((x) => x.id === serverId)?.name);
  const [available, setAvailable] = useState<{ containers: string[]; units: string[]; files: string[] } | null>(null);
  const [chosen, setChosen] = useState<LogSource[]>([]);
  const [streamId, setStreamId] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [ended, setEnded] = useState<Record<number, string | null>>({});
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  /** Recherche dans la liste des sources (colonne de gauche). */
  const [sourceQuery, setSourceQuery] = useState("");
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const [follow, setFollow] = useState(true);
  const buffer = useRef<Line[]>([]);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const running = streamId != null;

  useEffect(() => {
    void ensureConnected(serverId).then((ok) => {
      if (ok) void api.logSources(serverId).then(setAvailable, (e) => notify(errorMessage(e), "error"));
    });
  }, [serverId, notify]);

  // Les lignes reçues sont regroupées et affichées au plus 5 fois par seconde.
  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current || buffer.current.length === 0) return;
      const incoming = buffer.current;
      buffer.current = [];
      setLines((prev) => {
        const next = prev.concat(incoming);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }, 200);
    return () => clearInterval(id);
  }, []);

  const stop = useCallback(async () => {
    if (streamId != null) await api.logsStop(streamId).catch(() => {});
    setStreamId(null);
  }, [streamId]);

  // Arrêt du suivi en quittant la vue : aucune commande ne reste active sur le serveur.
  const streamRef = useRef<number | null>(null);
  streamRef.current = streamId;
  useEffect(() => () => void (streamRef.current != null && api.logsStop(streamRef.current)), []);

  const start = async () => {
    await stop();
    setLines([]);
    setEnded({});
    buffer.current = [];
    try {
      const id = await api.logsStart(serverId, chosen, 200, (e) => {
        if (e.type === "lines") {
          const now = Date.now();
          for (const l of e.lines) buffer.current.push({ id: ++seq.current, source: l.source, text: l.text, at: now });
        } else {
          setEnded((x) => ({ ...x, [e.source]: e.error }));
        }
      });
      setStreamId(id);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const toggle = (src: LogSource) => {
    setChosen((c) => (c.some((x) => x.kind === src.kind && x.name === src.name) ? c.filter((x) => !(x.kind === src.kind && x.name === src.name)) : [...c, src]));
  };

  const matcher = useMemo(() => {
    if (!filter) return null;
    try {
      return new RegExp(filter, "i");
    } catch {
      const f = filter.toLowerCase();
      return { test: (s: string) => s.toLowerCase().includes(f) };
    }
  }, [filter]);

  const visible = useMemo(() => {
    const out = lines.filter(
      (l) => (!matcher || matcher.test(l.text)) && (level === "all" || ERROR_RE.test(l.text) || (level === "warn" && WARN_RE.test(l.text))),
    );
    return out.slice(-SHOWN);
  }, [lines, matcher, level]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [visible, follow]);

  const label = (s: LogSource) => (s.kind === "file" ? s.name.replace("/var/log/", "") : s.kind === "unit" ? s.name.replace(/\.service$/, "") : s.name);

  /** Sources correspondant à la recherche ; celles déjà cochées restent visibles. */
  const filtrer = (names: string[]) => {
    const q = sourceQuery.trim().toLowerCase();
    return q ? names.filter((n) => n.toLowerCase().includes(q) || chosen.some((c) => c.name === n)) : names;
  };

  const exportLogs = async () => {
    const path = await save({ title: "Exporter les journaux", defaultPath: `journaux-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log` });
    if (!path) return;
    const content = visible.map((l) => `[${label(chosen[l.source])}] ${l.text}`).join("\n");
    try {
      await api.saveTextFile(path, content);
      notify(`Exporté : ${path}`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const Group = ({ title, kind, names }: { title: string; kind: LogSource["kind"]; names: string[] }) =>
    names.length ? (
      <div>
        <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</div>
        {names.map((n) => {
          const on = chosen.some((c) => c.kind === kind && c.name === n);
          return (
            <label key={n} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-hover">
              <input type="checkbox" checked={on} disabled={running} onChange={() => toggle({ kind, name: n })} />
              <span className="truncate" title={n}>{label({ kind, name: n })}</span>
            </label>
          );
        })}
      </div>
    ) : null;

  return (
    <PageLayout
      context={serverName}
      title="Journaux"
      subtitle="Conteneurs, services et fichiers suivis en direct, fusionnés par horodatage."
      guide="logs"
      scroll={false}
    >
    <div className="flex min-h-0 w-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
        <div className="border-b border-border px-3 py-2.5">
          <p className="mb-2 text-xs text-muted">Coche les sources à suivre en direct (12 au plus).</p>
          {/* Un serveur bien rempli propose des dizaines de services : la recherche évite de
              parcourir toute la liste pour trouver « nginx » ou « postgres ». */}
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2">
            <Search size={13} className="shrink-0 text-muted" />
            <Input
              className="h-8 border-0 bg-transparent px-0 text-xs focus:border-0 focus-visible:ring-0"
              placeholder="Chercher une source…"
              value={sourceQuery}
              onChange={(e) => setSourceQuery(e.target.value)}
            />
            {sourceQuery && (
              <button className="text-muted hover:text-fg" aria-label="Effacer la recherche" onClick={() => setSourceQuery("")}>
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
          {!available ? (
            <p className="text-xs text-muted">Recherche des sources…</p>
          ) : (
            <>
              <Group title="Conteneurs" kind="docker" names={filtrer(available.containers)} />
              <Group title="Services" kind="unit" names={filtrer(available.units)} />
              <Group title="Fichiers" kind="file" names={filtrer(available.files)} />
              {[available.containers, available.units, available.files].every((l) => filtrer(l).length === 0) && (
                <p className="text-xs text-muted">Aucune source ne correspond à « {sourceQuery} ».</p>
              )}
            </>
          )}
        </div>
        <div className="border-t border-border p-3">
          {running ? (
            <Button className="w-full" variant="danger" icon={<Square size={13} />} onClick={() => void stop()}>
              Arrêter le suivi
            </Button>
          ) : (
            <Button className="w-full" variant="primary" icon={<Play size={13} />} disabled={!chosen.length || chosen.length > 12} onClick={() => void start()}>
              Suivre {chosen.length || ""} source(s)
            </Button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Input className="!w-72 font-mono text-xs" placeholder="Filtrer (texte ou regex)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="flex rounded-md border border-border p-0.5 text-xs">
            {(
              [
                ["all", "Tout"],
                ["warn", "Avert. + erreurs"],
                ["error", "Erreurs"],
              ] as const
            ).map(([id, l]) => (
              <button key={id} onClick={() => setLevel(id)} className={`rounded px-2 py-0.5 ${level === id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}>
                {l}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Suivre la fin
          </label>
          <span className="ml-auto text-xs text-muted">
            {visible.length} ligne(s) affichée(s){lines.length > visible.length ? ` sur ${lines.length}` : ""}
          </span>
          <IconButton title={paused ? "Reprendre" : "Pause"} disabled={!running} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </IconButton>
          <IconButton title="Vider" onClick={() => setLines([])}>
            <Trash2 size={14} />
          </IconButton>
          <IconButton title="Exporter" disabled={!visible.length} onClick={() => void exportLogs()}>
            <Download size={14} />
          </IconButton>
        </div>
        {Object.keys(ended).length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-border px-3 py-1.5 text-xs">
            {Object.entries(ended).map(([i, e]) => (
              <Badge key={i} tone={e ? "danger" : "muted"}>
                {label(chosen[Number(i)])} : {e ? `arrêté (${e})` : "terminé"}
              </Badge>
            ))}
          </div>
        )}
        <div ref={box} className="min-h-0 flex-1 overflow-auto bg-bg px-3 py-2 font-mono text-xs leading-5 select-text" onWheel={() => setFollow(false)}>
          {!running && lines.length === 0 && <EmptyState icon={<ScrollText size={36} />} title="Choisis des sources puis lance le suivi" />}
          {visible.map((l) => (
            <div key={l.id} className={`flex gap-2 whitespace-pre-wrap break-all ${ERROR_RE.test(l.text) ? "bg-danger/10" : ""}`}>
              <span className="shrink-0 font-sans text-[10px] leading-5 font-semibold" style={{ color: TAG_COLORS[l.source % TAG_COLORS.length] }}>
                {label(chosen[l.source] ?? { kind: "file", name: "?" })}
              </span>
              <span className="text-fg/90">{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
    </PageLayout>
  );
}
