// Presse-papiers du système. L'API du navigateur échoue dans la webview selon le focus de la
// fenêtre (lecture refusée sans geste, document non focalisé…) : on passe par le plugin Tauri,
// qui lit et écrit côté Rust, et on garde l'API du navigateur en secours.
import { readText as pluginRead, writeText as pluginWrite } from "@tauri-apps/plugin-clipboard-manager";

export async function writeClipboard(text: string): Promise<void> {
  try {
    await pluginWrite(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

/** Contenu texte du presse-papiers ; chaîne vide s'il est vide ou illisible. */
export async function readClipboard(): Promise<string> {
  try {
    return (await pluginRead()) ?? "";
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }
}
