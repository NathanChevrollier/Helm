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
        // Onglet ouvert sur une commande (mises à jour, journal…) : elle est lancée par un shell
        // qui annonce son PID, sinon Helm perdrait le dossier courant de cet onglet.
        (Some(c), _) => Some(announcing_pid(&c)),
        (None, Some(name)) => Some(helm_core::tmux::attach_command(&name).map_err(|e| e.to_string())?),
        // Shell simple : il annonce son PID (séquence OSC ignorée par l'affichage) pour que
        // Helm retrouve son dossier courant (panneau Fichiers, glisser-déposer).
        (None, None) => Some(announcing_pid(LOGIN_SHELL)),
    };
    sessions.open_terminal(&conn, cols, rows, command, on_event).await
}

/// Shell de connexion de l'utilisateur (`exec` : il garde le PID annoncé).
const LOGIN_SHELL: &str = r#"exec "${SHELL:-/bin/sh}" -l"#;

/// Fait précéder une commande de la séquence OSC privée 7770, qui transmet à l'interface le PID
/// du shell qui l'exécute (séquence ignorée par l'affichage). Helm retrouve ensuite le dossier
/// courant de cet onglet via `/proc`, y compris quand un programme y tourne au premier plan.
fn announcing_pid(command: &str) -> String {
    let script = format!(r#"printf "\033]7770;%s\007" "$$"; {command}"#);
    format!("exec sh -c '{}'", script.replace('\'', r"'\''"))
}

/// Dossier de travail d'un ou plusieurs processus : celui du programme au premier plan du
/// terminal (après un `cd` dans un éditeur, par exemple), sinon celui du shell lui-même.
fn cwd_of_pids(pids: &[u32]) -> String {
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");
    format!(
        "for base in {list}; do \
           for p in $(ps -o tpgid= -p $base 2>/dev/null) $base; do \
             d=$(readlink /proc/$p/cwd 2>/dev/null); \
             [ -n \"$d\" ] && {{ echo \"$d\"; exit 0; }}; \
           done; \
         done; true"
    )
}

/// Dossier courant d'un terminal. Plusieurs pistes sont tentées dans l'ordre : le panneau tmux,
/// le PID annoncé par le shell, puis le PID du panneau tmux. `None` si aucune n'aboutit
/// (serveur déconnecté, système sans /proc, terminal lancé sur une commande).
#[tauri::command]
pub async fn term_cwd(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    tmux_session: Option<String>,
    pid: Option<u32>,
) -> Result<Option<String>, String> {
    if !sessions.is_connected(&server_id).await {
        return Ok(None);
    }
    if tmux_session.is_none() && pid.is_none() {
        return Ok(None);
    }
    let conn = sessions.get(&store, &server_id).await?;

    if let Some(name) = tmux_session {
        let cmd = helm_core::tmux::pane_path_command(&name).map_err(|e| e.to_string())?;
        let out = conn.exec(&cmd, None).await.map_err(|e| e.to_string())?;
        let mut lines = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty());
        // Première ligne : le chemin donné par tmux ; deuxième : le PID du panneau, pour /proc.
        let path = lines.next().unwrap_or_default();
        if path.starts_with('/') {
            return Ok(Some(path.to_string()));
        }
        if let Some(pane_pid) = lines.next().and_then(|p| p.parse::<u32>().ok()) {
            let out = conn.exec(&cwd_of_pids(&[pane_pid]), None).await.map_err(|e| e.to_string())?;
            let path = out.stdout.lines().next().unwrap_or_default().trim().to_string();
            return Ok(path.starts_with('/').then_some(path));
        }
        return Ok(None);
    }

    let out = conn.exec(&cwd_of_pids(&[pid.unwrap_or(0)]), None).await.map_err(|e| e.to_string())?;
    let path = out.stdout.lines().next().unwrap_or_default().trim().to_string();
    Ok(path.starts_with('/').then_some(path))
}

/// Fait défiler l'historique d'une session tmux (molette de la souris dans le terminal).
#[tauri::command]
pub async fn tmux_scroll(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    session: String,
    up: bool,
    lines: u32,
) -> Result<(), String> {
    if !sessions.is_connected(&server_id).await {
        return Ok(());
    }
    let conn = sessions.get(&store, &server_id).await?;
    let cmd = helm_core::tmux::scroll_command(&session, up, lines).map_err(|e| e.to_string())?;
    conn.exec(&cmd, None).await.map_err(|e| e.to_string())?;
    Ok(())
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
    use super::{announcing_pid, LOGIN_SHELL};

    #[test]
    fn annonce_le_pid_avant_le_shell() {
        let c = announcing_pid(LOGIN_SHELL);
        assert!(c.starts_with("exec sh -c 'printf "), "{c}");
        assert!(c.contains("7770"), "{c}");
        assert!(c.contains(r#"exec "${SHELL:-/bin/sh}" -l"#), "{c}");
    }

    #[test]
    fn protege_les_apostrophes_de_la_commande() {
        let c = announcing_pid("echo 'salut'; exec \"$SHELL\" -l");
        // Aucune apostrophe de la commande ne doit fermer la chaîne du `sh -c`.
        assert!(c.contains(r"'\''salut'\''"), "{c}");
        assert!(c.ends_with("-l'"), "{c}");
    }

    #[test]
    fn history() {
        let h = super::parse_history("ls\n#1700000000\ndocker ps\n: 1700000001:0;htop\nls\n");
        assert_eq!(h, vec!["ls", "htop", "docker ps"]);
    }
}
