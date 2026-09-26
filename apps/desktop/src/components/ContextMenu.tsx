import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import { Button, FOCUS_RING, IconButton, type ButtonVariant } from "./kit/base";

export type MenuItem =
  | { label: string; icon?: ReactNode; hint?: string; disabled?: boolean; danger?: boolean; checked?: boolean; onClick: () => void }
  | { heading: string }
  | "separator";

function isAction(item: MenuItem): item is Extract<MenuItem, { onClick: () => void }> {
  return typeof item === "object" && "onClick" in item;
}

/**
 * Menu flottant (clic droit ou bouton « ⋯ »). Il reste ouvert jusqu'à un clic ailleurs, Échap, un
 * défilement ou la perte du focus de la fenêtre. Flèches, Début/Fin et Entrée le pilotent au clavier.
 */
export function ContextMenu({ x, y, items, onClose, align = "start" }: { x: number; y: number; items: MenuItem[]; onClose: () => void; align?: "start" | "end" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Garde le menu entièrement visible près des bords de la fenêtre.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = align === "end" ? x - width : x;
    setPos({ left: Math.max(4, Math.min(left, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)) });
  }, [x, y, align]);

  const buttons = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not(:disabled)") ?? []);

  useEffect(() => {
    // Focus sur le menu : les flèches marchent tout de suite, sans voler le premier élément à la souris.
    ref.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const list = buttons();
      if (list.length === 0) return;
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      let next = -1;
      if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % list.length;
      else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      if (next >= 0) {
        e.preventDefault();
        e.stopPropagation();
        list[next].focus();
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

  const hasChecks = items.some((i) => isAction(i) && i.checked !== undefined);

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      className="animate-pop-in fixed z-50 max-h-[80vh] min-w-56 overflow-auto rounded-xl border border-border-strong bg-raised p-1 text-[13px] shadow-2xl outline-none"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item === "separator") return <div key={i} className="mx-1 my-1 border-t border-border" />;
        if (!isAction(item)) return <div key={i} className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-faint uppercase">{item.heading}</div>;
        return (
          <button
            key={i}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none disabled:opacity-40 enabled:hover:bg-hover-strong enabled:focus:bg-hover-strong ${item.danger ? "text-danger" : ""}`}
          >
            {hasChecks && <span className="flex w-4 justify-center text-accent">{item.checked && <Check size={14} />}</span>}
            {item.icon !== undefined && <span className={`flex w-4 justify-center ${item.danger ? "" : "text-muted"}`}>{item.icon}</span>}
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            {item.hint && <span className="font-mono text-[11px] text-faint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** État d'un menu contextuel (clic droit) : `open(e, items)` puis `{menu}` dans le rendu. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const close = useCallback(() => setState(null), []);
  const open = useCallback((e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) => {
    e.preventDefault();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  const menu = state ? <ContextMenu x={state.x} y={state.y} items={state.items} onClose={close} /> : null;
  return { open, close, menu };
}

/**
 * Bouton qui ouvre un menu : « ⋯ » (actions secondaires) sans libellé, ou un bouton avec chevron.
 * Les actions rares vivent ici plutôt que d'encombrer une barre d'outils.
 */
export function MenuButton({
  items,
  label,
  icon,
  title = "Plus d'actions",
  variant = "outline",
  size = "md",
  align = "end",
  disabled,
}: {
  items: MenuItem[] | (() => MenuItem[]);
  label?: ReactNode;
  icon?: ReactNode;
  title?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const [at, setAt] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // Le clic sur le bouton ferme d'abord le menu (clic « ailleurs ») : sans ce garde, il le rouvrirait.
  const closedAt = useRef(0);
  const close = useCallback(() => {
    closedAt.current = Date.now();
    setAt(null);
  }, []);
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (at || Date.now() - closedAt.current < 250) return setAt(null);
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ x: align === "end" ? r.right : r.left, y: r.bottom + 4, items: typeof items === "function" ? items() : items });
  };
  return (
    <>
      {label ? (
        <Button variant={variant} size={size} icon={icon} onClick={toggle} disabled={disabled} aria-haspopup="menu" aria-expanded={!!at} title={title}>
          {label}
          <ChevronDown size={13} className="-mr-0.5 text-muted" />
        </Button>
      ) : (
        <IconButton size={size} title={title} onClick={toggle} disabled={disabled} aria-haspopup="menu" aria-expanded={!!at} className={FOCUS_RING}>
          {icon ?? <MoreHorizontal size={16} />}
        </IconButton>
      )}
      {at && <ContextMenu x={at.x} y={at.y} items={at.items} onClose={close} align={align} />}
    </>
  );
}
