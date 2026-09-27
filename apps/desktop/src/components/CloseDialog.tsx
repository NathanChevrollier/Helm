// « Réduire ou quitter ? » à la fermeture de la fenêtre, avec la possibilité de retenir le choix.
import { useState } from "react";
import { LogOut, PanelBottomClose } from "lucide-react";
import { api } from "../lib/api";
import { quitApp, useCloseDialog } from "../lib/desktop";
import { useApp, type CloseAction } from "../lib/store";
import { Button, Checkbox, Modal } from "./ui";

export default function CloseDialog() {
  const setOpen = useCloseDialog((s) => s.setOpen);
  const setSettings = useApp((s) => s.setSettings);
  const [remember, setRemember] = useState(false);

  const choose = async (action: Exclude<CloseAction, "ask">) => {
    if (remember) setSettings({ closeAction: action });
    setOpen(false);
    if (action === "tray") await api.appHide();
    else await quitApp();
  };

  return (
    <Modal
      title="Fermer Zenytt ?"
      onClose={() => setOpen(false)}
      footer={
        <>
          <Button icon={<LogOut size={14} />} onClick={() => void choose("quit")}>
            Quitter
          </Button>
          <Button variant="primary" icon={<PanelBottomClose size={14} />} onClick={() => void choose("tray")}>
            Réduire dans la zone de notification
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>
          <strong>Réduire</strong> garde Zenytt ouvert en arrière-plan : tunnels, transferts, synchronisation et alertes continuent. Son icône, près de l'horloge, le rouvre.
        </p>
        <p className="text-muted">
          <strong>Quitter</strong> arrête tout.
        </p>
        <Checkbox checked={remember} onChange={setRemember} label="Retenir mon choix" hint="Modifiable dans Réglages → Préférences." />
      </div>
    </Modal>
  );
}
