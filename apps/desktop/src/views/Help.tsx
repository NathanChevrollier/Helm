// Aide intégrée : les fiches rangées par famille, avec recherche. Le « ? » d'une page ouvre, lui,
// une fenêtre ne contenant que la fiche de cette page (GuideDialog).
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { GUIDES, TOPICS, type Guide } from "../lib/guides";
import { useAppPick } from "../lib/store";
import PageLayout from "../components/PageLayout";
import GuideContent from "../components/GuideContent";
import { Badge, FOCUS_RING, Input } from "../components/ui";

/** Tout le texte d'une fiche, pour la recherche. */
const texteDe = (g: Guide) =>
  [
    g.title,
    g.summary,
    g.automatic ?? "",
    ...(g.how ?? []),
    ...(g.requirements ?? []),
    ...(g.steps ?? []).map((s) => `${s.text} ${s.command ?? ""}`),
    ...(g.troubleshooting ?? []).map((p) => `${p.symptom} ${p.answer} ${p.command ?? ""}`),
    ...(g.notes ?? []),
  ]
    .join(" ")
    .toLowerCase();

function Card({ guide, open, onToggle }: { guide: Guide; open: boolean; onToggle: () => void }) {
  const carte = useRef<HTMLElement>(null);

  // Une fiche qui s'ouvre se place sous les yeux : sans cela, son contenu apparaît hors de l'écran
  // quand la fiche est en bas de la page, et l'on croit qu'il ne s'est rien passé.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => carte.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <article
      ref={carte}
      className={`scroll-mt-4 overflow-hidden rounded-lg border bg-panel transition-colors ${open ? "border-border-strong" : "border-border"}`}
    >
      <button onClick={onToggle} aria-expanded={open} className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover ${FOCUS_RING}`}>
        <ChevronRight size={16} className={`mt-0.5 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{guide.title}</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{guide.summary}</p>
        </div>
        {guide.automatic && <Badge tone="ok">Installé par Helm</Badge>}
      </button>
      {/* Ouverture par la hauteur plutôt qu'une apparition brutale, qui donnait un à-coup. */}
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-border px-4 py-4">{open && <GuideContent guide={guide} />}</div>
        </div>
      </div>
    </article>
  );
}

export default function HelpView() {
  const { guide, guideInPage, openHelpPage, openGuide } = useAppPick("guide", "guideInPage", "openHelpPage", "openGuide");
  const [query, setQuery] = useState("");
  const ouverte = guideInPage ? guide : null;

  const resultats = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? GUIDES.filter((g) => texteDe(g).includes(q)) : GUIDES;
  }, [query]);

  const basculer = (id: Guide["id"]) => (ouverte === id ? openGuide(null) : openHelpPage(id));

  return (
    <PageLayout
      title="Aide"
      subtitle="Ce que fait chaque fonctionnalité, ce qu'elle demande sur le serveur, et les commandes à coller."
      actions={
        <div className="flex w-72 items-center gap-2 rounded-md border border-border bg-bg px-2.5">
          <Search size={14} className="shrink-0 text-muted" />
          <Input
            className="h-8 border-0 bg-transparent px-0 focus:border-0 focus-visible:ring-0"
            placeholder="tmux, compose, restic, certificat…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      }
    >
      {/* Les familles se rangent en colonnes selon la largeur ; une fiche dépliée prend toute la
          largeur pour rester lisible, puisqu'elle contient des commandes. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] items-start gap-x-6 gap-y-8 p-6">
        {TOPICS.map((t) => {
          const fiches = resultats.filter((g) => g.topic === t.id);
          if (fiches.length === 0) return null;
          return (
            <section key={t.id} className="flex flex-col gap-3">
              <div>
                <h2 className="text-sm font-semibold">{t.label}</h2>
                <p className="text-[13px] text-muted">{t.description}</p>
              </div>
              <div className="flex flex-col gap-2">
                {fiches.map((g) => (
                  <Card key={g.id} guide={g} open={ouverte === g.id} onToggle={() => basculer(g.id)} />
                ))}
              </div>
            </section>
          );
        })}
        {resultats.length === 0 && <p className="col-span-full p-8 text-center text-sm text-muted">Aucune fiche ne correspond à « {query} ».</p>}
      </div>
    </PageLayout>
  );
}
