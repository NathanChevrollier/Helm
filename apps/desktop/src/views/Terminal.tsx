import { useCallback, useEffect, useState } from "react";
import { Columns2, History, Plus, Radio, ScrollText, SquareTerminal, X } from "lucide-react";
import TerminalPane from "../components/TerminalPane";
import SnippetsPanel from "../components/SnippetsPanel";
import { api, errorMessage, type TmuxSession } from "../lib/api";
import { useBroadcast } from "../lib/broadcast";
import { newTmuxName, useApp, type TermTab } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, Modal } from "../components/ui";
import { matches } from "../lib/shortcuts";

const SHELLS = ["bash", "zsh", "sh", "fish", "dash", "ash"];

export default function TerminalView({ visible }: { visible: boolean }) {
  const { tabs, activeTab, setActiveTab, closeTab, openTab, updateTab, activeServerId, servers, ask, notify } = useApp();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [showSnippets, setShowSnippets] = useState(false);
  const [sessionsOf, setSessionsOf] = useState<string | null>(null);
  const [broadcastPicker, setBroadcastPicker] = useState(false);
  const broadcast = useBroadcast();
  const current = tabs.find((t) => t.key === activeTab);
  const serverOf = useCallback((id: string) => servers.find((s) => s.id === id), [servers]);

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
      const names = [tab.tmux, tab.split].filter((n): n is string => !!n);
      if (names.length) {
        try {
          const live = (await api.tmuxSessions(tab.serverId)).filter((s) => names.includes(s.name));
          const busy = live.filter((s) => !SHELLS.includes(s.command));
          let keep = false;
          if (busy.length) {
            keep = !!(await ask({
              title: "Un programme tourne encore",
              body: `« ${busy.map((b) => b.command).join(", ")} » est en cours dans ce terminal. Le laisser continuer en arrière-plan ? Tu pourras le retrouver via « Sessions ». Sinon, il sera arrêté.`,
              confirmLabel: "Laisser tourner",
            }));
          }
          if (!keep) for (const s of live) await api.tmuxKill(tab.serverId, s.name).catch(() => {});
        } catch {
          /* serveur injoignable : la session sera visible dans « Sessions » à la prochaine connexion */
        }
      }
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

  const toggleSplit = () => {
    if (!current) return;
    if (current.split != null) {
      const name = current.split;
      updateTab(current.key, { split: null });
      if (name) void api.tmuxKill(current.serverId, name).catch(() => {});
    } else {
      updateTab(current.key, { split: !current.command && current.tmux ? newTmuxName() : "" });
    }
  };

  const labelOf = (t: TermTab, right = false) => `${serverOf(t.serverId)?.name ?? "?"} · ${titles[t.key] ?? t.title}${right ? " (droite)" : ""}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-panel">
        <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          {tabs.map((t) => {
            const s = serverOf(t.serverId);
            const active = t.key === activeTab;
            return (
              <div
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                onAuxClick={(e) => e.button === 1 && void close(t)}
                className={`group flex max-w-56 min-w-32 cursor-pointer items-center gap-2 border-r border-border px-3 text-xs ${active ? "bg-bg text-fg" : "text-muted hover:text-fg"}`}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: s?.color ?? "#3b82f6" }} />
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
            className="m-1"
            disabled={!activeServerId}
            onClick={() => activeServerId && openTab(current?.serverId ?? activeServerId)}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="flex items-center gap-1 px-2">
          {broadcast.active ? (
            <Button size="sm" variant="danger" icon={<Radio size={13} />} onClick={() => broadcast.setActive(false)}>
              Arrêter la diffusion
            </Button>
          ) : (
            <IconButton title="Diffuser la saisie à plusieurs terminaux" disabled={Object.keys(broadcast.panes).length < 2} onClick={() => setBroadcastPicker(true)}>
              <Radio size={15} />
            </IconButton>
          )}
          <IconButton title="Sessions persistantes" disabled={!(current?.serverId ?? activeServerId)} onClick={() => setSessionsOf(current?.serverId ?? activeServerId)}>
            <History size={15} />
          </IconButton>
          <IconButton title="Diviser l'écran" disabled={!current} className={current?.split != null ? "text-accent" : ""} onClick={toggleSplit}>
            <Columns2 size={15} />
          </IconButton>
          <IconButton title="Snippets" className={showSnippets ? "text-accent" : ""} onClick={() => setShowSnippets((v) => !v)}>
            <ScrollText size={15} />
          </IconButton>
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
                  <div className="min-w-0 flex-1 border-l border-border">
                    <TerminalPane serverId={t.serverId} tmux={t.split || undefined} paneId={`${t.key}:1`} label={labelOf(t, true)} visible={show} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {showSnippets && <SnippetsPanel />}
      </div>

      {broadcastPicker && <BroadcastPicker onClose={() => setBroadcastPicker(false)} />}
      {sessionsOf && (
        <SessionsModal
          serverId={sessionsOf}
          openNames={tabs.flatMap((t) => [t.tmux, t.split]).filter((n): n is string => !!n)}
          onOpen={(name) => {
            const existing = tabs.find((t) => t.tmux === name || t.split === name);
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
