import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage } from "./api";
import { useApp } from "./store";

let running = false;

/**
 * Cherche une nouvelle version sur les releases GitHub (latest.json signé par la CI) et propose de
 * l'installer. Au démarrage (`manual` faux), les erreurs réseau sont ignorées en silence.
 */
export async function checkForUpdate(manual = false): Promise<void> {
  if (running) return;
  running = true;
  const { ask, notify } = useApp.getState();
  try {
    const update = await check();
    if (!update) {
      if (manual) notify("Helm est à jour.");
      return;
    }
    const notes = update.body?.trim();
    const ok = await ask({
      title: `Helm ${update.version} est disponible`,
      body: `Version installée : ${update.currentVersion}. Helm redémarrera après l'installation.${notes ? `\n\n${notes}` : ""}`,
      confirmLabel: "Installer et redémarrer",
    });
    if (!ok) return;
    notify(`Téléchargement de Helm ${update.version}…`);
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    if (manual) notify(`Mise à jour impossible : ${errorMessage(e)}`, "error");
    else console.warn("Vérification des mises à jour", e);
  } finally {
    running = false;
  }
}
