import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, RefreshCw, RotateCw, ScrollText, Square } from "lucide-react";
import { api, errorMessage, type Service } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, EmptyState, IconButton, Input, Modal } from "../../components/ui";
import { useCachedState } from "../../lib/cache";
import { useAutoRefresh } from "../../lib/refresh";

export default function Services({ serverId }: { serverId: string }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [list, setList] = useCachedState<Service[] | null | undefined>(`services:${serverId}`, undefined);
  const [filter, setFilter] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [logsOf, setLogsOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.services(serverId));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [serverId, notify]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh((auto) => (auto ? api.services(serverId).then(setList, () => {}) : load()), { serverId });

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    return (list ?? []).filter(
      (s) =>
        (!onlyActive || s.active !== "inactive" || s.enabled === "enabled") &&
        (!f || s.unit.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)),
    );
  }, [list, filter, onlyActive]);

  const act = async (s: Service, action: string, label: string) => {
    if (action !== "start") {
      const ok = await ask({
        title: `${label} ${s.unit} ?`,
        body: "Les sites qui dépendent de ce service peuvent être indisponibles pendant l'opération.",
        confirmLabel: label,
        danger: action === "stop",
      });
      if (!ok) return;
    }
    setBusy(s.unit);
    try {
      await api.serviceAction(serverId, s.unit, action);
      notify(`${s.unit} : ${label.toLowerCase()} OK`, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (list === null) {
    return (
      <EmptyState icon={<ScrollText size={36} />} title="systemd indisponible">
        Ce serveur n'utilise pas systemd (conteneur ou autre système d'init) : la gestion des services n'est pas possible.
      </EmptyState>
    );
  }

  const tone = (s: Service) => (s.active === "active" ? "ok" : s.active === "failed" ? "danger" : "muted");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Input className="!w-72" placeholder="Filtrer les services…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          Masquer les services inactifs non activés
        </label>
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} />
        </IconButton>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">État</th>
              <th className="px-3 py-2 font-medium">Démarrage</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="w-44" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.unit} className="group border-t border-border/50 hover:bg-hover-soft">
                <td className="px-3 py-1.5 font-mono text-xs">{s.unit.replace(/\.service$/, "")}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={tone(s)}>
                    {s.active} · {s.sub}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 text-xs text-muted">{s.enabled}</td>
                <td className="max-w-0 px-3 py-1.5">
                  <div className="truncate text-xs text-muted">{s.description}</div>
                </td>
                <td className="px-2 py-1 text-right">
                  <span className={`inline-flex ${busy === s.unit ? "" : "invisible group-hover:visible"}`}>
                    {s.active === "active" ? (
                      <>
                        <IconButton title="Redémarrer" disabled={!!busy} onClick={() => void act(s, "restart", "Redémarrer")}>
                          <RotateCw size={14} className={busy === s.unit ? "animate-spin" : ""} />
                        </IconButton>
                        <IconButton title="Arrêter" disabled={!!busy} onClick={() => void act(s, "stop", "Arrêter")}>
                          <Square size={13} />
                        </IconButton>
                      </>
                    ) : (
                      <IconButton title="Démarrer" disabled={!!busy} onClick={() => void act(s, "start", "Démarrer")}>
                        <Play size={14} />
                      </IconButton>
                    )}
                    <IconButton title="Journaux" onClick={() => setLogsOf(s.unit)}>
                      <ScrollText size={14} />
                    </IconButton>
                  </span>
                </td>
              </tr>
            ))}
            {list === undefined && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-sm text-muted">Chargement…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {logsOf && <LogsModal serverId={serverId} unit={logsOf} onClose={() => setLogsOf(null)} />}
    </div>
  );
}

function LogsModal({ serverId, unit, onClose }: { serverId: string; unit: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [lines, setLines] = useState(300);
  useEffect(() => {
    setText(null);
    api.serviceLogs(serverId, unit, lines).then(setText, (e) => setText(errorMessage(e)));
  }, [serverId, unit, lines]);
  return (
    <Modal
      title={`Journaux de ${unit}`}
      width="max-w-5xl"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={() => setLines((l) => l + 700)}>
          Charger plus
        </Button>
      }
    >
      <pre className="h-[60vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap select-text">
        {text ?? "Chargement…"}
      </pre>
    </Modal>
  );
}
