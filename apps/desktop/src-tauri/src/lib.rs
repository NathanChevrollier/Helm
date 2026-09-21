// Les commandes Tauri reçoivent chaque état partagé en paramètre : leur nombre dépasse vite 7.
#![allow(clippy::too_many_arguments)]

mod commands;
mod sessions;
mod store;

use commands::{backups, dashboard, deploy, docker, files, logs, monitoring, security, servers, sites, terminal, tunnels, workspace};
use tauri::Manager;

/// Renvoie la version de l'app, utilisée par l'UI pour vérifier que le pont Rust fonctionne.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Une seule instance : une deuxième fenêtre se disputerait les ports des tunnels et
        // écraserait les réglages de la première. Relancer Helm ramène la fenêtre existante.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(store::Store::open(&dir));
            app.manage(store::AuditLog::new(&dir, "app"));
            app.manage(sessions::Sessions::new());
            app.manage(monitoring::Monitor::default());
            app.manage(docker::DockerAccess::default());
            app.manage(files::Transfers::default());
            app.manage(dashboard::DashboardCache::default());
            app.manage(tunnels::Tunnels::default());
            app.manage(logs::LogStreams::default());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<tunnels::Tunnels>().autostart(&handle).await;
            });
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
            servers::server_set_ai_access,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            files::fs_home,
            files::fs_list,
            files::fs_read,
            files::fs_write,
            files::fs_stat,
            files::fs_mkdir,
            files::fs_create,
            files::fs_rename,
            files::fs_remove,
            files::fs_chmod,
            files::fs_download,
            files::fs_upload,
            files::fs_cancel,
            files::fs_copy_between,
            monitoring::mon_metrics,
            monitoring::mon_processes,
            monitoring::mon_kill,
            monitoring::mon_services,
            monitoring::mon_service_action,
            monitoring::mon_service_logs,
            monitoring::agent_info,
            monitoring::agent_history,
            monitoring::agent_install,
            monitoring::agent_uninstall,
            monitoring::agent_save_config,
            monitoring::agent_test_notify,
            docker::docker_overview,
            docker::docker_stats,
            docker::docker_container_action,
            docker::docker_inspect,
            docker::docker_logs,
            docker::docker_compose_action,
            docker::docker_compose_command,
            docker::docker_storage,
            docker::docker_remove_image,
            docker::docker_prune,
            docker::docker_restrict_preview,
            docker::docker_restrict_apply,
            sites::sites_state,
            sites::sites_read,
            sites::sites_write,
            sites::sites_set_enabled,
            sites::sites_delete,
            sites::sites_test,
            sites::sites_reload,
            sites::sites_plan,
            sites::sites_resolve,
            sites::sites_create_app,
            sites::sites_certbot,
            sites::sites_renew,
            sites::sites_check,
            sites::sites_preview,
            workspace::ui_state_get,
            workspace::ui_state_set,
            workspace::store_warning,
            workspace::app_lock_get,
            workspace::app_lock_set,
            workspace::audit_list,
            workspace::tmux_check,
            workspace::tmux_install,
            workspace::tmux_sessions,
            workspace::tmux_kill,
            workspace::mcp_config,
            workspace::save_text_file,
            dashboard::dashboard_summary,
            tunnels::tunnels_list,
            tunnels::tunnel_save,
            tunnels::tunnel_delete,
            tunnels::tunnel_start,
            tunnels::tunnel_stop,
            tunnels::tunnel_free_port,
            logs::logs_sources,
            logs::logs_start,
            logs::logs_stop,
            sites::nginx_backups,
            sites::nginx_backup_diff,
            sites::nginx_backup_restore,
            security::security_audit,
            security::security_fix_plan,
            security::security_fix_apply,
            backups::backup_overview,
            backups::backup_save,
            backups::backup_snapshots,
            backups::backup_list,
            backups::backup_restore,
            backups::backup_put_back,
            backups::backup_import_dump,
            backups::backup_stage_download,
            backups::backup_check,
            deploy::deploy_suggest_host,
            deploy::deploy_prepare,
            deploy::deploy_keys,
            deploy::deploy_key_create,
            deploy::deploy_key_revoke,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
