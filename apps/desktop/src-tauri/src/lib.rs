mod commands;
mod sessions;
mod store;

use commands::{files, servers, terminal};
use tauri::Manager;

/// Renvoie la version de l'app, utilisée par l'UI pour vérifier que le pont Rust fonctionne.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(store::Store::load(dir));
            app.manage(sessions::Sessions::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            servers::servers_list,
            servers::server_save,
            servers::server_delete,
            servers::host_trust,
            servers::ssh_connect,
            servers::ssh_disconnect,
            servers::snippets_list,
            servers::snippet_save,
            servers::snippet_delete,
            servers::putty_sessions,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            files::fs_home,
            files::fs_list,
            files::fs_read,
            files::fs_write,
            files::fs_mkdir,
            files::fs_create,
            files::fs_rename,
            files::fs_remove,
            files::fs_chmod,
            files::fs_download,
            files::fs_upload,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
