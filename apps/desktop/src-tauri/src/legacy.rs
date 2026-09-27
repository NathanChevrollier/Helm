//! Passage automatique des installations de la version précédente de l'application à Zenytt :
//! - au démarrage, les profils sont repris (les secrets le sont à leur première lecture) et
//!   l'ancienne application est désinstallée (Windows) ;
//! - à la première connexion à chaque serveur, ce qui y avait été installé sous l'ancien nom est
//!   repris, puis l'agent est réinstallé s'il était présent.
//!
//! Les anciens noms ne sont connus que de `zenytt_profiles::legacy` et `zenytt_core::legacy`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use zenytt_core::Connection;

use crate::store::{secrets, AuditLog, Store};

#[derive(Clone, Serialize)]
pub struct Notice {
    pub kind: &'static str,
    pub message: String,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Messages produits avant que l'interface n'écoute (reprise des profils au démarrage).
static PENDING: Mutex<Vec<Notice>> = Mutex::new(Vec::new());
/// Serveurs déjà vérifiés pendant cette session.
static CHECKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn notice(kind: &'static str, message: String) {
    let n = Notice { kind, message };
    match APP.get() {
        Some(app) => {
            let _ = app.emit("zenytt://notice", n);
        }
        None => PENDING.lock().unwrap_or_else(|e| e.into_inner()).push(n),
    }
}

/// À appeler au démarrage, avant d'ouvrir la configuration.
pub fn migrate_local(config_dir: &Path) {
    match zenytt_profiles::legacy::migrate_config(config_dir) {
        Ok(true) => {
            log::info!("profils de la version précédente repris dans {}", config_dir.display());
            notice("success", "Bienvenue dans Zenytt : tes serveurs et réglages ont été repris automatiquement.".into());
        }
        Ok(false) => {}
        Err(e) => {
            log::warn!("reprise des profils de la version précédente impossible : {e}");
            notice("error", format!("Tes anciens profils n'ont pas pu être repris : {e}"));
        }
    }
}

/// À appeler une fois l'application prête : rend l'`AppHandle` disponible et fait disparaître
/// l'ancienne application en arrière-plan.
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let product = app.config().product_name.clone().unwrap_or_else(|| "Zenytt".into());
    std::thread::spawn(move || {
        remove_previous_app(&product);
        // Cache de l'interface et journaux de l'ancienne application : rien à reprendre.
        for dir in zenytt_profiles::legacy::old_leftover_dirs() {
            if dir.exists() && std::fs::remove_dir_all(&dir).is_ok() {
                log::info!("ancien dossier supprimé : {}", dir.display());
            }
        }
    });
}

/// Messages en attente (l'interface les demande à son ouverture).
#[tauri::command]
pub fn app_notices() -> Vec<Notice> {
    std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Windows : la mise à jour installe Zenytt à côté de l'ancienne application, désinstallée ici
/// en silence (raccourcis et entrée « Applications installées » compris).
#[cfg(windows)]
fn remove_windows_app() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let key = format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{}", zenytt_profiles::legacy::OLD_PRODUCT_NAME);
    let Ok(out) =
        std::process::Command::new("reg").args(["query", &key, "/v", "UninstallString"]).creation_flags(CREATE_NO_WINDOW).output()
    else {
        return;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(uninstaller) = text.lines().find_map(|l| l.split_once("REG_SZ")).map(|(_, v)| v.trim().trim_matches('"').to_string()) else {
        return;
    };
    if !Path::new(&uninstaller).is_file() {
        return;
    }
    log::info!("désinstallation de l'ancienne application ({uninstaller})");
    match std::process::Command::new(&uninstaller).arg("/S").creation_flags(CREATE_NO_WINDOW).status() {
        // Le désinstalleur se relance depuis un dossier temporaire : on lui laisse le temps de finir
        // avant de supprimer les dossiers restants.
        Ok(s) if s.success() => std::thread::sleep(std::time::Duration::from_secs(10)),
        Ok(s) => log::warn!("désinstallation de l'ancienne application : code {:?}", s.code()),
        Err(e) => log::warn!("désinstallation de l'ancienne application impossible : {e}"),
    }
}

/// macOS : la mise à jour remplace l'application sur place, dans le bundle qui porte encore
/// l'ancien nom : il est renommé (effet au prochain lancement). Un autre exemplaire de l'ancienne
/// application dans « Applications » est supprimé.
fn remove_macos_app(product: &str) {
    use zenytt_profiles::legacy;

    let current = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf));
    if let Some(bundle) = &current {
        let name = bundle.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(new_name) = legacy::renamed_file(&name, product) {
            let target = bundle.with_file_name(new_name);
            if !target.exists() {
                match std::fs::rename(bundle, &target) {
                    Ok(()) => log::info!("application renommée : {}", target.display()),
                    Err(e) => log::warn!("renommage de {} impossible : {e}", bundle.display()),
                }
            }
        }
    }
    for old in legacy::old_app_bundles() {
        if current.as_deref() != Some(old.as_path()) && legacy::is_old_bundle(&old) && std::fs::remove_dir_all(&old).is_ok() {
            log::info!("ancienne application supprimée : {}", old.display());
        }
    }
}

