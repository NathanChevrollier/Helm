import { useEffect, useState } from "react";
import { lazy, Suspense } from "react";
import { CheckCircle2, FileCode2, Rocket } from "lucide-react";
import "../lib/monaco";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/store";
import { useMonacoTheme } from "../lib/theme";
import { Button, Field, Input, Modal } from "./ui";

const Editor = lazy(() => import("@monaco-editor/react"));

const validName = (n: string) => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(n);

/**
 * Nouveau projet Docker Compose : dossier + docker-compose.yml (+ .env), vérifiés par
 * `docker compose config` avant tout démarrage.
 */
export default function NewComposeProject({ serverId, onClose, onDone }: { serverId: string; onClose: () => void; onDone: () => void }) {
  const notify = useApp((s) => s.notify);
  const monacoTheme = useMonacoTheme();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [yaml, setYaml] = useState("");
  const [env, setEnv] = useState("");
  const [showEnv, setShowEnv] = useState(false);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Le modèle suit le nom tant que le fichier n'a pas été modifié à la main. */
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) return;
    const app = name || "mon-app";
    void api.dockerComposeTemplate(app, "nginx:alpine", 8100, 80).then(setYaml);
  }, [name, touched]);

  const dir = directory.trim() || `/opt/stacks/${name || "mon-app"}`;

  const create = async () => {
    if (!validName(name)) return notify("Nom de projet : minuscules, chiffres, - et _ seulement.", "error");
    setBusy(true);
    setError(null);
    try {
      const r = await api.dockerComposeCreate(serverId, name, directory.trim() || null, yaml, showEnv ? env : null, start);
      setDone(`${r.file}${r.started ? "\n\n" + r.log : ""}`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <Modal
        title="Projet créé"
        width="max-w-3xl"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Fermer
          </Button>
        }
      >
        <p className="mb-2 flex items-center gap-2 text-sm">
          <CheckCircle2 size={16} className="text-ok" /> {start ? "Projet créé et démarré." : "Projet créé (non démarré)."}
        </p>
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{done}</pre>
      </Modal>
    );
  }

  return (
    <Modal
      title="Nouveau projet Docker Compose"
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <label className="mr-auto flex items-center gap-2 self-center text-sm">
            <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
            Démarrer tout de suite
          </label>
          <Button variant="primary" loading={busy} icon={start ? <Rocket size={14} /> : <FileCode2 size={14} />} disabled={!validName(name)} onClick={() => void create()}>
            {start ? "Créer et démarrer" : "Créer"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nom du projet" hint="Sert de nom de projet compose et de dossier.">
            <Input value={name} placeholder="mon-app" onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus />
          </Field>
          <Field label="Dossier sur le serveur" hint="Vide : /opt/stacks/<nom>.">
            <Input className="font-mono text-xs" value={directory} placeholder={dir} onChange={(e) => setDirectory(e.target.value)} />
          </Field>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <span className="font-mono">{dir}/docker-compose.yml</span>
            <button className="hover:text-fg" onClick={() => setShowEnv((v) => !v)}>
              {showEnv ? "Masquer le fichier .env" : "Ajouter un fichier .env"}
            </button>
          </div>
          <div className="h-72 overflow-hidden rounded-md border border-border">
            <Suspense fallback={null}>
              <Editor
                value={yaml}
                onChange={(v) => {
                  setTouched(true);
                  setYaml(v ?? "");
                }}
                language="yaml"
                theme={monacoTheme}
                options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false }}
              />
            </Suspense>
          </div>
        </div>
        {showEnv && (
          <Field label="Fichier .env (variables et mots de passe)" hint="Enregistré à côté du compose, lisible par root seulement (chmod 600).">
            <textarea
              className="h-24 w-full resize-none rounded-md border border-border bg-bg p-2 font-mono text-xs outline-none focus:border-accent"
              placeholder={"MYSQL_PASSWORD=…\nAPP_SECRET=…"}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
          </Field>
        )}
        {error && <pre className="rounded-md border border-danger/40 bg-danger/10 p-3 font-mono text-xs whitespace-pre-wrap text-danger select-text">{error}</pre>}
        <p className="text-xs text-muted">
          Helm vérifie le fichier avec <span className="font-mono">docker compose config</span> avant de démarrer quoi que ce soit. Pense à ne publier les ports que sur 127.0.0.1 et à passer par un site (nginx ou Apache) pour l'exposer.
        </p>
      </div>
    </Modal>
  );
}
