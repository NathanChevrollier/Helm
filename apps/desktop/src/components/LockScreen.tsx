import { useEffect, useRef, useState } from "react";
import { Lock, ShipWheel } from "lucide-react";
import { useLock } from "../lib/lock";
import { Button, Input } from "./ui";

/** Après quelques échecs, chaque nouvel essai attend un peu plus : deviner au hasard devient très lent. */
const FREE_ATTEMPTS = 3;
const delayAfter = (failures: number) => (failures < FREE_ATTEMPTS ? 0 : Math.min(60, 2 ** (failures - FREE_ATTEMPTS + 1)));

/** Écran de verrouillage : recouvre toute l'interface et capte le clavier tant qu'il est affiché. */
export default function LockScreen() {
  const unlock = useLock((s) => s.unlock);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [caps, setCaps] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    // Le focus ne doit pas pouvoir revenir sur un terminal resté derrière.
    const keep = () => setTimeout(() => input.current?.focus(), 0);
    window.addEventListener("focusin", keep);
    return () => window.removeEventListener("focusin", keep);
  }, []);

  // Horloge : l'heure affichée et le décompte avant le prochain essai.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  const submit = async () => {
    if (!password || busy || wait > 0) return;
    setBusy(true);
    const ok = await unlock(password);
    setBusy(false);
    if (!ok) {
      const n = failures + 1;
      setFailures(n);
      setWaitUntil(Date.now() + delayAfter(n) * 1000);
      setNow(Date.now());
      setError(true);
      setPassword("");
    }
  };

  const clock = new Date(now);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-bg"
      style={{ backgroundImage: "radial-gradient(ellipse at 50% 30%, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent 60%)" }}
      onKeyDownCapture={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col items-center gap-6">
        <div className="text-center">
          <div className="text-5xl font-light tracking-tight tabular-nums">{clock.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div>
          <div className="mt-1 text-sm text-muted first-letter:uppercase">{clock.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
        <form
          className="flex w-80 flex-col items-center gap-4 rounded-2xl border border-border bg-panel p-7 shadow-2xl"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <ShipWheel size={26} />
          </div>
          <div className="text-center">
            <h1 className="flex items-center justify-center gap-2 text-base font-semibold">
              <Lock size={14} /> Helm est verrouillé
            </h1>
            <p className="mt-1 text-xs text-muted">Les connexions et les terminaux continuent en arrière-plan.</p>
          </div>
          <Input
            ref={input}
            type="password"
            className="h-9"
            aria-label="Mot de passe de Helm"
            placeholder="Mot de passe de Helm"
            value={password}
            onKeyUp={(e) => setCaps(e.getModifierState("CapsLock"))}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(false);
            }}
          />
          {(error || caps) && (
            <div className="-mt-2 flex w-full flex-col gap-0.5 text-xs">
              {error && <p className="text-danger">Mot de passe incorrect{failures > 1 ? ` (${failures} essais)` : ""}.</p>}
              {caps && <p className="text-warn">Verrouillage majuscules activé.</p>}
            </div>
          )}
          <Button variant="primary" className="h-9 w-full justify-center" loading={busy} disabled={wait > 0} type="submit">
            {wait > 0 ? `Nouvel essai dans ${wait} s` : "Déverrouiller"}
          </Button>
        </form>
      </div>
    </div>
  );
}
