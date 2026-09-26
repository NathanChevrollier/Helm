// Aide-mémoire des raccourcis : ceux de l'app (modifiables) et ceux, fixes, des pages.
import { navigate, useShell } from "../../lib/shell";
import { display, SHORTCUTS, shortcutOf, type ShortcutId } from "../../lib/shortcuts";
import { Button, Kbd, Modal } from "../ui";

const FIXED: [string, string][] = [
  ["F5 · Ctrl+R", "Actualiser la page et l'état des serveurs"],
  ["Ctrl+Entrée", "Exécuter la requête SQL"],
  ["Ctrl+S", "Enregistrer le fichier ouvert dans l'éditeur"],
  ["Ctrl+= · Ctrl+- · Ctrl+0", "Taille du texte du terminal (aussi Ctrl+molette)"],
  ["Ctrl+Maj+C · Ctrl+Maj+V", "Copier, coller dans le terminal"],
  ["F2 · Suppr · Retour arrière", "Renommer, supprimer, dossier parent (Fichiers)"],
  ["Ctrl+P", "Rechercher des fichiers sur le serveur (Fichiers)"],
  ["Échap", "Fermer la fenêtre, le tiroir ou le menu du dessus"],
];

export default function ShortcutsHelp() {
  const open = useShell((s) => s.shortcutsOpen);
  const setOpen = useShell((s) => s.setShortcutsOpen);
  if (!open) return null;
  return (
    <Modal
      title="Raccourcis clavier"
      description="Ceux de la première liste se changent dans Réglages → Raccourcis."
      width="max-w-2xl"
      onClose={() => setOpen(false)}
      footer={
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            navigate("settings", "shortcuts");
          }}
        >
          Modifier les raccourcis
        </Button>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <dl className="flex flex-col gap-2 text-[13px]">
          {(Object.keys(SHORTCUTS) as ShortcutId[]).map((id) => (
            <div key={id} className="flex items-center justify-between gap-3">
              <dt className="text-muted">{SHORTCUTS[id].label}</dt>
              <dd>
                <Kbd>{display(shortcutOf(id))}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
        <dl className="flex flex-col gap-2 text-[13px]">
          {FIXED.map(([keys, label]) => (
            <div key={keys} className="flex items-center justify-between gap-3">
              <dt className="text-muted">{label}</dt>
              <dd className="shrink-0">
                <Kbd>{keys}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}
