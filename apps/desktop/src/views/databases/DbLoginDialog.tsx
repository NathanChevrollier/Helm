// Compte à utiliser pour une instance, quand ceux du conteneur (MYSQL_ROOT_PASSWORD…) ou du socket
// ne suffisent pas. Gardé dans le gestionnaire d'identifiants du système, jamais dans un fichier.
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { api, errorMessage, type DbInstance } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Button, Field, Input, Modal } from "../../components/ui";

export default function DbLoginDialog({ serverId, instance, onClose, onSaved }: { serverId: string; instance: DbInstance; onClose: () => void; onSaved: () => void }) {
  const { notify } = useAppPick("notify");
  const [saved, setSaved] = useState<string | null>(null);
  const [user, setUser] = useState(instance.engine === "postgres" ? "postgres" : "root");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.dbLoginGet(serverId, instance.id).then((u) => {
      setSaved(u);
      if (u) setUser(u);
    });
  }, [serverId, instance.id]);

  const save = async (u: string, pw: string) => {
    setBusy(true);
    try {
      await api.dbLoginSet(serverId, instance.id, u, pw);
      notify(u ? `Compte « ${u} » enregistré pour ${instance.label}.` : `Compte oublié : ${instance.label} utilise de nouveau les identifiants du conteneur.`, "success");
      onSaved();
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Identifiants de ${instance.label}`}
      description="Gardés dans le gestionnaire d'identifiants du système, transmis au client SQL sans jamais apparaître dans une ligne de commande."
      width="max-w-md"
      onClose={onClose}
      footer={
        <>
          {saved && (
            <Button variant="ghost" disabled={busy} onClick={() => void save("", "")}>
              Oublier
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<KeyRound size={13} />} loading={busy} disabled={!user.trim()} onClick={() => void save(user, password)}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-muted">
          Sans compte enregistré, Zenytt prend ceux du conteneur : MYSQL_ROOT_PASSWORD (ou son fichier _FILE), sinon MYSQL_USER / MYSQL_PASSWORD ; POSTGRES_USER pour PostgreSQL. Si le mot de passe root a changé depuis la création du conteneur, renseigne-le ici.
        </p>
        <Field label="Utilisateur">
          <Input value={user} onChange={(e) => setUser(e.target.value)} className="font-mono" autoFocus />
        </Field>
        <Field label="Mot de passe">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && user.trim() && void save(user, password)} />
        </Field>
      </div>
    </Modal>
  );
}
