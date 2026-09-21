import { useEffect, useRef, useState } from "react";
import { Circle, Search, Square, X } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type TermEvent } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { broadcastInput, isBroadcasting, useBroadcast } from "../lib/broadcast";
import { useTheme } from "../lib/theme";
import { display, isAppShortcut, matches, shortcutOf } from "../lib/shortcuts";

/** Terminal actuellement focalisé : cible des snippets. */
export const focusedTerminal: { id: number | null; focus?: () => void } = { id: null };

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

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  selectionBackground: "#0969da33",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
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
  const fontSize = useApp((s) => s.settings.terminalFontSize);
  const theme = useTheme((s) => s.theme);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const openSearchRef = useRef<() => void>(() => {});
  openSearchRef.current = () => {
    setSearching(true);
    // Déjà ouverte : on resélectionne le texte ; sinon autoFocus prend le relais au montage.
    searchInput.current?.select();
  };
  /** Enregistrement asciicast v2 : [secondes depuis le début, "o", texte]. */
  const recording = useRef<{ start: number; cols: number; rows: number; events: [number, "o", string][]; decoder: TextDecoder } | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    const term = new Terminal({
      theme: useTheme.getState().theme === "light" ? LIGHT_THEME : THEME,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: useApp.getState().settings.terminalFontSize,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    // Seuls les liens web s'ouvrent : une sortie de commande ne doit pas pouvoir lancer autre chose.
    term.loadAddon(new WebLinksAddon((_e, url) => /^https?:\/\//i.test(url) && void openUrl(url)));
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
              const bytes = decode(e.data);
              term.write(bytes);
              const rec = recording.current;
              if (rec) rec.events.push([(performance.now() - rec.start) / 1000, "o", rec.decoder.decode(bytes, { stream: true })]);
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
      focusedTerminal.focus = () => term.focus();
    });

    // Collage : un bloc de plusieurs lignes s'exécuterait ligne par ligne dès le collage ; on
    // demande confirmation (sauf si le shell gère le « bracketed paste »), et toujours quand la
    // saisie est diffusée à plusieurs serveurs.
    const safePaste = async (text: string) => {
      if (!text) return;
      const multiline = /[\r\n]/.test(text.replace(/\r?\n$/, ""));
      const broadcast = isBroadcasting(paneId);
      if ((multiline && !term.modes.bracketedPasteMode) || broadcast) {
        const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
        const ok = await useApp.getState().ask({
          title: broadcast ? `Coller dans ${useBroadcast.getState().targets.length} terminaux ?` : `Coller ${lines} lignes ?`,
          body: broadcast
            ? "La saisie est diffusée : ce texte sera envoyé à tous les terminaux sélectionnés."
            : "Chaque ligne sera exécutée dès le collage. Vérifie le contenu avant de continuer.",
          code: text.length > 3000 ? `${text.slice(0, 3000)}\n…` : text,
          confirmLabel: "Coller",
          danger: broadcast,
        });
        if (!ok) return;
      }
      term.paste(text);
      term.focus();
    };
    // Ctrl+V et collage natif : interceptés avant xterm (phase de capture sur le conteneur).
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void safePaste(e.clipboardData?.getData("text/plain") ?? "");
    };
    const hostEl = host.current!;
    hostEl.addEventListener("paste", onPaste, true);

    // Taille de police : Ctrl+= / Ctrl+- / Ctrl+0 et Ctrl+molette, partagée par tous les terminaux.
    const zoom = (delta: number | null) => {
      const { settings, setSettings } = useApp.getState();
      const size = delta === null ? 14 : Math.min(28, Math.max(9, settings.terminalFontSize + delta));
      setSettings({ terminalFontSize: size });
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    };
    hostEl.addEventListener("wheel", onWheel, { passive: false });

    // Ctrl+Shift+C / Ctrl+Shift+V, comme dans les terminaux Linux ; Ctrl+C reste SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (matches(e, "termSearch")) {
        openSearchRef.current();
        return false;
      }
      // Raccourcis de l'app (palette, onglets, verrouillage…) : pour Helm, pas pour le shell.
      if (isAppShortcut(e)) return false;
      if (!e.ctrlKey) return true;
      if (!e.shiftKey && !e.altKey) {
        if (e.code === "Equal" || e.code === "NumpadAdd") return (zoom(1), false);
        if (e.code === "Minus" || e.code === "NumpadSubtract") return (zoom(-1), false);
        if (e.code === "Digit0" || e.code === "Numpad0") return (zoom(null), false);
        return true;
      }
      if (!e.shiftKey) return true;
      if (e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      if (e.code === "KeyV") {
        void navigator.clipboard.readText().then(safePaste);
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
        void navigator.clipboard.readText().then(safePaste);
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
      hostEl.removeEventListener("paste", onPaste, true);
      hostEl.removeEventListener("wheel", onWheel);
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

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme === "light" ? LIGHT_THEME : THEME;
  }, [theme]);

  // Changement de taille de police (depuis n'importe quel terminal) : appliqué à celui-ci.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  const find = (backwards = false) => {
    if (!query) return;
    const opts = { caseSensitive: false, decorations: { matchOverviewRuler: "#d29922", activeMatchColorOverviewRuler: "#3b82f6", matchBackground: "#d2992255", activeMatchBackground: "#3b82f6aa" } };
    if (backwards) searchRef.current?.findPrevious(query, opts);
    else searchRef.current?.findNext(query, opts);
  };
  const closeSearch = () => {
    setSearching(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  const toggleRecording = async () => {
    const term = termRef.current;
    if (!term) return;
    if (!recording.current) {
      recording.current = { start: performance.now(), cols: term.cols, rows: term.rows, events: [], decoder: new TextDecoder() };
      setIsRecording(true);
      return;
    }
    const rec = recording.current;
    recording.current = null;
    setIsRecording(false);
    const { notify } = useApp.getState();
    if (rec.events.length === 0) return notify("Rien à enregistrer : aucune sortie pendant l'enregistrement.", "info");
    const path = await save({
      title: "Enregistrer la session",
      defaultPath: `session-${label.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.cast`,
      filters: [{ name: "Enregistrement asciicast", extensions: ["cast"] }],
    });
    if (!path) return;
    const header = { version: 2, width: rec.cols, height: rec.rows, timestamp: Math.floor(Date.now() / 1000 - (performance.now() - rec.start) / 1000), title: label };
    const content = [JSON.stringify(header), ...rec.events.map((e) => JSON.stringify([Number(e[0].toFixed(4)), e[1], e[2]]))].join("\n") + "\n";
    try {
      await api.saveTextFile(path, content);
      notify(`Session enregistrée : ${path} (lecture avec asciinema play)`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <div className="group/term relative h-full w-full">
      <div ref={host} className="h-full w-full overflow-hidden bg-bg" />
      <div className={`absolute top-1 right-3 z-10 flex items-center gap-1 ${searching || isRecording ? "" : "opacity-0 group-hover/term:opacity-100"}`}>
        {isRecording && (
          <span className="flex items-center gap-1 rounded bg-danger/85 px-1.5 py-0.5 text-[10px] font-medium text-white">
            <Circle size={8} fill="currentColor" /> REC
          </span>
        )}
        {searching ? (
          <span className="flex items-center gap-1 rounded-md border border-border bg-panel px-1.5 py-1 shadow-lg">
            <input
              ref={searchInput}
              autoFocus
              className="w-48 bg-transparent text-xs outline-none placeholder:text-muted/60"
              placeholder="Rechercher (Entrée, Maj+Entrée)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") find(e.shiftKey);
                if (e.key === "Escape") closeSearch();
              }}
            />
            <button className="text-muted hover:text-fg" title="Fermer (Échap)" onClick={closeSearch}>
              <X size={12} />
            </button>
          </span>
        ) : (
          <button className="rounded bg-panel/90 p-1 text-muted hover:text-fg" title={`Rechercher dans le terminal (${display(shortcutOf("termSearch"))})`} onClick={() => openSearchRef.current()}>
            <Search size={13} />
          </button>
        )}
        <button
          className={`rounded bg-panel/90 p-1 hover:text-fg ${isRecording ? "text-danger" : "text-muted"}`}
          title={isRecording ? "Arrêter et enregistrer la session" : "Enregistrer la session (asciicast)"}
          onClick={() => void toggleRecording()}
        >
          {isRecording ? <Square size={13} fill="currentColor" /> : <Circle size={13} />}
        </button>
      </div>
      {broadcasting && (
        <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 bg-danger/85 px-3 py-0.5 text-center text-[11px] font-medium text-white">
          Saisie diffusée à {broadcastCount} terminaux
        </div>
      )}
    </div>
  );
}
