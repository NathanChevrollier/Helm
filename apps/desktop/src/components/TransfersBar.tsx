import { X } from "lucide-react";
import { formatBytes } from "../lib/api";
import { cancel, useTransfers } from "../lib/transfers";
import { IconButton } from "./ui";

/** Transferts de fichiers en cours (explorateur, dépôt dans un terminal), annulables. */
export default function TransfersBar() {
  const list = useTransfers((s) => s.list);
  const remove = useTransfers((s) => s.remove);
  if (list.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-border bg-panel px-3 py-2">
      {list.map((t) => {
        const pct = t.progress && t.progress.total ? Math.round((t.progress.done / t.progress.total) * 100) : null;
        return (
          <div key={t.id} className="flex items-center gap-3 py-1 text-xs">
            <span className="w-80 truncate" title={t.label}>{t.label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-border">
              <div
                className={`h-full transition-all ${t.state === "error" ? "bg-danger" : t.state === "done" ? "bg-ok" : t.state === "cancelled" ? "bg-muted" : "bg-accent"}`}
                style={{ width: t.state === "done" ? "100%" : `${pct ?? 5}%` }}
              />
            </div>
            <span className="w-64 truncate text-muted" title={t.message}>
              {t.state === "error" || t.state === "cancelled" ? t.message : t.state === "done" ? "Terminé" : t.progress ? `${t.progress.file.split(/[\\/]/).pop()} · ${formatBytes(t.progress.done)}` : "…"}
            </span>
            {t.state === "running" ? (
              <IconButton title="Annuler" onClick={() => cancel(t.id)}>
                <X size={13} />
              </IconButton>
            ) : t.state === "error" ? (
              <IconButton title="Masquer" onClick={() => remove(t.id)}>
                <X size={13} />
              </IconButton>
            ) : (
              <span className="w-7" />
            )}
          </div>
        );
      })}
    </div>
  );
}
