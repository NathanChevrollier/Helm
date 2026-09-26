// Recherche inversée dans l'historique du shell distant (Ctrl+R).
//
// Helm lit les fichiers d'historique que le shell tient déjà : rien n'est installé sur le serveur.
// La recherche est approximative (« dcps » trouve « docker compose ps »), les commandes habituelles
// remontent, et la durée d'exécution s'affiche quand le shell l'a enregistrée — zsh en mode
// EXTENDED_HISTORY le fait, bash jamais. Helm ne l'invente pas dans les autres cas.
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, History, Repeat } from "lucide-react";
import { api, errorMessage, formatDuration, type ShellHistoryEntry } from "../lib/api";
import { rankCommands } from "../lib/fuzzy";
import { Input, Modal } from "./ui";

/** Il y a combien de temps, en clair. */
function ago(last: number | null): string {
  if (!last) return "";
  const secs = Date.now() / 1000 - last;
  if (secs < 90) return "à l'instant";
  if (secs < 5400) return `il y a ${Math.round(secs / 60)} min`;
  if (secs < 172800) return `il y a ${Math.round(secs / 3600)} h`;
  return `il y a ${Math.round(secs / 86400)} j`;
}

/** Commande avec les lettres trouvées mises en évidence. */
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const marked = new Set(positions);
  return (
    <>
      {[...text].map((c, i) => (
        <span key={i} className={marked.has(i) ? "text-accent" : undefined}>
          {c}
        </span>
      ))}
    </>
  );
}

export default function HistoryPalette({
  serverId,
  onClose,
  onPick,
}: {
  serverId: string;
  onClose: () => void;
  /** Commande choisie : envoyée telle quelle au terminal, ou seulement écrite sans être lancée. */
  onPick: (command: string, run: boolean) => void;
}) {
  const [entries, setEntries] = useState<ShellHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.termHistory(serverId).then(
      (l) => !cancelled && setEntries(l),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const results = useMemo(() => rankCommands(entries ?? [], query).slice(0, 200), [entries, query]);
  // Une nouvelle recherche repart du premier résultat.
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, results]);

  const choose = (run: boolean) => {
    const pick = results[cursor];
    if (pick) onPick(pick.item.command, run);
  };

  return (
    <Modal title="Historique du shell" width="max-w-3xl" onClose={onClose}>
      <div
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, results.length - 1));
          } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            // Maj+Entrée écrit la commande sans la lancer : de quoi la relire ou la corriger.
            choose(!e.shiftKey);
          } else if (e.key === "Tab") {
            e.preventDefault();
            choose(false);
          }
        }}
      >
        <Input
          className="font-mono"
          placeholder="Chercher une commande… (dcps trouve docker compose ps)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <p className="mt-1.5 text-[11px] text-muted">
          ↑ ↓ pour choisir · Entrée pour lancer · Maj+Entrée ou Tab pour écrire sans lancer
        </p>

        {error && <pre className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}
        {entries === null && !error && <p className="mt-3 text-sm text-muted">Lecture de l'historique…</p>}
        {entries !== null && entries.length === 0 && (
          <p className="mt-3 text-sm text-muted">
            Aucun historique lisible sur ce serveur. Helm lit <span className="font-mono">~/.bash_history</span>,{" "}
            <span className="font-mono">~/.zsh_history</span> et l'historique de fish ; le shell ne les écrit parfois qu'à la déconnexion.
          </p>
        )}

        <div ref={listRef} className="mt-2 max-h-[55vh] overflow-auto">
          {results.map((r, i) => (
            <button
              key={r.item.command}
              data-selected={i === cursor}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${i === cursor ? "bg-accent/15" : "hover:bg-hover"}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(r.item.command, true)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                <Highlighted text={r.item.command} positions={r.positions} />
              </span>
              {r.item.count > 1 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted" title={`${r.item.count} fois dans l'historique`}>
                  <Repeat size={9} />
                  {r.item.count}
                </span>
              )}
              {/* Seul zsh en mode étendu enregistre la durée : elle n'apparaît donc pas partout. */}
              {r.item.duration != null && (
                <span className="shrink-0 text-[10px] text-warn" title="Durée de la dernière exécution">
                  {formatDuration(r.item.duration)}
                </span>
              )}
              <span className="w-24 shrink-0 text-right text-[10px] text-muted">{ago(r.item.last)}</span>
              {i === cursor && <CornerDownLeft size={11} className="shrink-0 text-accent" />}
            </button>
          ))}
          {entries !== null && entries.length > 0 && results.length === 0 && (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted">
              <History size={13} /> Aucune commande ne correspond.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
