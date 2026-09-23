import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Database, Download, Play, Plus, RefreshCw, Table2, TriangleAlert } from "lucide-react";
import { api, errorMessage, formatBytes, type DbInstance, type DbNamed, type DbQueryResult } from "../lib/api";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";
import { useMonacoTheme } from "../lib/theme";
import { Badge, Button, EmptyState, IconButton, Input, Modal } from "../components/ui";
import PageLayout from "../components/PageLayout";

// Monaco reste hors du morceau de code de cet onglet : il ne retarde plus son ouverture.
const SqlEditor = lazy(() => import("../components/SqlEditor"));

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

function Databases({ serverId }: { serverId: string }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const monacoTheme = useMonacoTheme();
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
        setInstances(list);
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
  useAutoRefresh((auto) => loadInstances(auto), { serverId });

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

  const run = async (text = sql) => {
    if (!instance || running || !text.trim()) return;
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

  const openTable = async (name: string) => {
    if (!instance) return;
    try {
      const q = await api.dbPreviewQuery(instance.engine, name, Math.min(limit, 500));
      setSql(q);
      await run(q);
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

  if (instances && instances.length === 0) {
    return (
      <EmptyState icon={<Database size={40} />} title="Aucune base de données trouvée">
        Helm cherche les conteneurs MySQL, MariaDB et PostgreSQL en cours, ainsi que les services installés sur le serveur.
        <Button className="mt-3" size="sm" icon={<RefreshCw size={13} />} onClick={() => void loadInstances()}>
          Rechercher à nouveau
        </Button>
      </EmptyState>
    );
  }

  return (
    <PageLayout
      title="Bases de données"
      guide="databases"
      scroll={false}
      subtitle="Les requêtes passent par le client du serveur (mysql, psql) via SSH : aucun port de base n'a besoin d'être ouvert."
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
          <Button size="sm" icon={<Plus size={13} />} disabled={!instance} onClick={() => void createDatabase()}>
            Nouvelle base
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
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] hover:bg-hover"
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
                onMount={(editor, monaco) => {
                  // Ctrl+Entrée exécute, comme dans les clients SQL habituels.
                  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run(editor.getValue()));
                }}
              />
            </Suspense>
          </div>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
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
            {result && (
              <span className="text-xs text-muted">
                {result.rows.length} ligne(s) · {result.durationMs} ms{result.truncated && " · tronqué"}
              </span>
            )}
            {result && result.rows.length > 0 && (
              <Button size="sm" className="ml-auto" icon={<Download size={13} />} onClick={() => void exportCsv()}>
                Exporter en CSV
              </Button>
            )}
          </div>
          {/* Le tableau garde ses colonnes à leur largeur naturelle et défile horizontalement ;
              un clic ouvre la ligne entière, seule façon de lire une valeur longue. */}
          <div className="min-h-0 flex-1 overflow-auto">
            {error && <pre className="m-3 rounded-md border border-danger/40 bg-danger/10 p-3 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}
            {result && result.columns.length > 0 && (
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-panel text-left text-muted">
                  <tr>
                    {result.columns.map((c, i) => (
                      <th key={i} className="border-b border-border px-3 py-1.5 font-medium whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr
                      key={i}
                      className="cursor-pointer border-b border-border/40 hover:bg-hover-soft"
                      onClick={() => setRowDetail({ columns: result.columns, values: row })}
                      title="Cliquer pour lire la ligne entière"
                    >
                      {row.map((v, j) => (
                        <td key={j} className="max-w-80 truncate px-3 py-1 font-mono select-text">
                          {v === null ? <span className="text-muted italic">NULL</span> : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
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
