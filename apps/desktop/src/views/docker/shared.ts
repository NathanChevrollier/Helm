// Éléments partagés par les onglets de la page Docker.
import { useApp } from "../../lib/store";
import type { Tone } from "../../components/ui";

/**
 * Dossiers de conteneurs d'un serveur : ceux créés (même vides) et ceux déjà attribués.
 * Le classement est propre à ce PC (il ne change rien sur le serveur).
 */
export function useContainerFolders(serverId: string) {
  const assigned = useApp((s) => s.folders.containers[serverId]) ?? {};
  const created = useApp((s) => s.folders.containerFolders[serverId]) ?? [];
  const setFolders = useApp((s) => s.setFolders);
  const names = [...new Set([...created, ...Object.values(assigned)])].filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));

  const move = (containers: string[], folder: string | null) =>
    setFolders((f) => {
      const map = { ...(f.containers[serverId] ?? {}) };
      for (const name of containers) {
        if (folder) map[name] = folder;
        else delete map[name];
      }
      return { ...f, containers: { ...f.containers, [serverId]: map }, containerFolders: folder ? { ...f.containerFolders, [serverId]: [...new Set([...created, folder])] } : f.containerFolders };
    });
  const create = (name: string) => setFolders((f) => ({ ...f, containerFolders: { ...f.containerFolders, [serverId]: [...new Set([...created, name])] } }));
  const rename = (from: string, to: string) =>
    setFolders((f) => {
      const map = Object.fromEntries(Object.entries(f.containers[serverId] ?? {}).map(([k, v]) => [k, v === from ? to : v]));
      const list = [...new Set([...(f.containerFolders[serverId] ?? []).filter((x) => x !== from), to])];
      return { ...f, containers: { ...f.containers, [serverId]: map }, containerFolders: { ...f.containerFolders, [serverId]: list } };
    });
  const remove = (name: string) =>
    setFolders((f) => {
      const map = Object.fromEntries(Object.entries(f.containers[serverId] ?? {}).filter(([, v]) => v !== name));
      return { ...f, containers: { ...f.containers, [serverId]: map }, containerFolders: { ...f.containerFolders, [serverId]: (f.containerFolders[serverId] ?? []).filter((x) => x !== name) } };
    });
  return { names, folderOf: (container: string) => assigned[container] ?? "", move, create, rename, remove };
}

export function stateTone(state: string): Tone {
  return state === "running" ? "ok" : state === "restarting" || state === "paused" ? "warn" : state === "dead" ? "danger" : "muted";
}

