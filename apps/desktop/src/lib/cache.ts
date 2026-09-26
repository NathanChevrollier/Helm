import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/** Dernières données de chaque page, gardées en mémoire tant que l'app est ouverte. */
const memory = new Map<string, unknown>();

/**
 * `useState` dont la valeur survit au démontage : en revenant sur une page, les données
 * précédentes s'affichent tout de suite pendant que la page les recharge.
 * `key` doit inclure le serveur (ex. `docker:${serverId}`).
 */
export function useCachedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        memory.set(key, v);
        return v;
      }),
    [key],
  );
  return [value, set];
}

/** Oublie les données d'un serveur (profil supprimé). */
export function forgetCached(serverId: string) {
  for (const k of memory.keys()) if (k.endsWith(`:${serverId}`)) memory.delete(k);
}

/** Dernière valeur connue d'une clé, hors composant (palette, raccourcis). */
export function peekCached<T>(key: string): T | undefined {
  return memory.get(key) as T | undefined;
}
