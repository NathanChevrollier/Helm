// Fiche d'une machine virtuelle : système, adresses, disques, réseau et écran.
import { useEffect, useState } from "react";
import { api, errorMessage, type Vm, type VmDetail } from "../../lib/api";
import { formatMemory, stateLabel } from "../../lib/vm";
import { Badge, Drawer, ErrorState, KeyValue, Loading, MenuButton, Section, type MenuItem } from "../../components/ui";

export default function VmDrawer({ serverId, vm, onClose, menu }: { serverId: string; vm: Vm; onClose: () => void; menu: (vm: Vm) => MenuItem[] }) {
  const [detail, setDetail] = useState<VmDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    api.vmDetail(serverId, vm.uuid).then(
      (d) => alive && setDetail(d),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
    // L'état change (démarrage) : adresses IP et port d'écran aussi.
  }, [serverId, vm.uuid, vm.state]);

  const s = stateLabel(vm.state);
  const g = detail?.graphics;

  return (
    <Drawer
      title={vm.name}
      subtitle={
        <span className="flex items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span>
            {vm.vcpus} vCPU · {formatMemory(vm.memoryKib)}
          </span>
        </span>
      }
      actions={<MenuButton size="sm" items={() => menu(vm)} />}
      onClose={onClose}
      width={520}
    >
      {error && <ErrorState message={error} />}
      {!detail && !error && <Loading rows={6} />}
      {detail && (
        <div className="flex flex-col gap-6">
          <Section title="Système">
            <KeyValue
              items={[
                ["UUID", <span className="font-mono text-xs">{vm.uuid}</span>],
                ["Type", detail.os],
                ["Machine", detail.machine || "—"],
                ["Micrologiciel", detail.firmware === "uefi" ? "UEFI" : "BIOS"],
                ["Démarrage auto", vm.autostart ? "oui, avec le serveur" : "non"],
              ]}
            />
          </Section>
          <Section title="Adresses IP">
            {detail.ips.length ? (
              <div className="flex flex-wrap gap-1.5">
                {detail.ips.map((ip) => (
                  <span key={ip} className="rounded bg-hover-strong px-2 py-0.5 font-mono text-xs select-text">
                    {ip}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">{vm.state === "running" ? "Aucune adresse connue (ni bail DHCP de libvirt, ni agent invité)." : "La VM est éteinte."}</p>
            )}
          </Section>
          <Section title="Disques" count={detail.disks.length}>
            <KeyValue items={detail.disks.map((d) => [<span className="font-mono">{d.target}</span>, <span className="font-mono text-xs">{d.device === "cdrom" ? "CD-ROM · " : ""}{d.source ?? "vide"}{d.format ? ` (${d.format})` : ""}</span>])} />
          </Section>
          <Section title="Réseau" count={detail.nics.length}>
            <KeyValue items={detail.nics.map((n) => [<span className="font-mono text-xs">{n.mac}</span>, `${n.source || "—"}${n.model ? ` · ${n.model}` : ""}`])} />
          </Section>
          <Section title="Écran">
            {g?.kind === "vnc" && (
              <div className="flex flex-col gap-2 text-[13px]">
                <span>
                  VNC {g.port ? <span className="font-mono">{`${g.listen}:${g.port}`}</span> : "(port attribué au démarrage)"}
                  {g.password ? " · protégé par mot de passe" : ""}
                </span>
                {g.public && <p className="text-xs text-warn">Écouté sur le réseau : d'autres peuvent s'y connecter. Zenytt passe par un tunnel SSH ; restreins l'écoute à 127.0.0.1.</p>}
              </div>
            )}
            {g?.kind === "spice" && <p className="text-xs text-muted">SPICE : Zenytt n'affiche que le VNC. Utilise la console série, ou passe l'affichage de la VM en VNC.</p>}
            {g?.kind === "none" && <p className="text-xs text-muted">Pas d'écran : utilise la console série.</p>}
          </Section>
        </div>
      )}
    </Drawer>
  );
}
