// Tiroir « Machines », à droite : passer d'une machine à l'autre sans quitter la page en cours.
//
// Tout ce dont on peut prendre la main au même endroit : les sessions déjà ouvertes (terminaux,
// écran distant), les serveurs (terminal, fichiers, supervision), leurs machines virtuelles (écran,
// console série) et les bureaux à distance. Un clic sur un serveur reprend son terminal s'il y en a
// déjà un, sinon en ouvre un : c'est le geste le plus fréquent, il ne demande qu'un clic.
import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronRight, FolderTree, Monitor, MonitorPlay, Search, SquareTerminal, TerminalSquare, X } from "lucide-react";
import { api, errorMessage, type Vm } from "../../lib/api";
import { ensureConnected, useApp } from "../../lib/store";
import { navigate, useShell } from "../../lib/shell";
import { useRdp } from "../../lib/rdp";
import { stateLabel } from "../../lib/vm";
import { launchDesktop, useDesktops } from "../RemoteDesktops";
import { Avatar, Badge, IconButton, Input, StatusDot } from "../ui";
import { display, shortcutOf } from "../../lib/shortcuts";

/** VM d'un serveur, chargées à la demande (dépliage) : libvirt peut demander sudo et prendre du temps. */
type VmState = { loading: true } | { loading: false; vms: Vm[]; error?: string };

