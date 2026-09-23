// Aide intégrée : une fiche par fonctionnalité, avec ce qu'il faut sur le serveur et les commandes
// prêtes à coller. Accessible depuis la colonne de gauche, depuis le « ? » de chaque page et
// depuis la palette de commandes.
import { useMemo, useState } from "react";
import { ArrowUpRight, Check, Copy, Search, Sparkles, TerminalSquare } from "lucide-react";
import { GUIDES, type Guide } from "../lib/guides";
import { useApp, useAppPick } from "../lib/store";
import { usePanes } from "../lib/panes";
import { api } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { SECTIONS } from "../sections";
import PageLayout from "../components/PageLayout";
import { Badge, Button, FOCUS_RING, Input } from "../components/ui";

/** Une commande : copiable, et insérable dans le terminal ouvert sans être exécutée. */
function Command({ command, sudo }: { command: string; sudo?: boolean }) {
  const { notify } = useAppPick("notify");
  const [copied, setCopied] = useState(false);
  const full = sudo ? `sudo ${command}` : command;

  const copy = async () => {
    await writeClipboard(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // On écrit la commande sans retour à la ligne : elle attend une relecture avant d'être lancée.
  const toTerminal = () => {
    const pane = usePanes.getState();
    const id = pane.active ? (pane.panes[pane.active]?.termId ?? null) : null;
    if (id == null) return notify("Ouvre d'abord un terminal sur le serveur concerné.", "info");
    void api.termWrite(id, full);
    useApp.getState().setSection("terminal");
  };

  return (
    <div className="group flex items-start gap-2 rounded-md border border-border bg-bg px-3 py-2">
      <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap select-text">
        {sudo && <span className="text-muted">sudo </span>}
        {command}
      </code>
      <button
        onClick={() => void copy()}
        title="Copier la commande"
        aria-label="Copier la commande"
        className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover-strong hover:text-fg ${FOCUS_RING}`}
      >
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </button>
      <button
        onClick={toTerminal}
        title="Écrire dans le terminal actif (sans l'exécuter)"
        aria-label="Écrire dans le terminal actif"
        className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover-strong hover:text-fg ${FOCUS_RING}`}
      >
        <TerminalSquare size={14} />
      </button>
    </div>
  );
}

function GuideCard({ guide, open, onToggle }: { guide: Guide; open: boolean; onToggle: () => void }) {
  const setSection = useApp((s) => s.setSection);
  const section = guide.section ? SECTIONS.find((s) => s.id === guide.section) : undefined;

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-panel">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover ${FOCUS_RING}`}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{guide.title}</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{guide.summary}</p>
        </div>
        {guide.automatic && (
          <Badge tone="ok">
            <Sparkles size={11} className="mr-1" /> Automatique
          </Badge>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
          {guide.automatic && (
            <p className="rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-[13px] leading-relaxed text-fg">{guide.automatic}</p>
          )}

          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Ce qu'il faut sur le serveur</h3>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed">
              {guide.requirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Mise en place</h3>
            {guide.steps.map((s, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <p className="text-[13px] leading-relaxed">{s.text}</p>
                {s.command && <Command command={s.command} sudo={s.sudo} />}
              </div>
            ))}
          </section>

          {guide.notes && guide.notes.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Bon à savoir</h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-muted">
                {guide.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          {section && (
            <div>
              <Button size="sm" icon={<ArrowUpRight size={13} />} onClick={() => setSection(section.id)}>
                Ouvrir {section.label}
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function HelpView() {
  const { guide, openGuide } = useAppPick("guide", "openGuide");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GUIDES;
    return GUIDES.filter((g) =>
      [g.title, g.summary, ...g.requirements, ...g.steps.map((s) => `${s.text} ${s.command ?? ""}`), ...(g.notes ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [query]);

  return (
    <PageLayout
      title="Aide"
      subtitle="Ce que fait chaque fonctionnalité, ce qu'elle demande sur le serveur, et les commandes à coller."
      actions={
        <div className="flex w-72 items-center gap-2 rounded-md border border-border bg-bg px-2">
          <Search size={14} className="shrink-0 text-muted" />
          <Input
            className="h-8 border-0 bg-transparent px-0 focus:border-0"
            placeholder="Chercher : tmux, compose, restic…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-6">
        {shown.map((g) => (
          <GuideCard key={g.id} guide={g} open={guide === g.id} onToggle={() => openGuide(guide === g.id ? null : g.id)} />
        ))}
        {shown.length === 0 && <p className="p-8 text-center text-sm text-muted">Aucune fiche ne correspond à « {query} ».</p>}
      </div>
    </PageLayout>
  );
}
