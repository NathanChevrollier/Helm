// Éditeur SQL. Isolé dans son propre fichier — et chargé à la demande — pour que Monaco ne parte
// pas dans le morceau de code de l'onglet Bases de données : celui-ci s'affiche sans l'attendre.
import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor, languages, Position } from "monaco-editor";
import "../lib/monaco";

/** Mots-clés proposés à la saisie, en plus des tables de la base choisie. */
const MOTS_CLES = [
  "SELECT", "FROM", "WHERE", "ORDER BY", "GROUP BY", "HAVING", "LIMIT", "OFFSET", "JOIN", "LEFT JOIN",
  "INNER JOIN", "ON", "AS", "AND", "OR", "NOT", "NULL", "IS NULL", "IS NOT NULL", "IN", "LIKE", "ILIKE",
  "BETWEEN", "COUNT(*)", "SUM(", "AVG(", "MIN(", "MAX(", "DISTINCT", "INSERT INTO", "VALUES", "UPDATE",
  "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "BEGIN", "COMMIT", "ROLLBACK",
];

export default function SqlEditor({
  value,
  onChange,
  theme,
  onMount,
  tables = [],
}: {
  value: string;
  onChange: (value: string) => void;
  theme: string;
  onMount: OnMount;
  /** Tables de la base sélectionnée, proposées à la saisie. */
  tables?: string[];
}) {
  // Les tables changent avec la base : la complétion lit toujours la dernière liste connue.
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const fournisseurRef = useRef<{ dispose: () => void } | null>(null);
  useEffect(() => () => fournisseurRef.current?.dispose(), []);

  // La complétion est enregistrée au montage de l'éditeur : Monaco n'existe pas avant.
  const enregistrerCompletion = (monaco: Parameters<OnMount>[1]) => {
    fournisseurRef.current?.dispose();
    fournisseurRef.current = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model: editor.ITextModel, position: Position) => {
        const mot = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: mot.startColumn, endColumn: mot.endColumn };
        const suggestions: languages.CompletionItem[] = [
          ...tablesRef.current.map((t) => ({
            label: t,
            kind: monaco.languages.CompletionItemKind.Struct,
            detail: "table",
            // Un nom qui sort de l'ordinaire (majuscule, tiret, espace) doit être cité.
            insertText: /^[a-z_][a-z0-9_]*$/.test(t) ? t : `"${t}"`,
            range,
          })),
          ...MOTS_CLES.map((k) => ({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range })),
        ];
        return { suggestions };
      },
    });
  };

  return (
    <Editor
      value={value}
      onChange={(v) => onChange(v ?? "")}
      language="sql"
      theme={theme}
      options={{
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: "off",
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        wordWrap: "on",
        padding: { top: 10, bottom: 10 },
      }}
      onMount={(editor, monaco) => {
        enregistrerCompletion(monaco);
        onMount(editor, monaco);
      }}
    />
  );
}
