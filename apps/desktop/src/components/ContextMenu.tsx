import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem =
  | { label: string; icon?: ReactNode; hint?: string; disabled?: boolean; danger?: boolean; onClick: () => void }
  | "separator";

/**
 * Menu contextuel flottant. Il reste ouvert jusqu'à un clic ailleurs, Échap, un défilement ou
 * la perte du focus de la fenêtre : relâcher le bouton de la souris ne le ferme pas.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Garde le menu entièrement visible près des bords de la fenêtre.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Enregistré au tour suivant : le clic droit qui a ouvert le menu ne doit pas le refermer.
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("wheel", onClose, true);
    });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-56 rounded-lg border border-border-strong bg-panel py-1 text-[13px] shadow-2xl"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="my-1 border-t border-border" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left disabled:opacity-40 enabled:hover:bg-hover-strong ${item.danger ? "text-danger" : ""}`}
          >
            <span className="flex w-4 justify-center text-muted">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="font-mono text-[11px] text-muted">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
