//! Espace de travail : état de l'interface, journal d'actions et sessions tmux.

use helm_core::tmux::{self, Session};
use helm_profiles::audit::Entry;
use tauri::State;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub fn ui_state_get(store: State<'_, Store>) -> serde_json::Value {
    store.read(|d| d.ui_state.clone())
}

/// Ouvre le dossier des journaux de Helm dans l'explorateur.
#[tauri::command]
pub fn logs_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<String>).map_err(|e| e.to_string())
}

/// Helm est verrouillé. Gardé côté Rust : recharger l'interface (F5) ne déverrouille pas.
static LOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Empreinte du mot de passe de verrouillage de l'app (PBKDF2, calculée par l'interface),
/// conservée dans le coffre de l'OS. `None` : verrouillage désactivé.
#[tauri::command]
pub fn app_lock_get() -> Option<String> {
    crate::store::secrets::get("app", "lock")
}

#[tauri::command]
pub fn app_lock_set(hash: String) -> Result<(), String> {
    if LOCKED.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Helm est verrouillé".into());
    }
    crate::store::secrets::set("app", "lock", &hash)
}

/// État du verrouillage (relu au démarrage de l'interface).
#[tauri::command]
pub fn app_is_locked() -> bool {
    LOCKED.load(std::sync::atomic::Ordering::SeqCst) && crate::store::secrets::get("app", "lock").is_some()
}

#[tauri::command]
pub fn app_lock_engage() {
    if crate::store::secrets::get("app", "lock").is_some() {
        LOCKED.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Déverrouille si le mot de passe correspond à l'empreinte PBKDF2 enregistrée (format de
/// l'interface : `pbkdf2$itérations$sel$empreinte`, en base64).
#[tauri::command]
pub async fn app_unlock(password: String) -> bool {
    let Some(stored) = crate::store::secrets::get("app", "lock") else {
        LOCKED.store(false, std::sync::atomic::Ordering::SeqCst);
        return true;
    };
    let ok = verify_lock_password(&password, &stored);
    if ok {
        LOCKED.store(false, std::sync::atomic::Ordering::SeqCst);
    } else {
        // Freine les essais au hasard.
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
    ok
}

fn verify_lock_password(password: &str, stored: &str) -> bool {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let parts: Vec<&str> = stored.split('$').collect();
    let [kind, iter, salt, hash] = parts.as_slice() else { return false };
    let (Ok(iter), Ok(salt), Ok(hash)) = (iter.parse::<u32>(), b64.decode(salt), b64.decode(hash)) else { return false };
    let Some(iter) = std::num::NonZeroU32::new(iter) else { return false };
    *kind == "pbkdf2" && ring::pbkdf2::verify(ring::pbkdf2::PBKDF2_HMAC_SHA256, iter, &salt, password.as_bytes(), &hash).is_ok()
}

/// Problème rencontré au chargement de la configuration, à afficher au démarrage.
#[tauri::command]
pub fn store_warning(store: State<'_, Store>) -> Option<String> {
    store.warning()
}

#[tauri::command]
pub fn ui_state_set(store: State<'_, Store>, state: serde_json::Value) -> Result<(), String> {
    store.write(|d| d.ui_state = state)
}

#[tauri::command]
pub fn audit_list(audit: State<'_, AuditLog>, limit: usize) -> Vec<Entry> {
    audit.recent(limit.min(5000))
}

/// Version de tmux installée, ou `None`.
#[tauri::command]
pub async fn tmux_check(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Option<String>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    tmux::available(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn tmux_install(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        tmux::install(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "tmux.install", "", r)
}

#[tauri::command]
pub async fn tmux_sessions(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Session>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    tmux::sessions(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn tmux_kill(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    name: String,
) -> Result<(), String> {
    let r = async {
        let conn = sessions.get(&store, &server_id).await?;
        tmux::kill(&conn, &name).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "tmux.kill", &name, r)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    command: String,
    claude_desktop: String,
    claude_code: String,
}

/// Configuration à copier dans Claude Desktop / Claude Code pour brancher le serveur MCP de Helm.
#[tauri::command]
pub fn mcp_config() -> Result<McpConfig, String> {
    let exe = std::env::current_exe().map_err(err)?.display().to_string();
    let desktop = serde_json::json!({ "mcpServers": { "helm": { "command": exe, "args": ["--mcp"] } } });
    Ok(McpConfig {
        claude_desktop: serde_json::to_string_pretty(&desktop).map_err(err)?,
        claude_code: format!("claude mcp add helm -- \"{exe}\" --mcp"),
        command: exe,
    })
}

/// Écrit un fichier texte sur le PC (chemin choisi par l'utilisateur dans la boîte de dialogue native).
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(err)
}

/// Exporte les réglages dans un fichier (chiffré si un mot de passe est donné).
#[tauri::command]
pub fn settings_export(store: State<'_, Store>, path: String, password: String, include_secrets: bool) -> Result<(), String> {
    let text = helm_profiles::export::export(&store, &password, include_secrets)?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    log::info!("réglages exportés vers {path} (chiffré : {}, secrets : {include_secrets})", !password.is_empty());
    Ok(())
}

/// Le fichier à importer est-il chiffré ?
#[tauri::command]
pub fn settings_import_encrypted(path: String) -> Result<bool, String> {
    helm_profiles::export::is_encrypted(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn settings_import(store: State<'_, Store>, path: String, password: String) -> Result<helm_profiles::export::ImportSummary, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let summary = helm_profiles::export::import(&store, &text, &password)?;
    log::info!("réglages importés depuis {path} : {summary:?}");
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    #[test]
    fn lock_password_format() {
        // Même format que lib/lock.ts : pbkdf2$itérations$sel$empreinte (base64).
        let b64 = base64::engine::general_purpose::STANDARD;
        let salt = [7u8; 16];
        let mut hash = [0u8; 32];
        ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, std::num::NonZeroU32::new(1000).unwrap(), &salt, b"secret", &mut hash);
        let stored = format!("pbkdf2$1000${}${}", b64.encode(salt), b64.encode(hash));
        assert!(super::verify_lock_password("secret", &stored));
        assert!(!super::verify_lock_password("Secret", &stored));
        assert!(!super::verify_lock_password("secret", "n'importe quoi"));
    }
}
