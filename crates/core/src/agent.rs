//! Installation et pilotage de l'agent `helmd` sur le serveur, via SSH.

use std::path::Path;

use helm_protocol::{AgentConfig, AgentStatus, HistoryPoint, Request, Response, CONFIG_PATH};
use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

/// Unité systemd durcie : utilisateur dédié, système de fichiers en lecture seule sauf l'historique.
pub const SYSTEMD_UNIT: &str = r#"[Unit]
Description=Helm monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/helmd run
User=helmd
Group=helmd
RuntimeDirectory=helmd
RuntimeDirectoryMode=0755
StateDirectory=helmd
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=64M

[Install]
WantedBy=multi-user.target
"#;

/// Script d'installation exécuté en root. `$1` = binaire envoyé. Sans systemd (conteneur),
/// l'agent est lancé en arrière-plan avec `nohup`.
pub const INSTALL_SCRIPT: &str = r#"set -e
BIN="$1"
install -m 0755 "$BIN" /usr/local/bin/helmd
rm -f "$BIN"
id helmd >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin helmd 2>/dev/null || adduser -S -H -s /sbin/nologin helmd
install -d -m 0755 /etc/helmd
[ -f /etc/helmd/config.json ] || /usr/local/bin/helmd default-config > /etc/helmd/config.json
chown root:helmd /etc/helmd/config.json
chmod 0640 /etc/helmd/config.json
install -d -o helmd -g helmd -m 0750 /var/lib/helmd
if [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/helmd.service
  systemctl daemon-reload
  systemctl enable helmd >/dev/null 2>&1
  systemctl restart helmd
  echo "MODE=systemd"
else
  cat > /dev/null
  install -d -o helmd -g helmd -m 0755 /run/helmd
  pkill -x helmd 2>/dev/null || true
  su -s /bin/sh helmd -c 'nohup /usr/local/bin/helmd run >/var/lib/helmd/helmd.log 2>&1 &'
  echo "MODE=nohup"
fi
sleep 1
/usr/local/bin/helmd version
"#;

pub const UNINSTALL_SCRIPT: &str = r#"
if [ -d /run/systemd/system ]; then
  systemctl disable --now helmd 2>/dev/null || true
  rm -f /etc/systemd/system/helmd.service
  systemctl daemon-reload
else
  pkill -x helmd 2>/dev/null || true
fi
rm -f /usr/local/bin/helmd
rm -rf /var/lib/helmd /etc/helmd /run/helmd
userdel helmd 2>/dev/null || deluser helmd 2>/dev/null || true
echo OK
"#;

/// Cible Rust correspondant à la sortie de `uname -m`.
pub fn target_for_arch(uname_m: &str) -> Option<&'static str> {
    match uname_m.trim() {
        "x86_64" | "amd64" => Some("x86_64"),
        "aarch64" | "arm64" => Some("aarch64"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub installed: bool,
    pub running: bool,
    pub status: Option<AgentStatus>,
    pub error: Option<String>,
}

fn query_command(req: &Request) -> String {
    format!("helmd query {}", shell_quote(&serde_json::to_string(req).unwrap_or_default()))
}

async fn query(conn: &Connection, req: &Request) -> Result<Response> {
    let out = conn.exec(&format!("PATH=$PATH:/usr/local/bin; {}", query_command(req)), None).await?;
    if !out.success() {
        return Err(Error::Remote(out.stderr.trim().to_string()));
    }
    serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("réponse de l'agent illisible : {e}")))
}

/// Requête en root : seule façon d'obtenir les URL de notification et l'envoi de test.
async fn query_root(conn: &Connection, req: &Request, sudo: Option<&str>) -> Result<Response> {
    let out = conn.exec_sudo(&format!("PATH=$PATH:/usr/local/bin; {}", query_command(req)), sudo, None).await?;
    if !out.success() {
        return Err(Error::Remote(out.stderr.trim().to_string()));
    }
    serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("réponse de l'agent illisible : {e}")))
}

/// État de l'agent, URL de notification masquées (lecture sans privilège).
pub async fn info(conn: &Connection) -> Result<AgentInfo> {
    info_with(conn, None).await
}

/// État complet de l'agent, configuration comprise, lu en root. Repli sur [`info`] sans sudo.
pub async fn info_privileged(conn: &Connection, sudo: Option<&str>) -> Result<AgentInfo> {
    match info_with(conn, Some(sudo)).await {
        Ok(i) if i.status.is_some() => Ok(i),
        _ => info(conn).await,
    }
}

async fn info_with(conn: &Connection, root: Option<Option<&str>>) -> Result<AgentInfo> {
    let installed = conn.exec("test -x /usr/local/bin/helmd", None).await?.success();
    if !installed {
        return Ok(AgentInfo { installed, running: false, status: None, error: None });
    }
    let answer = match root {
        Some(sudo) => query_root(conn, &Request::Status, sudo).await,
        None => query(conn, &Request::Status).await,
    };
    Ok(match answer {
        Ok(Response::Status(s)) => AgentInfo { installed, running: true, status: Some(*s), error: None },
        Ok(other) => AgentInfo { installed, running: true, status: None, error: Some(format!("réponse inattendue : {other:?}")) },
        Err(e) => AgentInfo { installed, running: false, status: None, error: Some(e.to_string()) },
    })
}

