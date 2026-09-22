import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Pencil, Trash2 } from "lucide-react";
import { useApp } from "../lib/store";
import { IconButton } from "./ui";

/** Demande un nom de dossier (création ou renommage). `null` si annulé ou vide. */
export async function askFolderName(title: string, initial = ""): Promise<string | null> {
  const v = await useApp.getState().ask({ title, input: { label: "Nom du dossier", initial }, confirmLabel: "Valider" });
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Bascule l'état replié d'un dossier (`key` unique, ex. `servers:Prod`). */
export function toggleCollapsed(key: string) {
  useApp.getState().setFolders((f) => ({
    ...f,
    collapsed: f.collapsed.includes(key) ? f.collapsed.filter((k) => k !== key) : [...f.collapsed, key],
  }));
}

/**
 * Section de dossier repliable, et cible de dépôt (`data-drop`) pour y glisser des éléments.
 * `name` vide : éléments hors dossier (ni renommage ni suppression).
 */
export function FolderSection({
  collapseKey,
  name,
  count,
  onRename,
  onDelete,
  children,
}: {
  collapseKey: string;
  name: string;
  count: number;
  onRename?: () => void;
  onDelete?: () => void;
  children: ReactNode;
}) {
  const collapsed = useApp((s) => s.folders.collapsed.includes(collapseKey));
  const Icon = collapsed ? Folder : FolderOpen;
  return (
    <section className="rounded-lg" data-drop={name}>
      <div className="group/folder mb-2 flex items-center gap-2 rounded-md px-1 py-1 text-sm">
        <button className="flex min-w-0 items-center gap-2 text-left" onClick={() => toggleCollapsed(collapseKey)}>
          {collapsed ? <ChevronRight size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
          <Icon size={15} className={name ? "text-accent" : "text-muted"} />
          <span className={`truncate font-medium ${name ? "" : "text-muted"}`}>{name || "Sans dossier"}</span>
          <span className="text-xs text-muted">{count}</span>
        </button>
        {name && (
          <span className="flex opacity-0 transition-opacity group-hover/folder:opacity-100">
            {onRename && (
              <IconButton title="Renommer le dossier" className="size-6" onClick={onRename}>
                <Pencil size={12} />
              </IconButton>
            )}
            {onDelete && (
              <IconButton title="Supprimer le dossier (son contenu revient hors dossier)" className="size-6" onClick={onDelete}>
                <Trash2 size={12} />
              </IconButton>
            )}
          </span>
        )}
      </div>
      {!collapsed && children}
      {!collapsed && count === 0 && (
        <p className="mb-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted">Glisse des éléments ici</p>
      )}
    </section>
  );
}
