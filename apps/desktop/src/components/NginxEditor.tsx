import { useEffect, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { CheckCircle2, FileDiff, ShieldCheck, XCircle } from "lucide-react";
import "../lib/monaco";
import { api, errorMessage, type ApplyResult } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, Modal } from "./ui";

/**
 * Éditeur de configuration nginx avec application sûre :
 * aperçu des changements → sauvegarde → nginx -t → reload, restauration automatique si échec.
 */
export default function NginxEditor({
  serverId,
  path,
  initial,
  enableLink,
  onClose,
  onApplied,
}: {
  serverId: string;
  path: string;
  /** Contenu de départ pour un nouveau fichier (sinon le fichier est lu sur le serveur). */
  initial?: string;
  enableLink?: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const ask = useApp((s) => s.ask);
  const [original, setOriginal] = useState<string | null>(initial !== undefined ? "" : null);
  const [value, setValue] = useState(initial ?? "");
  const [view, setView] = useState<"edit" | "diff">("edit");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = original !== null && value !== original;

  useEffect(() => {
    if (initial !== undefined) return;
    api.sitesRead(serverId, path).then(
      (t) => {
        setOriginal(t);
        setValue(t);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [serverId, path, initial]);

  const apply = async () => {
    setApplying(true);
    setResult(null);
    try {
      const r = await api.sitesWrite(serverId, path, value, enableLink);
      setResult(r);
      if (r.ok) {
        setOriginal(value);
        setView("edit");
        onApplied();
      }
    } catch (e) {
      setResult({ ok: false, backup: null, log: errorMessage(e) });
    } finally {
      setApplying(false);
    }
  };

  const close = async () => {
    if (dirty && !(await ask({ title: "Modifications non appliquées", body: "Fermer sans appliquer ?", confirmLabel: "Fermer", danger: true }))) return;
    onClose();
  };

  return (
    <Modal
      width="max-w-6xl"
      title={
        <span className="flex items-center gap-2 font-mono text-xs">
          {path}
          {dirty && <Badge tone="warn">modifié</Badge>}
        </span>
      }
      onClose={() => void close()}
      footer={
        <>
          <span className="mr-auto flex items-center gap-1.5 self-center text-xs text-muted">
            <ShieldCheck size={13} className="text-ok" /> Sauvegarde automatique, puis nginx -t. Rien n'est rechargé si le test échoue.
          </span>
          <Button icon={<FileDiff size={14} />} disabled={!dirty} onClick={() => setView((v) => (v === "edit" ? "diff" : "edit"))}>
            {view === "edit" ? "Voir les changements" : "Éditer"}
          </Button>
          <Button variant="primary" loading={applying} disabled={!dirty} onClick={() => void apply()}>
            Tester et appliquer
          </Button>
        </>
      }
    >
      <div className="flex h-[68vh] flex-col gap-3">
        {result && (
          <div className={`rounded-md border px-3 py-2 text-sm ${result.ok ? "border-ok/40 bg-ok/10" : "border-danger/40 bg-danger/10"}`}>
            <div className="flex items-center gap-2 font-medium">
              {result.ok ? <CheckCircle2 size={15} className="text-ok" /> : <XCircle size={15} className="text-danger" />}
              {result.ok ? "Configuration appliquée et nginx rechargé." : "Configuration refusée : l'ancienne version a été restaurée, tes sites n'ont pas été affectés."}
            </div>
            {result.backup && <div className="mt-1 text-xs text-muted">Sauvegarde : <span className="font-mono">{result.backup}</span></div>}
            {!result.ok && <pre className="mt-2 max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap select-text">{result.log}</pre>}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {error ? (
            <p className="text-sm text-danger">{error}</p>
          ) : original === null ? (
            <p className="text-sm text-muted">Chargement…</p>
          ) : view === "diff" ? (
            <DiffEditor keepCurrentOriginalModel keepCurrentModifiedModel original={original} modified={value} language="nginx" theme="helm-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }} />
          ) : (
            <Editor
              value={value}
              onChange={(v) => setValue(v ?? "")}
              language="nginx"
              theme="helm-dark"
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