export default function MachinesDrawer() {
  const servers = useApp((s) => s.servers);
  const tabs = useApp((s) => s.tabs);
  const activeTab = useApp((s) => s.activeTab);
  const section = useApp((s) => s.section);
  const { list: desktops, reload: reloadDesktops } = useDesktops();
  const remote = useRdp((s) => s.desktop);
  const remoteOrigin = useRdp((s) => s.origin);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [vms, setVms] = useState<Record<string, VmState>>({});
  const close = () => useShell.getState().setMachinesOpen(false);

  useEffect(() => {
    void reloadDesktops().catch(() => {});
  }, [reloadDesktops]);

  const f = filter.trim().toLowerCase();
  const match = (...texts: (string | null | undefined)[]) => !f || texts.some((t) => t?.toLowerCase().includes(f));
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "";
  const shownServers = useMemo(() => servers.filter((s) => match(s.name, s.host, s.group)), [servers, f]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTab = (key: string) => {
    useApp.getState().setActiveTab(key);
    useApp.getState().setSection("terminal");
  };

  /** Prendre la main : son terminal s'il y en a déjà un (le dernier ouvert), sinon un nouveau. */
  const takeOver = (serverId: string) => {
    useApp.getState().setActiveServer(serverId);
    const existing = [...tabs].reverse().find((t) => t.serverId === serverId && !t.command && !t.grid && !t.join);
    if (existing) goTab(existing.key);
    else useApp.getState().openTab(serverId);
  };

  const toggleVms = async (serverId: string) => {
    const next = !open[serverId];
    setOpen((o) => ({ ...o, [serverId]: next }));
    if (!next || vms[serverId]) return;
    setVms((v) => ({ ...v, [serverId]: { loading: true } }));
    try {
      if (!(await ensureConnected(serverId))) throw new Error("serveur non connecté");
      const o = await api.vmOverview(serverId);
      setVms((v) => ({ ...v, [serverId]: { loading: false, vms: o.vms, error: o.access === "unavailable" ? (o.reason ?? "libvirt indisponible") : undefined } }));
    } catch (e) {
      setVms((v) => ({ ...v, [serverId]: { loading: false, vms: [], error: errorMessage(e) } }));
    }
  };

  const serial = async (serverId: string, vm: Vm) => {
    try {
      const command = await api.vmSerialCommand(serverId, vm.uuid);
      useApp.getState().openTab(serverId, { title: `${vm.name} (console)`, command });
    } catch (e) {
      useApp.getState().notify(errorMessage(e), "error");
    }
  };

  const openTabs = tabs.filter((t) => match(t.title, serverName(t.serverId)));
  const shownDesktops = desktops.filter((d) => match(d.name, d.host));

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-panel relative z-30" aria-label="Machines">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Monitor size={15} className="text-accent" />
        <h2 className="flex-1 text-[13px] font-semibold">Machines</h2>
        <span className="font-mono text-[10px] text-faint">{display(shortcutOf("machines"))}</span>
        <IconButton size="sm" title="Fermer le tiroir" onClick={close}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="border-b border-border p-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input size_="sm" className="pl-7" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        </div>
      </div>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2.5">
        {(openTabs.length > 0 || remote) && (
          <Group title="Sessions ouvertes">
            {remote && (
              <Row
                icon={<MonitorPlay size={14} className="text-accent" />}
                label={remote.name}
                sub={remote.host}
                active={section === remoteOrigin}
                onClick={() => remoteOrigin && useApp.getState().setSection(remoteOrigin)}
              />
            )}
            {openTabs.map((t) => (
              <Row
                key={t.key}
                icon={<SquareTerminal size={14} className={t.key === activeTab && section === "terminal" ? "text-accent" : "text-muted"} />}
                label={t.title}
                sub={t.join ? "terminal partagé" : t.grid ? `${t.grid.length} serveurs` : serverName(t.serverId)}
                active={t.key === activeTab && section === "terminal"}
                onClick={() => goTab(t.key)}
              />
            ))}
          </Group>
        )}

        <Group title="Serveurs">
          {shownServers.length === 0 && <p className="px-2 text-xs text-faint">Aucun serveur.</p>}
          {shownServers.map((s) => {
            const state = vms[s.id];
            return (
              <div key={s.id} className="flex flex-col">
                <div className="group flex items-center gap-1 rounded-lg hover:bg-hover">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left" title="Prendre la main : son terminal (ou un nouveau)" onClick={() => takeOver(s.id)}>
                    <span className="relative shrink-0">
                      <Avatar name={s.name} color={s.color} size={26} />
                      <StatusDot tone={s.connected ? "ok" : "muted"} className="absolute -right-0.5 -bottom-0.5 size-[8px]! border-2 border-panel" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-medium">{s.name}</span>
                      <span className="truncate font-mono text-[10.5px] text-muted">
                        {s.username}@{s.host}
                      </span>
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center opacity-60 group-hover:opacity-100">
                    <IconButton size="sm" title="Fichiers" onClick={() => navigate("files", undefined, s.id)}>
                      <FolderTree size={13} />
                    </IconButton>
                    <IconButton size="sm" title="Supervision" onClick={() => navigate("monitoring", undefined, s.id)}>
                      <Activity size={13} />
                    </IconButton>
                    <IconButton size="sm" title={open[s.id] ? "Masquer ses machines virtuelles" : "Ses machines virtuelles"} onClick={() => void toggleVms(s.id)}>
                      {open[s.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </IconButton>
                  </span>
                </div>
                {open[s.id] && (
                  <div className="ml-6 flex flex-col border-l border-line pl-2">
                    {state?.loading && <p className="px-2 py-1 text-xs text-faint">Lecture des VM…</p>}
                    {state && !state.loading && state.error && <p className="px-2 py-1 text-xs text-faint">{state.error}</p>}
                    {state && !state.loading && !state.error && state.vms.length === 0 && <p className="px-2 py-1 text-xs text-faint">Aucune machine virtuelle.</p>}
                    {state &&
                      !state.loading &&
                      state.vms.map((vm) => {
                        const st = stateLabel(vm.state);
                        const running = vm.state === "running";
                        return (
                          <div key={vm.uuid} className="group/vm flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-hover">
                            <StatusDot tone={running ? "ok" : "muted"} className="size-1.5!" />
                            <span className="min-w-0 flex-1 truncate text-[12.5px]" title={`${vm.name} · ${st.label}`}>
                              {vm.name}
                            </span>
                            {!running && <Badge tone={st.tone}>{st.label}</Badge>}
                            {running && (
                              <>
                                <IconButton size="sm" title="Écran (VNC)" onClick={() => void useRdp.getState().openVm(s.id, vm)}>
                                  <MonitorPlay size={13} />
                                </IconButton>
                                <IconButton size="sm" title="Console série" onClick={() => void serial(s.id, vm)}>
                                  <TerminalSquare size={13} />
                                </IconButton>
                              </>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        </Group>

        {shownDesktops.length > 0 && (
          <Group title="Bureaux à distance">
            {shownDesktops.map((d) => (
              <Row
                key={d.id}
                icon={<Monitor size={14} className="text-muted" />}
                label={d.name}
                sub={`${(d.protocol ?? "rdp").toUpperCase()} · ${d.host}${d.viaServerId ? ` · via ${serverName(d.viaServerId)}` : ""}`}
                active={remote?.id === d.id}
                onClick={() => void launchDesktop(d)}
              />
            ))}
          </Group>
        )}
      </div>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-2 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({ icon, label, sub, active, onClick }: { icon: React.ReactNode; label: string; sub?: string; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover ${active ? "bg-hover-soft" : ""}`}>
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className={`truncate text-[13px] ${active ? "font-medium" : ""}`}>{label}</span>
        {sub && <span className="truncate text-[10.5px] text-muted">{sub}</span>}
      </span>
    </button>
  );
}
