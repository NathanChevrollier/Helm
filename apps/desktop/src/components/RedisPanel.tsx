// Explorateur Redis / Valkey : parcours des clés par pages (SCAN, jamais KEYS *), lecture des
// valeurs quel que soit leur type, durée de vie, et console pour les commandes libres.
// Tout passe par `redis-cli` lancé sur le serveur : aucun port n'a besoin d'être ouvert.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Clock, Database, KeyRound, RefreshCw, Search, Send, Trash2 } from "lucide-react";
import { api, errorMessage, formatBytes, type RedisKeyInfo, type RedisKeyValue, type RedisOverview, type RedisServer } from "../lib/api";
import { ensureConnected, useAppPick } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, Input, Modal } from "./ui";
import PageLayout from "./PageLayout";

/** Durée de vie affichée en clair. */
function ttlLabel(ttl: number | null): string {
  if (ttl === null) return "—";
  if (ttl < 60) return `${ttl} s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)} min`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)} h`;
  return `${Math.round(ttl / 86400)} j`;
}

const TONS: Record<string, "accent" | "ok" | "warn" | "muted"> = {
  string: "accent",
  hash: "ok",
  list: "warn",
  set: "warn",
  zset: "warn",
  stream: "muted",
};

export default function RedisPanel({ serverId, onBackToSql }: { serverId: string; onBackToSql: () => void }) {
  const { notify, ask } = useAppPick("notify", "ask");
  const [servers, setServers] = useState<RedisServer[] | null>(null);
  const [serverKey, setServerKey] = useState<string | null>(null);
  const [overview, setOverview] = useState<RedisOverview | null>(null);
  const [database, setDatabase] = useState(0);
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<RedisKeyInfo[]>([]);
  const [cursor, setCursor] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RedisKeyValue | null>(null);
  /** Console : commande en cours de saisie et lignes déjà échangées. */
  const [command, setCommand] = useState("");
  const [console_, setConsole] = useState<{ command: string; lines: string[] }[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  /** Édition d'une clé de type chaîne. */
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const consoleEnd = useRef<HTMLDivElement>(null);

  const server = servers?.find((s) => s.id === serverKey) ?? null;
  const serverRef = useRef(server);
  serverRef.current = server;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        if (!(await ensureConnected(serverId))) return;
        const list = await api.redisServers(serverId);
        if (cancelled) return;
        setServers(list);
        setServerKey((id) => (list.some((s) => s.id === id) ? id : (list[0]?.id ?? null)));
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  // Résumé du serveur choisi (version, mémoire, clés par base).
  useEffect(() => {
    setOverview(null);
    if (!serverKey) return;
    let cancelled = false;
    api.redisOverview(serverId, serverRef.current!).then(
      (o) => !cancelled && setOverview(o),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [serverId, serverKey]);

  /** Première page de clés (curseur remis à zéro). */
  const search = useCallback(
    async (append = false) => {
      if (!serverRef.current) return;
      setLoading(true);
      setError(null);
      try {
        const page = await api.redisScan(serverId, serverRef.current, database, append ? cursor : "0", pattern);
        setKeys((old) => (append ? [...old, ...page.keys] : page.keys));
        setCursor(page.cursor);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [serverId, database, pattern, cursor],
  );

  // Changer de serveur ou de base repart de la première page.
  useEffect(() => {
    setKeys([]);
    setCursor("0");
    setSelected(null);
    if (!serverKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.redisScan(serverId, serverRef.current!, database, "0", "*");
        if (cancelled) return;
        setKeys(page.keys);
        setCursor(page.cursor);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, serverKey, database]);

  useEffect(() => {
    consoleEnd.current?.scrollIntoView({ block: "end" });
  }, [console_]);

  const openKey = async (key: string) => {
    if (!server) return;
    try {
      setSelected(await api.redisKey(serverId, server, database, key));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const removeKeys = async (list: string[]) => {
    if (!server || list.length === 0) return;
    const ok = await ask({
      title: list.length === 1 ? "Supprimer cette clé" : `Supprimer ${list.length} clés`,
      body: "La suppression est immédiate et définitive.",
      code: list.slice(0, 20).join("\n"),
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await api.redisDelete(serverId, server, database, list);
      notify(`${n} clé(s) supprimée(s).`, "success");
      setKeys((old) => old.filter((k) => !list.includes(k.key)));
      if (selected && list.includes(selected.key)) setSelected(null);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const changeTtl = async (key: string, current: number | null) => {
    if (!server) return;
    const answer = await ask({
      title: `Durée de vie de ${key}`,
      body: `Actuellement : ${current === null ? "sans expiration" : ttlLabel(current)}. Saisis un nombre de secondes, ou laisse vide pour retirer l'expiration.`,
      input: { label: "Secondes", initial: current?.toString() ?? "" },
      confirmLabel: "Appliquer",
    });
    if (typeof answer !== "string") return;
    const ttl = answer.trim() === "" ? null : Number(answer.trim());
    if (ttl !== null && (!Number.isFinite(ttl) || ttl <= 0)) return notify("Nombre de secondes invalide.", "error");
    try {
      await api.redisExpire(serverId, server, database, key, ttl);
      notify("Durée de vie modifiée.", "success");
      await openKey(key);
      void search();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const saveValue = async () => {
    if (!server || !editing) return;
    const { key, value } = editing;
    setEditing(null);
    try {
      // Sans durée de vie précisée, celle de la clé est conservée (KEEPTTL côté Rust).
      await api.redisSet(serverId, server, database, key, value, null);
      notify("Valeur enregistrée.", "success");
      await openKey(key);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const runCommand = async () => {
    if (!server || !command.trim()) return;
    const sent = command.trim();
    setCommand("");
    try {
      const lines = await api.redisCommand(serverId, server, database, sent);
      setConsole((old) => [...old.slice(-40), { command: sent, lines }]);
    } catch (e) {
      setConsole((old) => [...old.slice(-40), { command: sent, lines: [`✗ ${errorMessage(e)}`] }]);
    }
  };

  if (servers && servers.length === 0) {
    return (
      <EmptyState icon={<Database size={40} />} title="Aucun serveur Redis trouvé">
        Helm cherche les conteneurs Redis, Valkey et KeyDB en cours, ainsi que le service installé sur la machine.
        <div className="mt-3 flex justify-center gap-2">
          <Button size="sm" onClick={onBackToSql}>
            Revenir au SQL
          </Button>
        </div>
      </EmptyState>
    );
  }

  return (
    <PageLayout
      title="Redis / Valkey"
      guide="databases"
      scroll={false}
      subtitle="Les clés sont parcourues par pages avec SCAN : l'explorateur reste utilisable sur une base de plusieurs millions de clés."
      actions={
        <>
          <select className="h-9 max-w-72 rounded-md border border-border bg-bg px-2 text-sm" aria-label="Serveur Redis" value={serverKey ?? ""} onChange={(e) => setServerKey(e.target.value)}>
            {(servers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select className="h-9 rounded-md border border-border bg-bg px-2 text-sm" aria-label="Base" value={database} onChange={(e) => setDatabase(Number(e.target.value))}>
            {Array.from({ length: 16 }, (_, i) => {
              const count = overview?.databases.find(([n]) => n === i)?.[1];
              return (
                <option key={i} value={i}>
                  base {i}
                  {count ? ` (${count.toLocaleString("fr-FR")} clés)` : ""}
                </option>
              );
            })}
          </select>
          <Button size="sm" onClick={() => setConsoleOpen((o) => !o)}>
            Console
          </Button>
          <Button size="sm" onClick={onBackToSql}>
            SQL
          </Button>
          <IconButton title="Actualiser" onClick={() => void search()}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </IconButton>
        </>
      }
    >
      {overview && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-1.5 text-xs text-muted">
          <span>Version {overview.version || "?"}</span>
          <span>Mémoire {formatBytes(overview.memory)}</span>
          <span>{overview.uptimeDays} jour(s) d'activité</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-96 shrink-0 flex-col border-r border-border">
          <form
            className="flex items-center gap-1 border-b border-border p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input className="h-7 font-mono text-xs" placeholder="Motif : user:* " value={pattern} onChange={(e) => setPattern(e.target.value)} />
            <IconButton title="Chercher">
              <Search size={14} />
            </IconButton>
          </form>
          <div className="min-h-0 flex-1 overflow-auto">
            {error && <p className="m-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger select-text">{error}</p>}
            {keys.length === 0 && !loading && !error && <p className="p-3 text-xs text-muted">Aucune clé pour ce motif.</p>}
            {keys.map((k) => (
              <button
                key={k.key}
                className={`group flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hover ${selected?.key === k.key ? "bg-hover-soft" : ""}`}
                onClick={() => void openKey(k.key)}
              >
                <Badge tone={TONS[k.kind] ?? "muted"}>{k.kind}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{k.key}</span>
                {k.ttl !== null && (
                  <span className="shrink-0 text-[10px] text-muted" title="Durée de vie restante">
                    {ttlLabel(k.ttl)}
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-muted tabular-nums">{k.size ? formatBytes(k.size) : ""}</span>
                <ChevronRight size={12} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-border p-2 text-xs text-muted">
            <span className="flex-1">{keys.length} clé(s) chargée(s)</span>
            {cursor !== "0" && (
              <Button size="sm" loading={loading} onClick={() => void search(true)}>
                Charger la suite
              </Button>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <KeyRound size={13} className="text-accent" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs select-text" title={selected.key}>
                  {selected.key}
                </span>
                <Badge tone={TONS[selected.kind] ?? "muted"}>{selected.kind}</Badge>
                <span className="text-xs text-muted">
                  {selected.total.toLocaleString("fr-FR")} {selected.kind === "string" ? "octet(s)" : "élément(s)"}
                </span>
                <Button size="sm" icon={<Clock size={13} />} onClick={() => void changeTtl(selected.key, selected.ttl)}>
                  {ttlLabel(selected.ttl)}
                </Button>
                {selected.kind === "string" && (
                  <Button size="sm" onClick={() => setEditing({ key: selected.key, value: selected.entries[0]?.[1] ?? "" })}>
                    Modifier
                  </Button>
                )}
                <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void removeKeys([selected.key])}>
                  Supprimer
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {selected.kind === "string" ? (
                  <pre className="p-3 font-mono text-xs break-all whitespace-pre-wrap select-text">{selected.entries[0]?.[1] ?? ""}</pre>
                ) : (
                  <table className="min-w-full text-xs">
                    <tbody>
                      {selected.entries.map(([field, value], i) => (
                        <tr key={i} className="border-b border-border/40">
                          <td className="w-64 px-3 py-1 font-mono text-muted select-text">{field ?? i}</td>
                          <td className="px-3 py-1 font-mono break-all select-text">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {selected.truncated && (
                  <p className="border-t border-border px-3 py-2 text-xs text-muted">
                    Affichage limité aux 200 premiers éléments sur {selected.total.toLocaleString("fr-FR")}.
                  </p>
                )}
              </div>
            </>
          ) : (
            <EmptyState icon={<KeyRound size={36} />} title="Choisis une clé">
              Le motif accepte les jokers Redis : <code className="font-mono">session:*</code>, <code className="font-mono">user:??</code>.
            </EmptyState>
          )}

          {consoleOpen && (
            <div className="flex h-56 shrink-0 flex-col border-t border-border">
              <div className="min-h-0 flex-1 overflow-auto bg-bg p-2 font-mono text-[11px]">
                {console_.length === 0 && <p className="text-muted">Exemple : GET session:42 · HGETALL user:1 · TTL cle · DBSIZE</p>}
                {console_.map((e, i) => (
                  <div key={i} className="mb-1">
                    <p className="text-accent select-text">&gt; {e.command}</p>
                    {e.lines.map((l, j) => (
                      <p key={j} className="break-all whitespace-pre-wrap text-fg select-text">
                        {l}
                      </p>
                    ))}
                  </div>
                ))}
                <div ref={consoleEnd} />
              </div>
              <form
                className="flex items-center gap-1 border-t border-border p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runCommand();
                }}
              >
                <Input className="h-7 font-mono text-xs" placeholder="Commande Redis…" value={command} onChange={(e) => setCommand(e.target.value)} />
                <IconButton title="Envoyer">
                  <Send size={14} />
                </IconButton>
              </form>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <Modal
          title={`Modifier ${editing.key}`}
          width="max-w-3xl"
          onClose={() => setEditing(null)}
          footer={
            <Button variant="primary" onClick={() => void saveValue()}>
              Enregistrer
            </Button>
          }
        >
          <p className="mb-2 text-xs text-muted">La durée de vie de la clé est conservée.</p>
          <textarea
            className="h-64 w-full resize-none rounded-md border border-border bg-bg p-2 font-mono text-xs outline-none focus:border-accent"
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          />
        </Modal>
      )}
    </PageLayout>
  );
}
