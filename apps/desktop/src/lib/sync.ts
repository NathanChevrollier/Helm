// Synchronisation des réglages avec les autres PC : au démarrage, toutes les 5 minutes et sur demande.
import { create } from "zustand";
import { api, errorMessage, type SyncOutcome } from "./api";
import { useApp } from "./store";

const INTERVAL_MS = 5 * 60_000;

interface SyncState {
  running: boolean;
  lastError: string | null;
  last: SyncOutcome | null;
}

export const useSync = create<SyncState>(() => ({ running: false, lastError: null, last: null }));

/**
 * Synchronise si c'est configuré. En automatique, une erreur reste discrète (visible dans les
 * réglages) ; lancée à la main, elle est affichée.
 */
export async function runSync(manual = false): Promise<SyncOutcome | null> {
  if (useSync.getState().running) return null;
  const { notify, refreshServers } = useApp.getState();
  try {
    const cfg = await api.syncGet();
    if (cfg.mode === "off" || !cfg.hasPassphrase) {
      if (manual) notify("Synchronisation non configurée (Réglages → Préférences).", "info");
      return null;
    }
    useSync.setState({ running: true });
    const out = await api.syncNow();
    useSync.setState({ last: out, lastError: null });
    if (out.action === "pulled" || out.action === "merged") {
      await refreshServers();
      // La banque d'identifiants se recharge à l'ouverture de la page Serveurs.
      const { useIdentities } = await import("../components/Identities");
      void useIdentities.getState().reload();
      notify("Réglages synchronisés depuis tes autres PC", "success");
    } else if (manual) {
      notify(out.action === "pushed" ? "Réglages envoyés" : "Déjà à jour", "success");
    }
    return out;
  } catch (e) {
    const msg = errorMessage(e);
    useSync.setState({ lastError: msg });
    if (manual) notify(`Synchronisation impossible : ${msg}`, "error");
    return null;
  } finally {
    useSync.setState({ running: false });
  }
}

/** Synchronisation au démarrage puis périodique, tant que l'app est ouverte. */
export function watchSync(): () => void {
  const first = setTimeout(() => void runSync(), 3000);
  const id = setInterval(() => {
    if (!document.hidden) void runSync();
  }, INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(id);
  };
}
