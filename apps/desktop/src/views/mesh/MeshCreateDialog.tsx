// Création d'un réseau privé, ou ajout d'un serveur à un réseau existant.
import { useState } from "react";
import { api, errorMessage, type MeshNetwork, type MeshReport } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Button, Checkbox, ErrorState, Field, Input, Modal } from "../../components/ui";

/** Refus d'un serveur resté dans un réseau inconnu de ce PC (même texte que `UNKNOWN_NETWORK` côté Rust). */
const UNKNOWN_NETWORK = "inconnu de ce PC";

export default function MeshCreateDialog({ network, onClose, onDone }: { network?: MeshNetwork; onClose: () => void; onDone: (report: MeshReport) => void }) {
  const { servers } = useAppPick("servers");
  const [name, setName] = useState("Réseau privé");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);

  const adding = !!network;
  const candidates = servers.filter((s) => !network?.members.some((m) => m.serverId === s.id));
  const toggle = (id: string, on: boolean) => setPicked((p) => (adding ? (on ? [id] : []) : on ? [...p, id] : p.filter((x) => x !== id)));
  const ready = adding ? picked.length === 1 : picked.length >= 2 && name.trim().length > 0;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onDone(adding ? await api.meshAdd(network.id, picked[0], takeover) : await api.meshCreate(name.trim(), picked, takeover));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const count = adding ? 1 : picked.length;

  return (
    <Modal
      title={adding ? `Ajouter un serveur à « ${network.name} »` : "Nouveau réseau privé"}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void submit()}>
            {adding ? "Ajouter au réseau" : "Créer le réseau"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Zenytt installe WireGuard sur chaque serveur, fait générer une clé par le serveur lui-même (elle n'en sort jamais) et les relie. Chaque serveur reçoit une adresse
          privée en 10.x. Le port UDP 51820 doit être ouvert dans le pare-feu de ton hébergeur.
        </p>
        {!adding && (
          <Field label="Nom du réseau">
            <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
        )}
        {/* Pas de Field ici : c'est un <label>, et des cases à cocher imbriquées dans un label se cochent mal. */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{adding ? "Serveur à ajouter" : "Serveurs à relier (au moins deux)"}</span>
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {candidates.length === 0 && <p className="text-sm text-muted">Tous tes serveurs font déjà partie de ce réseau.</p>}
            {candidates.map((s) => (
              <Checkbox
                key={s.id}
                checked={picked.includes(s.id)}
                onChange={(on) => toggle(s.id, on)}
                disabled={busy}
                label={
                  <span>
                    {s.name} <span className="font-mono text-xs text-faint">{s.host}</span>
                  </span>
                }
              />
            ))}
          </div>
        </div>
        {busy && (
          <p className="text-sm text-muted">
            Installation et configuration sur {count} serveur{count > 1 ? "s" : ""}…
          </p>
        )}
        {error && <ErrorState message={<span className="whitespace-pre-line">{error}</span>} />}
        {/* Serveur resté configuré pour un réseau que ce PC ne connaît pas : reprise sur accord explicite. */}
        {(takeover || error?.includes(UNKNOWN_NETWORK)) && (
          <Checkbox
            checked={takeover}
            onChange={setTakeover}
            disabled={busy}
            label="Reprendre les serveurs encore configurés"
            hint="Ils quittent d'abord leur ancien réseau (interface zenytt et clé supprimées), puis rejoignent celui-ci. Si cet ancien réseau est géré depuis un autre PC, ses autres membres ne les joindront plus."
          />
        )}
      </div>
    </Modal>
  );
}
