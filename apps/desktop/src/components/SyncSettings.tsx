import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CloudCog, FileSymlink, RefreshCw } from "lucide-react";
import { api, errorMessage, type SyncMode, type SyncView } from "../lib/api";
import { runSync, useSync } from "../lib/sync";
import { useApp } from "../lib/store";
import { Button, Field, Input } from "./ui";

const MODES: { id: SyncMode; label: string }[] = [
  { id: "off", label: "Désactivée" },
  { id: "file", label: "Fichier partagé" },
  { id: "server", label: "Serveur (Docker)" },
];

/** Réglage de la synchronisation entre PC (Réglages → Préférences). */
export default function SyncSettings() {
  const notify = useApp((s) => s.notify);
  const { running, lastError } = useSync();
  const [view, setView] = useState<SyncView | null>(null);
  const [mode, setMode] = useState<SyncMode>("off");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.syncGet().then((v) => {
      setView(v);
      setMode(v.mode);
      setPath(v.path ?? "");
      setUrl(v.url ?? "");
      setIncludeSecrets(v.includeSecrets);
    });
  useEffect(() => {
    void load();
  }, []);
  // Rafraîchit l'heure de la dernière synchronisation après chaque passage.
  useEffect(() => {
    if (!running) void api.syncGet().then(setView).catch(() => {});
  }, [running]);

  const pickFile = async () => {
    const p = await save({ title: "Fichier de synchronisation (dans un dossier OneDrive, Dropbox…)", defaultPath: "helm-sync.json", filters: [{ name: "Synchronisation Helm", extensions: ["json"] }] });
    if (p) setPath(p);
  };

  const apply = async () => {
    if (passphrase && passphrase !== confirm) return notify("Les deux phrases de passe ne correspondent pas.", "error");
    if (mode !== "off" && !passphrase && !view?.hasPassphrase) return notify("Choisis une phrase de passe : la même sur tous tes PC.", "error");
    if (mode === "server" && !token && !view?.hasToken) return notify("Colle le jeton du serveur (fichier .env du serveur).", "error");
    setSaving(true);
    try {
      await api.syncSet({ mode, path, url, includeSecrets, passphrase: passphrase || undefined, token: token || undefined });
      setPassphrase("");
      setConfirm("");
      setToken("");
      await load();
      if (mode !== "off") await runSync(true);
      else notify("Synchronisation désactivée", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const kept = (has: boolean | undefined) => (has ? "Déjà enregistrée : laisse vide pour la conserver." : undefined);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
      <div>
        <span className="flex items-center gap-2 font-medium">
          <CloudCog size={16} className="text-accent" />
          Synchronisation entre PC
        </span>
        <span className="block text-sm text-muted">
          Serveurs, identifiants, clés d'hôte approuvées, snippets et tunnels identiques sur tous tes PC. Tout est chiffré avec ta phrase de passe avant de quitter ce PC : ni le fichier ni le serveur ne peuvent le lire.
        </span>
      </div>
      <div className="flex w-fit gap-1 rounded-md border border-border bg-bg p-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`rounded px-3 py-1 text-xs transition-colors ${mode === m.id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "file" && (
        <Field label="Fichier" hint="Place-le dans un dossier déjà synchronisé (OneDrive, Dropbox, Syncthing, partage réseau) et choisis le même sur tes autres PC.">
          <div className="flex gap-2">
            <Input className="font-mono text-xs" value={path} placeholder="C:\Users\…\OneDrive\helm-sync.json" onChange={(e) => setPath(e.target.value)} />
            <Button type="button" icon={<FileSymlink size={14} />} onClick={() => void pickFile()}>
              Choisir…
            </Button>
          </div>
        </Field>
      )}
      {mode === "server" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Adresse du serveur" hint="Serveur helm-sync (dossier sync-server du dépôt : Dockerfile, compose, bloc nginx).">
            <Input value={url} placeholder="https://sync.exemple.fr" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Jeton" hint={kept(view?.hasToken) ?? "Valeur de HELM_SYNC_TOKENS sur le serveur."}>
            <Input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
          </Field>
        </div>
      )}
      {mode !== "off" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phrase de passe" hint={kept(view?.hasPassphrase) ?? "10 caractères minimum, la même sur tous tes PC. Perdue, les données synchronisées sont illisibles."}>
              <Input type="password" value={passphrase} autoComplete="new-password" onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
            <Field label="Confirmation">
              <Input type="password" value={confirm} autoComplete="new-password" disabled={!passphrase} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
            <span>
              Synchroniser aussi les secrets (mots de passe SSH et sudo, passphrases)
              <span className="block text-xs text-muted">Pratique, mais leur sécurité repose alors sur ta phrase de passe : choisis-la longue.</span>
            </span>
          </label>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" loading={saving} onClick={() => void apply()}>
          Enregistrer
        </Button>
        {view && view.mode !== "off" && (
          <Button size="sm" icon={<RefreshCw size={13} className={running ? "animate-spin" : ""} />} disabled={running} onClick={() => void runSync(true)}>
            Synchroniser maintenant
          </Button>
        )}
        {view?.lastSync && (
          <span className="text-xs text-muted">
            Dernière synchronisation : {new Date(view.lastSync).toLocaleString("fr-FR")} (révision {view.lastRev})
          </span>
        )}
      </div>
      {lastError && view?.mode !== "off" && <p className="text-xs text-danger">Dernière tentative : {lastError}</p>}
    </div>
  );
}
