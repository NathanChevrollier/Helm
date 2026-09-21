// Monaco empaqueté localement (pas de CDN) + coloration syntaxique nginx.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

monaco.languages.register({ id: "nginx", extensions: [".conf"], aliases: ["nginx"] });
monaco.languages.setMonarchTokensProvider("nginx", {
  keywords: [
    "server", "location", "upstream", "http", "events", "listen", "server_name", "root", "index",
    "proxy_pass", "proxy_set_header", "proxy_http_version", "return", "rewrite", "include",
    "ssl_certificate", "ssl_certificate_key", "try_files", "client_max_body_size", "add_header",
    "gzip", "access_log", "error_log", "if", "set", "map", "alias", "allow", "deny", "ssl_protocols",
  ],
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/'([^'\\]|\\.)*'/, "string"],
      [/\$[a-zA-Z_][\w]*/, "variable"],
      [/\b\d+[kmgsdhKMG]?\b/, "number"],
      [/[a-z_]+(?=\s)/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      [/[{};]/, "delimiter"],
    ],
  },
});

monaco.editor.defineTheme("helm-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#0e0f11", "editor.lineHighlightBackground": "#16181c" },
});

monaco.editor.defineTheme("helm-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#ffffff", "editor.lineHighlightBackground": "#f6f8fa" },
});

/** Devine le langage Monaco d'après le nom de fichier. */
export function languageFor(path: string): string {
  const name = path.split("/").pop()!.toLowerCase();
  if (path.includes("/nginx/") || name.endsWith(".conf") && path.includes("nginx")) return "nginx";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile") return "plaintext";
  if (name.startsWith(".env")) return "ini";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript",
    json: "json", yml: "yaml", yaml: "yaml", md: "markdown", html: "html", htm: "html", css: "css", scss: "scss",
    py: "python", sh: "shell", bash: "shell", zsh: "shell", php: "php", go: "go", rs: "rust", sql: "sql",
    xml: "xml", toml: "ini", ini: "ini", conf: "ini", service: "ini", java: "java", rb: "ruby", c: "c", h: "c", cpp: "cpp",
  };
  return map[ext] ?? "plaintext";
}
