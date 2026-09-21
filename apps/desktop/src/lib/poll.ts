import { useEffect, useRef, type DependencyList } from "react";

/**
 * Exécute `task` tout de suite puis toutes les `intervalMs` millisecondes, tant que `enabled`.
 * - Jamais deux exécutions en même temps : si la précédente n'est pas finie, le tour est sauté.
 * - En pause quand la fenêtre est réduite ou masquée ; reprise immédiate à son retour.
 * `deps` relance le cycle (changement de serveur…). `task` gère lui-même ses erreurs.
 */
export function usePolling(task: () => Promise<unknown> | void, intervalMs: number, deps: DependencyList, enabled = true) {
  const ref = useRef(task);
  ref.current = task;

  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    let stopped = false;
    const tick = async () => {
      if (busy || stopped || document.hidden) return;
      busy = true;
      try {
        await ref.current();
      } catch {
        /* erreurs traitées par la tâche */
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, ...deps]);
}
