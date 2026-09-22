import { useCallback, useEffect, useState } from "react";
import { Columns2, FolderTree, History, LayoutGrid, Plus, Radio, ScrollText, Server, Share2, SquareTerminal, Users, X } from "lucide-react";
import TerminalPane from "../components/TerminalPane";
import SnippetsPanel from "../components/SnippetsPanel";
import TerminalFiles from "../components/TerminalFiles";
import TerminalStatusBar from "../components/TerminalStatusBar";
import TransfersBar from "../components/TransfersBar";
import { ContextMenu } from "../components/ContextMenu";
import { api, errorMessage, type TmuxSession } from "../lib/api";
import { useBroadcast } from "../lib/broadcast";
import { usePanes } from "../lib/panes";
import { ensureConnected, newTmuxName, useApp, useAppPick, type TermTab } from "../lib/store";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal } from "../components/ui";
import { matches } from "../lib/shortcuts";

const SHELLS = ["bash", "zsh", "sh", "fish", "dash", "ash"];

/** Sessions tmux d'un onglet, avec le serveur de chacune (un onglet peut en couvrir plusieurs). */
function tabSessions(tab: TermTab): { serverId: string; name: string }[] {
  const out: { serverId: string; name: string }[] = [];
  if (tab.join) return out;
  if (tab.tmux) out.push({ serverId: tab.serverId, name: tab.tmux });
  if (tab.split) out.push({ serverId: tab.splitServerId ?? tab.serverId, name: tab.split });
  for (const g of tab.grid ?? []) if (g.tmux) out.push({ serverId: g.serverId, name: g.tmux });
  return out;
}

/** Identifiants des panneaux d'un onglet (diffusion, panneau actif). */
function tabPaneIds(tab: TermTab): string[] {
  if (tab.grid) return tab.grid.map((_, i) => `${tab.key}:g${i}`);
  return tab.split != null ? [`${tab.key}:0`, `${tab.key}:1`] : [`${tab.key}:0`];
}

