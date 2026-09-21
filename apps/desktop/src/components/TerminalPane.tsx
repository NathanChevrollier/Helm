import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type TermEvent } from "../lib/api";
import { ensureConnected } from "../lib/store";

/** Terminal actuellement focalisé : cible des snippets. */
export const focusedTerminal: { id: number | null } = { id: null };

const THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#3b82f6",
  selectionBackground: "#3b82f655",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function TerminalPane({
  serverId,
  command,
  visible,
  onTitle,
}: {
  serverId: string;
  command?: string;
  visible: boolean;
  onTitle?: (title: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, url) => void openUrl(url)));
    term.open(host.current!);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL indisponible : rendu DOM par défaut */
    }
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let waitingReconnect = false;

    const start = async () => {
      term.write("\x1b[2mConnexion…\x1b[0m\r\n");
      if (!(await ensureConnected(serverId))) {
        term.write("\x1b[31mConnexion annulée ou impossible.\x1b[0m Appuie sur Entrée pour réessayer.\r\n");
        waitingReconnect = true;
        return;
      }
      try {
        const id = await api.termOpen(serverId, term.cols, term.rows, (e: TermEvent) => {
          if (e.type === "data") term.write(decode(e.data));
          else {
            idRef.current = null;
            if (disposed) return;
            term.write(`\r\n\x1b[2m[Session terminée${e.code != null ? ` (code ${e.code})` : ""}] Appuie sur Entrée pour relancer.\x1b[0m\r\n`);
            waitingReconnect = true;
          }
        }, command);
        if (disposed) {
          void api.termClose(id);
          return;
        }
        idRef.current = id;
        focusedTerminal.id = id;
        term.focus();
      } catch (e) {
        term.write(`\x1b[31m${errorMessage(e)}\x1b[0m\r\nAppuie sur Entrée pour réessayer.\r\n`);
        waitingReconnect = true;
      }
    };

    term.onData((data) => {
      if (waitingReconnect) {
        if (data === "\r") {
          waitingReconnect = false;
          term.clear();
          void start();
        }
        return;
      }
      if (idRef.current != null) void api.termWrite(idRef.current, data);
    });
    term.onResize(({ cols, rows }) => {
      if (idRef.current != null) void api.termResize(idRef.current, cols, rows);
    });
    term.onTitleChange((t) => onTitle?.(t));
    term.textarea?.addEventListener("focus", () => {
      focusedTerminal.id = idRef.current;
    });

    // Ctrl+Shift+C / Ctrl+Shift+V, comme dans les terminaux Linux ; Ctrl+C reste SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      if (e.code === "KeyV") {
        void navigator.clipboard.readText().then((text) => term.paste(text));
        return false;
      }
      return true;
    });
    // Clic droit : colle, comme PuTTY.
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        void navigator.clipboard.writeText(sel);
        term.clearSelection();
      } else {
        void navigator.clipboard.readText().then((text) => term.paste(text));
      }
    };
    host.current!.addEventListener("contextmenu", onContext);

    const observer = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) fit.fit();
    });
    observer.observe(host.current!);

    void start();

    return () => {
      disposed = true;
      observer.disconnect();
      if (idRef.current != null) void api.termClose(idRef.current);
      term.dispose();
    };
    // La session est liée au serveur et à la commande initiale uniquement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, command]);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  return <div ref={host} className="h-full w-full overflow-hidden bg-bg" />;
}
