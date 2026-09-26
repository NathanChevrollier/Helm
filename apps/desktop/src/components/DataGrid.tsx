// Tableau de résultats SQL : tri et filtres posés depuis l'en-tête, édition d'une cellule sur
// double-clic. L'édition n'est proposée que si Helm connaît la clé primaire de la table affichée —
// sans elle, aucune ligne n'est identifiable de façon sûre et le tableau reste en lecture seule.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Filter as FilterIcon, KeyRound, ListFilter, Maximize2, Trash2, X } from "lucide-react";
import { DB_FILTER_OPS, type DbColumn, type DbFilter, type DbFilterOp, type DbQueryResult } from "../lib/api";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Button, Input } from "./ui";

export interface Sort {
  column: string;
  desc: boolean;
}

/** Les opérateurs qui n'ont pas de valeur à comparer. */
const SANS_VALEUR: DbFilterOp[] = ["IS NULL", "IS NOT NULL"];

export default function DataGrid({
  result,
  columns,
  editable,
  sort,
  onSort,
  filters,
  onFilters,
  onEditCell,
  onDeleteRow,
  onOpenRow,
}: {
  result: DbQueryResult;
  /** Schéma de la table affichée, ou null pour une requête libre. */
  columns: DbColumn[] | null;
  /** Vrai si la table a une clé primaire entièrement présente dans le résultat. */
  editable: boolean;
  sort: Sort | null;
  onSort: (sort: Sort | null) => void;
  filters: DbFilter[];
  onFilters: (filters: DbFilter[]) => void;
  onEditCell: (column: string, rowIndex: number, value: string | null) => void;
  onDeleteRow: (rowIndex: number) => void;
  onOpenRow: (values: (string | null)[]) => void;
}) {
  /** Cellule en cours d'édition, et son brouillon. */
  const [editing, setEditing] = useState<{ row: number; col: number; draft: string; wasNull: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Colonne dont le petit formulaire de filtre est ouvert. */
  const [filterOn, setFilterOn] = useState<{ column: string; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Un nouveau résultat annule toute édition en cours : les indices de ligne ne valent plus rien.
  useEffect(() => setEditing(null), [result]);

  const byName = new Map((columns ?? []).map((c) => [c.name, c]));
  const primary = (columns ?? []).filter((c) => c.primary).map((c) => c.name);

  const headerMenu = (column: string, e: React.MouseEvent, anchor?: DOMRect) => {
    e.preventDefault();
    e.stopPropagation();
    const filtered = filters.some((f) => f.column === column);
    const x = anchor ? anchor.left : e.clientX;
    const y = anchor ? anchor.bottom + 4 : e.clientY;
    setMenu({
      x,
      y,
      items: [
        { label: "Trier croissant", icon: <ArrowUp size={13} />, onClick: () => onSort({ column, desc: false }) },
        { label: "Trier décroissant", icon: <ArrowDown size={13} />, onClick: () => onSort({ column, desc: true }) },
        ...(sort ? ([{ label: "Ne plus trier", icon: <X size={13} />, onClick: () => onSort(null) }] as MenuItem[]) : []),
        "separator",
        ...(columns ? ([{ label: "Filtrer cette colonne…", icon: <FilterIcon size={13} />, onClick: () => setFilterOn({ column, x, y }) }] as MenuItem[]) : []),
        {
          label: "Retirer le filtre",
          icon: <X size={13} />,
          disabled: !filtered,
          onClick: () => onFilters(filters.filter((f) => f.column !== column)),
        },
        ...(filters.length > 1
          ? ([{ label: "Retirer tous les filtres", icon: <ListFilter size={13} />, onClick: () => onFilters([]) }] as MenuItem[])
          : []),
      ],
    });
  };

  const commit = () => {
    if (!editing) return;
    const { row, col, draft, wasNull } = editing;
    setEditing(null);
    const before = result.rows[row]?.[col] ?? null;
    // Réécrire la même valeur ne déclenche aucune requête.
    if (draft === (before ?? "") && !(wasNull && draft === "")) return;
    onEditCell(result.columns[col], row, draft);
  };

  return (
    <>
      <table className="min-w-full text-xs">
        <thead className="sticky top-0 z-10 bg-subtle text-left text-muted">
          <tr>
            <th className="w-14 border-b border-border" />
            {result.columns.map((c, i) => {
              const meta = byName.get(c);
              const active = sort?.column === c;
              const filtered = filters.filter((f) => f.column === c);
              return (
                <th
                  key={i}
                  className="group/th cursor-pointer border-b border-l border-border border-l-line py-1.5 pr-1 pl-3 font-medium whitespace-nowrap select-none hover:bg-hover"
                  title={
                    columns
                      ? `${meta?.dataType ?? "?"}${meta?.primary ? " · clé primaire" : ""}${meta?.nullable === false ? " · NOT NULL" : ""}\nClic : trier · Clic droit : menu`
                      : "Clic : trier"
                  }
                  onClick={() => onSort(active && !sort.desc ? { column: c, desc: true } : active && sort.desc ? null : { column: c, desc: false })}
                  onContextMenu={(e) => headerMenu(c, e)}
                >
                  <span className="inline-flex items-center gap-1">
                    {meta?.primary && <KeyRound size={10} className="text-accent" />}
                    {c}
                    {active && (sort.desc ? <ArrowDown size={11} className="text-accent" /> : <ArrowUp size={11} className="text-accent" />)}
                    {filtered.length > 0 && <FilterIcon size={10} className="text-accent" />}
                    {meta && <span className="ml-1 font-mono text-[10px] font-normal text-faint">{meta.dataType}</span>}
                    <button
                      type="button"
                      title="Trier, filtrer…"
                      aria-label={`Menu de la colonne ${c}`}
                      className="ml-0.5 rounded p-0.5 text-faint hover:bg-hover-strong hover:text-fg"
                      onClick={(e) => headerMenu(c, e, e.currentTarget.getBoundingClientRect())}
                    >
                      <ChevronDown size={12} />
                    </button>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="group border-b border-line hover:bg-hover-soft">
              <td className="px-1.5 align-middle whitespace-nowrap">
                <span className="flex items-center gap-0.5">
                  <button className="rounded p-1 text-faint hover:bg-hover-strong hover:text-fg" title="Ouvrir la fiche de la ligne" onClick={() => onOpenRow(row)}>
                    <Maximize2 size={11} />
                  </button>
                  {editable && (
                    <button className="rounded p-1 text-faint hover:bg-danger/15 hover:text-danger" title="Supprimer cette ligne" onClick={() => onDeleteRow(i)}>
                      <Trash2 size={11} />
                    </button>
                  )}
                </span>
              </td>
              {row.map((v, j) => {
                const isEditing = editing?.row === i && editing.col === j;
                return (
                  <td
                    key={j}
                    className={`max-w-80 border-l border-line px-3 py-1.5 font-mono select-text ${isEditing ? "" : "truncate"} ${editable ? "cursor-cell" : "cursor-pointer"}`}
                    title={editable ? "Double-clic : modifier la cellule" : "Clic : lire la ligne entière"}
                    onClick={() => !isEditing && !editable && onOpenRow(row)}
                    onDoubleClick={() => {
                      if (!editable) return onOpenRow(row);
                      setEditing({ row: i, col: j, draft: v ?? "", wasNull: v === null });
                    }}
                  >
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <Input
                          ref={inputRef}
                          className="h-6 w-full min-w-40 font-mono text-xs"
                          value={editing.draft}
                          onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                          onBlur={commit}
                          autoFocus
                        />
                        {byName.get(result.columns[j])?.nullable !== false && (
                          <button
                            className="shrink-0 rounded px-1 text-[10px] text-muted hover:bg-hover hover:text-fg"
                            title="Mettre la cellule à NULL"
                            // `mousedown` passe avant le `blur` du champ, qui validerait le brouillon.
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setEditing(null);
                              onEditCell(result.columns[j], i, null);
                            }}
                          >
                            NULL
                          </button>
                        )}
                      </div>
                    ) : v === null ? (
                      <span className="text-muted italic">NULL</span>
                    ) : (
                      v
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {filterOn && (
        <FilterForm
          column={filterOn.column}
          x={filterOn.x}
          y={filterOn.y}
          existing={filters.find((f) => f.column === filterOn.column) ?? null}
          onClose={() => setFilterOn(null)}
          onApply={(f) => {
            onFilters([...filters.filter((x) => x.column !== f.column), f]);
            setFilterOn(null);
          }}
        />
      )}
      {editable && primary.length === 0 && <p className="p-3 text-xs text-muted">Cette table n'a pas de clé primaire : l'édition en place est impossible.</p>}
    </>
  );
}

/** Petit formulaire d'un filtre de colonne, posé là où le menu a été ouvert. */
function FilterForm({
  column,
  x,
  y,
  existing,
  onApply,
  onClose,
}: {
  column: string;
  x: number;
  y: number;
  existing: DbFilter | null;
  onApply: (filter: DbFilter) => void;
  onClose: () => void;
}) {
  const [op, setOp] = useState<DbFilterOp>(existing?.op ?? "=");
  const [value, setValue] = useState(existing?.value ?? "");
  const needsValue = !SANS_VALEUR.includes(op);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed z-50 w-64 rounded-md border border-border bg-panel p-2 shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 270), top: Math.min(y, window.innerHeight - 140) }}
    >
      <p className="mb-2 truncate font-mono text-[11px] text-muted">{column}</p>
      <div className="flex gap-1">
        <select className="h-7 rounded-md border border-border bg-bg px-1 text-xs" value={op} onChange={(e) => setOp(e.target.value as DbFilterOp)}>
          {DB_FILTER_OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {needsValue && (
          <Input
            className="h-7 flex-1 font-mono text-xs"
            placeholder={op.includes("LIKE") ? "abc%" : "valeur"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onApply({ column, op, value })}
            autoFocus
          />
        )}
      </div>
      <div className="mt-2 flex justify-end gap-1">
        <Button size="sm" onClick={onClose}>
          Annuler
        </Button>
        <Button size="sm" variant="primary" onClick={() => onApply({ column, op, value: needsValue ? value : "" })}>
          Filtrer
        </Button>
      </div>
    </div>
  );
}
