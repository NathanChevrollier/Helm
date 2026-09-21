import { useEffect, useState } from "react";
import { create } from "zustand";
import { CheckCircle2, Copy, ShieldAlert, Stethoscope, XCircle } from "lucide-react";
import { api, errorMessage, type Diagnosis } from "../lib/api";
import { useApp } from "../lib/store";
import { Button, Modal } from "./ui";

/** Serveur dont le diagnostic de connexion est affiché. */
export const useDoctor = create<{ serverId: string | null; open: (id: string) => void; close: () => void }>((set) => ({
  serverId: null,
  open: (serverId) => set({ serverId }),
  close: () => set({ serverId: null }),
}));

/** Erreurs de connexion pour lesquelles un diagnostic réseau a du sens (pas un refus d'identifiants). */
export function isNetworkFailure(message: string): boolean {
  return /délai dépassé|timed out|timeout|connexion impossible|refus|unreachable|injoignable|os error/i.test(message) && !/authentification/i.test(message);
}

export default function ConnectionDoctor() {
  const { serverId, close } = useDoctor();
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const notify = useApp((s) => s.notify);
  const [result, setResult] = useState<Diagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverId) return;
    setResult(null);
    setError(null);
    api.diagnose(serverId).then(setResult, (e) => setError(errorMessage(e)));
  }, [serverId]);

  if (!serverId || !server) return null;
  const unban = result?.publicIp ? `sudo fail2ban-client set sshd unbanip ${result.publicIp}` : null;

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Stethoscope size={16} /> Diagnostic de connexion — {server.name}
        </span>
      }
      width="max-w-2xl"
      onClose={close}
      footer={<Button onClick={close}>Fermer</Button>}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted">
          Tests réseau depuis ton PC vers {server.host}, sans aucune tentative de connexion : ils ne peuvent pas aggraver un bannissement.
        </p>
        {error && <p className="text-danger">{error}</p>}
        {!result && !error && <p className="text-muted">Tests en cours (jusqu'à une trentaine de secondes)…</p>}
        {result && (
          <>
            <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg p-3">
              {result.checks.map((c) => (
                <li key={c.label} className="flex items-start gap-2">
                  {c.ok ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />}
                  <span className="w-40 shrink-0">{c.label}</span>
                  <span className="font-mono text-xs break-all text-muted">{c.detail}</span>
                </li>
              ))}
              {result.publicIp && (
                <li className="flex items-start gap-2 text-muted">
                  <span className="w-[15px] shrink-0" />
                  <span className="w-40 shrink-0">Ton IP publique</span>
                  <span className="font-mono text-xs">{result.publicIp}</span>
                </li>
              )}
            </ul>
            <div className={`flex gap-2 rounded-lg border p-3 ${result.probablyBanned ? "border-warn/50 bg-warn/10" : "border-border bg-panel"}`}>
              <ShieldAlert size={16} className={`mt-0.5 shrink-0 ${result.probablyBanned ? "text-warn" : "text-muted"}`} />
              <div className="flex flex-col gap-2">
                <p className="font-medium">{result.verdict}</p>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-muted">
                  {result.advice.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            </div>
            {result.probablyBanned && unban && (
              <Button
                size="sm"
                className="self-start"
                icon={<Copy size={13} />}
                onClick={() => {
                  void navigator.clipboard.writeText(unban);
                  notify("Commande de déblocage copiée", "success");
                }}
              >
                Copier la commande de déblocage
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
