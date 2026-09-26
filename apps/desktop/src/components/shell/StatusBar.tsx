// Barre d'état : serveur actif, transferts en cours, synchronisation et raccourcis utiles.
import { ArrowDownUp, CloudCheck, CloudOff, Keyboard, Loader2 } from "lucide-react";
import { useApp } from "../../lib/store";
import { useShell } from "../../lib/shell";
import { useTransfers } from "../../lib/transfers";
import { useSync } from "../../lib/sync";
import { display, shortcutOf } from "../../lib/shortcuts";
import { FOCUS_RING, StatusDot } from "../ui";

export default function StatusBar() {
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  const transfers = useTransfers((s) => s.list);
  const running = transfers.filter((t) => t.state === "running");
  const sync = useSync();
  const setShortcuts = useShell((s) => s.setShortcutsOpen);
  const pct = running.length === 1 && running[0].progress && running[0].progress.total > 0 ? Math.round((running[0].progress.done / running[0].progress.total) * 100) : null;

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 border-t border-border bg-rail px-3.5 text-[11.5px] text-muted">
      {server ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusDot tone={server.connected ? "ok" : "muted"} />
          <span className="truncate font-mono">
            {server.username}@{server.host}:{server.port}
          </span>
          {!server.connected && <span className="text-faint">· non connecté</span>}
        </span>
      ) : (
        <span>Aucun serveur sélectionné</span>
      )}
      {running.length > 0 && (
        <span className="flex min-w-0 items-center gap-1.5 text-fg/80">
          <ArrowDownUp size={12} />
          <span className="truncate">
            {running.length === 1 ? running[0].label : `${running.length} transferts`}
            {pct != null && ` · ${pct} %`}
          </span>
        </span>
      )}
      <span className="flex-1" />
      {sync.running ? (
        <span className="flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Synchronisation…
        </span>
      ) : sync.lastError ? (
        <span className="flex items-center gap-1.5 text-warn" title={sync.lastError}>
          <CloudOff size={12} /> Synchro en échec
        </span>
      ) : (
        sync.last && (
          <span className="flex items-center gap-1.5" title="Réglages synchronisés">
            <CloudCheck size={12} /> Synchronisé
          </span>
        )
      )}
      <button type="button" onClick={() => setShortcuts(true)} className={`flex items-center gap-1.5 rounded font-mono hover:text-fg ${FOCUS_RING}`}>
        <Keyboard size={12} />
        {display(shortcutOf("palette"))} commandes · {display(shortcutOf("shortcutsHelp"))} raccourcis
      </button>
    </footer>
  );
}
