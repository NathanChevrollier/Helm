import { useApp } from "../lib/store";

/** Demande un nom de dossier (création ou renommage). `null` si annulé ou vide. */
export async function askFolderName(title: string, initial = ""): Promise<string | null> {
  const v = await useApp.getState().ask({ title, input: { label: "Nom du dossier", initial }, confirmLabel: "Valider" });
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Bascule l'état replié d'un dossier (`key` unique, ex. `servers:Prod`). */
export function toggleCollapsed(key: string) {
  useApp.getState().setFolders((f) => ({
    ...f,
    collapsed: f.collapsed.includes(key) ? f.collapsed.filter((k) => k !== key) : [...f.collapsed, key],
  }));
}

