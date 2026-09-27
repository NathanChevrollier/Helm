import { lazy, Suspense, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CloudCog, Copy, FileSymlink, KeyRound, Link2, Lock, RefreshCw, Rocket, UploadCloud } from "lucide-react";
import { api, errorMessage, type SyncMode, type SyncView } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { runSync, useSync } from "../lib/sync";
import { useApp } from "../lib/store";
import { Button, Checkbox, CodeBlock, Field, Input, Modal, Segmented } from "./ui";

const SyncInstallWizard = lazy(() => import("./SyncInstallWizard"));

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
  const [wizard, setWizard] = useState(false);
  const [joining, setJoining] = useState(false);
  const [pairing, setPairing] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const servers = useApp((s) => s.servers);

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
    const p = await save({ title: "Fichier de synchronisation (dans un dossier OneDrive, Dropbox…)", defaultPath: "zenytt-sync.json", filters: [{ name: "Synchronisation Zenytt", extensions: ["json"] }] });
    if (p) setPath(p);
  };

  const apply = async () => {
    if (passphrase && passphrase !== confirm) return notify("Les deux phrases de passe ne correspondent pas.", "error");
    if (mode !== "off" && !passphrase && !view?.hasPassphrase) return notify("Choisis une phrase de passe : la même sur tous tes PC.", "error");
    // Mode privé (installé par l'assistant) : gardé tant qu'aucune adresse n'est saisie.
    const tunnel = mode === "server" && !url.trim() ? (view?.tunnel ?? null) : null;
    if (mode === "server" && !tunnel && !token && !view?.hasToken) return notify("Colle le jeton du serveur (fichier .env du serveur).", "error");
    setSaving(true);
    try {
      await api.syncSet({ mode, path, url, tunnel, includeSecrets, passphrase: passphrase || undefined, token: token || undefined });
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
  const privateServer = view?.tunnel ? (servers.find((s) => s.id === view.tunnel!.serverId)?.name ?? "serveur supprimé") : null;

  /** Remet sur le serveur la version de zenytt-sync embarquée dans cette version de Zenytt. */
  const updateServer = async () => {
    if (!view?.tunnel) return;
    setUpdating(true);
    try {
      await api.syncServerInstall(view.tunnel.serverId);
      notify("Serveur de synchronisation mis à jour", "success");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setUpdating(false);
    }
  };

  const showPairing = async () => {
    try {
      setPairing(await api.syncPairingCode());
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-panel p-4">
      <div>
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <CloudCog size={15} className="text-accent" />
          Synchronisation entre postes
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">
          Serveurs, bureaux à distance, identifiants, clés d'hôte approuvées, snippets et tunnels identiques sur tous tes PC. Tout est chiffré avec ta phrase de passe avant de quitter ce PC : ni le fichier ni le serveur ne peuvent le lire.
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Rocket size={13} />} onClick={() => setWizard(true)}>
          Installer mon serveur de synchro…
        </Button>
        <Button size="sm" icon={<Link2 size={13} />} onClick={() => setJoining(true)}>
          Rejoindre avec un code…
        </Button>
        {view?.mode === "server" && view.hasPassphrase && (
          <Button size="sm" icon={<KeyRound size={13} />} onClick={() => void showPairing()}>
            Code pour un autre PC
          </Button>
        )}
      </div>
      <Segmented label="Mode de synchronisation" size="sm" value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.id, label: m.label }))} />

      {mode === "file" && (
        <Field label="Fichier" hint="Place-le dans un dossier déjà synchronisé (OneDrive, Dropbox, Syncthing, partage réseau) et choisis le même sur tes autres PC.">
          <div className="flex gap-2">
            <Input className="font-mono text-xs" value={path} placeholder="C:\Users\…\OneDrive\zenytt-sync.json" onChange={(e) => setPath(e.target.value)} />
            <Button type="button" icon={<FileSymlink size={14} />} onClick={() => void pickFile()}>
              Choisir…
            </Button>
          </div>
        </Field>
      )}
      {mode === "server" && privateServer && !url.trim() && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg p-3 text-xs">
          <Lock size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            Mode privé : serveur de synchronisation sur <strong>{privateServer}</strong> (port {view!.tunnel!.port}), joint par un tunnel SSH. Aucun port ouvert.
          </span>
          <Button size="sm" icon={<UploadCloud size={13} />} loading={updating} onClick={() => void updateServer()}>
            Mettre à jour le serveur
          </Button>
        </div>
      )}
      {mode === "server" && (
        <details className="rounded-md border border-border bg-bg p-3 text-xs" open={!privateServer && !view?.hasToken}>
          <summary className="cursor-pointer font-medium text-fg">{privateServer ? "Utiliser plutôt un serveur public (adresse et jeton)" : "Serveur déjà en place : adresse et jeton"}</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Adresse du serveur" hint="Adresse HTTPS d'un serveur zenytt-sync. Laisse vide pour garder le mode privé.">
              <Input value={url} placeholder="https://sync.exemple.fr" onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field label="Jeton" hint={kept(view?.hasToken) ?? "Valeur de ZENYTT_SYNC_TOKENS sur le serveur."}>
              <Input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
            </Field>
          </div>
        </details>
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
          <Checkbox
            checked={includeSecrets}
            onChange={setIncludeSecrets}
            label="Synchroniser aussi les secrets (mots de passe SSH et sudo, passphrases)"
            hint="Pratique, mais leur sécurité repose alors sur ta phrase de passe : choisis-la longue."
          />
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

      {wizard && (
        <Suspense fallback={null}>
          <SyncInstallWizard onClose={() => setWizard(false)} onDone={() => void load()} />
        </Suspense>
      )}
      {joining && (
        <JoinDialog
          onClose={() => setJoining(false)}
          onDone={() => {
            setJoining(false);
            void load();
          }}
        />
      )}
      {pairing && (
        <Modal title="Code pour un autre PC" onClose={() => setPairing(null)} footer={<Button onClick={() => setPairing(null)}>Fermer</Button>}>
          <p className="mb-3 text-sm">
            Sur l'autre PC : Réglages → Synchronisation → <strong>Rejoindre avec un code</strong>, colle ce code puis ta phrase de passe. Le code est chiffré avec elle : sans elle, il ne révèle rien.
          </p>
          <CodeBlock
            code={pairing}
            className="max-h-48 overflow-auto break-all"
            actions={
              <Button size="sm" icon={<Copy size={13} />} onClick={() => void writeClipboard(pairing).then(() => notify("Code copié", "success"))}>
                Copier
              </Button>
            }
          />
        </Modal>
      )}
    </div>
  );
}

/** Rejoindre la synchronisation d'un autre PC avec son code d'appairage et la phrase de passe. */
function JoinDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const notify = useApp((s) => s.notify);
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const join = async () => {
    setBusy(true);
    try {
      await api.syncJoin(code, passphrase);
      await useApp.getState().refreshServers();
      await runSync(true);
      onDone();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Rejoindre la synchronisation"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={busy} disabled={!code.trim().startsWith("zenytt-pair:") || passphrase.length < 10} onClick={() => void join()}>
            Rejoindre
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">Le code s'obtient sur un PC déjà synchronisé : Réglages → Synchronisation → « Code pour un autre PC ».</p>
        <Field label="Code d'appairage">
          <textarea
            className="min-h-24 rounded-md border border-border bg-bg p-2 font-mono text-xs"
            value={code}
            placeholder="zenytt-pair:…"
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field label="Phrase de passe de synchronisation">
          <Input type="password" value={passphrase} autoComplete="off" onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
