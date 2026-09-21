//! Terminaux interactifs.

use tauri::ipc::Channel;
use tauri::State;

use crate::sessions::{Sessions, TermEvent};
use crate::store::Store;

#[tauri::command]
pub async fn term_open(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    cols: u32,
    rows: u32,
    command: Option<String>,
    tmux_session: Option<String>,
    on_event: Channel<TermEvent>,
) -> Result<u64, String> {
    let conn = sessions.get(&store, &server_id).await?;
    // Une session tmux remplace le shell : elle survit aux coupures et à la fermeture de l'app.
    let command = match (command, tmux_session) {
        (Some(c), _) => Some(c),
        (None, Some(name)) => Some(helm_core::tmux::attach_command(&name).map_err(|e| e.to_string())?),
        (None, None) => None,
    };
    sessions.open_terminal(&conn, cols, rows, command, on_event).await
}

#[tauri::command]
pub async fn term_write(sessions: State<'_, Sessions>, id: u64, data: String) -> Result<(), String> {
    sessions.write_terminal(id, data.as_bytes()).await
}

#[tauri::command]
pub async fn term_resize(sessions: State<'_, Sessions>, id: u64, cols: u32, rows: u32) -> Result<(), String> {
    sessions.resize_terminal(id, cols, rows).await
}

#[tauri::command]
pub async fn term_close(sessions: State<'_, Sessions>, id: u64) -> Result<(), String> {
    sessions.close_terminal(id).await;
    Ok(())
}
