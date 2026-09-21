//! Processus, services systemd et journaux, via des commandes standard.

use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    /// Mémoire résidente en octets.
    pub rss: u64,
    /// Durée d'exécution en secondes.
    pub elapsed: u64,
    pub name: String,
    pub command: String,
}

pub const PS_COMMAND: &str = "ps -eo pid=,user=,pcpu=,pmem=,rss=,etimes=,comm=,args= --sort=-pcpu | head -n 150";

pub fn parse_ps(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let user = it.next()?.to_string();
            let cpu = it.next()?.parse().ok()?;
            let mem = it.next()?.parse().ok()?;
            let rss = it.next()?.parse::<u64>().ok()? * 1024;
            let elapsed = it.next()?.parse().ok()?;
            let name = it.next()?.to_string();
            let command = it.collect::<Vec<_>>().join(" ");
            Some(Process { pid, user, cpu, mem, rss, elapsed, name, command })
        })
        .collect()
}

pub async fn processes(conn: &Connection) -> Result<Vec<Process>> {
    Ok(parse_ps(&conn.run(PS_COMMAND).await?))
}

/// Envoie un signal à un processus (TERM ou KILL), en root si nécessaire.
pub async fn kill(conn: &Connection, pid: u32, force: bool, sudo: Option<&str>) -> Result<()> {
    let sig = if force { "KILL" } else { "TERM" };
    let cmd = format!("kill -{sig} {pid}");
    let out = conn.exec(&cmd, None).await?;
    if out.success() {
        return Ok(());
    }
    conn.exec_sudo(&cmd, sudo, None).await?.into_result()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub unit: String,
    pub load: String,
    /// active, inactive, failed…
    pub active: String,
    /// running, exited, dead…
    pub sub: String,
    pub description: String,
    /// enabled, disabled, static… (vide si inconnu)
    pub enabled: String,
}

pub const SERVICES_COMMAND: &str = "command -v systemctl >/dev/null && [ -d /run/systemd/system ] || { echo NO_SYSTEMD; exit 0; }; \
systemctl list-units --type=service --all --no-legend --plain --no-pager; echo @@files; \
systemctl list-unit-files --type=service --no-legend --plain --no-pager";

pub fn parse_services(text: &str) -> Option<Vec<Service>> {
    if text.trim() == "NO_SYSTEMD" {
        return None;
    }
    let (units, files) = text.split_once("@@files").unwrap_or((text, ""));
    let enabled: std::collections::HashMap<&str, &str> = files
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?, it.next()?))
        })
        .collect();
    Some(
        units
            .lines()
            .filter_map(|line| {
                let line = line.trim_start_matches(['●', '*', ' ']);
                let mut it = line.split_whitespace();
                let unit = it.next()?;
                if !unit.ends_with(".service") {
                    return None;
                }
                let (load, active, sub) = (it.next()?, it.next()?, it.next()?);
                Some(Service {
                    unit: unit.to_string(),
                    load: load.to_string(),
                    active: active.to_string(),
                    sub: sub.to_string(),
                    description: it.collect::<Vec<_>>().join(" "),
                    enabled: enabled.get(unit).copied().unwrap_or("").to_string(),
                })
            })
            .collect(),
    )
}

/// `None` si le serveur n'utilise pas systemd.
pub async fn services(conn: &Connection) -> Result<Option<Vec<Service>>> {
    Ok(parse_services(&conn.run(SERVICES_COMMAND).await?))
}

fn valid_unit(unit: &str) -> Result<()> {
    let ok = !unit.is_empty() && unit.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:".contains(c));
    if ok {
        Ok(())
    } else {
        Err(Error::Other(format!("nom de service invalide : {unit}")))
    }
}

pub async fn service_action(conn: &Connection, unit: &str, action: &str, sudo: Option<&str>) -> Result<()> {
    valid_unit(unit)?;
    if !["start", "stop", "restart", "reload", "enable", "disable"].contains(&action) {
        return Err(Error::Other(format!("action inconnue : {action}")));
    }
    conn.exec_sudo(&format!("systemctl {action} {unit}"), sudo, None).await?.into_result()?;
    Ok(())
}

/// Dernières lignes du journal d'un service (en root si possible, pour voir tous les messages).
pub async fn service_logs(conn: &Connection, unit: &str, lines: u32, sudo: Option<&str>) -> Result<String> {
    valid_unit(unit)?;
    let cmd = format!("journalctl -u {} -n {} --no-pager -o short-iso", shell_quote(unit), lines.min(5000));
    let out = conn.exec_sudo(&cmd, sudo, None).await?;
    if out.success() {
        return Ok(out.stdout);
    }
    Ok(conn.exec(&cmd, None).await?.into_result()?.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps() {
        let p = parse_ps("  42 root      12.5  1.0  2048   3600 nginx nginx: master process /usr/sbin/nginx -g daemon off;\n  7 www-data 0.0 0.1 100 10 php-fpm php-fpm: pool www\n");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].pid, 42);
        assert_eq!(p[0].rss, 2048 * 1024);
        assert_eq!(p[0].command, "nginx: master process /usr/sbin/nginx -g daemon off;");
    }

    #[test]
    fn services_merge_enabled_state() {
        let text = "nginx.service loaded active running A high performance web server\n● foo.service loaded failed failed Foo\nsys-fs.mount loaded active mounted x\n@@files\nnginx.service enabled enabled\nfoo.service disabled enabled\n";
        let s = parse_services(text).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].description, "A high performance web server");
        assert_eq!(s[0].enabled, "enabled");
        assert_eq!(s[1].active, "failed");
        assert!(parse_services("NO_SYSTEMD\n").is_none());
    }

    #[test]
    fn unit_names_are_validated() {
        assert!(valid_unit("nginx.service").is_ok());
        assert!(valid_unit("getty@tty1.service").is_ok());
        assert!(valid_unit("x; rm -rf /").is_err());
    }
}
