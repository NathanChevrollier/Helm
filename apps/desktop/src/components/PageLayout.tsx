// Gabarit commun à toutes les sections. Avant, chaque vue dessinait son propre en-tête (parfois
// aucun) et empilait jusqu'à quatre zones de défilement : on ne savait plus où était le titre, où
// étaient les actions, ni ce que la molette allait faire bouger.
//
// Règle unique : un bandeau (titre, contexte, actions, sous-onglets éventuels) qui ne défile pas,
// puis UNE seule zone de défilement. Les colonnes latérales gardent la leur, jamais plus.
import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { useApp } from "../lib/store";
import { FOCUS_RING, IconButton } from "./ui";
import type { GuideId } from "../lib/guides";

export interface PageTab<T extends string = string> {
  id: T;
  label: string;
  /** Compteur affiché à droite du libellé (alertes, éléments en attente…). */
  count?: number;
}

export default function PageLayout<T extends string>({
  title,
  subtitle,
  context,
  actions,
  tabs,
  activeTab,
  onTab,
  guide,
  scroll = true,
  children,
}: {
  title: string;
  /** Une ligne qui dit à quoi sert la page ou ce qu'elle montre. */
  subtitle?: ReactNode;
  /** Rappel du serveur concerné, affiché avant le titre. */
  context?: ReactNode;
  actions?: ReactNode;
  tabs?: PageTab<T>[];
  activeTab?: T;
  onTab?: (id: T) => void;
  /** Fiche d'aide ouverte par le « ? » du bandeau. */
  guide?: GuideId;
  /** `false` quand la vue gère elle-même ses zones (terminal, explorateur en colonnes). */
  scroll?: boolean;
  children: ReactNode;
}) {
  const openGuide = useApp((s) => s.openGuide);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-3 border-b border-border px-6 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="min-w-0">
            {context && <p className="truncate text-xs text-muted">{context}</p>}
            <h1 className="truncate text-lg font-semibold">{title}</h1>
          </div>
          {guide && (
            <IconButton title="Aide sur cette section" onClick={() => openGuide(guide)}>
              <CircleHelp size={16} />
            </IconButton>
          )}
          {subtitle && <p className="min-w-0 flex-1 truncate text-[13px] text-muted">{subtitle}</p>}
          {actions && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {tabs && tabs.length > 0 && (
          <nav className="-mb-3 flex flex-wrap items-center gap-1" aria-label="Sous-sections">
            {tabs.map((t) => {
              const active = t.id === activeTab;
              return (
                <button
                  key={t.id}
                  onClick={() => onTab?.(t.id)}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-9 items-center gap-1.5 rounded-t-md border-b-2 px-3 text-[13px] transition-colors ${FOCUS_RING} ${
                    active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
                  }`}
                >
                  {t.label}
                  {t.count != null && t.count > 0 && (
                    <span className="rounded-full bg-hover-strong px-1.5 text-[11px] text-muted">{t.count}</span>
                  )}
                </button>
              );
            })}
          </nav>
        )}
      </header>
      <div className={`min-h-0 flex-1 ${scroll ? "overflow-auto" : "flex"}`}>{children}</div>
    </div>
  );
}
