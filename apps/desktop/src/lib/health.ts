// État de santé des serveurs (métriques, alertes, conteneurs, certificats), partagé entre l'Accueil,
// les badges de la barre latérale et les notifications d'alerte. Avant, chacun interrogeait le
// serveur de son côté : le même `dashboard_summary` partait deux fois par minute.
import { create } from "zustand";
import { api, type DashboardSummary } from "./api";

interface HealthState {
  summaries: Record<string, DashboardSummary>;
  /** Horodatage (ms) de la dernière réponse, par serveur. */
  at: Record<string, number>;
  set: (id: string, s: DashboardSummary) => void;
  forget: (id: string) => void;
}

export const useHealth = create<HealthState>((set) => ({
  summaries: {},
  at: {},
  set: (id, s) => set((st) => ({ summaries: { ...st.summaries, [id]: s }, at: { ...st.at, [id]: Date.now() } })),
  forget: (id) =>
    set((st) => {
      const summaries = { ...st.summaries };
      const at = { ...st.at };
      delete summaries[id];
      delete at[id];
      return { summaries, at };
    }),
}));

const inflight = new Map<string, Promise<DashboardSummary>>();

/**
 * Résumé d'un serveur. Deux appels simultanés partagent la même requête, et une réponse de moins
 * de `maxAgeMs` est réutilisée telle quelle.
 */
export function fetchHealth(serverId: string, maxAgeMs = 10_000): Promise<DashboardSummary> {
  const { summaries, at } = useHealth.getState();
  const cached = summaries[serverId];
  if (cached && Date.now() - (at[serverId] ?? 0) < maxAgeMs) return Promise.resolve(cached);
  const pending = inflight.get(serverId);
  if (pending) return pending;
  const p = api
    .dashboardSummary(serverId)
    .catch((e) => ({ connected: false, error: String(e) }) as DashboardSummary)
    .then((s) => {
      useHealth.getState().set(serverId, s);
      return s;
    })
    .finally(() => inflight.delete(serverId));
  inflight.set(serverId, p);
  return p;
}

/** Nombres affichés en badge dans la barre latérale pour un serveur. */
export function badgesOf(s: DashboardSummary | undefined): { alerts: number; stopped: number; certs: number } {
  if (!s?.connected) return { alerts: 0, stopped: 0, certs: 0 };
  const soon = Date.now() / 1000 + 21 * 86_400;
  return {
    alerts: s.alerts?.length ?? 0,
    stopped: s.containersStopped ?? 0,
    certs: (s.certificates ?? []).filter((c) => c.notAfter < soon).length,
  };
}
