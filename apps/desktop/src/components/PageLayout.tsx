// Gabarit commun à toutes les sections.
//
// Règle unique : un bandeau fixe (contexte, titre, actions, éventuelle ligne d'état, onglets, barre
// d'outils), puis UNE seule zone de défilement. Les colonnes latérales gardent la leur, jamais plus.
// Actions : la principale à droite, les rares dans un menu « ⋯ » passé dans `actions`.
import { useEffect, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { useApp } from "../lib/store";
import { useShell } from "../lib/shell";
import { FOCUS_RING, IconButton } from "./ui";
import type { GuideId } from "../lib/guides";

export interface PageTab<T extends string = string> {
  id: T;
  label: string;
  /** Compteur affiché à droite du libellé (alertes, éléments en attente…). */
  count?: number | string;
  /** Couleur du compteur quand il signale un problème. */
  tone?: "warn" | "danger";
}

export default function PageLayout<T extends string>({
  title,
  subtitle,
  context,
  actions,
  status,
  tabs,
  activeTab,
  onTab,
  toolbar,
  guide,
  scroll = true,
  children,
}: {
  title: string;
  /** Une ligne de texte : à quoi sert la page ou ce qu'elle montre (pas de contrôles ici). */
  subtitle?: ReactNode;
  /** Contexte affiché au-dessus du titre (serveur, version, badges). */
  context?: ReactNode;
  actions?: ReactNode;
  /** Ligne d'état sous le titre (moteur, version, bascules) : elle peut contenir des contrôles. */
  status?: ReactNode;
  tabs?: PageTab<T>[];
  activeTab?: T;
  onTab?: (id: T) => void;
  /** Filtres et contrôles de la vue courante, sous les onglets. */
  toolbar?: ReactNode;
  /** Fiche d'aide ouverte par le « ? » du bandeau. */
  guide?: GuideId;
  /** `false` quand la vue gère elle-même ses zones (terminal, explorateur en colonnes). */
  scroll?: boolean;
  children: ReactNode;
}) {
  const openGuide = useApp((s) => s.openGuide);
  const setCrumb = useShell((s) => s.setCrumb);
  const activeLabel = tabs?.find((t) => t.id === activeTab)?.label ?? null;
  useEffect(() => {
    setCrumb(activeLabel);
    return () => setCrumb(null);
  }, [activeLabel, setCrumb]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={`flex shrink-0 flex-col gap-3 border-b border-border px-7 pt-[18px] ${tabs?.length ? "" : "pb-4"}`}>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            {(context || subtitle) && (
              <div className="mb-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
                {context && <span className="flex shrink-0 items-center gap-2">{context}</span>}
                {context && subtitle && <span className="text-faint">·</span>}
                {subtitle && <span className="truncate">{subtitle}</span>}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-[22px] leading-tight font-semibold tracking-tight">{title}</h1>
              {guide && (
                <IconButton size="sm" title="Aide sur cette section" onClick={() => openGuide(guide)} className="text-faint">
                  <CircleHelp size={15} />
                </IconButton>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {status && <div className="flex min-w-0 flex-wrap items-center gap-2.5 text-xs text-muted">{status}</div>}
        {tabs && tabs.length > 0 && (
          <nav className="-mb-px flex flex-wrap items-center gap-1" aria-label="Sous-sections">
            {tabs.map((t) => {
              const active = t.id === activeTab;
              const tone = t.tone === "danger" ? "bg-danger/16 text-danger" : t.tone === "warn" ? "bg-warn/16 text-warn" : "bg-hover-strong text-muted";
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTab?.(t.id)}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-9 items-center gap-1.5 border-b-2 px-3 text-[13px] transition-colors ${FOCUS_RING} ${
                    active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
                  }`}
                >
                  {t.label}
                  {t.count != null && t.count !== 0 && t.count !== "" && <span className={`rounded-full px-1.5 text-[11px] leading-[18px] ${tone}`}>{t.count}</span>}
                </button>
              );
            })}
          </nav>
        )}
      </header>
      {toolbar && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-7 py-2.5">{toolbar}</div>}
      <div className={`relative min-h-0 flex-1 ${scroll ? "overflow-auto" : "flex"}`}>{children}</div>
    </div>
  );
}

