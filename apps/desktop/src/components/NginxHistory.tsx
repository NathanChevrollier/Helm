import { useEffect, useState } from "react";
import { CheckCircle2, History, RotateCcw, XCircle } from "lucide-react";
import { api, errorMessage, type ApplyResult } from "../lib/api";
import { useApp } from "../lib/store";
import { Button, Modal } from "./ui";

/** `20260921-133323` → date lisible. */
function when(name: string): string {
  const d = new Date(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}`);
  return isNaN(d.getTime()) ? name : d.toLocaleString("fr-FR");
}

function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <p className="p-4 text-sm text-muted">Aucune différence avec la configuration actuelle.</p>;
  return (
    <pre className="font-mono text-[11px] leading-5 select-text">
      {text.split("\n").map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ")
              ? "font-semibold text-muted"
              : l.startsWith("+")
                ? "bg-ok/10 text-ok"
                : l.startsWith("-")
                  ? "bg-danger/10 text-danger"
                  : l.startsWith("@@")
                    ? "text-accent"
                    : ""
          }
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

export default function NginxHistory({ serverId, onClose, onRestored }: { serverId: string; onClose: () => void; onRestored: () => void }) {
  const { ask, notify } = useApp();
  const [list, setList] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.nginxBackups(serverId).then(setList, (e) => {
      setList([]);
      notify(errorMessage(e), "error");
    });
  }, [serverId, notify]);

  useEffect(() => {
    if (!selected) return;
    setDiff(null);
    setResult(null);
    api.nginxBackupDiff(serverId, selected).then(setDiff, (e) => setDiff(errorMessage(e)));
  }, [serverId, selected]);

  const restore = async () => {
    if (!selected) return;
    const ok = await ask({
      title: `Restaurer la configuration du ${when(selected)} ?`,
      body: "Toute la configuration nginx reviendra à cet état. L'état actuel est d'abord sauvegardé, puis la configuration restaurée est testée : si le test échoue, rien ne change.",
      confirmLabel: "Restaurer",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.nginxBackupRestore(serverId, selected);
      setResult(r);
      if (r.ok) onRestored();
    } catch (e) {
      setResult({ ok: false, backup: null, log: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Historique des configurations nginx" width="max-w-6xl" onClose={onClose}>
      <div className="grid h-[65vh] grid-cols-[240px_1fr] gap-4">
        <div className="overflow-auto rounded-lg border border-border">
          {list === null && <p className="p-3 text-sm text-muted">Chargement…</p>}
          {list?.length === 0 && <p className="p-3 text-sm text-muted">Aucune sauvegarde : elles sont créées à chaque modification faite avec Helm.</p>}
          {list?.map((n) => (
            <button key={n} onClick={() => setSelected(n)} className={`block w-full border-b border-border/50 px-3 py-2 text-left text-sm hover:bg-white/5 ${selected === n ? "bg-accent/15" : ""}`}>
              <span className="flex items-center gap-2">
                <History size={13} className="text-muted" /> {when(n)}
              </span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {!selected ? (
            <p className="text-sm text-muted">Choisis une sauvegarde pour voir ce qui a changé depuis.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="text-sm">
                  Différences entre la sauvegarde du <strong>{when(selected)}</strong> (−) et la configuration actuelle (+)
                </span>
                <Button size="sm" variant="danger" className="ml-auto" icon={<RotateCcw size={13} />} loading={busy} onClick={() => void restore()}>
                  Restaurer cette version
                </Button>
              </div>
              {result && (
                <div className={`rounded-md border px-3 py-2 text-sm ${result.ok ? "border-ok/40 bg-ok/10" : "border-danger/40 bg-danger/10"}`}>
                  <div className="flex items-center gap-2">
                    {result.ok ? <CheckCircle2 size={15} className="text-ok" /> : <XCircle size={15} className="text-danger" />}
                    {result.ok ? `Configuration restaurée et nginx rechargé (état précédent sauvegardé : ${result.backup}).` : "Restauration refusée : la configuration actuelle est conservée."}
                  </div>
                  {!result.ok && <pre className="mt-2 font-mono text-xs whitespace-pre-wrap">{result.log}</pre>}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-bg p-2">{diff === null ? <p className="p-2 text-sm text-muted">Calcul des différences…</p> : <DiffView text={diff} />}</div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