export default function TerminalView({ visible }: { visible: boolean }) {
  const { tabs, activeTab, setActiveTab, closeTab, openTab, openGridTab, openJoinTab, updateTab, activeServerId, servers, ask, notify, settings } = useAppPick("tabs", "activeTab", "setActiveTab", "closeTab", "openTab", "openGridTab", "openJoinTab", "updateTab", "activeServerId", "servers", "ask", "notify", "settings");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [showSnippets, setShowSnippets] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null);
  const [multiPicker, setMultiPicker] = useState(false);
  const [joinPicker, setJoinPicker] = useState(false);
  const [sessionsOf, setSessionsOf] = useState<string | null>(null);
  const [broadcastPicker, setBroadcastPicker] = useState(false);
  const broadcast = useBroadcast();
  const current = tabs.find((t) => t.key === activeTab);
  const serverOf = useCallback((id: string) => servers.find((s) => s.id === id), [servers]);
  // Panneau qui a le focus dans l'onglet affiché (à défaut, le premier) : cible du panneau
  // Fichiers et de la barre de monitoring.
  const focusedPane = usePanes((s) => s.active);
  const currentPanes = current ? tabPaneIds(current) : [];
  const activePane = focusedPane && currentPanes.includes(focusedPane) ? focusedPane : (currentPanes[0] ?? null);
  const activePaneServer = usePanes((s) => (activePane ? s.panes[activePane]?.serverId : undefined)) ?? current?.serverId;

  // La diffusion s'arrête dès qu'on quitte le terminal.
  useEffect(() => {
    if (!visible && useBroadcast.getState().active) useBroadcast.getState().setActive(false);
  }, [visible]);

  /**
   * Ferme un onglet. Sa session tmux est fermée aussi, sauf si un programme y tourne encore :
   * on propose alors de le laisser continuer en arrière-plan.
   */
  const close = useCallback(
    async (tab: TermTab) => {
      const sessions = tabSessions(tab);
      const byServer = new Map<string, string[]>();
      for (const s of sessions) byServer.set(s.serverId, [...(byServer.get(s.serverId) ?? []), s.name]);
      const live: { serverId: string; name: string; command: string }[] = [];
      for (const [serverId, names] of byServer) {
        try {
          for (const s of await api.tmuxSessions(serverId)) if (names.includes(s.name)) live.push({ serverId, name: s.name, command: s.command });
        } catch {
          /* serveur injoignable : la session sera visible dans « Sessions » à la prochaine connexion */
        }
      }
      const busy = live.filter((s) => !SHELLS.includes(s.command));
      let keep = false;
      if (busy.length) {
        keep = !!(await ask({
          title: "Un programme tourne encore",
          body: `« ${busy.map((b) => b.command).join(", ")} » est en cours dans ce terminal. Le laisser continuer en arrière-plan ? Tu pourras le retrouver via « Sessions ». Sinon, il sera arrêté.`,
          confirmLabel: "Laisser tourner",
        }));
      }
      if (!keep) for (const s of live) await api.tmuxKill(s.serverId, s.name).catch(() => {});
      closeTab(tab.key);
    },
    [ask, closeTab],
  );

  // Raccourcis (modifiables dans les réglages) : nouvel onglet, fermer, onglet suivant / précédent.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "newTab") && activeServerId) {
        e.preventDefault();
        openTab(current?.serverId ?? activeServerId);
      } else if (matches(e, "closeTab") && current) {
        e.preventDefault();
        void close(current);
      } else if ((matches(e, "nextTab") || matches(e, "prevTab")) && tabs.length > 1 && current) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.key === current.key);
        const next = tabs[(i + (matches(e, "nextTab") ? 1 : tabs.length - 1)) % tabs.length];
        setActiveTab(next.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, activeServerId, current, openTab, close, tabs, setActiveTab]);

  /** Divise l'onglet ; le second panneau peut ouvrir un autre serveur (deux hôtes côte à côte). */
  const splitWith = async (serverId: string) => {
    if (!current) return;
    const other = serverId !== current.serverId;
    // Autre serveur : connecté d'abord, pour que ses dialogues (clé d'hôte, mot de passe) passent seuls.
    if (other && !(await ensureConnected(serverId, { force: true }))) return;
    const persistent = other
      ? settings.persistentSessions && !settings.tmuxDeclined[serverId]
      : !current.command && !!current.tmux;
    updateTab(current.key, { split: persistent ? newTmuxName() : "", splitServerId: other ? serverId : undefined });
  };
  const toggleSplit = (e: React.MouseEvent) => {
    if (!current || current.grid) return;
    if (current.split != null) {
      const name = current.split;
      const on = current.splitServerId ?? current.serverId;
      updateTab(current.key, { split: null, splitServerId: undefined });
      if (name) void api.tmuxKill(on, name).catch(() => {});
    } else if (servers.length > 1) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setSplitMenu({ x: r.left, y: r.bottom + 4 });
    } else {
      void splitWith(current.serverId);
    }
  };

  const labelOf = (t: TermTab, right = false) =>
    t.join
      ? `${titles[t.key] ?? t.title} (partagé)`
      : right ? `${serverOf(t.splitServerId ?? t.serverId)?.name ?? "?"} · ${titles[t.key] ?? t.title} (droite)` : `${serverOf(t.serverId)?.name ?? "?"} · ${titles[t.key] ?? t.title}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-stretch border-b border-border bg-rail pl-2">
        <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          {tabs.map((t) => {
            const s = serverOf(t.serverId);
            const active = t.key === activeTab;
            return (
              <div
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                onAuxClick={(e) => e.button === 1 && void close(t)}
                className={`group flex max-w-60 min-w-32 cursor-pointer items-center gap-2 border-b-2 px-3.5 text-[13px] ${
                  active ? "border-accent bg-bg font-medium text-fg" : "border-transparent text-muted hover:text-fg"
                }`}
              >
                {t.join ? (
                  <Share2 size={12} className="shrink-0 text-accent" />
                ) : t.grid ? (
                  <LayoutGrid size={12} className="shrink-0 text-accent" />
                ) : (
                  <span className="size-[7px] shrink-0 rounded-full" style={{ background: s?.color ?? "var(--color-accent)" }} />
                )}
                <span className="flex-1 truncate" title={titles[t.key] ?? t.title}>
                  {t.title}
                </span>
                {t.tmux && <span title="Session persistante (tmux)" className="text-[9px] text-muted">●</span>}
                <button
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-hover-strong"
                  onClick={(e) => {
                    e.stopPropagation();
                    void close(t);
                  }}
                  aria-label="Fermer l'onglet"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <IconButton
            title="Nouveau terminal (Ctrl+Shift+T)"
            className="m-2"
            disabled={!activeServerId}
            onClick={() => activeServerId && openTab(current?.serverId ?? activeServerId)}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="flex items-center gap-1.5 px-3">
          {broadcast.active ? (
            <Button size="sm" variant="danger" icon={<Radio size={13} />} onClick={() => broadcast.setActive(false)}>
              Arrêter la diffusion
            </Button>
          ) : (
            <ToolButton label="Diffuser" title="Diffuser la saisie à plusieurs terminaux" icon={<Radio size={13} />} disabled={Object.keys(broadcast.panes).length < 2} onClick={() => setBroadcastPicker(true)} />
          )}
          <ToolButton label="Rejoindre" title="Rejoindre le terminal partagé par quelqu'un (invitation helm-term:…)" icon={<Users size={13} />} onClick={() => setJoinPicker(true)} />
          <ToolButton label="Multi-serveurs" title="Un terminal par serveur, côte à côte, avec la saisie diffusée à tous" icon={<LayoutGrid size={13} />} disabled={servers.length < 2} onClick={() => setMultiPicker(true)} />
          <ToolButton label="Sessions" title="Sessions persistantes (tmux)" icon={<History size={13} />} disabled={!(current?.serverId ?? activeServerId)} onClick={() => setSessionsOf(current?.serverId ?? activeServerId)} />
          <ToolButton label="Diviser" title="Diviser l'écran (même serveur ou un autre)" icon={<Columns2 size={13} />} disabled={!current || !!current.grid || !!current.join} active={current?.split != null} onClick={toggleSplit} />
          <ToolButton label="Fichiers" title="Fichiers du serveur, au dossier courant du terminal" icon={<FolderTree size={13} />} active={showFiles} disabled={!current || !!current.join} onClick={() => setShowFiles((v) => !v)} />
          <ToolButton label="Snippets" title="Snippets" icon={<ScrollText size={13} />} active={showSnippets} onClick={() => setShowSnippets((v) => !v)} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {tabs.length === 0 && (
            <EmptyState icon={<SquareTerminal size={40} />} title="Aucun terminal ouvert">
              {activeServerId ? (
                <Button variant="primary" className="mt-2" onClick={() => openTab(activeServerId)}>
                  Ouvrir un terminal sur {serverOf(activeServerId)?.name}
                </Button>
              ) : (
                "Ajoute d'abord un serveur dans l'onglet Serveurs."
              )}
            </EmptyState>
          )}
          {tabs.map((t) => {
            const show = visible && t.key === activeTab;
            return (
              <div key={t.key} className={`absolute inset-0 flex ${t.key === activeTab ? "" : "invisible"}`}>
                {t.join ? (
                  <TerminalPane
                    serverId=""
                    join={t.join}
                    paneId={`${t.key}:0`}
                    label={labelOf(t)}
                    visible={show}
                    onTitle={(title) => setTitles((x) => ({ ...x, [t.key]: title }))}
                  />
                ) : t.grid ? (
                  <GridPanes tab={t} visible={show} />
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <TerminalPane
                        serverId={t.serverId}
                        command={t.command}
                        tmux={t.tmux}
                        paneId={`${t.key}:0`}
                        label={labelOf(t)}
                        visible={show}
                        onTitle={(title) => setTitles((x) => ({ ...x, [t.key]: title }))}
                      />
                    </div>
                    {t.split != null && (
                      <div className="flex min-w-0 flex-1 flex-col border-l border-border">
                        {t.splitServerId && <PaneHeader serverId={t.splitServerId} />}
                        <div className="min-h-0 flex-1">
                          <TerminalPane serverId={t.splitServerId ?? t.serverId} tmux={t.split || undefined} paneId={`${t.key}:1`} label={labelOf(t, true)} visible={show} />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {showFiles && activePane && <TerminalFiles paneId={activePane} visible={visible} />}
        {showSnippets && <SnippetsPanel />}
      </div>
      <TransfersBar />
      {settings.terminalStatusBar && activePaneServer && <TerminalStatusBar serverId={activePaneServer} visible={visible} />}

      {splitMenu && current && (
        <ContextMenu
          x={splitMenu.x}
          y={splitMenu.y}
          onClose={() => setSplitMenu(null)}
          items={[
            { label: `Même serveur (${serverOf(current.serverId)?.name ?? "?"})`, icon: <Columns2 size={14} />, onClick: () => void splitWith(current.serverId) },
            "separator",
            ...servers
              .filter((s) => s.id !== current.serverId)
              .map((s) => ({ label: s.name, hint: s.host, icon: <Server size={14} style={{ color: s.color ?? undefined }} />, onClick: () => void splitWith(s.id) })),
          ]}
        />
      )}
      {joinPicker && (
        <JoinPicker
          onClose={() => setJoinPicker(false)}
          onJoin={(code, title) => {
            setJoinPicker(false);
            openJoinTab(code, title);
          }}
        />
      )}
      {multiPicker && (
        <MultiServerPicker
          onClose={() => setMultiPicker(false)}
          onOpen={async (ids, broadcastOn) => {
            setMultiPicker(false);
            // Un serveur après l'autre : un seul dialogue de connexion à la fois.
            const ready: string[] = [];
            for (const id of ids) if (await ensureConnected(id, { force: true })) ready.push(id);
            if (ready.length < ids.length) notify(`${ids.length - ready.length} serveur(s) non connecté(s), laissé(s) de côté`, "info");
            if (!ready.length) return;
            const key = openGridTab(ready);
            if (broadcastOn && ready.length > 1) useBroadcast.getState().setActive(true, ready.map((_, i) => `${key}:g${i}`));
          }}
        />
      )}

      {broadcastPicker && <BroadcastPicker onClose={() => setBroadcastPicker(false)} />}
      {sessionsOf && (
        <SessionsModal
          serverId={sessionsOf}
          openNames={tabs.flatMap((t) => tabSessions(t).map((x) => x.name))}
          onOpen={(name) => {
            const existing = tabs.find((t) => tabSessions(t).some((x) => x.name === name));
            if (existing) setActiveTab(existing.key);
            else openTab(sessionsOf, { title: `${serverOf(sessionsOf)?.name} (reprise)`, tmux: name });
            setSessionsOf(null);
          }}
          onClose={() => setSessionsOf(null)}
          notify={notify}
        />
      )}
    </div>
  );
}

/** Nom et couleur du serveur, en tête d'un panneau (grille multi-serveurs, écran divisé sur deux hôtes). */
function PaneHeader({ serverId }: { serverId: string }) {
  const s = useApp((st) => st.servers.find((x) => x.id === serverId));
  return (
    <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-rail px-2 text-[11px]">
      <span className="size-[7px] rounded-full" style={{ background: s?.color ?? "var(--color-accent)" }} />
      <span className="font-medium">{s?.name ?? "?"}</span>
      <span className="truncate font-mono text-muted">
        {s?.username}@{s?.host}
      </span>
    </div>
  );
}

/** Onglet multi-serveurs : un terminal par serveur, en grille. */
function GridPanes({ tab, visible }: { tab: TermTab; visible: boolean }) {
  const servers = useApp((s) => s.servers);
  const grid = tab.grid ?? [];
  const cols = grid.length <= 1 ? 1 : grid.length <= 4 ? 2 : 3;
  return (
    <div className="grid min-w-0 flex-1 gap-px bg-border" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }}>
      {grid.map((g, i) => (
        <div key={i} className="flex min-h-0 min-w-0 flex-col bg-bg">
          <PaneHeader serverId={g.serverId} />
          <div className="min-h-0 flex-1">
            <TerminalPane
              serverId={g.serverId}
              tmux={g.tmux}
              paneId={`${tab.key}:g${i}`}
              label={servers.find((s) => s.id === g.serverId)?.name ?? "?"}
              visible={visible}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Choix des serveurs d'un onglet multi-serveurs. */
function MultiServerPicker({ onClose, onOpen }: { onClose: () => void; onOpen: (ids: string[], broadcast: boolean) => void }) {
  const servers = useApp((s) => s.servers);
  const [selected, setSelected] = useState<string[]>([]);
  const [broadcastOn, setBroadcastOn] = useState(true);
  return (
    <Modal
      title="Terminaux multi-serveurs"
      onClose={onClose}
      footer={
        <Button variant="primary" icon={<LayoutGrid size={14} />} disabled={selected.length < 2} onClick={() => onOpen(selected, broadcastOn)}>
          Ouvrir {selected.length} terminaux
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted">Un terminal par serveur, affichés côte à côte dans un même onglet. Pratique pour lancer la même commande sur plusieurs hôtes et comparer les résultats.</p>
      <ul className="mb-3 flex flex-col gap-1">
        {servers.map((s) => (
          <li key={s.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
              <input
                type="checkbox"
                checked={selected.includes(s.id)}
                onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
              />
              <span className="size-[7px] rounded-full" style={{ background: s.color ?? "var(--color-accent)" }} />
              <span className="text-sm">{s.name}</span>
              <span className="ml-auto font-mono text-xs text-muted">
                {s.username}@{s.host}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
        <input type="checkbox" className="mt-0.5" checked={broadcastOn} onChange={(e) => setBroadcastOn(e.target.checked)} />
        <span>
          Diffuser la saisie à tous les terminaux
          <span className="block text-xs text-muted">Les commandes sensibles (rm -rf, reboot…) demandent confirmation. Arrêt avec « Arrêter la diffusion ».</span>
        </span>
      </label>
    </Modal>
  );
}

/** Saisie d'une invitation reçue (terminal partagé par quelqu'un d'autre). */
function JoinPicker({ onClose, onJoin }: { onClose: () => void; onJoin: (code: string, title: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const valid = code.trim().startsWith("helm-term:");
  return (
    <Modal
      title="Rejoindre un terminal partagé"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Users size={14} />} disabled={!valid} onClick={() => onJoin(code.trim(), name.trim() || "Terminal partagé")}>
            Rejoindre
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Colle l'invitation reçue (elle commence par <span className="font-mono">helm-term:</span>). Tu verras le terminal de la personne en
        direct ; si elle a partagé le contrôle, tu pourras aussi y taper.
      </p>
      <textarea
        className="h-28 w-full resize-none rounded-md border border-border bg-bg p-2 font-mono text-xs outline-none focus:border-accent"
        placeholder="helm-term:…"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <div className="mt-3">
        <Field label="Nom de l'onglet (facultatif)">
          <Input value={name} placeholder="Terminal de …" onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function BroadcastPicker({ onClose }: { onClose: () => void }) {
  const { panes, setActive } = useBroadcast();
  const ids = Object.keys(panes).filter((id) => panes[id].termId != null);
  const [selected, setSelected] = useState<Set<string>>(new Set(ids));
  return (
    <Modal
      title="Diffuser la saisie"
      onClose={onClose}
      footer={
        <Button
          variant="danger"
          icon={<Radio size={14} />}
          disabled={selected.size < 2}
          onClick={() => {
            setActive(true, [...selected]);
            onClose();
          }}
        >
          Diffuser à {selected.size} terminaux
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Tout ce que tu taperas dans l'un de ces terminaux sera envoyé à tous. Les commandes sensibles (rm -rf, reboot, docker rm…) demanderont une confirmation. La diffusion s'arrête quand tu quittes le terminal.
      </p>
      <ul className="flex flex-col gap-1">
        {ids.map((id) => (
          <li key={id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
              <input
                type="checkbox"
                checked={selected.has(id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(id);
                  else next.delete(id);
                  setSelected(next);
                }}
              />
              <span className="text-sm">{panes[id].label}</span>
            </label>
          </li>
        ))}
        {ids.length < 2 && <li className="text-sm text-muted">Ouvre et connecte au moins deux terminaux.</li>}
      </ul>
    </Modal>
  );
}

function SessionsModal({
  serverId,
  openNames,
  onOpen,
  onClose,
  notify,
}: {
  serverId: string;
  openNames: string[];
  onOpen: (name: string) => void;
  onClose: () => void;
  notify: (m: string, k?: "info" | "error" | "success") => void;
}) {
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [list, setList] = useState<TmuxSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.tmuxSessions(serverId).then(setList, (e) => setError(errorMessage(e)));
  }, [serverId]);
  useEffect(load, [load]);

  return (
    <Modal title={`Sessions persistantes sur ${server?.name}`} width="max-w-2xl" onClose={onClose}>
      <p className="mb-3 text-sm text-muted">
        Ces terminaux continuent de tourner sur le serveur, même app fermée. Rouvre-les pour reprendre exactement là où tu en étais.
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {list && list.length === 0 && <p className="text-sm text-muted">Aucune session Helm sur ce serveur.</p>}
      <ul className="flex flex-col gap-2">
        {list?.map((s) => (
          <li key={s.name} className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
            <span className="font-mono text-xs">{s.name}</span>
            <Badge tone={SHELLS.includes(s.command) ? "muted" : "accent"}>{s.command}</Badge>
            {openNames.includes(s.name) ? <Badge tone="ok">ouverte</Badge> : s.attached ? <Badge tone="warn">ouverte ailleurs</Badge> : null}
            <span className="ml-auto text-xs text-muted">{new Date(s.created * 1000).toLocaleString("fr-FR")}</span>
            <Button size="sm" onClick={() => onOpen(s.name)}>
              Ouvrir
            </Button>
            <IconButton
              title="Fermer la session"
              onClick={async () => {
                try {
                  await api.tmuxKill(serverId, s.name);
                  load();
                } catch (e) {
                  notify(errorMessage(e), "error");
                }
              }}
            >
              <X size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Bouton texte de la barre d'onglets du terminal. */
function ToolButton({ label, title, icon, active, disabled, onClick }: { label: string; title: string; icon: React.ReactNode; active?: boolean; disabled?: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5 text-xs transition-colors disabled:opacity-40 ${
        active ? "border-accent/60 bg-accent/10 text-fg" : "border-border text-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
