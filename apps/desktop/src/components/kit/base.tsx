// Contrôles de base : boutons, champs, cases, interrupteurs, contrôle segmenté.
// Une seule hauteur par taille (32 px par défaut, 28 px en « sm ») pour que tout s'aligne dans
// une barre d'outils, quel que soit le mélange de contrôles.
import { forwardRef, useId, type ComponentProps, type ReactNode } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";

/**
 * Anneau de focus commun à tous les contrôles : l'app se pilote au clavier (palette, raccourcis),
 * il faut donc toujours voir où l'on est. `focus-visible` n'apparaît pas au clic à la souris.
 */
export const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg";

export type ButtonVariant = "primary" | "ghost" | "danger" | "outline" | "subtle";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border border-accent bg-accent font-semibold text-accent-fg hover:bg-accent/90",
  outline: "border border-border-strong/70 text-fg hover:border-border-strong hover:bg-hover",
  subtle: "border border-transparent bg-hover text-fg hover:bg-hover-strong",
  ghost: "border border-transparent text-muted hover:bg-hover hover:text-fg",
  danger: "border border-transparent bg-danger/15 text-danger hover:bg-danger/25",
};

export function Button({
  variant = "outline",
  size = "md",
  loading,
  icon,
  children,
  className = "",
  ...rest
}: ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
}) {
  const sizing = size === "sm" ? "h-7 px-2.5 text-xs gap-1.5" : "h-8 px-3 text-[13px] gap-2";
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 ${FOCUS_RING} ${sizing} ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** Bouton d'icône. `title` sert aussi d'étiquette accessible : il est donc obligatoire en pratique. */
export function IconButton({
  title,
  children,
  className = "",
  size = "md",
  active,
  ...rest
}: ComponentProps<"button"> & { size?: "sm" | "md"; active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      title={title}
      aria-label={rest["aria-label"] ?? title}
      aria-pressed={active}
      className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${FOCUS_RING} ${size === "sm" ? "size-7" : "size-8"} ${
        active ? "bg-accent/15 text-accent" : "text-muted hover:bg-hover-strong hover:text-fg"
      } ${className}`}
    >
      {children}
    </button>
  );
}

const FIELD_BASE =
  "w-full rounded-lg border border-border bg-bg px-2.5 text-[13px] text-fg outline-none transition-colors placeholder:text-faint hover:border-border-strong/70 focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input"> & { size_?: "sm" | "md" }>(function Input({ className = "", size_, ...props }, ref) {
  const height = /(^|\s)!?h-/.test(className) ? "" : size_ === "sm" ? "h-7 text-xs" : "h-8";
  return <input ref={ref} {...props} className={`${FIELD_BASE} ${height} ${className}`} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(function Textarea({ className = "", ...props }, ref) {
  return <textarea ref={ref} {...props} className={`${FIELD_BASE} min-h-20 resize-y py-2 leading-relaxed ${className}`} />;
});

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** Liste déroulante native (clavier et lecteurs d'écran gratuits), habillée comme les champs. */
export function Select<T extends string | number = string>({
  value,
  onChange,
  options,
  className = "",
  size = "md",
  ...rest
}: Omit<ComponentProps<"select">, "value" | "onChange" | "size"> & {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  size?: "sm" | "md";
}) {
  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <select
        {...rest}
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const opt = options.find((o) => String(o.value) === raw);
          if (opt) onChange(opt.value);
        }}
        className={`${FIELD_BASE} ${size === "sm" ? "h-7 text-xs" : "h-8"} cursor-pointer appearance-none pr-7`}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
            {typeof o.label === "string" ? o.label : String(o.value)}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted" />
    </span>
  );
}

export function Field({ label, hint, error, children, className = "" }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

/** Case à cocher dessinée (la case native ne suit pas le thème), clavier et lecteur d'écran conservés. */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className = "",
  indeterminate,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  indeterminate?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={`inline-flex min-w-0 cursor-pointer items-start gap-2 text-[13px] ${disabled ? "cursor-not-allowed opacity-50" : ""} ${className}`}>
      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate;
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={`mt-px flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
          checked || indeterminate ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-bg"
        }`}
      >
        {indeterminate ? <span className="h-0.5 w-2 rounded bg-current" /> : checked && <Check size={12} strokeWidth={3} />}
      </span>
      {(label || hint) && (
        <span className="flex min-w-0 flex-col">
          {label && <span>{label}</span>}
          {hint && <span className="text-xs text-faint">{hint}</span>}
        </span>
      )}
    </label>
  );
}

/** Interrupteur pour un réglage qui s'applique tout de suite (pas pour un choix dans un formulaire). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${FOCUS_RING} ${
        checked ? "border-accent bg-accent" : "border-border-strong bg-raised"
      }`}
    >
      <span className={`absolute size-4 rounded-full transition-all ${checked ? "left-[18px] bg-accent-fg" : "left-[2px] bg-faint"}`} />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Choix exclusif entre 2 à 5 options courtes, toutes visibles. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  label,
  className = "",
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  size?: "sm" | "md";
  label?: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex shrink-0 rounded-lg border border-border bg-subtle p-[3px] ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${FOCUS_RING} ${
              size === "sm" ? "h-[22px] text-xs" : "h-[26px] text-[12.5px]"
            } ${on ? "bg-raised text-fg shadow-sm ring-1 ring-border-strong/60" : "text-muted hover:text-fg"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <kbd className={`rounded-[5px] border border-border-strong px-1.5 py-px font-mono text-[10.5px] font-normal text-muted ${className}`}>{children}</kbd>;
}

/** Filet vertical entre deux groupes d'une barre d'outils. */
export function ToolbarSep() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}
