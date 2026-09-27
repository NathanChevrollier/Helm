//! Icône dans la zone de notification, fermeture de la fenêtre (réduire ou quitter) et lancement
//! à l'ouverture de session.
//!
//! Les décisions qui dépendent de l'état de l'interface (confirmation, activités en cours) sont
//! prises par l'interface : Rust lui signale la demande par un événement. Tant que l'interface
//! n'a pas démarré (ou si elle a planté), Rust agit seul pour que l'app reste toujours fermable.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// Argument du lancement automatique : l'app démarre réduite dans la zone de notification.
pub const HIDDEN_ARG: &str = "--hidden";
const TRAY_ID: &str = "main";

/// L'interface écoute les demandes de fermeture (sinon Rust ferme directement).
static UI_READY: AtomicBool = AtomicBool::new(false);

/// Action demandée depuis l'icône ou la fenêtre, transmise à l'interface.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayAction {
    action: &'static str,
    server_id: Option<String>,
}

/// Serveur affiché dans le menu de l'icône.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayServer {
    id: String,
    name: String,
    connected: bool,
    alerts: u32,
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window("main") {
        Some(w) if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => show_main(app),
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, action: &'static str, server_id: Option<String>) {
    let _ = app.emit("zenytt://tray", TrayAction { action, server_id });
}

/// Libellé d'un serveur dans le menu : état de connexion et alertes en cours.
pub(crate) fn server_label(name: &str, connected: bool, alerts: u32) -> String {
    let dot = if !connected {
        "○"
    } else if alerts > 0 {
        "⚠"
    } else {
        "●"
    };
    match alerts {
        0 => format!("{dot}  {name}"),
        1 => format!("{dot}  {name} — 1 alerte"),
        n => format!("{dot}  {name} — {n} alertes"),
    }
}

/// Infobulle de l'icône.
pub(crate) fn tooltip(alerts: u32) -> String {
    match alerts {
        0 => "Zenytt".into(),
        1 => "Zenytt — 1 alerte en cours".into(),
        n => format!("Zenytt — {n} alertes en cours"),
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, servers: &[TrayServer]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Ouvrir Zenytt", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if !servers.is_empty() {
        let sub = Submenu::new(app, "Serveurs", true)?;
        for s in servers {
            sub.append(&MenuItem::with_id(
                app,
                format!("server:{}", s.id),
                server_label(&s.name, s.connected, s.alerts),
                true,
                None::<&str>,
            )?)?;
        }
        menu.append(&sub)?;
    }
    menu.append(&MenuItem::with_id(app, "sync", "Synchroniser maintenant", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "lock", "Verrouiller", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quitter Zenytt", true, None::<&str>)?)?;
    Ok(menu)
}

/// Crée l'icône de la zone de notification.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(0))
        .menu(&build_menu(app, &[])?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "sync" => emit(app, "sync", None),
            "lock" => emit(app, "lock", None),
            "quit" => request_quit(app),
            id => {
                if let Some(server) = id.strip_prefix("server:") {
                    show_main(app);
                    emit(app, "server", Some(server.to_string()));
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// « Quitter » : l'interface confirme s'il reste des activités en cours ; sans interface, on quitte.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    if UI_READY.load(Ordering::Relaxed) {
        show_main(app);
        emit(app, "quit", None);
    } else {
        app.exit(0);
    }
}

/// Fermeture de la fenêtre : l'interface choisit entre réduire et quitter. Renvoie `false` quand
/// l'interface ne répond pas encore : la fenêtre se ferme alors normalement.
pub fn on_close_requested<R: Runtime>(app: &AppHandle<R>) -> bool {
    if UI_READY.load(Ordering::Relaxed) {
        emit(app, "close", None);
        true
    } else {
        false
    }
}

/// L'interface est prête à recevoir les demandes de fermeture.
#[tauri::command]
pub fn app_ui_ready() {
    UI_READY.store(true, Ordering::Relaxed);
}

/// Met à jour le menu et l'infobulle de l'icône (serveurs, état de connexion, alertes).
#[tauri::command]
pub fn tray_update(app: AppHandle, servers: Vec<TrayServer>) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("icône absente")?;
    tray.set_menu(Some(build_menu(&app, &servers).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip(servers.iter().map(|s| s.alerts).sum()))).map_err(|e| e.to_string())
}

/// Réduit dans la zone de notification.
#[tauri::command]
pub fn app_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Quitte vraiment (tunnels, terminaux et transferts compris).
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| format!("lancement au démarrage : {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_show_connection_and_alerts() {
        assert_eq!(server_label("VPS", true, 0), "●  VPS");
        assert_eq!(server_label("VPS", false, 0), "○  VPS");
        assert_eq!(server_label("VPS", true, 1), "⚠  VPS — 1 alerte");
        assert_eq!(server_label("VPS", true, 3), "⚠  VPS — 3 alertes");
        assert_eq!(tooltip(0), "Zenytt");
        assert_eq!(tooltip(2), "Zenytt — 2 alertes en cours");
    }
}
