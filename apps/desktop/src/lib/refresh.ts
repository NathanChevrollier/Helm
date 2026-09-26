// Actualisation des données affichées : globale (bouton de l'en-tête, F5) et automatique
// (toutes les N secondes, réglable), pour que l'état des conteneurs, sites, fichiers… reste à jour.
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useApp } from "./store";
import { useLock } from "./lock";

interface RefreshState {
  /** Incrémenté à chaque demande d'actualisation globale. */
  tick: number;
  bump: () => void;
}

export const useRefresh = create<RefreshState>((set) => ({
  tick: 0,
  bump: () => set((s) => ({ tick: s.tick + 1 })),
}));

/** Actualise tout : liste des serveurs (état de connexion) et page affichée. */
export function refreshAll() {
  void useApp.getState().refreshServers().catch(() => {});
  useRefresh.getState().bump();
}

/**
 * Relance `load` à chaque actualisation globale et, si `auto`, toutes les `autoRefreshSecs`
 * secondes (fenêtre visible, serveur déjà connecté : jamais de connexion ni de dialogue provoqués
 * en arrière-plan). Le premier chargement reste à la charge de la page. `load` reçoit `true` pour
 * une actualisation automatique : à elle de rester discrète (pas d'erreur affichée, sélection gardée…).
 */
export function useAutoRefresh(load: (auto: boolean) => unknown, opts: { serverId?: string; auto?: boolean; enabled?: boolean } = {}) {
  const { serverId, auto = true, enabled = true } = opts;
  const ref = useRef(load);
  ref.current = load;
  const tick = useRefresh((s) => s.tick);
  const seen = useRef(tick);
  const secs = useApp((s) => s.settings.autoRefreshSecs);
  const connected = useApp((s) => (serverId ? (s.servers.find((x) => x.id === serverId)?.connected ?? false) : true));

  useEffect(() => {
    if (tick === seen.current) return;
    seen.current = tick;
    if (enabled) void ref.current(false);
  }, [tick, enabled]);

  useEffect(() => {
    if (!auto || !enabled || !connected || secs <= 0) return;
    let busy = false;
    const id = setInterval(async () => {
      if (busy || document.hidden || useLock.getState().locked) return;
      busy = true;
      try {
        await ref.current(true);
      } catch {
        /* erreurs traitées par la page */
      } finally {
        busy = false;
      }
    }, secs * 1000);
    return () => clearInterval(id);
  }, [auto, enabled, connected, secs]);
}
