// Catalogue d'applications Docker Compose : choisir une application, remplir ses réglages, puis
// relire les fichiers avant de les écrire sur le serveur.
//
// Le catalogue est intégré à Helm (aucun appel réseau, aucun dépôt tiers à faire confiance) et les
// mots de passe sont tirés de l'aléa du système, côté Rust. Chaque application ne publie ses ports
// que sur 127.0.0.1 : l'accès public passe par un site nginx, avec HTTPS, comme le reste du serveur.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, Eye, EyeOff, ExternalLink, Package, Search } from "lucide-react";
import { api, errorMessage, type CatalogApp, type CatalogVariable } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { useAppPick } from "../lib/store";
import type { ComposePreset } from "./NewComposeProject";
import { Badge, Button, EmptyState, Field, Input, Modal } from "./ui";

export default function AppCatalog({ onClose, onDeploy }: { onClose: () => void; onDeploy: (preset: ComposePreset) => void }) {
  const { notify } = useAppPick("notify");
  const [apps, setApps] = useState<CatalogApp[] | null>(null);
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<CatalogApp | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dockerCatalog().then(setApps, (e) => setError(errorMessage(e)));
  }, []);

  // Les mots de passe sont générés côté Rust : le formulaire les reçoit déjà remplis.
  const choose = async (app: CatalogApp) => {
    setError(null);
    try {
      const defaults = await api.dockerCatalogDefaults(app.id);
      setValues(Object.fromEntries(defaults));
      setChosen(app);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const deploy = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.dockerCatalogRender(chosen.id, values);
      onDeploy({ name: chosen.id, yaml: r.compose, env: r.env, notes: notesFor(chosen) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const byCategory = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const shown = (apps ?? []).filter((a) => !f || a.name.toLowerCase().includes(f) || a.description.toLowerCase().includes(f) || a.category.toLowerCase().includes(f));
    const groups = new Map<string, CatalogApp[]>();
    for (const a of shown) groups.set(a.category, [...(groups.get(a.category) ?? []), a]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "fr"));
  }, [apps, filter]);

  if (chosen) {
    return (
      <Modal
        title={`Configurer ${chosen.name}`}
        width="max-w-2xl"
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => setChosen(null)}>
              Retour au catalogue
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void deploy()}>
              Voir les fichiers
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">{chosen.description}</p>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge>{chosen.category}</Badge>
          {chosen.httpPort !== null && <Badge tone="accent">interface web</Badge>}
          {chosen.docsUrl && (
            <a className="flex items-center gap-1 text-accent hover:underline" href={chosen.docsUrl} target="_blank" rel="noreferrer">
              Documentation <ExternalLink size={11} />
            </a>
          )}
        </div>

        <div className="flex flex-col gap-3">
          {chosen.variables.map((v) => (
            <VariableField
              key={v.key}
              variable={v}
              value={values[v.key] ?? ""}
              revealed={!!reveal[v.key]}
              onReveal={() => setReveal((r) => ({ ...r, [v.key]: !r[v.key] }))}
              onChange={(value) => setValues((old) => ({ ...old, [v.key]: value }))}
              onCopy={() => {
                void writeClipboard(values[v.key] ?? "");
                notify("Copié.", "success");
              }}
            />
          ))}
        </div>

        {chosen.variables.some((v) => v.kind === "password") && (
          <p className="mt-3 rounded-md border border-warn/40 bg-warn/5 p-2 text-xs">
            Les mots de passe ci-dessus ont été tirés au hasard par Helm et ne seront plus affichés après le déploiement. Note-les maintenant, ou retrouve-les
            dans le fichier <span className="font-mono">.env</span> du projet sur le serveur.
          </p>
        )}
        {chosen.notes.length > 0 && (
          <ul className="mt-3 flex list-inside list-disc flex-col gap-1 text-xs text-muted">
            {chosen.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {error && <pre className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}
      </Modal>
    );
  }

  return (
    <Modal title="Catalogue d'applications" width="max-w-3xl" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <Search size={14} className="text-muted" />
        <Input className="h-8" placeholder="Chercher une application…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
      </div>
      <p className="mb-3 text-xs text-muted">
        Chaque application est déployée dans son propre projet Compose, avec des mots de passe générés et des ports ouverts sur 127.0.0.1 seulement. Tu relis les
        fichiers avant qu'ils ne soient écrits.
      </p>
      {error && <pre className="mb-3 rounded-md border border-danger/40 bg-danger/10 p-2 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}
      {apps === null ? (
        <p className="text-sm text-muted">Chargement…</p>
      ) : byCategory.length === 0 ? (
        <EmptyState icon={<Package size={32} />} title="Aucune application ne correspond" />
      ) : (
        <div className="flex flex-col gap-4">
          {byCategory.map(([category, list]) => (
            <section key={category}>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{category}</h3>
              <div className="grid grid-cols-2 gap-2">
                {list.map((a) => (
                  <button
                    key={a.id}
                    className="flex flex-col gap-1 rounded-lg border border-border p-3 text-left transition-colors hover:border-accent/60 hover:bg-hover-soft"
                    onClick={() => void choose(a)}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Package size={14} className="text-accent" />
                      {a.name}
                    </span>
                    <span className="text-xs text-muted">{a.description}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Notes reprises dans la fenêtre de relecture, pour ne pas les perdre en changeant d'écran. */
function notesFor(app: CatalogApp): string[] {
  const notes = [...app.notes];
  if (app.httpPort !== null) {
    notes.push("Pour l'ouvrir sur Internet : onglet Sites, « Nouveau site », en pointant le sous-domaine vers le port local choisi (HTTPS compris).");
  }
  return notes;
}

const PLACEHOLDERS: Record<CatalogVariable["kind"], string> = {
  text: "",
  password: "",
  port: "8080",
  domain: "app.exemple.fr",
  path: "/opt/stacks/…",
  email: "moi@exemple.fr",
};

function VariableField({
  variable,
  value,
  revealed,
  onChange,
  onReveal,
  onCopy,
}: {
  variable: CatalogVariable;
  value: string;
  revealed: boolean;
  onChange: (value: string) => void;
  onReveal: () => void;
  onCopy: () => void;
}) {
  const secret = variable.kind === "password";
  return (
    <Field label={variable.label} hint={variable.hint}>
      <div className="flex items-center gap-1">
        <Input
          className={variable.kind === "text" ? "h-8" : "h-8 font-mono text-xs"}
          type={secret && !revealed ? "password" : "text"}
          placeholder={PLACEHOLDERS[variable.kind]}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {secret && (
          <>
            <button className="shrink-0 rounded p-1.5 text-muted hover:bg-hover hover:text-fg" title={revealed ? "Masquer" : "Afficher"} onClick={onReveal}>
              {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button className="shrink-0 rounded p-1.5 text-muted hover:bg-hover hover:text-fg" title="Copier" onClick={onCopy}>
              <Copy size={14} />
            </button>
          </>
        )}
      </div>
    </Field>
  );
}
