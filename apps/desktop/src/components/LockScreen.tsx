import { useEffect, useRef, useState } from "react";
import { Lock, ShipWheel } from "lucide-react";
import { useLock } from "../lib/lock";
import { Button, Input } from "./ui";

/** Écran de verrouillage : recouvre toute l'interface et capte le clavier tant qu'il est affiché. */
export default function LockScreen() {
  const unlock = useLock((s) => s.unlock);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    // Le focus ne doit pas pouvoir revenir sur un terminal resté derrière.
    const keep = () => setTimeout(() => input.current?.focus(), 0);
    window.addEventListener("focusin", keep);
    return () => window.removeEventListener("focusin", keep);
  }, []);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    const ok = await unlock(password);
    setBusy(false);
    if (!ok) {
      setError(true);
      setPassword("");
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-bg" onKeyDownCapture={(e) => e.stopPropagation()}>
      <form
        className="flex w-80 flex-col items-center gap-4 rounded-lg border border-border bg-panel p-8"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ShipWheel size={32} className="text-accent" />
        <div className="text-center">
          <h1 className="flex items-center justify-center gap-2 text-lg font-semibold">
            <Lock size={16} /> Helm est verrouillé
          </h1>
          <p className="mt-1 text-sm text-muted">Les connexions et les terminaux continuent en arrière-plan.</p>
        </div>
        <Input
          ref={input}
          type="password"
          placeholder="Mot de passe de Helm"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(false);
          }}
        />
        {error && <p className="text-sm text-danger">Mot de passe incorrect.</p>}
        <Button variant="primary" className="w-full justify-center" loading={busy} type="submit">
          Déverrouiller
        </Button>
      </form>
    </div>
  );
}