/// Linux : une AppImage mise à jour garde son ancien nom de fichier (renommée ici) ; un paquet
/// .deb ou .rpm installe Zenytt à côté de l'ancien paquet, désinstallé ici (le système demande
/// le mot de passe administrateur, et réessaie au prochain lancement en cas de refus).
fn remove_linux_app(product: &str) {
    use std::process::Command;
    use zenytt_profiles::legacy;

    if let Some(image) = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from) {
        let name = image.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(new_name) = legacy::renamed_file(&name, product) {
            let target = image.with_file_name(new_name);
            if !target.exists() && std::fs::rename(&image, &target).is_ok() {
                log::info!("AppImage renommée : {}", target.display());
            }
        }
        return;
    }
    let installed = |cmd: &str, args: &[&str], expect: &str| {
        Command::new(cmd).args(args).output().is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains(expect))
    };
    let removal = if installed("dpkg-query", &["-W", "-f=${Status}", legacy::OLD_PACKAGE], "install ok installed") {
        Some(["dpkg", "-r", legacy::OLD_PACKAGE])
    } else if installed("rpm", &["-q", legacy::OLD_PACKAGE], legacy::OLD_PACKAGE) {
        Some(["rpm", "-e", legacy::OLD_PACKAGE])
    } else {
        None
    };
    if let Some(args) = removal {
        log::info!("désinstallation de l'ancien paquet {}", legacy::OLD_PACKAGE);
        match Command::new("pkexec").args(args).status() {
            Ok(s) if s.success() => log::info!("ancien paquet désinstallé"),
            Ok(s) => log::warn!("désinstallation de l'ancien paquet : code {:?}", s.code()),
            Err(e) => log::warn!("désinstallation de l'ancien paquet impossible : {e}"),
        }
    }
}

/// Le code de chaque système est compilé partout (donc vérifié), mais n'est exécuté que sur le sien.
fn remove_previous_app(product: &str) {
    #[cfg(windows)]
    remove_windows_app();
    if cfg!(target_os = "macos") {
        remove_macos_app(product);
    }
    if cfg!(target_os = "linux") {
        remove_linux_app(product);
    }
}

/// À appeler après chaque nouvelle connexion : vérifie une fois par session si le serveur a
/// encore des éléments installés sous l'ancien nom, et les reprend en arrière-plan.
pub fn on_connect(server_id: &str, conn: &Connection) {
    let Some(app) = APP.get().cloned() else { return };
    if !CHECKED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(server_id.to_string()) {
        return;
    }
    let (id, conn) = (server_id.to_string(), conn.clone());
    tauri::async_runtime::spawn(async move { migrate_server(app, id, conn).await });
}

async fn migrate_server(app: AppHandle, id: String, conn: Connection) {
    use zenytt_core::legacy;

    let store = app.state::<Store>();
    let audit = app.state::<AuditLog>();
    let name = store.server(&id).map(|s| s.name).unwrap_or_default();

    if let Ok(renamed) = legacy::rename_tmux_sessions(&conn).await {
        for line in renamed {
            log::info!("[{name}] {line}");
        }
    }
    if !matches!(legacy::needs_migration(&conn).await, Ok(true)) {
        return;
    }
    let sudo = secrets::get(&id, "sudo");
    let report = match legacy::migrate(&conn, sudo.as_deref()).await {
        Ok(r) => r,
        Err(e) => {
            // Sans droits root (mot de passe sudo absent), on réessaiera à la prochaine connexion.
            CHECKED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).remove(&id);
            log::warn!("[{name}] reprise de l'ancienne installation : {e}");
            audit.record(&id, &name, "migration.serveur", "", Err(&e.to_string()));
            notice(
                "error",
                format!("« {name} » : la mise à jour du serveur pour Zenytt demande les droits administrateur. Enregistre le mot de passe sudo dans son profil, puis reconnecte-toi."),
            );
            return;
        }
    };
    let mut lines = report.lines;
    if report.reinstall_agent {
        match crate::commands::monitoring::install_agent(&conn, sudo.as_deref()).await {
            Ok(_) => lines.push("agent de supervision réinstallé".into()),
            Err(e) => lines.push(format!("agent de supervision à réinstaller (page Supervision) : {e}")),
        }
    }
    for line in &lines {
        log::info!("[{name}] {line}");
    }
    audit.record(&id, &name, "migration.serveur", &lines.join(" ; "), Ok(()));
    notice("success", format!("« {name} » a été mis à jour pour Zenytt ({} élément(s) repris).", lines.len()));
}
