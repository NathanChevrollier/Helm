import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Copy, History, SlidersHorizontal, XCircle } from "lucide-react";
import { api, errorMessage, type AuditEntry, type McpConfig } from "../lib/api";
import { useApp } from "../lib/store";
import { Badge, Button, Input } from "../components/ui";

const TABS = [
  { id: "journal", label: "Journal d'actions", icon: History },
  { id: "ai", label: "Accès IA (MCP)", icon: Bot },
  { id: "prefs", label: "Préférences", icon: SlidersHorizontal },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function SettingsView() {
  const [tab, setTab] = useState<TabId>("journal");
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-border px-6 pt-4">
        <h1 className="pb-3 text-lg font-semibold">Réglages</h1>
        <nav className="ml-auto flex self-end">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm ${tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === "journal" && <Journal />}
        {tab === "ai" && <AiAccess />}
        {tab === "prefs" && <Preferences />}
      </div>
    </div>
  );
}

function Journal() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [filter, setFilter] = useState("");
  const [origin, setOrigin] = useState<"all" | "app" | "mcp">("all");
  useEffect(() => {
    void api.auditList(2000).then(setEntries);
  }, []);
  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    return (entries ?? []).filter(
      (e) => (origin === "all" || e.origin === origin) && (!f || `${e.serverName} ${e.action} ${e.detail} ${e.error ?? ""}`.toLowerCase().includes(f)),
    );
  }, [entries, filter, origin]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">Chaque modification faite par Helm sur un serveur, et chaque lecture faite par l'IA via MCP, est inscrite ici (fichier local, jamais envoyé ailleurs).</p>
      <div className="flex items-center gap-2">
        <Input className="!w-80" placeholder="Filtrer (serveur, action, détail)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select className="h-8 rounded-md border border-border bg-bg px-2 text-sm" value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
          <option value="all">Toutes origines</option>
          <option value="app">Helm</option>
          <option value="mcp">IA (MCP)</option>
        </select>
        <span className="ml-auto text-xs text-muted">{rows.length} entrée(s)</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Origine</th>
              <th className="px-3 py-2 font-medium">Serveur</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Détail</th>
              <th className="px-3 py-2 font-medium">Résultat</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={i} className="border-t border-border/50 align-top">
                <td className="px-3 py-1.5 text-xs whitespace-nowrap text-muted tabular-nums">{new Date(e.t).toLocaleString("fr-FR")}</td>
                <td className="px-3 py-1.5">{e.origin === "mcp" ? <Badge tone="accent">IA</Badge> : <Badge>Helm</Badge>}</td>
                <td className="px-3 py-1.5 text-xs">{e.serverName}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{e.action}</td>
                <td className="max-w-80 px-3 py-1.5 text-xs break-all text-muted">{e.detail}</td>
                <td className="px-3 py-1.5 text-xs">
                  {e.ok ? (
                    <CheckCircle2 size={14} className="text-ok" />
                  ) : (
                    <span className="flex items-start gap-1 text-danger">
                      <XCircle size={14} className="mt-0.5 shrink-0" /> {e.error}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {entries && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-sm text-muted">Aucune action enregistrée.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AiAccess() {
  const { servers, refreshServers, notify } = useApp();
  const [config, setConfig] = useState<McpConfig | null>(null);
  useEffect(() => {
    void api.mcpConfig().then(setConfig);
  }, []);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    notify("Copié", "success");
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Ce que l'IA peut faire</h2>
        <ul className="flex flex-col gap-1 text-sm text-muted">
          <li>• <strong className="text-fg">Lire uniquement</strong> : état, métriques, alertes, conteneurs, logs, sites, configuration nginx, audit, sauvegardes.</li>
          <li>• <strong className="text-fg">Aucune action</strong> : aucun outil ne peut modifier un serveur ni exécuter une commande libre.</li>
          <li>• Les mots de passe, jetons et clés sont masqués avant l'envoi ; clés privées et fichiers sensibles restent illisibles.</li>
          <li>• Chaque lecture est inscrite dans le journal d'actions (origine « IA »).</li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Serveurs accessibles par l'IA</h2>
        <p className="text-xs text-muted">Désactivé par défaut. Les données lues sont envoyées au fournisseur du modèle que tu utilises.</p>
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-panel p-2">
          {servers.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/5">
              <input
                type="checkbox"
                checked={!!s.aiAccess}
                onChange={async (e) => {
                  try {
                    await api.setAiAccess(s.id, e.target.checked);
                    await refreshServers();
                  } catch (err) {
                    notify(errorMessage(err), "error");
                  }
                }}
              />
              <span className="text-sm">{s.name}</span>
              <span className="font-mono text-xs text-muted">{s.host}</span>
            </label>
          ))}
          {servers.length === 0 && <p className="p-2 text-sm text-muted">Aucun serveur.</p>}
        </div>
      </section>

      {config && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium">Brancher Claude</h2>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-muted">
              Claude Code (dans un terminal)
              <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(config.claudeCode)}>
                Copier
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-xs select-text">{config.claudeCode}</pre>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-muted">
              Claude Desktop (fichier claude_desktop_config.json)
              <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(config.claudeDesktop)}>
                Copier
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-xs select-text">{config.claudeDesktop}</pre>
          </div>
          <p className="text-xs text-muted">Le serveur MCP est l'app Helm elle-même, lancée avec l'option --mcp (sans fenêtre). Réinstalle la config si tu déplaces Helm.</p>
        </section>
      )}
    </div>
  );
}

function Preferences() {
  const { settings, setSettings, servers } = useApp();
  const declined = Object.keys(settings.tmuxDeclined).filter((id) => settings.tmuxDeclined[id]);
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <label className="flex items-start gap-3 rounded-lg border border-border bg-panel p-4">
        <input type="checkbox" className="mt-1" checked={settings.persistentSessions} onChange={(e) => setSettings({ persistentSessions: e.target.checked })} />
        <span>
          <span className="font-medium">Sessions persistantes (tmux)</span>
          <span className="block text-sm text-muted">
            Les nouveaux terminaux tournent dans une session tmux : ils survivent aux coupures réseau et à la fermeture de Helm, et se rattachent automatiquement.
          </span>
        </span>
      </label>
      {declined.length > 0 && (
        <div className="rounded-lg border border-border bg-panel p-4 text-sm">
          <p className="text-muted">
            Installation de tmux refusée pour : {declined.map((id) => servers.find((s) => s.id === id)?.name ?? "serveur supprimé").join(", ")}.
          </p>
          <Button size="sm" className="mt-2" onClick={() => setSettings({ tmuxDeclined: {} })}>
            Reproposer l'installation
          </Button>
        </div>
      )}
    </div>
  );
}
