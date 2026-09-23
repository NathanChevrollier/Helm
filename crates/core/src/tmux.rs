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
///
/// La souris reste volontairement désactivée côté tmux : sinon c'est lui qui reçoit les clics et
/// la molette, et l'on perd la sélection à la souris, le copier et le défilement de Helm.
pub fn attach_command(name: &str) -> Result<String> {
    if !valid_session(name) {
        return Err(Error::Other(format!("nom de session invalide : {name}")));
    }
    Ok(format!(
        "tmux new-session -A -s {name} \\; set-option -q -t {name} status off \\; set-option -q -t {name} mouse off \\; set-option -q -t {name} history-limit 50000"
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

/// Dossier courant du panneau actif d'une session : tmux le donne directement, et à défaut on
/// lit celui du programme au premier plan du panneau (tmux compilé sans cette information,
/// serveur sans /proc…).
pub fn pane_path_command(name: &str) -> Result<String> {
    if !valid_session(name) {
        return Err(Error::Other(format!("nom de session invalide : {name}")));
    }
    Ok(format!(
        "tmux display-message -p -t {name} '#{{pane_current_path}}' 2>/dev/null; \
         tmux display-message -p -t {name} '#{{pane_pid}}' 2>/dev/null"
    ))
}

/// Fait défiler l'historique d'une session dans le mode copie de tmux.
///
/// Sous tmux, l'écran alterné prive le terminal de l'app de son propre historique : la molette y
/// est traduite en flèches, qui rappellent les dernières commandes au lieu de remonter le texte.
/// On passe donc par tmux lui-même. Descendre jusqu'en bas sort du mode copie (`-e`).
pub fn scroll_command(name: &str, up: bool, lines: u32) -> Result<String> {
    if !valid_session(name) {
        return Err(Error::Other(format!("nom de session invalide : {name}")));
    }
    let lines = lines.clamp(1, 200);
    let direction = if up { "scroll-up" } else { "scroll-down" };
    Ok(format!("tmux copy-mode -e -t {name} 2>/dev/null; tmux send-keys -t {name} -X -N {lines} {direction} 2>/dev/null; true"))
}

/// Préfixe des erreurs « pas de gestionnaire de paquets utilisable » : l'UI cesse alors de
/// proposer l'installation sur ce serveur au lieu d'afficher une erreur à chaque terminal.
pub const UNSUPPORTED: &str = "UNSUPPORTED:";

/// Gestionnaires de paquets reconnus, dans l'ordre de préférence, avec leur commande d'installation.
const MANAGERS: &[(&str, &str)] = &[
    ("apt-get", "DEBIAN_FRONTEND=noninteractive apt-get install -y tmux"),
    ("dnf", "dnf install -y tmux"),
    ("yum", "yum install -y tmux"),
    ("zypper", "zypper --non-interactive install tmux"),
    ("pacman", "pacman -S --noconfirm --needed tmux"),
    ("apk", "apk add tmux"),
    // Unraid (Slackware sans gestionnaire de paquets) : plugin « un-get » de la communauté.
    ("un-get", "un-get update && un-get install tmux"),
    ("opkg", "opkg update && opkg install tmux"),
    ("pkg", "pkg install -y tmux"),
];

/// Détecte la distribution (Unraid ?) et le premier gestionnaire de paquets disponible.
const PROBE: &str = "[ -f /etc/unraid-version ] && echo unraid; \
     for m in apt-get dnf yum zypper pacman apk un-get opkg pkg; do command -v $m >/dev/null 2>&1 && { echo \"pm:$m\"; break; }; done; true";

/// Commande d'installation à partir du résultat de [`PROBE`], ou message expliquant quoi faire.
fn install_plan(probe: &str) -> std::result::Result<&'static str, String> {
    let unraid = probe.lines().any(|l| l.trim() == "unraid");
    let manager = probe.lines().find_map(|l| l.trim().strip_prefix("pm:"));
    if let Some(cmd) = manager.and_then(|m| MANAGERS.iter().find(|(name, _)| *name == m)).map(|(_, cmd)| *cmd) {
        return Ok(cmd);
    }
    Err(if unraid {
        format!(
            "{UNSUPPORTED} Unraid n'a pas de gestionnaire de paquets. Installe tmux avec le plugin « un-get » \
             (Apps → un-get, puis « un-get install tmux ») ou « NerdTools », et rouvre un terminal. \
             En attendant, les terminaux fonctionnent normalement, sans persistance."
        )
    } else {
        format!(
            "{UNSUPPORTED} aucun gestionnaire de paquets reconnu sur ce serveur (apt, dnf, yum, zypper, pacman, apk, opkg, pkg). \
             Installe tmux à la main pour profiter des sessions persistantes ; les terminaux fonctionnent sans."
        )
    })
}

/// Installe tmux avec le gestionnaire de paquets du serveur.
pub async fn install(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    crate::ssh::long(async move {
        let probe = conn.exec(PROBE, None).await?.stdout;
        let script = install_plan(&probe).map_err(Error::Other)?;
        Ok(conn.exec_sudo(script, sudo, None).await?.into_result()?.stdout)
    })
    .await
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

    #[test]
    fn install_plans() {
        assert!(install_plan("pm:apt-get\n").unwrap().contains("apt-get install"));
        assert!(install_plan("unraid\npm:un-get\n").unwrap().starts_with("un-get update"));
        let unraid = install_plan("unraid\n").unwrap_err();
        assert!(unraid.starts_with(UNSUPPORTED) && unraid.contains("Unraid"));
        assert!(install_plan("").unwrap_err().starts_with(UNSUPPORTED));
        assert!(install_plan("pm:inconnu\n").is_err());
        assert!(pane_path_command("helm-a").unwrap().contains("pane_current_path"));
        assert!(pane_path_command("x; reboot").is_err());
    }
}
