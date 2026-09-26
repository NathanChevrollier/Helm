// Import des profils depuis PuTTY (registre Windows) et ~/.ssh/config (OpenSSH).
import { useEffect, useState } from "react";
import { PlugZap } from "lucide-react";
import { api, type ServerProfile } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Button, Checkbox, Modal, PROFILE_COLORS, Segmented, Skeleton } from "../../components/ui";

const SOURCES = [
  ["putty", "PuTTY"],
  ["openssh", "OpenSSH (~/.ssh/config)"],
] as const;

/** Import des sessions PuTTY (registre Windows) et des hôtes de ~/.ssh/config (OpenSSH). */
export default function ImportServers({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const notify = useApp((s) => s.notify);
  const [source, setSource] = useState<"putty" | "openssh">("putty");
  const [sessions, setSessions] = useState<ServerProfile[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    setSessions(null);
    (source === "putty" ? api.puttySessions() : api.sshConfigSessions()).then((list) => {
      setSessions(list);
      setSelected(new Set(list.map((_, i) => i)));
    });
  }, [source]);

  const doImport = async () => {
    if (!sessions) return;
    const chosen = sessions.filter((_, i) => selected.has(i));
    // Les rebonds OpenSSH (ProxyJump) désignent un hôte par son alias : on les relie une fois
    // tous les profils créés (importés maintenant ou déjà présents, par nom).
    const ids = new Map<string, string>(useApp.getState().servers.map((s) => [s.name, s.id]));
    const pending: { id: string; profile: ServerProfile; alias: string }[] = [];
    for (const s of chosen) {
      const alias = s.jumpId?.startsWith("alias:") ? s.jumpId.slice("alias:".length) : null;
      const profile = { ...s, color: PROFILE_COLORS[0], jumpId: null };
      const id = await api.saveServer(profile, {});
      ids.set(s.name, id);
      if (alias) pending.push({ id, profile: { ...profile, id }, alias });
    }
    const unresolved: string[] = [];
    for (const { id, profile, alias } of pending) {
      const jump = ids.get(alias);
      if (jump && jump !== id) await api.saveServer({ ...profile, jumpId: jump }, {});
      else unresolved.push(`${profile.name} → ${alias}`);
    }
    notify(
      `${chosen.length} serveur(s) importé(s).${unresolved.length ? ` Rebond introuvable pour : ${unresolved.join(", ")} (à régler dans le profil).` : ""}`,
      unresolved.length ? "info" : "success",
    );
    onDone();
    onClose();
  };

  return (
    <Modal
      title="Importer des serveurs"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" onClick={doImport} disabled={!selected.size} icon={<PlugZap size={14} />}>
            Importer {selected.size || ""}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <Segmented label="Source" value={source} onChange={setSource} options={SOURCES.map(([value, label]) => ({ value, label }))} />
        {sessions && sessions.length > 0 && (
          <Checkbox
            checked={selected.size === sessions.length}
            indeterminate={selected.size > 0 && selected.size < sessions.length}
            onChange={(v) => setSelected(v ? new Set(sessions.map((_, i) => i)) : new Set())}
            label="Tout sélectionner"
          />
        )}
      </div>
      {sessions === null ? (
        <Skeleton rows={4} />
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted">{source === "putty" ? "Aucune session SSH enregistrée dans PuTTY n'a été trouvée." : "Aucun hôte trouvé dans ~/.ssh/config."}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sessions.map((s, i) => (
            <li key={i}>
              <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover">
                <Checkbox
                  checked={selected.has(i)}
                  onChange={(v) => {
                    const next = new Set(selected);
                    if (v) next.add(i);
                    else next.delete(i);
                    setSelected(next);
                  }}
                  label={s.name}
                  className="flex-1"
                />
                <span className="font-mono text-xs text-muted">
                  {s.username}@{s.host}:{s.port}
                  {s.jumpId?.startsWith("alias:") && ` via ${s.jumpId.slice(6)}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
