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

/// Historique des commandes du shell de l'utilisateur (bash et zsh), le plus récent d'abord,
/// sans doublons. Lu seulement sur demande (palette Ctrl+K), jamais conservé par Helm.
#[tauri::command]
pub async fn shell_history(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<String>, String> {
    if !sessions.is_connected(&server_id).await {
        return Ok(vec![]);
    }
    let conn = sessions.get(&store, &server_id).await?;
    let out = conn
        .exec("for f in \"$HOME/.bash_history\" \"$HOME/.zsh_history\"; do [ -r \"$f\" ] && tail -n 3000 \"$f\"; done", None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_history(&out.stdout))
}

fn parse_history(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in text.lines().rev() {
        // zsh (EXTENDED_HISTORY) : « : 1700000000:0;commande » ; bash (HISTTIMEFORMAT) : « #1700000000 ».
        let cmd = match line.strip_prefix(": ") {
            Some(rest) if rest.contains(';') => rest.split_once(';').map(|x| x.1).unwrap_or(rest),
            _ => line,
        }
        .trim();
        if cmd.is_empty() || (cmd.starts_with('#') && cmd[1..].chars().all(|c| c.is_ascii_digit())) {
            continue;
        }
        if seen.insert(cmd.to_string()) {
            out.push(cmd.to_string());
            if out.len() >= 500 {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn history() {
        let h = super::parse_history("ls\n#1700000000\ndocker ps\n: 1700000001:0;htop\nls\n");
        assert_eq!(h, vec!["ls", "htop", "docker ps"]);
    }
}
