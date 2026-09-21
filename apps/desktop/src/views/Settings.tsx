import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Copy, History, Lock, SlidersHorizontal, XCircle } from "lucide-react";
import { api, errorMessage, type AuditEntry, type McpConfig } from "../lib/api";
import { useApp } from "../lib/store";
import { hashPassword, useLock } from "../lib/lock";
import type { ThemeSetting } from "../lib/theme";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
            <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
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
  const { settings, setSettings, servers, notify } = useApp();
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
      <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-4">
        <span className="flex-1">
          <span className="font-medium">Thème</span>
          <span className="block text-sm text-muted">« Système » suit le thème de Windows.</span>
        </span>
        <select className="h-8 rounded-md border border-border bg-bg px-2 text-sm" value={settings.theme} onChange={(e) => setSettings({ theme: e.target.value as ThemeSetting })}>
          <option value="dark">Sombre</option>
          <option value="light">Clair</option>
          <option value="system">Système</option>
        </select>
      </div>
      <label className="flex items-start gap-3 rounded-lg border border-border bg-panel p-4">
        <input type="checkbox" className="mt-1" checked={settings.alertNotifications} onChange={(e) => setSettings({ alertNotifications: e.target.checked })} />
        <span>
          <span className="font-medium">Notifications Windows pour les alertes</span>
          <span className="block text-sm text-muted">
            Tant que Helm est ouvert, une notification apparaît dès qu'une alerte se déclenche sur un serveur connecté (CPU, mémoire, disque, site injoignable…). Helm fermé, c'est l'agent qui prévient (Discord, ntfy, webhook).
          </span>
        </span>
      </label>
      <AppLock />
      <ExportImport />
      <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-4">
        <span className="flex-1">
          <span className="font-medium">Journaux de Helm</span>
          <span className="block text-sm text-muted">Connexions, actions et erreurs de l'app, sans aucun secret. Utile pour comprendre un problème.</span>
        </span>
        <Button size="sm" onClick={() => void api.logsOpenDir().catch((e) => notify(errorMessage(e), "error"))}>
          Ouvrir le dossier
        </Button>
      </div>
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

const LOCK_DELAYS = [
  { minutes: 0, label: "Jamais (verrouillage manuel uniquement)" },
  { minutes: 5, label: "Après 5 minutes d'inactivité" },
  { minutes: 15, label: "Après 15 minutes d'inactivité" },
  { minutes: 30, label: "Après 30 minutes d'inactivité" },
  { minutes: 60, label: "Après 1 heure d'inactivité" },
];

/** Mot de passe de verrouillage de Helm et délai de verrouillage automatique. */
function AppLock() {
  const { settings, setSettings, notify, ask } = useApp();
  const configured = useLock((s) => s.configured);
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (pw.length < 6) return notify("Choisis au moins 6 caractères.", "error");
    if (pw !== confirm) return notify("Les deux mots de passe ne correspondent pas.", "error");
    setBusy(true);
    try {
      await api.appLockSet(await hashPassword(pw));
      await useLock.getState().refresh();
      setEditing(false);
      setPw("");
      setConfirm("");
      notify("Mot de passe de verrouillage enregistré (Ctrl+Maj+L pour verrouiller)", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await ask({ title: "Désactiver le verrouillage ?", body: "Helm ne sera plus protégé par un mot de passe.", confirmLabel: "Désactiver", danger: true }))) return;
    await api.appLockSet("");
    setSettings({ lockMinutes: 0 });
    await useLock.getState().refresh();
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
      <div>
        <span className="flex items-center gap-2 font-medium">
          <Lock size={14} /> Verrouillage de Helm {configured && <Badge tone="ok">activé</Badge>}
        </span>
        <span className="block text-sm text-muted">
          Helm ouvert donne accès à tous tes serveurs. Un mot de passe masque l'interface quand tu t'absentes ; connexions et terminaux continuent en arrière-plan. Seule son empreinte est conservée, dans le coffre de Windows.
        </span>
      </div>
      {configured && !editing && (
        <>
          <select
            className="h-8 w-80 rounded-md border border-border bg-bg px-2 text-sm"
            value={settings.lockMinutes}
            onChange={(e) => setSettings({ lockMinutes: Number(e.target.value) })}
          >
            {LOCK_DELAYS.map((d) => (
              <option key={d.minutes} value={d.minutes}>
                {d.label}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              Changer le mot de passe
            </Button>
            <Button size="sm" variant="danger" onClick={() => void remove()}>
              Désactiver
            </Button>
          </div>
        </>
      )}
      {(!configured || editing) && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input className="!w-80" type="password" placeholder="Nouveau mot de passe (6 caractères min.)" value={pw} onChange={(e) => setPw(e.target.value)} />
          <Input className="!w-80" type="password" placeholder="Confirmation" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" type="submit" loading={busy}>
              {configured ? "Enregistrer" : "Activer le verrouillage"}
            </Button>
            {editing && (
              <Button size="sm" onClick={() => setEditing(false)}>
                Annuler
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/** Export / import des réglages (changement de PC, copie de secours). */
function ExportImport() {
  const { notify, ask, refreshServers } = useApp();
  const [exporting, setExporting] = useState(false);
  const [pw, setPw] = useState("");
  const [withSecrets, setWithSecrets] = useState(false);

  const doExport = async () => {
    if (withSecrets && pw.length < 8) return notify("Avec les secrets, choisis un mot de passe d'au moins 8 caractères.", "error");
    const path = await saveDialog({ defaultPath: `helm-reglages-${new Date().toISOString().slice(0, 10)}.helm`, filters: [{ name: "Réglages Helm", extensions: ["helm"] }] });
    if (!path) return;
    try {
      await api.settingsExport(path, pw, withSecrets);
      notify(pw ? "Réglages exportés (fichier chiffré)" : "Réglages exportés", "success");
      setExporting(false);
      setPw("");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const doImport = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Réglages Helm", extensions: ["helm", "json"] }] });
    if (typeof path !== "string") return;
    try {
      let password = "";
      if (await api.settingsImportEncrypted(path)) {
        const v = await ask({ title: "Fichier chiffré", body: "Mot de passe choisi lors de l'export :", input: { label: "Mot de passe", secret: true }, confirmLabel: "Importer" });
        if (typeof v !== "string" || !v) return;
        password = v;
      }
      const r = await api.settingsImport(path, password);
      await refreshServers();
      notify(`Importé : ${r.servers} serveur(s), ${r.snippets} snippet(s), ${r.tunnels} tunnel(s), ${r.secrets} secret(s)`, "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
      <div>
        <span className="font-medium">Exporter / importer mes réglages</span>
        <span className="block text-sm text-muted">
          Serveurs, clés d'hôte approuvées, snippets et tunnels, pour changer de PC ou garder une copie. L'import complète la configuration actuelle sans rien supprimer.
        </span>
      </div>
      {exporting ? (
        <div className="flex flex-col gap-2">
          <Input className="!w-80" type="password" placeholder="Mot de passe de chiffrement (recommandé)" value={pw} onChange={(e) => setPw(e.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
            Inclure les secrets (mots de passe SSH et sudo, passphrases, mot de passe restic) — fichier chiffré obligatoire
          </label>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => void doExport()}>
              Choisir l'emplacement…
            </Button>
            <Button size="sm" onClick={() => setExporting(false)}>
              Annuler
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setExporting(true)}>
            Exporter…
          </Button>
          <Button size="sm" onClick={() => void doImport()}>
            Importer…
          </Button>
        </div>
      )}
    </div>
  );
}
