import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { FileDiff, Save, ShieldAlert } from "lucide-react";
import "../lib/monaco";
import { languageFor } from "../lib/monaco";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, Modal } from "./ui";

/** Éditeur de fichier distant en fenêtre modale, avec aperçu des modifications avant enregistrement. */
export default function FileEditor({ serverId, path, onClose }: { serverId: string; path: string; onClose: () => void }) {
  const notify = useApp((s) => s.notify);
  const ask = useApp((s) => s.ask);
  const [original, setOriginal] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [sudo, setSudo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const dirty = original !== null && value !== original;
  const saveRef = useRef<() => void>(() => {});

  const load = useCallback(
    async (withSudo: boolean) => {
      setError(null);
      try {
        const text = await api.fsRead(serverId, path, withSudo);
        setOriginal(text);
        setValue(text);
        setSudo(withSudo);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [serverId, path],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await api.fsWrite(serverId, path, value, sudo);
      setOriginal(value);
      setShowDiff(false);
      notify(`${path} enregistré`, "success");
    } catch (e) {
      const msg = errorMessage(e);
      if (!sudo && /permission|denied|refus/i.test(msg)) {
        const ok = await ask({
          title: "Permission refusée",
          body: "Ce fichier appartient à un autre utilisateur. Enregistrer en root avec sudo ?",
          confirmLabel: "Enregistrer avec sudo",
        });
        if (ok) {
          try {
            await api.fsWrite(serverId, path, value, true);
            setSudo(true);
            setOriginal(value);
            notify(`${path} enregistré (sudo)`, "success");
          } catch (e2) {
            notify(errorMessage(e2), "error");
          }
        }
      } else {
        notify(msg, "error");
      }
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    editor.focus();
  };

  const close = async () => {
    if (dirty) {
      const ok = await ask({ title: "Modifications non enregistrées", body: "Fermer sans enregistrer ?", confirmLabel: "Fermer", danger: true });
      if (!ok) return;
    }
    onClose();
  };

  return (
    <Modal
      width="max-w-6xl"
      title={
        <span className="flex items-center gap-2 font-mono text-xs">
          {path}
          {dirty && <Badge tone="warn">modifié</Badge>}
          {sudo && <Badge tone="danger">root</Badge>}
        </span>
      }
      onClose={() => void close()}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted">Ctrl+S pour enregistrer</span>
          <Button icon={<FileDiff size={14} />} disabled={!dirty} onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Éditer" : "Voir les modifications"}
          </Button>
          <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={() => void save()}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="h-[70vh]">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <ShieldAlert size={32} className="text-warn" />
            <p className="max-w-md text-sm text-muted">{error}</p>
            {/permission|denied/i.test(error) && (
              <Button variant="primary" onClick={() => void load(true)}>
                Ouvrir en root (sudo)
              </Button>
            )}
          </div>
        ) : original === null ? (
          <p className="text-sm text-muted">Chargement…</p>
        ) : showDiff ? (
          <DiffEditor
            original={original}
            modified={value}
            language={languageFor(path)}
            theme="helm-dark"
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13 }}
          />
        ) : (
          <Editor
            value={value}
            onChange={(v) => setValue(v ?? "")}
            language={languageFor(path)}
            theme="helm-dark"
            onMount={onMount}
            options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
          />
        )}
      </div>
    </Modal>
  );
}
