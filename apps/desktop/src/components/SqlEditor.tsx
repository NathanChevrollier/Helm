// Éditeur SQL. Isolé dans son propre fichier — et chargé à la demande — pour que Monaco ne parte
// pas dans le morceau de code de l'onglet Bases de données : celui-ci s'affiche sans l'attendre.
import Editor, { type OnMount } from "@monaco-editor/react";
import "../lib/monaco";

export default function SqlEditor({
  value,
  onChange,
  theme,
  onMount,
}: {
  value: string;
  onChange: (value: string) => void;
  theme: string;
  onMount: OnMount;
}) {
  return (
    <Editor
      value={value}
      onChange={(v) => onChange(v ?? "")}
      language="sql"
      theme={theme}
      options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, lineNumbers: "off" }}
      onMount={onMount}
    />
  );
}
