import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, errorMessage, type AiCapabilities, type AiExecMode, type AiSettings as Settings, type AiView } from "../lib/api";
import { useApp } from "../lib/store";
import { ask, useAssistant } from "../lib/assistant";
import { Badge, Button, Field, Input } from "./ui";

/** Fournisseurs prêts à l'emploi : le reste (adresse, modèle) se règle à la main. */
const PRESETS: { id: string; label: string; settings: Partial<Settings>; hint: string }[] = [
  { id: "claude", label: "Claude (Anthropic)", settings: { provider: "anthropic", baseUrl: "", model: "claude-opus-5" }, hint: "Clé sur console.anthropic.com. Le plus à l'aise sur les tâches d'administration." },
  { id: "openai", label: "OpenAI", settings: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" }, hint: "Clé sur platform.openai.com." },
  { id: "mistral", label: "Mistral", settings: { provider: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest" }, hint: "Clé sur console.mistral.ai." },
  { id: "openrouter", label: "OpenRouter", settings: { provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" }, hint: "Un seul compte pour de nombreux modèles." },
  { id: "ollama", label: "Ollama (local)", settings: { provider: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.1" }, hint: "Rien ne sort de ton réseau. Choisis un modèle qui gère les outils." },
  { id: "lmstudio", label: "LM Studio (local)", settings: { provider: "openai", baseUrl: "http://localhost:1234/v1", model: "local-model" }, hint: "Serveur local de LM Studio." },
];

const CAPABILITIES: { key: keyof AiCapabilities; label: string; hint: string }[] = [
  { key: "status", label: "État des serveurs", hint: "CPU, mémoire, disques, charge, alertes." },
  { key: "containers", label: "Conteneurs Docker", hint: "Noms, images, états, ports." },
  { key: "logs", label: "Journaux", hint: "Conteneurs et services systemd." },
  { key: "sites", label: "Sites web", hint: "Domaines nginx, certificats." },
  { key: "processes", label: "Processus", hint: "Les plus gourmands en CPU." },
  { key: "security", label: "Audit de sécurité", hint: "SSH, pare-feu, fail2ban, mises à jour." },
  { key: "files", label: "Fichiers de configuration", hint: "Lecture limitée (clés et secrets exclus). Désactivé par défaut." },
];

const MODES: { id: AiExecMode; label: string; hint: string }[] = [
  { id: "off", label: "Lecture seule", hint: "L'assistant explique ; c'est toi qui tapes les commandes." },
  { id: "propose", label: "Propose, tu valides", hint: "Chaque commande s'affiche dans la discussion avec Exécuter / Refuser." },
  { id: "auto", label: "Exécution autonome", hint: "Il exécute lui-même ; les commandes sensibles demandent quand même ta validation." },
];

/** Réglages de l'assistant IA (Réglages → Préférences). */
export default function AiSettingsPanel() {
  const notify = useApp((s) => s.notify);
  const [view, setView] = useState<AiView | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.aiGet().then((v) => {
      setView(v);
      const { hasKey: _ignored, ...rest } = v;
      setSettings(rest);
    });
  useEffect(() => {
    void load();
  }, []);

  if (!settings) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      await api.aiSet(settings, key || undefined);
      setKey("");
      await load();
      await useAssistant.getState().reload();
      notify("Assistant enregistré", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    await save();
    await useAssistant.getState().reset();
    useAssistant.getState().setOpen(true);
    void ask("Dis bonjour en une phrase et indique quel modèle tu es.");
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
      <div>
        <span className="flex items-center gap-2 font-medium">
          <Sparkles size={16} className="text-accent" />
          Assistant IA
        </span>
        <span className="block text-sm text-muted">
          Un panneau de discussion qui peut consulter tes serveurs pour t'aider à comprendre une erreur. Les données lues (journaux, configurations) partent chez le fournisseur choisi : les mots de passe, clés et jetons sont masqués avant l'envoi.
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const active = settings.provider === p.settings.provider && settings.baseUrl === (p.settings.baseUrl ?? "");
          return (
            <button
              key={p.id}
              title={p.hint}
              onClick={() => setSettings({ ...settings, ...p.settings } as Settings)}
              className={`rounded-md border px-2.5 py-1 text-xs ${active ? "border-accent bg-accent/10 text-fg" : "border-border text-muted hover:text-fg"}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Modèle">
          <Input value={settings.model} onChange={(e) => set("model", e.target.value)} />
        </Field>
        <Field label="Clé d'API" hint={view?.hasKey ? "Déjà enregistrée : laisse vide pour la conserver." : "Inutile pour un modèle local."}>
          <Input type="password" value={key} autoComplete="new-password" onChange={(e) => setKey(e.target.value)} />
        </Field>
        {settings.provider === "openai" && (
          <div className="col-span-2">
            <Field label="Adresse de l'API" hint="Doit se terminer par /v1 pour la plupart des fournisseurs.">
              <Input value={settings.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => set("baseUrl", e.target.value)} />
            </Field>
          </div>
        )}
      </div>

      <div>
        <span className="text-xs font-medium text-muted">Ce qu'il peut consulter</span>
        <div className="mt-1 grid grid-cols-2 gap-x-4">
          {CAPABILITIES.map((c) => (
            <label key={c.key} className="flex items-start gap-2 py-1 text-sm" title={c.hint}>
              <input
                type="checkbox"
                className="mt-1"
                checked={settings.capabilities[c.key]}
                onChange={(e) => set("capabilities", { ...settings.capabilities, [c.key]: e.target.checked })}
              />
              <span>
                {c.label}
                <span className="block text-xs text-muted">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">
          Il ne voit que les serveurs cochés dans l'onglet « Accès IA ». Rien n'est consulté sans que tu poses une question.
        </p>
      </div>

      <div>
        <span className="text-xs font-medium text-muted">Commandes</span>
        <div className="mt-1 flex flex-col gap-1">
          {MODES.map((m) => (
            <label key={m.id} className="flex items-start gap-2 text-sm">
              <input type="radio" className="mt-1" name="ai-exec" checked={settings.execMode === m.id} onChange={() => set("execMode", m.id)} />
              <span>
                {m.label}
                {m.id === "auto" && <Badge tone="warn">à activer en connaissance de cause</Badge>}
                <span className="block text-xs text-muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
          Enregistrer
        </Button>
        <Button size="sm" icon={<Sparkles size={13} />} onClick={() => void test()}>
          Enregistrer et tester
        </Button>
      </div>
    </div>
  );
}
