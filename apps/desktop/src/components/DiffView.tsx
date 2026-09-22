// Comparaison avant/après. Isolée et chargée à la demande : Monaco ne pèse plus sur l'ouverture
// des onglets qui n'affichent une différence que dans une fenêtre.
import { DiffEditor } from "@monaco-editor/react";
import "../lib/monaco";

export default function DiffView({
  original,
  modified,
  language,
  theme,
}: {
  original: string;
  modified: string;
  language: string;
  theme: string;
}) {
  return (
    <DiffEditor
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      original={original}
      modified={modified}
      language={language}
      theme={theme}
      options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12 }}
    />
  );
}
