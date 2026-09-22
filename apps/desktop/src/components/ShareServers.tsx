import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy, FileDown, FileUp, Share2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { useApp, useAppPick } from "../lib/store";
import { Button, Field, Input, Modal } from "./ui";

/**
 * Partage d'une sélection de serveurs avec quelqu'un d'autre : fichier ou code à coller, toujours
 * chiffrés par un mot de passe à transmettre séparément.
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const { servers, activeServerId, notify } = useAppPick("servers", "activeServerId", "notify");
  const [selected, setSelected] = useState<string[]>(activeServerId ? [activeServerId] : []);
  const [withSecrets, setWithSecrets] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const check = () => {
    if (!selected.length) return notify("Choisis au moins un serveur.", "error") ?? false;
    if (password.length < 8) return notify("Mot de passe trop court (8 caractères minimum).", "error") ?? false;
    return true;
  };

  const copyCode = async () => {
    if (!check()) return;
    setBusy(true);
    try {
      const code = await api.settingsShareCode(selected, password, withSecrets);
      await writeClipboard(code);
      notify("Code copié : colle-le à ton correspondant, et donne-lui le mot de passe par un autre canal.", "success");
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async () => {
    if (!check()) return;
    const path = await saveDialog({ defaultPath: `partage-helm-${new Date().toISOString().slice(0, 10)}.helm`, filters: [{ name: "Partage Helm", extensions: ["helm"] }] });
    if (!path) return;
    setBusy(true);
    try {
      await api.saveTextFile(path, await api.settingsShare(selected, password, withSecrets));
      notify(`Partage enregistré : ${path}`, "success");
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Partager des serveurs"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button loading={busy} icon={<FileDown size={14} />} onClick={() => void saveFile()}>
            Enregistrer un fichier…
          </Button>
          <Button variant="primary" loading={busy} icon={<Copy size={14} />} onClick={() => void copyCode()}>
            Copier le code
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Le partage contient les profils choisis (et leurs serveurs de rebond), leurs identifiants de la banque et les clés d'hôte approuvées. Il est chiffré : transmets le mot de passe par un autre moyen que le partage lui-même.
      </p>
      <ul className="mb-3 flex max-h-64 flex-col gap-1 overflow-auto">
        {servers.map((s) => (
          <li key={s.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
              <input
                type="checkbox"
                checked={selected.includes(s.id)}
                onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
              />
              <span className="size-[7px] rounded-full" style={{ background: s.color ?? "var(--color-accent)" }} />
              <span className="text-sm">{s.name}</span>
              <span className="ml-auto font-mono text-xs text-muted">
                {s.username}@{s.host}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Field label="Mot de passe du partage" hint="8 caractères minimum. Sans lui, le partage est illisible.">
        <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
        <span>
          Inclure les secrets (mots de passe SSH et sudo, passphrases)
          <span className="block text-xs text-muted">À n'utiliser que pour un compte prévu pour être partagé : la personne aura le même accès que toi.</span>
        </span>
      </label>
    </Modal>
  );
}

/** Réception d'un partage : code collé ou fichier reçu. */
export function ReceiveShareDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const notify = useApp((s) => s.notify);
  const ask = useApp((s) => s.ask);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (content: string) => {
    setBusy(true);
    try {
      let password = "";
      if (await api.settingsTextEncrypted(content)) {
        const v = await ask({ title: "Partage chiffré", body: "Mot de passe communiqué par la personne qui partage :", input: { label: "Mot de passe", secret: true }, confirmLabel: "Importer" });
        if (typeof v !== "string" || !v) return;
        password = v;
      }
      const r = await api.settingsImportText(content, password);
      notify(`Importé : ${r.servers} serveur(s), ${r.identities} identifiant(s)`, "success");
      onDone();
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const fromFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Partage Helm", extensions: ["helm", "json"] }] });
    if (typeof path !== "string") return;
    try {
      await load(await api.readTextFile(path));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  return (
    <Modal
      title="Recevoir un partage"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button icon={<FileUp size={14} />} loading={busy} onClick={() => void fromFile()}>
            Ouvrir un fichier…
          </Button>
          <Button variant="primary" icon={<Share2 size={14} />} loading={busy} disabled={!text.trim()} onClick={() => void load(text)}>
            Importer le code
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Colle ici le code reçu (il commence par <span className="font-mono">helm-share:</span>), ou ouvre le fichier de partage. Les profils existants de même identifiant sont remplacés ; rien n'est supprimé.
      </p>
      <textarea
        className="h-40 w-full resize-none rounded-md border border-border bg-bg p-2 font-mono text-xs outline-none focus:border-accent"
        placeholder="helm-share:…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Modal>
  );
}
