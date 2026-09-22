import { useEffect, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { CheckCircle2, FileDiff, ShieldCheck, XCircle } from "lucide-react";
import "../lib/monaco";
import { api, ENGINE_LABELS, errorMessage, type ApplyResult, type WebEngine } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, Modal } from "./ui";
import { useMonacoTheme } from "../lib/theme";

/**
 * Éditeur de configuration nginx ou Apache avec application sûre :
 * aperçu des changements → sauvegarde → test de la config → reload, restauration automatique si échec.
 */
export default function NginxEditor({
  serverId,
  path,
  initial,
  enableLink,
  engine = "nginx",
  onClose,
  onApplied,
}: {
  serverId: string;
  path: string;
  engine?: WebEngine;
  /** Contenu de départ pour un nouveau fichier (sinon le fichier est lu sur le serveur). */
  initial?: string;
  enableLink?: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const ask = useApp((s) => s.ask);
  const monacoTheme = useMonacoTheme();
  const web = ENGINE_LABELS[engine];
  // Coloration nginx ; Apache n'a pas de grammaire dans Monaco.
  const language = engine === "nginx" ? "nginx" : "plaintext";
  const [original, setOriginal] = useState<string | null>(initial !== undefined ? "" : null);
  const [value, setValue] = useState(initial ?? "");
  const [view, setView] = useState<"edit" | "diff">("edit");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = original !== null && value !== original;

  useEffect(() => {
    if (initial !== undefined) return;
    api.sitesRead(serverId, path, engine).then(
      (t) => {
        setOriginal(t);
        setValue(t);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [serverId, path, initial, engine]);

  const apply = async () => {
    setApplying(true);
    setResult(null);
    try {
      // Modification concurrente (certbot, autre session…) depuis l'ouverture : on ne l'écrase pas sans accord.
      if (initial === undefined && original !== null) {
        const current = await api.sitesRead(serverId, path, engine).catch(() => null);
        if (current !== null && current !== original) {
          const ok = await ask({
            title: "Le fichier a changé sur le serveur",
            body: "Il a été modifié depuis que tu l'as ouvert (certbot ajoute par exemple ses lignes HTTPS). Appliquer ta version fera disparaître ces changements. Pour les récupérer, ferme puis rouvre le fichier.",
            confirmLabel: "Appliquer quand même",
            danger: true,
          });
          if (!ok) return;
        }
      }
      const r = await api.sitesWrite(serverId, path, value, enableLink, engine);
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
            <ShieldCheck size={13} className="text-ok" /> Sauvegarde automatique, puis test de la configuration {web}. Rien n'est rechargé si le test échoue.
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
              {result.ok ? `Configuration appliquée et ${web} rechargé.` : "Configuration refusée : l'ancienne version a été restaurée, tes sites n'ont pas été affectés."}
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
            <DiffEditor keepCurrentOriginalModel keepCurrentModifiedModel original={original} modified={value} language={language} theme={monacoTheme} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }} />
          ) : (
            <Editor
              value={value}
              onChange={(v) => setValue(v ?? "")}
              language={language}
              theme={monacoTheme}
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
