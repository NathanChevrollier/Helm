import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pencil, Play, RefreshCw, Timer } from "lucide-react";
import { api, errorMessage, type CronSource, type Schedule } from "../../lib/api";
import { useApp, useAppPick } from "../../lib/store";
import { Badge, Button, EmptyState, IconButton, Modal } from "../../components/ui";
import { useCachedState } from "../../lib/cache";

export default function ScheduleView({ serverId }: { serverId: string }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [data, setData] = useCachedState<Schedule | null>(`schedule:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<CronSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.scheduleList(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>;
  if (!data) return <EmptyState icon={<CalendarClock size={36} className="animate-pulse" />} title="Lecture des tâches planifiées…" />;

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        Crontabs des utilisateurs, fichiers système (/etc/crontab, /etc/cron.d) et timers systemd.
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>

      {data.crontabs.length === 0 && <p className="text-sm text-muted">Aucune crontab.</p>}
      {data.crontabs.map((c) => (
        <section key={c.id} className="rounded-lg border border-border bg-panel">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <CalendarClock size={14} />
            <span className="font-mono text-sm">{c.label}</span>
            {!c.editable && <Badge>système</Badge>}
            {c.editable && (
              <Button size="sm" className="ml-auto" icon={<Pencil size={13} />} onClick={() => setEditing(c)}>
                Modifier
              </Button>
            )}
          </header>
          {c.jobs.length === 0 ? (
            <p className="px-4 py-2.5 text-sm text-muted">Aucune tâche active.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {c.jobs.map((j, i) => (
                  <tr key={i} className="border-t border-border/50 align-top first:border-t-0">
                    <td className="w-56 px-4 py-2">
                      <div className="font-mono text-xs">{j.schedule}</div>
                      {j.human && <div className="text-xs text-muted">{j.human}</div>}
                    </td>
                    {j.user !== null && <td className="w-20 px-2 py-2 text-xs text-muted">{j.user}</td>}
                    <td className="px-2 py-2 font-mono text-xs break-all">{j.command}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      {data.systemd && (
        <section className="rounded-lg border border-border bg-panel">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Timer size={14} />
            <span className="font-medium">Timers systemd</span>
          </header>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-1.5 font-medium">Timer</th>
                <th className="px-2 py-1.5 font-medium">Prochaine exécution</th>
                <th className="px-2 py-1.5 font-medium">Dernière</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.timers.map((t) => (
                <tr key={t.unit} className="border-t border-border/50">
                  <td className="px-4 py-1.5">
                    <div className="font-mono text-xs">{t.unit}</div>
                    <div className="text-[11px] text-muted">{t.activates}</div>
                  </td>
                  <td className="px-2 py-1.5 text-xs">{t.next}</td>
                  <td className="px-2 py-1.5 text-xs text-muted">{t.last}</td>
                  <td className="px-2 py-1.5 text-right">
                    {t.activates.endsWith(".service") && (
                      <IconButton
                        title={`Lancer ${t.activates} maintenant`}
                        onClick={async () => {
                          if (!(await ask({ title: `Lancer ${t.activates} maintenant ?`, body: "La tâche s'exécute tout de suite, en plus de son planning habituel.", confirmLabel: "Lancer" }))) return;
                          try {
                            await api.timerRun(serverId, t.activates);
                            notify(`${t.activates} lancé`, "success");
                          } catch (e) {
                            notify(errorMessage(e), "error");
                          }
                        }}
                      >
                        <Play size={14} />
                      </IconButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {editing && (
        <CrontabEditor
          serverId={serverId}
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function CrontabEditor({ serverId, source, onClose, onSaved }: { serverId: string; source: CronSource; onClose: () => void; onSaved: () => void }) {
  const notify = useApp((s) => s.notify);
  const [text, setText] = useState(source.raw);
  const [saving, setSaving] = useState(false);
  const user = source.id.replace(/^user:/, "");

  const save = async () => {
    setSaving(true);
    try {
      await api.crontabSave(serverId, user, text);
      notify(`Crontab de ${user} enregistrée`, "success");
      onSaved();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Crontab de ${user}`}
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted">minute heure jour-du-mois mois jour-de-la-semaine commande · crontab vérifie la syntaxe avant d'enregistrer</span>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={saving} disabled={text === source.raw} onClick={() => void save()}>
            Enregistrer
          </Button>
        </>
      }
    >
      <textarea
        className="h-[55vh] w-full resize-none rounded-md border border-border bg-bg p-3 font-mono text-xs outline-none focus:border-accent"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Modal>
  );
}