pub async fn history(conn: &Connection, range_secs: u64, points: usize) -> Result<Vec<HistoryPoint>> {
    match query(conn, &Request::History { range_secs, points }).await? {
        Response::History { points } => Ok(points),
        Response::Error { message } => Err(Error::Remote(message)),
        other => Err(Error::Other(format!("réponse inattendue : {other:?}"))),
    }
}

pub async fn test_notify(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    match query_root(conn, &Request::TestNotify, sudo).await? {
        Response::Ok { message } => Ok(message),
        Response::Error { message } => Err(Error::Remote(message)),
        other => Err(Error::Other(format!("réponse inattendue : {other:?}"))),
    }
}

/// Écrit la configuration ; l'agent la recharge tout seul au relevé suivant.
pub async fn save_config(conn: &Connection, cfg: &AgentConfig, sudo: Option<&str>) -> Result<()> {
    // Une URL affichée masquée (lecture sans sudo) conserve sa valeur actuelle.
    let mut cfg = cfg.clone();
    let n = &mut cfg.notifiers;
    if [&n.discord_webhook, &n.ntfy_url, &n.webhook_url].iter().any(|v| v.as_deref() == Some(helm_protocol::REDACTED)) {
        let current: AgentConfig = serde_json::from_str(&conn.read_file_sudo(CONFIG_PATH, sudo).await?).unwrap_or_default();
        let keep = |v: &mut Option<String>, old: &Option<String>| {
            if v.as_deref() == Some(helm_protocol::REDACTED) {
                v.clone_from(old);
            }
        };
        keep(&mut n.discord_webhook, &current.notifiers.discord_webhook);
        keep(&mut n.ntfy_url, &current.notifiers.ntfy_url);
        keep(&mut n.webhook_url, &current.notifiers.webhook_url);
    }
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| Error::Other(e.to_string()))?;
    conn.write_file_sudo(CONFIG_PATH, &json, sudo).await
}

/// Envoie le binaire adapté à l'architecture du serveur et l'installe comme service.
/// `binary_for` renvoie le chemin local du binaire pour une architecture (`x86_64`, `aarch64`).
pub async fn install(conn: &Connection, sudo: Option<&str>, binary_for: impl Fn(&str) -> Option<std::path::PathBuf>) -> Result<String> {
    let arch = conn.run("uname -m").await?;
    let target = target_for_arch(&arch).ok_or_else(|| Error::Other(format!("architecture non prise en charge : {}", arch.trim())))?;
    let local = binary_for(target).ok_or_else(|| Error::Other(format!("binaire helmd introuvable pour {target}")))?;
    let remote = upload_binary(conn, &local).await?;
    // Le script lit l'unité systemd sur stdin.
    let cmd = format!("sh -c {} helmd-install {}", shell_quote(INSTALL_SCRIPT), shell_quote(&remote));
    let out = conn.exec_sudo(&cmd, sudo, Some(SYSTEMD_UNIT.as_bytes())).await?.into_result()?;
    Ok(out.stdout)
}

async fn upload_binary(conn: &Connection, local: &Path) -> Result<String> {
    let sftp = conn.sftp().await?;
    let remote = format!("/tmp/helmd-upload-{}", std::process::id());
    let noop = |_p: crate::sftp::Progress| true;
    let dir = std::env::temp_dir().join(format!("helm-agent-{}", std::process::id()));
    // `upload` conserve le nom du fichier : on passe par une copie nommée comme la cible.
    std::fs::create_dir_all(&dir).map_err(|e| Error::Other(e.to_string()))?;
    let staged = dir.join(remote.trim_start_matches("/tmp/"));
    std::fs::copy(local, &staged).map_err(|e| Error::Other(format!("{} : {e}", local.display())))?;
    let res = crate::sftp::upload(&sftp, &staged, "/tmp", &noop).await;
    let _ = std::fs::remove_dir_all(&dir);
    res?;
    Ok(remote)
}

pub async fn uninstall(conn: &Connection, sudo: Option<&str>) -> Result<()> {
    conn.exec_sudo(UNINSTALL_SCRIPT, sudo, None).await?.into_result()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arch_mapping() {
        assert_eq!(target_for_arch("x86_64\n"), Some("x86_64"));
        assert_eq!(target_for_arch("aarch64"), Some("aarch64"));
        assert_eq!(target_for_arch("armv7l"), None);
    }

    #[test]
    fn query_is_quoted() {
        assert_eq!(query_command(&Request::Status), r#"helmd query '{"type":"status"}'"#);
    }
}
