//! Sessions persistantes : chaque onglet de terminal vit dans une session tmux `helm-…`,
//! qui survit aux coupures réseau et à la fermeture de l'app.

use serde::Serialize;

use crate::{Connection, Error, Result};

/// Préfixe des sessions créées par Helm (les autres sessions tmux de l'utilisateur ne sont pas touchées).
pub const PREFIX: &str = "helm-";

pub fn valid_session(name: &str) -> bool {
    name.starts_with(PREFIX) && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Commande d'attache (ou de création) d'une session, avec des réglages propres à cette session
/// uniquement : le `.tmux.conf` de l'utilisateur n'est jamais modifié.
pub fn attach_command(name: &str) -> Result<String> {
    if !valid_session(name) {
        return Err(Error::Other(format!("nom de session invalide : {name}")));
    }
    Ok(format!(
        "tmux new-session -A -s {name} \\; set-option -q -t {name} status off \\; set-option -q -t {name} mouse on \\; set-option -q -t {name} history-limit 50000"
    ))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub name: String,
    pub attached: bool,
    /// Horodatage Unix de création (secondes).
    pub created: i64,
    pub windows: u32,
    /// Commande en cours dans le panneau actif (bash, htop, apt…).
    pub command: String,
}

pub const LIST_COMMAND: &str =
    "tmux ls -F '#{session_name}|#{session_attached}|#{session_created}|#{session_windows}|#{pane_current_command}' 2>/dev/null || true";

pub fn parse_list(text: &str) -> Vec<Session> {
    text.lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split('|').collect();
            if p.len() < 5 || !p[0].starts_with(PREFIX) {
                return None;
            }
            Some(Session {
                name: p[0].to_string(),
                attached: p[1] != "0",
                created: p[2].parse().unwrap_or(0),
                windows: p[3].parse().unwrap_or(1),
                command: p[4].to_string(),
            })
        })
        .collect()
}

pub async fn available(conn: &Connection) -> Result<Option<String>> {
    let out = conn.exec("tmux -V 2>/dev/null", None).await?;
    Ok(out.success().then(|| out.stdout.trim().to_string()))
}

pub async fn sessions(conn: &Connection) -> Result<Vec<Session>> {
    Ok(parse_list(&conn.run(LIST_COMMAND).await?))
}

pub async fn kill(conn: &Connection, name: &str) -> Result<()> {
    if !valid_session(name) {
        return Err(Error::Other(format!("nom de session invalide : {name}")));
    }
    conn.run(&format!("tmux kill-session -t {name}")).await?;
    Ok(())
}

/// Installe tmux avec le gestionnaire de paquets du serveur.
pub async fn install(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    let script = "if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y tmux; \
                  elif command -v dnf >/dev/null; then dnf install -y tmux; \
                  elif command -v yum >/dev/null; then yum install -y tmux; \
                  elif command -v apk >/dev/null; then apk add tmux; \
                  else echo 'gestionnaire de paquets non reconnu' >&2; exit 1; fi";
    Ok(conn.exec_sudo(script, sudo, None).await?.into_result()?.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_session("helm-3f2a9c"));
        assert!(!valid_session("work"));
        assert!(!valid_session("helm-x; rm -rf /"));
        assert!(attach_command("helm-a").unwrap().starts_with("tmux new-session -A -s helm-a "));
        assert!(attach_command("perso").is_err());
    }

    #[test]
    fn list() {
        let s = parse_list("helm-abc|1|1790000000|2|htop\nperso|0|1|1|bash\nhelm-def|0|1790000100|1|bash\n");
        assert_eq!(s.len(), 2);
        assert!(s[0].attached);
        assert_eq!(s[0].command, "htop");
        assert!(!s[1].attached);
    }
}
