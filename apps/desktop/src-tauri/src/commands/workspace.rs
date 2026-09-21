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
