import type { MouseEvent } from "react";
import type { Container } from "../../lib/api";

type Port = Container["ports"][number];

/** Publié sur toutes les interfaces, donc joignable depuis Internet sans pare-feu. */
export const isExposed = (p: Port) => p.hostIp === "0.0.0.0" || p.hostIp === "::";

/** Ports publiés d'un conteneur, en puces ; ceux exposés à Internet sont signalés en orange. */
export default function PortChips({ ports, onPortClick }: { ports: Port[]; onPortClick?: (p: Port, e: MouseEvent) => void }) {
  if (ports.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ports.map((p) => {
        const exposed = isExposed(p);
        const cls = `inline-flex h-[22px] items-center rounded-md border px-1.5 font-mono text-[11px] ${exposed ? "border-warn/45 text-warn" : "border-border-strong/60 bg-raised text-fg/80"}`;
        const label = `${exposed ? "*" : ""}${p.hostPort}→${p.containerPort}`;
        const title = exposed ? "Exposé sur toutes les interfaces" : "Accessible uniquement depuis le serveur";
        return onPortClick ? (
          <button
            key={`${p.hostIp}:${p.hostPort}/${p.protocol}`}
            type="button"
            title={`${title} : clic pour les actions`}
            onClick={(e) => {
              e.stopPropagation();
              onPortClick(p, e);
            }}
            className={cls}
          >
            {label}
          </button>
        ) : (
          <span key={`${p.hostIp}:${p.hostPort}/${p.protocol}`} title={title} className={cls}>
            {label}
          </span>
        );
      })}
    </span>
  );
}
