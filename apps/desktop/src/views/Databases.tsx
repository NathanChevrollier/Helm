import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Database, Download, FileSearch, Play, Plus, RefreshCw, Rows3, Table2, TriangleAlert } from "lucide-react";
import {
  api,
  errorMessage,
  formatBytes,
  type DbColumn,
  type DbFilter,
  type DbInstance,
  type DbKeyPart,
  type DbNamed,
  type DbQueryResult,
} from "../lib/api";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { useMonacoTheme } from "../lib/theme";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";
import PageLayout from "../components/PageLayout";
import DataGrid, { type Sort } from "../components/DataGrid";

// Monaco reste hors du morceau de code de cet onglet : il ne retarde plus son ouverture.
const SqlEditor = lazy(() => import("../components/SqlEditor"));
// La console Redis n'est chargée que si l'onglet Redis est ouvert.
const RedisPanel = lazy(() => import("../components/RedisPanel"));

const LIMITS = [100, 500, 1000, 5000];

export default function DatabasesView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<Database size={40} />} title="Aucun serveur sélectionné" />;
  return <Databases key={serverId} serverId={serverId} />;
}

/** Valeur d'une cellule pour un fichier CSV (RFC 4180). */
function csvCell(v: string | null): string {
  if (v === null) return "";
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Table ouverte depuis la liste : son schéma, son tri et ses filtres. */
interface TableView {
  table: string;
  columns: DbColumn[];
  sort: Sort | null;
  filters: DbFilter[];
}

function Databases({ serverId }: { serverId: string }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const monacoTheme = useMonacoTheme();
  const [mode, setMode] = useCachedState<"sql" | "redis">(`dbMode:${serverId}`, "sql");
  const [instances, setInstances] = useCachedState<DbInstance[] | null>(`db:${serverId}`, null);
  const [instanceId, setInstanceId] = useCachedState<string | null>(`dbInstance:${serverId}`, null);
  const [databases, setDatabases] = useState<DbNamed[] | null>(null);
  const [database, setDatabase] = useCachedState<string | null>(`dbName:${serverId}`, null);
  const [tables, setTables] = useState<DbNamed[] | null>(null);
  const [filter, setFilter] = useState("");
  const [sql, setSql] = useCachedState(`dbSql:${serverId}`, "SELECT 1;");
  const [limit, setLimit] = useState(500);
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Table ouverte depuis la liste, ou null pour une requête libre (tableau en lecture seule). */
  const [view, setView] = useState<TableView | null>(null);
  /** Formulaire d'insertion d'une ligne. */
  const [inserting, setInserting] = useState<Record<string, string | null> | null>(null);
  const [searchingSqlite, setSearchingSqlite] = useState(false);

  const instance = instances?.find((i) => i.id === instanceId) ?? null;

  // Version de l'instance affichée : demandée après coup, elle ne retarde ni la liste ni les tables.
  // Elle est gardée à part et jamais réécrite dans `instances` : y toucher changeait l'identité de
  // l'objet, ce qui relançait cet effet en boucle et faisait clignoter la page.
  const [versions, setVersions] = useState<Record<string, string>>({});
  const instanceKey = instance?.id ?? null;
  /** Ligne ouverte en lecture complète. */
  const [rowDetail, setRowDetail] = useState<{ columns: string[]; values: (string | null)[] } | null>(null);
  /** Incrémenté pour relire bases et tables après une création. */
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!instanceKey || !instance || versions[instanceKey] !== undefined) return;
    let cancelled = false;
    void api.dbVersion(serverId, instance).then(
      (v) => !cancelled && setVersions((x) => ({ ...x, [instanceKey]: v || instance.version || "" })),
      () => !cancelled && setVersions((x) => ({ ...x, [instanceKey]: "" })),
    );
    return () => {
      cancelled = true;
    };
    // `instance` ne figure pas dans les dépendances : seul son identifiant compte ici.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceKey, versions]);

  const loadInstances = useCallback(
    async (auto = false) => {
      setLoading(true);
      try {
        if (!auto && !(await ensureConnected(serverId))) return;
        const list = await api.dbInstances(serverId);
        // Les fichiers SQLite déjà ouverts sont conservés : la découverte ne les renvoie pas.
        setInstances((old) => [...list, ...(old ?? []).filter((i) => i.engine === "sqlite")]);
        setInstanceId((id) => (list.some((i) => i.id === id) ? id : (list[0]?.id ?? null)));
      } catch (e) {
        if (!auto) setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [serverId, setInstances, setInstanceId],
  );

  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);
  useAutoRefresh((auto) => loadInstances(auto), { serverId, enabled: mode === "sql" });

  // Bases de l'instance choisie. Les effets suivants dépendent de l'IDENTIFIANT de l'instance, pas
  // de l'objet : l'actualisation automatique recrée la liste, et dépendre de l'objet relançait tout
  // (avec un passage par « null ») toutes les quelques secondes — d'où le clignotement.
  const instanceRef = useRef(instance);
  instanceRef.current = instance;

  useEffect(() => {
    if (!instanceKey) return;
    let cancelled = false;
    setDatabases(null);
    setTables(null);
    api.dbDatabases(serverId, instanceRef.current!).then(
      (list) => {
        if (cancelled) return;
        setDatabases(list);
        setDatabase((d) => (list.some((x) => x.name === d) ? d : (list.find((x) => !SYSTEM_DBS.includes(x.name))?.name ?? list[0]?.name ?? null)));
      },
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, instanceKey, refreshKey, setDatabase]);

  // Tables de la base choisie.
  useEffect(() => {
    setTables(null);
    if (!instanceKey || !database) return;
    let cancelled = false;
    api.dbTables(serverId, instanceRef.current!, database).then(
      (list) => !cancelled && setTables(list),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, instanceKey, database, refreshKey]);

  // Changer d'instance ou de base rend la table ouverte caduque.
  useEffect(() => setView(null), [instanceKey, database]);

  /** Crée une base vide dans l'instance affichée, puis la sélectionne. */
  const createDatabase = async () => {
    if (!instance) return;
    const name = await ask({
      title: "Nouvelle base de données",
      body: `Sur ${instance.label}. Lettres, chiffres, « _ » et « - » uniquement. L'encodage est UTF-8.`,
      input: { label: "Nom de la base" },
      confirmLabel: "Créer",
    });
    if (typeof name !== "string" || !name.trim()) return;
    try {
      await api.dbCreate(serverId, instance, name.trim());
      notify(`Base « ${name.trim()} » créée.`, "success");
      setDatabase(name.trim());
      setRefreshKey((k) => k + 1);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Cherche les fichiers SQLite du serveur et les ajoute à la liste des instances. */
  const findSqlite = async () => {
    setSearchingSqlite(true);
    try {
      const found = await api.dbSqliteFiles(serverId);
      if (found.length === 0) {
        notify("Aucun fichier SQLite trouvé dans /opt, /srv, /var/lib, /var/www, /home, /root ou /data.", "info");
        return;
      }
      setInstances((old) => {
        const known = new Set((old ?? []).map((i) => i.id));
        return [...(old ?? []), ...found.filter((f) => !known.has(f.id))];
      });
      notify(`${found.length} fichier(s) SQLite trouvé(s).`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSearchingSqlite(false);
    }
  };

  const run = async (text = sql, fromTable = false) => {
    if (!instance || running || !text.trim()) return;
    // Une requête tapée à la main ne correspond plus forcément à la table ouverte : le tableau
    // repasse en lecture seule plutôt que d'éditer la mauvaise table.
    if (!fromTable) setView(null);
    // Une requête qui modifie les données demande confirmation : elle n'est pas annulable.
    if (!isReadOnly(text)) {
      const ok = await ask({
        title: "Cette requête modifie la base",
        body: `Elle sera exécutée sur ${database ?? instance.label}. Il n'y a pas d'annulation : vérifie la requête (et la sauvegarde) avant de continuer.`,
        code: text.trim().slice(0, 2000),
        confirmLabel: "Exécuter",
        danger: true,
      });
      if (!ok) return;
    }
    setRunning(true);
    setError(null);
    try {
      setResult(await api.dbQuery(serverId, instance, database, text, limit));
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  /** Relit la table ouverte avec son tri et ses filtres, et met l'éditeur SQL en accord. */
  const runTable = useCallback(
    async (v: TableView) => {
      if (!instance) return;
      try {
        const q = await api.dbTableQuery(instance.engine, v.table, v.filters, v.sort?.column ?? null, v.sort?.desc ?? false, Math.min(limit, 5000));
        setSql(q);
        setView(v);
        setRunning(true);
        setError(null);
        setResult(await api.dbQuery(serverId, instance, database, q, limit));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setRunning(false);
      }
    },
    [instance, serverId, database, limit, setSql],
  );

  const openTable = async (name: string) => {
    if (!instance) return;
    try {
      // Le schéma sert à deux choses : l'autocomplétion, et savoir si l'édition est possible.
      const columns = await api.dbColumns(serverId, instance, database, name).catch(() => [] as DbColumn[]);
      await runTable({ table: name, columns, sort: null, filters: [] });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  /** Clé primaire de la table ouverte, entièrement présente dans le résultat affiché. */
  const primary = useMemo(() => {
    if (!view || !result) return null;
    const names = view.columns.filter((c) => c.primary).map((c) => c.name);
    if (names.length === 0 || !names.every((n) => result.columns.includes(n))) return null;
    return names;
  }, [view, result]);

  const keyOf = (rowIndex: number): DbKeyPart[] =>
    (primary ?? []).map((name) => ({ column: name, value: result!.rows[rowIndex][result!.columns.indexOf(name)] ?? null }));

  /** Applique une requête d'écriture après validation, puis relit la table. */
  const applyWrite = async (title: string, body: string, sqlText: string) => {
    if (!instance || !view) return;
    const ok = await ask({ title, body, code: sqlText, confirmLabel: "Appliquer", danger: true });
    if (!ok) return;
    try {
      await api.dbQuery(serverId, instance, database, sqlText, 1);
      notify("Modification appliquée.", "success");
      await runTable(view);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const editCell = async (column: string, rowIndex: number, value: string | null) => {
    if (!instance || !view || !primary || !result) return;
    const before = result.rows[rowIndex][result.columns.indexOf(column)];
    try {
      const sqlText = await api.dbUpdateCellSql(instance.engine, view.table, column, value, keyOf(rowIndex));
      await applyWrite(
        `Modifier ${view.table}.${column}`,
        `Avant : ${before === null ? "NULL" : `« ${before} »`}\nAprès : ${value === null ? "NULL" : `« ${value} »`}`,
        sqlText,
      );
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const deleteRow = async (rowIndex: number) => {
    if (!instance || !view || !primary) return;
    try {
      const sqlText = await api.dbDeleteRowSql(instance.engine, view.table, keyOf(rowIndex));
      await applyWrite("Supprimer cette ligne", "La suppression est définitive : il n'y a pas d'annulation.", sqlText);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const insertRow = async () => {
    if (!instance || !view || !inserting) return;
    const values = Object.entries(inserting).filter(([, v]) => v !== null && v !== "") as [string, string][];
    setInserting(null);
    if (values.length === 0) return notify("Aucune valeur saisie.", "info");
    try {
      const sqlText = await api.dbInsertRowSql(instance.engine, view.table, values);
      await applyWrite(`Ajouter une ligne dans ${view.table}`, "Les colonnes laissées vides prennent leur valeur par défaut.", sqlText);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const exportCsv = async () => {
    if (!result) return;
    const path = await saveDialog({ defaultPath: `${database ?? "resultat"}-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    const text = [result.columns.map(csvCell).join(","), ...result.rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
    try {
      await api.saveTextFile(path, text);
      notify(`Exporté : ${path}`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const shownTables = useMemo(() => (tables ?? []).filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase())), [tables, filter]);

  if (mode === "redis") {
    return (
      <Suspense fallback={<div className="p-4 text-sm text-muted">Chargement…</div>}>
        <RedisPanel serverId={serverId} onBackToSql={() => setMode("sql")} />
      </Suspense>
    );
  }

  if (instances && instances.length === 0) {
    return (
      <EmptyState icon={<Database size={40} />} title="Aucune base de données trouvée">
        Helm cherche les conteneurs MySQL, MariaDB et PostgreSQL en cours, ainsi que les services installés sur le serveur.
        <div className="mt-3 flex justify-center gap-2">
          <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void loadInstances()}>
            Rechercher à nouveau
          </Button>
          <Button size="sm" icon={<FileSearch size={13} />} loading={searchingSqlite} onClick={() => void findSqlite()}>
            Chercher des fichiers SQLite
          </Button>
          <Button size="sm" onClick={() => setMode("redis")}>
            Explorer Redis
          </Button>
        </div>
      </EmptyState>
    );
  }

  return (
    <PageLayout
      title="Bases de données"
      guide="databases"
      scroll={false}
      subtitle="Les requêtes passent par le client du serveur (mysql, psql, sqlite3) via SSH : aucun port de base n'a besoin d'être ouvert."
      actions={
        <>
          <select
            className="h-9 max-w-72 rounded-md border border-border bg-bg px-2 text-sm"
            aria-label="Instance"
            value={instanceId ?? ""}
            onChange={(e) => setInstanceId(e.target.value)}
          >
            {(instances ?? []).map((i) => {
              const v = versions[i.id] || i.version;
              return (
                <option key={i.id} value={i.id}>
                  {i.label}
                  {v && ` — ${v}`}
                </option>
              );
            })}
          </select>
          <select
            className="h-9 max-w-56 rounded-md border border-border bg-bg px-2 text-sm"
            aria-label="Base de données"
            value={database ?? ""}
            onChange={(e) => setDatabase(e.target.value)}
          >
            {databases === null && <option value="">Chargement…</option>}
            {(databases ?? []).map((d) => (
              <option key={d.name} value={d.name}>
                {d.name} {d.size ? `(${formatBytes(d.size)})` : ""}
              </option>
            ))}
          </select>
          <Button size="sm" icon={<Plus size={13} />} disabled={!instance || instance.engine === "sqlite"} onClick={() => void createDatabase()}>
            Nouvelle base
          </Button>
          <Button size="sm" icon={<FileSearch size={13} />} loading={searchingSqlite} onClick={() => void findSqlite()} title="Chercher les fichiers .db / .sqlite du serveur">
            SQLite
          </Button>
          <Button size="sm" onClick={() => setMode("redis")} title="Explorer les clés Redis / Valkey">
            Redis
          </Button>
          <IconButton title="Actualiser" onClick={() => void loadInstances()}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </IconButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border">
          <div className="border-b border-border p-2">
            <Input className="h-7 text-xs" placeholder="Filtrer les tables…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {tables === null ? (
              <p className="p-3 text-xs text-muted">Chargement…</p>
            ) : shownTables.length === 0 ? (
              <p className="p-3 text-xs text-muted">Aucune table.</p>
            ) : (
              shownTables.map((t) => (
                <button
                  key={t.name}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] hover:bg-hover ${view?.table === t.name ? "bg-hover-soft font-medium" : ""}`}
                  title={`${t.count.toLocaleString("fr-FR")} lignes (estimation) · ${formatBytes(t.size)}`}
                  onClick={() => void openTable(t.name)}
                >
                  <Table2 size={13} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="text-[11px] text-muted tabular-nums">{t.count > 0 ? t.count.toLocaleString("fr-FR") : ""}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="h-52 border-b border-border">
            <Suspense fallback={<div className="p-3 text-xs text-muted">Chargement de l'éditeur…</div>}>
              <SqlEditor
                value={sql}
                onChange={setSql}
                theme={monacoTheme}
                tables={(tables ?? []).map((t) => t.name)}
                columns={view?.columns.map((c) => ({ name: c.name, table: view.table, dataType: c.dataType })) ?? []}
                onMount={(editor, monaco) => {
                  // Ctrl+Entrée exécute, comme dans les clients SQL habituels.
                  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run(editor.getValue()));
                }}
              />
            </Suspense>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <Button size="sm" variant="primary" loading={running} icon={<Play size={13} />} onClick={() => void run()}>
              Exécuter (Ctrl+Entrée)
            </Button>
            <select className="h-7 rounded-md border border-border bg-bg px-2 text-xs" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n} lignes max
                </option>
              ))}
            </select>
            {sql.trim().length > 0 && !isReadOnly(sql) && (
              <Badge tone="warn">
                <TriangleAlert size={11} className="mr-1" /> requête qui modifie
              </Badge>
            )}
            {view && (
              <Badge tone={primary ? "accent" : "muted"}>
                {view.table}
                {primary ? " · éditable" : " · lecture seule (pas de clé primaire)"}
              </Badge>
            )}
            {view && view.filters.length > 0 && (
              <Button size="sm" onClick={() => void runTable({ ...view, filters: [] })}>
                Retirer les filtres ({view.filters.length})
              </Button>
            )}
            {result && (
              <span className="text-xs text-muted">
                {result.rows.length} ligne(s) · {result.durationMs} ms{result.truncated && " · tronqué"}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {view && primary && (
                <Button
                  size="sm"
                  icon={<Rows3 size={13} />}
                  onClick={() => setInserting(Object.fromEntries(view.columns.map((c) => [c.name, ""])))}
                >
                  Ajouter une ligne
                </Button>
              )}
              {result && result.rows.length > 0 && (
                <Button size="sm" icon={<Download size={13} />} onClick={() => void exportCsv()}>
                  Exporter en CSV
                </Button>
              )}
            </div>
          </div>
          {/* Le tableau garde ses colonnes à leur largeur naturelle et défile horizontalement ;
              un clic ouvre la ligne entière, seule façon de lire une valeur longue. */}
          <div className="min-h-0 flex-1 overflow-auto">
            {error && <pre className="m-3 rounded-md border border-danger/40 bg-danger/10 p-3 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}
            {result && result.columns.length > 0 && (
              <DataGrid
                result={result}
                columns={view?.columns ?? null}
                editable={!!primary}
                sort={view?.sort ?? null}
                onSort={(s) => view && void runTable({ ...view, sort: s })}
                filters={view?.filters ?? []}
                onFilters={(f) => view && void runTable({ ...view, filters: f })}
                onEditCell={(c, i, v) => void editCell(c, i, v)}
                onDeleteRow={(i) => void deleteRow(i)}
                onOpenRow={(values) => setRowDetail({ columns: result.columns, values })}
              />
            )}
            {result && result.columns.length === 0 && !error && <p className="p-4 text-sm text-muted">Requête exécutée (aucun résultat à afficher).</p>}
          </div>
        </div>
      </div>

      {rowDetail && (
        <Modal title="Ligne complète" width="max-w-4xl" onClose={() => setRowDetail(null)}>
          <dl className="flex flex-col divide-y divide-border">
            {rowDetail.columns.map((c, i) => (
              <div key={i} className="grid grid-cols-[minmax(120px,200px)_minmax(0,1fr)] gap-4 py-2">
                <dt className="font-mono text-xs text-muted">{c}</dt>
                <dd className="font-mono text-xs break-all whitespace-pre-wrap select-text">
                  {rowDetail.values[i] === null ? <span className="text-muted italic">NULL</span> : rowDetail.values[i]}
                </dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}

      {inserting && view && (
        <Modal
          title={`Ajouter une ligne dans ${view.table}`}
          width="max-w-2xl"
          onClose={() => setInserting(null)}
          footer={
            <Button variant="primary" onClick={() => void insertRow()}>
              Voir la requête
            </Button>
          }
        >
          <p className="mb-3 text-xs text-muted">Les colonnes laissées vides prennent leur valeur par défaut (auto-incrément, date du jour…).</p>
          <div className="flex flex-col gap-2">
            {view.columns.map((c) => (
              <Field key={c.name} label={`${c.name} — ${c.dataType}${c.nullable ? "" : " (obligatoire)"}`}>
                <Input
                  className="h-8 font-mono text-xs"
                  value={inserting[c.name] ?? ""}
                  placeholder={c.primary ? "clé primaire" : ""}
                  onChange={(e) => setInserting({ ...inserting, [c.name]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        </Modal>
      )}
    </PageLayout>
  );
}

const SYSTEM_DBS = ["information_schema", "performance_schema", "mysql", "sys", "postgres", "template0", "template1"];

/** Même règle que côté Rust : seules ces requêtes s'exécutent sans confirmation. */
function isReadOnly(sql: string): boolean {
  const text = sql
    .replace(/--[^\n]*\n/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  const first = text.split(/[\s(;]+/).find(Boolean)?.toUpperCase() ?? "";
  return ["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "WITH", "TABLE", "VALUES", "ANALYZE"].includes(first);
}
