import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from "react";
import { Loader2, TriangleAlert, X } from "lucide-react";
import { useApp } from "../lib/store";

type Variant = "primary" | "ghost" | "danger" | "outline";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent/90",
  ghost: "text-muted hover:bg-hover hover:text-fg",
  danger: "bg-danger/15 text-danger hover:bg-danger/25",
  outline: "border border-border text-fg hover:bg-hover",
};

/**
 * Anneau de focus commun à tous les contrôles : l'app se pilote au clavier (palette, raccourcis),
 * il faut donc toujours voir où l'on est. `focus-visible` n'apparaît pas au clic à la souris.
 */
export const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg";

export function Button({
  variant = "outline",
  size = "md",
  loading,
  icon,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}) {
  const sizing = size === "sm" ? "h-8 px-2.5 text-xs gap-1.5" : "h-9 px-3.5 text-sm gap-2";
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${FOCUS_RING} ${sizing} ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** Bouton d'icône. 32 px au minimum : en dessous, la cible est trop petite pour un clic sûr. */
export function IconButton({ title, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      title={title}
      aria-label={title}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover-strong hover:text-fg disabled:opacity-40 ${FOCUS_RING} ${className}`}
    >
      {children}
    </button>
  );
}

export function Input(props: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`h-9 w-full rounded-md border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-muted focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/50 ${props.className ?? ""}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted/70">{hint}</span>}
    </label>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = "max-w-2xl",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Les fenêtres suivent la taille de l'app : sur un grand écran, une modale minuscule perdue au
  // centre ne sert personne ; sur une petite fenêtre, elle ne doit pas déborder.
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 md:p-10" onMouseDown={onClose}>
      <div
        className={`flex max-h-[88vh] w-full ${width} min-w-0 flex-col rounded-lg border border-border bg-panel shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton title="Fermer" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Dialogue global de confirmation / saisie piloté par `useApp().ask`. */
export function DialogHost() {
  const dialog = useApp((s) => s.dialog);
  const close = useApp((s) => s.closeDialog);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(dialog?.input?.initial ?? "");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [dialog]);

  if (!dialog) return null;
  const submit = () => close(dialog.input ? value : true);

  return (
    <Modal
      title={dialog.title}
      onClose={() => close(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Annuler
          </Button>
          <Button variant={dialog.danger ? "danger" : "primary"} onClick={submit}>
            {dialog.confirmLabel ?? "Confirmer"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {dialog.body && <p className="text-sm leading-relaxed text-muted">{dialog.body}</p>}
        {dialog.code && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg p-3 font-mono text-xs select-text">
            {dialog.code}
          </pre>
        )}
        {dialog.input && (
          <Field label={dialog.input.label}>
            <Input
              ref={inputRef}
              type={dialog.input.secret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
        )}
      </form>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const colors = { info: "border-accent/40", error: "border-danger/50", success: "border-ok/50" };
  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-50 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-md border bg-panel px-3 py-2 text-sm shadow-xl select-text ${colors[t.kind]}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-accent">{icon}</div>
      <h2 className="text-base font-semibold">{title}</h2>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

/**
 * Squelette de chargement : il prend la forme de ce qui va s'afficher, pour que la page ne saute
 * pas quand les données arrivent. À n'afficher que si l'attente dépasse un instant perceptible
 * (voir `useDelayed`), sinon il ne fait que clignoter.
 */
export function Skeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-hover" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

/** Vrai seulement si la condition dure : évite de faire clignoter un squelette sur 80 ms. */
export function useDelayed(active: boolean, delay = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) return setShown(false);
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);
  return shown;
}

/**
 * Erreur qui empêche la vue de fonctionner : elle reste affichée (contrairement à une notification)
 * et porte l'action qui répare, parce qu'un message seul laisse l'utilisateur sans issue.
 */
export function ErrorState({ message, onRetry, retryLabel = "Réessayer" }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm text-danger">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" />
      <p className="min-w-0 flex-1 break-words select-text">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "warn" | "danger" | "accent" }) {
  const tones = {
    muted: "border-border text-muted",
    ok: "border-ok/40 text-ok",
    warn: "border-warn/40 text-warn",
    danger: "border-danger/40 text-danger",
    accent: "border-accent/40 text-accent",
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>;
}
