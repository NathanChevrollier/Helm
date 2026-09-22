import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Box, Cable, FolderOpen, Globe, History, Layers, Monitor, Plug, RotateCw, ScrollText, Search, Server, SquareTerminal, Star, Stethoscope, Zap } from "lucide-react";
import { useDoctor } from "./ConnectionDoctor";
import { focusedTerminal } from "../lib/focus";
import { api, errorMessage, shellQuote, type DesktopView, type DockerOverview, type Snippet, type TunnelView } from "../lib/api";
import { launchDesktop } from "./RemoteDesktops";
import { SECTIONS } from "../sections";
import { ensureConnected, useApp } from "../lib/store";

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

/** Score de correspondance approximative (0 = pas de correspondance). */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || t[idx - 1] === " " ? 50 : 0);
  let ti = 0;
  let points = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    points += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return points;
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const { servers, activeServerId, setSection, setActiveServer, openTab, ask, notify, recent, pushRecent, setFilesPath } = app;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [docker, setDocker] = useState<DockerOverview | null>(null);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [tunnels, setTunnels] = useState<TunnelView[]>([]);
  const [desktops, setDesktops] = useState<DesktopView[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  // Historique du shell du serveur de l'onglet actif, quand on vient d'un terminal.
  const termServer = app.section === "terminal" ? app.tabs.find((t) => t.key === app.activeTab)?.serverId : undefined;
  const [history, setHistory] = useState<string[]>([]);
  useEffect(() => {
    if (termServer) void api.shellHistory(termServer).then(setHistory).catch(() => {});
  }, [termServer]);
  const input = useRef<HTMLInputElement>(null);
  const server = servers.find((s) => s.id === activeServerId);

  useEffect(() => {
    input.current?.focus();
    void api.snippets().then(setSnippets);
    void api.tunnels().then(setTunnels);
    void api.desktops().then(setDesktops).catch(() => {});
    // Les données du serveur ne sont chargées que s'il est déjà connecté (aucune connexion imposée).
    if (server?.connected) {
      void api.dockerOverview(server.id).then(setDocker).catch(() => {});
      void api
        .sitesState(server.id)
        .then((s) => setDomains([...new Set(s.files.flatMap((f) => f.servers.flatMap((b) => b.serverNames)))].filter((d) => d.includes("."))))
        .catch(() => {});
    }
  }, [server?.id, server?.connected]);

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = SECTIONS.map((s) => ({ id: `go:${s.id}`, label: `Aller à ${s.label}`, icon: <s.icon size={15} />, run: () => setSection(s.id) }));
    for (const s of servers) {
      list.push({ id: `server:${s.id}`, label: `Serveur : ${s.name}`, hint: s.host, icon: <Server size={15} />, run: () => setActiveServer(s.id) });
      list.push({ id: `term:${s.id}`, label: `Terminal sur ${s.name}`, icon: <SquareTerminal size={15} />, run: () => openTab(s.id) });
      list.push({
        id: `doctor:${s.id}`,
        label: `Diagnostiquer la connexion à ${s.name}`,
        hint: "IP bannie, sshd arrêté, serveur éteint…",
        icon: <Stethoscope size={15} />,
        run: () => useDoctor.getState().open(s.id),
      });
      if (!s.connected) {
        list.push({
          id: `connect:${s.id}`,
          label: `Se connecter à ${s.name}`,
          icon: <Plug size={15} />,
          run: async () => {
            if (await ensureConnected(s.id, { force: true })) notify(`Connecté à ${s.name}`, "success");
          },
        });
      }
    }
    if (server) {
      const sid = server.id;
      const dk = `${docker?.access === "sudo" ? "sudo " : ""}${docker?.engine ?? "docker"}`;
      list.push({
        id: "nginx:test",
        label: "Tester la configuration nginx",
        hint: server.name,
        icon: <Zap size={15} />,
        run: async () => {
          const r = await api.sitesTest(sid).catch((e) => ({ ok: false, output: errorMessage(e) }));
          notify(r.ok ? "Configuration nginx valide" : r.output, r.ok ? "success" : "error");
        },
      });
      for (const c of docker?.containers ?? []) {
        list.push({ id: `logs:${c.name}`, label: `Logs de ${c.name}`, hint: server.name, icon: <ScrollText size={15} />, run: () => openTab(sid, { title: `${c.name} (logs)`, command: `${dk} logs -f --tail 300 ${shellQuote(c.id)}` }) });
        if (c.state === "running") {
          list.push({
            id: `shell:${c.name}`,
            label: `Shell dans ${c.name}`,
            hint: server.name,
            icon: <SquareTerminal size={15} />,
            run: () => openTab(sid, { title: `${c.name} (shell)`, command: `${dk} exec -it ${shellQuote(c.id)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'` }),
          });
        }
        list.push({
          id: `restart:${c.name}`,
          label: `Redémarrer ${c.name}`,
          hint: server.name,
          icon: <RotateCw size={15} />,
          run: async () => {
            if (!(await ask({ title: `Redémarrer ${c.name} ?`, confirmLabel: "Redémarrer" }))) return;
            try {
              await api.dockerAction(sid, c.id, "restart");
              notify(`${c.name} redémarré`, "success");
            } catch (e) {
              notify(errorMessage(e), "error");
            }
          },
        });
      }
      for (const p of docker?.projects ?? []) {
        list.push({
          id: `deploy:${p.name}`,
          label: `Déployer ${p.name}`,
          hint: "pull, redémarrage, vérification, retour arrière si échec",
          icon: <Layers size={15} />,
          run: async () => {
            if (!(await ask({ title: `Déployer ${p.name} ?`, body: "Télécharge les nouvelles images, redémarre le projet et revient à la version précédente si la vérification échoue.", confirmLabel: "Déployer" }))) return;
            try {
              const host = await api.deploySuggestHost(sid, p.name).catch(() => null);
              const cmd = await api.deployPrepare(sid, p, host);
              openTab(sid, { title: `Déploiement ${p.name}`, command: `${cmd}; echo; echo 'Tu peux fermer cet onglet.'; exec "$SHELL" -l` });
            } catch (e) {
              notify(errorMessage(e), "error");
            }
          },
        });
      }
      for (const d of domains) {
        list.push({ id: `open:${d}`, label: `Ouvrir ${d}`, icon: <Globe size={15} />, run: () => void openUrl(`https://${d}`) });
      }
      for (const sn of snippets) {
        list.push({
          id: `snippet:${sn.id}`,
          label: `Snippet : ${sn.name}`,
          hint: sn.command,
          icon: <ScrollText size={15} />,
          run: () => openTab(sid, { title: sn.name, command: `${sn.command}; echo; exec "$SHELL" -l` }),
        });
      }
    }
    for (const d of desktops) {
      list.push({ id: `rdp:${d.id}`, label: `Bureau à distance : ${d.name}`, hint: d.host, icon: <Monitor size={15} />, run: () => void launchDesktop(d) });
    }
    for (const t of tunnels) {
      list.push({
        id: `tunnel:${t.id}`,
        label: `${t.running ? "Arrêter" : "Démarrer"} le tunnel ${t.name || t.localPort}`,
        hint: `127.0.0.1:${t.localPort} → ${t.remoteHost}:${t.remotePort}`,
        icon: <Cable size={15} />,
        run: () => void (t.running ? api.tunnelStop(t.id) : api.tunnelStart(t.id)).catch((e) => notify(errorMessage(e), "error")),
      });
    }
    // Commandes déjà tapées : insérées dans le terminal actif, sans être exécutées.
    if (query && focusedTerminal.id != null) {
      history.forEach((cmd, i) =>
        list.push({
          id: `history:${i}`,
          label: cmd,
          hint: "historique · insérer dans le terminal",
          icon: <History size={15} />,
          run: () => {
            if (focusedTerminal.id != null) void api.termWrite(focusedTerminal.id, cmd);
            focusedTerminal.focus?.();
          },
        }),
      );
    }
    if (server) {
      for (const b of useApp.getState().bookmarks[server.id] ?? []) {
        list.push({
          id: `bookmark:${server.id}:${b.path}`,
          label: `Raccourci : ${b.name}`,
          hint: b.path,
          icon: <Star size={15} />,
          run: () => {
            setFilesPath(server.id, b.path);
            setSection("files");
          },
        });
      }
    }
    if (query.startsWith("/") && server) {
      list.unshift({
        id: "path",
        label: `Ouvrir ${query} dans Fichiers`,
        hint: server.name,
        icon: <FolderOpen size={15} />,
        run: () => {
          setFilesPath(server.id, query);
          setSection("files");
        },
      });
    }
    return list;
  }, [servers, server, docker, snippets, tunnels, desktops, domains, history, query, setSection, setActiveServer, openTab, ask, notify, setFilesPath]);

  const results = useMemo(() => {
    if (!query) {
      const rank = (a: Action) => {
        const r = recent.indexOf(a.id);
        return r < 0 ? 999 : r;
      };
      return [...actions].sort((a, b) => rank(a) - rank(b)).slice(0, 40);
    }
    return actions
      .map((a) => ({ a, s: score(query, `${a.label} ${a.hint ?? ""}`) + (recent.includes(a.id) ? 5 : 0) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 40)
      .map((x) => x.a);
  }, [actions, query, recent]);

  useEffect(() => setIndex(0), [query]);

  const execute = (a: Action | undefined) => {
    if (!a) return;
    if (a.id !== "path" && !a.id.startsWith("history:")) pushRecent(a.id);
    onClose();
    void a.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/50 pt-[12vh]" onMouseDown={onClose}>
      <div className="flex h-fit max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={16} className="text-muted" />
          <input
            ref={input}
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
            placeholder={`Rechercher une action${server ? ` (serveur : ${server.name})` : ""}, ou un chemin commençant par /`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") execute(results[index]);
            }}
          />
          <kbd className="rounded border border-border px-1.5 text-[10px] text-muted">Échap</kbd>
        </div>
        <ul className="min-h-0 overflow-auto py-1">
          {results.map((a, i) => (
            <li key={a.id}>
              <button
                onMouseEnter={() => setIndex(i)}
                onClick={() => execute(a)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${i === index ? "bg-accent/15" : ""}`}
              >
                <span className="text-muted">{a.icon}</span>
                <span className="truncate">{a.label}</span>
                {a.hint && <span className="ml-auto max-w-72 truncate pl-4 text-xs text-muted">{a.hint}</span>}
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="flex items-center gap-2 px-3 py-6 text-sm text-muted">
              <Box size={15} /> Aucune action trouvée.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
