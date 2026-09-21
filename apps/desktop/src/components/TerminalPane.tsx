import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type TermEvent } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { broadcastInput, isBroadcasting, useBroadcast } from "../lib/broadcast";

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

/** Présence de tmux par serveur : vrai, faux, ou null si la vérification a échoué (rien n'est alors mis en cache). */
const tmuxPresent = new Map<string, Promise<boolean>>();

function tmuxAvailable(serverId: string): Promise<boolean | null> {
  let p = tmuxPresent.get(serverId);
  if (!p) {
    p = api.tmuxCheck(serverId).then((v) => !!v);
    tmuxPresent.set(serverId, p);
  }
  return p.catch(() => {
    tmuxPresent.delete(serverId);
    return null;
  });
}

/** Serveurs pour lesquels l'installation de tmux a déjà été proposée pendant cette session de l'app. */
const tmuxOffered = new Set<string>();

/** Propose tmux une fois le terminal ouvert, sans bloquer son ouverture. */
async function offerTmux(serverId: string) {
  const { settings, setSettings, ask, notify } = useApp.getState();
  if (settings.tmuxDeclined[serverId] || tmuxOffered.has(serverId)) return;
  tmuxOffered.add(serverId);
  const ok = await ask({
    title: "Sessions persistantes",
    body: "tmux n'est pas installé sur ce serveur. Il permet de retrouver tes terminaux intacts après une coupure réseau ou la fermeture de l'app. L'installer maintenant (paquet officiel de ta distribution) ? Les prochains terminaux ouverts en profiteront.",
    confirmLabel: "Installer tmux",
  });
  if (!ok) {
    setSettings({ tmuxDeclined: { ...useApp.getState().settings.tmuxDeclined, [serverId]: true } });
    return;
  }
  try {
    await api.tmuxInstall(serverId);
    tmuxPresent.set(serverId, Promise.resolve(true));
    notify("tmux installé : les prochains terminaux seront persistants", "success");
  } catch (e) {
    notify(`Installation de tmux impossible : ${errorMessage(e)}`, "error");
  }
}

export default function TerminalPane({
  serverId,
  command,
  tmux,
  paneId,
  label,
  visible,
  onTitle,
}: {
  serverId: string;
  command?: string;
  /** Session tmux à créer ou rattacher (sessions persistantes). */
  tmux?: string;
  /** Identifiant du panneau, pour la diffusion de la saisie. */
  paneId: string;
  label: string;
  visible: boolean;
  onTitle?: (title: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<number | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const started = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const broadcasting = useBroadcast((s) => s.active && s.targets.includes(paneId));
  const broadcastCount = useBroadcast((s) => s.targets.length);

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
    useBroadcast.getState().register(paneId, { termId: null, label });

    let disposed = false;
    let waitingReconnect = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const setTerm = (id: number | null) => {
      idRef.current = id;
      useBroadcast.getState().register(paneId, { termId: id, label });
    };

    // Reconnexion automatique : 1 s, 2 s, 4 s… jusqu'à 30 s entre deux tentatives.
    const scheduleRetry = () => {
      const delay = Math.min(30, 2 ** retry);
      retry++;
      term.write(`\x1b[2mNouvelle tentative dans ${delay} s… (Entrée pour réessayer tout de suite)\x1b[0m\r\n`);
      waitingReconnect = true;
      retryTimer = setTimeout(() => {
        if (disposed || !waitingReconnect) return;
        waitingReconnect = false;
        void start(false);
      }, delay * 1000);
    };

    const start = async (interactive = true): Promise<void> => {
      term.write("\x1b[2mConnexion…\x1b[0m\r\n");
      if (!(await ensureConnected(serverId, { interactive, force: interactive }))) {
        if (!interactive && tmux) return scheduleRetry();
        term.write("\x1b[31mConnexion annulée ou impossible.\x1b[0m Appuie sur Entrée pour réessayer.\r\n");
        waitingReconnect = true;
        return;
      }
      const hasTmux = !command && tmux ? await tmuxAvailable(serverId) : null;
      const useTmux = hasTmux === true;
      try {
        const id = await api.termOpen(
          serverId,
          term.cols,
          term.rows,
          (e: TermEvent) => {
            if (e.type === "data") {
              term.write(decode(e.data));
              return;
            }
            setTerm(null);
            if (disposed) return;
            if (e.code == null && useTmux) {
              // Coupure réseau : la session tmux tourne toujours, on s'y rattache tout seul.
              term.write("\r\n\x1b[33m[Connexion perdue, la session continue sur le serveur]\x1b[0m\r\n");
              scheduleRetry();
              return;
            }
            term.write(`\r\n\x1b[2m[Session terminée${e.code != null ? ` (code ${e.code})` : ""}] Appuie sur Entrée pour relancer.\x1b[0m\r\n`);
            waitingReconnect = true;
          },
          { command, tmuxSession: useTmux ? tmux : undefined },
        );
        if (disposed) {
          void api.termClose(id);
          return;
        }
        retry = 0;
        setTerm(id);
        focusedTerminal.id = id;
        if (visibleRef.current) term.focus();
        if (hasTmux === false) void offerTmux(serverId);
      } catch (e) {
        if (!interactive && tmux) return scheduleRetry();
        term.write(`\x1b[31m${errorMessage(e)}\x1b[0m\r\nAppuie sur Entrée pour réessayer.\r\n`);
        waitingReconnect = true;
      }
    };

    startRef.current = () => {
      if (started.current) return;
      started.current = true;
      void start();
    };

    term.onData((data) => {
      if (waitingReconnect) {
        if (data === "\r") {
          clearTimeout(retryTimer);
          waitingReconnect = false;
          term.clear();
          void start();
        }
        return;
      }
      if (isBroadcasting(paneId)) {
        void broadcastInput(data);
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

    if (visibleRef.current) startRef.current();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      observer.disconnect();
      useBroadcast.getState().unregister(paneId);
      // Fermer le canal détache simplement la session tmux : elle continue sur le serveur.
      if (idRef.current != null) void api.termClose(idRef.current);
      term.dispose();
    };
    // La session est liée au serveur, à la commande et à la session tmux initiales uniquement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, command, tmux, paneId]);

  // Connexion différée : un onglet restauré ne se connecte qu'à son premier affichage.
  useEffect(() => {
    if (visible) {
      startRef.current?.();
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full overflow-hidden bg-bg" />
      {broadcasting && (
        <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 bg-danger/85 px-3 py-0.5 text-center text-[11px] font-medium text-white">
          Saisie diffusée à {broadcastCount} terminaux
        </div>
      )}
    </div>
  );
}
