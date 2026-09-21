//! fail2ban : état des jails, IP bannies, déblocage et liste des adresses jamais bannies.
//!
//! Les exceptions (`ignoreip`) sont écrites dans un fichier dédié, lu en dernier par fail2ban
//! (`jail.d/zz-helm-ignore.local`) : les fichiers de l'utilisateur ne sont jamais modifiés. La
//! configuration est testée (`fail2ban-client -t`) avant rechargement, et restaurée en cas d'échec.

use std::net::IpAddr;

use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub const IGNORE_FILE: &str = "/etc/fail2ban/jail.d/zz-helm-ignore.local";

const STATE_SCRIPT: &str = r#"command -v fail2ban-client >/dev/null 2>&1 || { echo @@ABSENT; exit 0; }
fail2ban-client ping >/dev/null 2>&1 || { echo @@INACTIVE; exit 0; }
echo "@@VERSION $(fail2ban-client version 2>/dev/null | head -n1)"
for j in $(fail2ban-client status | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
  echo "@@JAIL $j"
  fail2ban-client status "$j"
  echo "@@BANTIME $(fail2ban-client get "$j" bantime 2>/dev/null)"
  echo "@@FINDTIME $(fail2ban-client get "$j" findtime 2>/dev/null)"
  echo "@@MAXRETRY $(fail2ban-client get "$j" maxretry 2>/dev/null)"
  echo "@@IGNORE"
  fail2ban-client get "$j" ignoreip 2>/dev/null
  echo "@@END"
done
"#;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Jail {
    pub name: String,
    pub currently_failed: u64,
    pub total_failed: u64,
    pub currently_banned: u64,
    pub total_banned: u64,
    pub banned: Vec<String>,
    /// Durée du bannissement en secondes (négative : définitif).
    pub bantime: i64,
    pub findtime: i64,
    pub maxretry: i64,
    pub ignoreip: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub jails: Vec<Jail>,
}

fn number_after(line: &str, label: &str) -> Option<u64> {
    line.split_once(label).and_then(|(_, rest)| rest.trim().parse().ok())
}

pub fn parse_state(out: &str) -> State {
    if out.contains("@@ABSENT") {
        return State { installed: false, running: false, version: None, jails: vec![] };
    }
    if out.contains("@@INACTIVE") {
        return State { installed: true, running: false, version: None, jails: vec![] };
    }
    let mut state = State { installed: true, running: true, version: None, jails: vec![] };
    let mut jail: Option<Jail> = None;
    let mut in_ignore = false;
    for line in out.lines() {
        if let Some(v) = line.strip_prefix("@@VERSION ") {
            state.version = Some(v.trim().to_string()).filter(|v| !v.is_empty());
        } else if let Some(name) = line.strip_prefix("@@JAIL ") {
            jail = Some(Jail { name: name.trim().to_string(), ..Default::default() });
            in_ignore = false;
        } else if line == "@@IGNORE" {
            in_ignore = true;
        } else if line == "@@END" {
            state.jails.extend(jail.take());
            in_ignore = false;
        } else if let Some(j) = jail.as_mut() {
            if let Some(v) = line.strip_prefix("@@BANTIME ") {
                j.bantime = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("@@FINDTIME ") {
                j.findtime = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("@@MAXRETRY ") {
                j.maxretry = v.trim().parse().unwrap_or(0);
            } else if in_ignore {
                // « |- 127.0.0.0/8 », « `- ::1 » ; la ligne de titre est ignorée.
                let v = line.trim_start_matches(['|', '`', '-', ' ']).trim();
                if !v.is_empty() && !v.contains(' ') {
                    j.ignoreip.push(v.to_string());
                }
            } else if let Some(n) = number_after(line, "Currently failed:") {
                j.currently_failed = n;
            } else if let Some(n) = number_after(line, "Total failed:") {
                j.total_failed = n;
            } else if let Some(n) = number_after(line, "Currently banned:") {
                j.currently_banned = n;
            } else if let Some(n) = number_after(line, "Total banned:") {
                j.total_banned = n;
            } else if let Some((_, list)) = line.split_once("Banned IP list:") {
                j.banned = list.split_whitespace().map(str::to_string).collect();
            }
        }
    }
    state
}

pub async fn state(conn: &Connection, sudo: Option<&str>) -> Result<State> {
    let out = conn.exec_sudo(STATE_SCRIPT, sudo, None).await?.into_result()?;
    Ok(parse_state(&out.stdout))
}

fn valid_jail(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Adresse IP, ou réseau en notation CIDR (`192.168.1.0/24`).
pub fn valid_address(addr: &str) -> bool {
    let (ip, mask) = match addr.split_once('/') {
        Some((ip, m)) => (ip, Some(m)),
        None => (addr, None),
    };
    let Ok(ip) = ip.parse::<IpAddr>() else { return false };
    match mask {
        None => true,
        Some(m) => m.parse::<u8>().is_ok_and(|m| m <= if ip.is_ipv4() { 32 } else { 128 }),
    }
}

pub async fn unban(conn: &Connection, sudo: Option<&str>, jail: &str, ip: &str) -> Result<()> {
    if !valid_jail(jail) || !valid_address(ip) {
        return Err(Error::Other("jail ou adresse invalide".into()));
    }
    conn.exec_sudo(&format!("fail2ban-client set {jail} unbanip {ip}"), sudo, None).await?.into_result()?;
    Ok(())
}

/// Contenu du fichier d'exceptions : la même liste pour tous les jails (et par défaut).
pub fn ignore_file(addresses: &[String], jails: &[String]) -> String {
    let list = addresses.join(" ");
    let mut s = format!("# Géré par Helm : adresses jamais bannies par fail2ban.\n# Modifie-les depuis Helm (Sécurité → fail2ban).\n\n[DEFAULT]\nignoreip = {list}\n");
    // Une valeur définie dans la section d'un jail (jail.local) l'emporte sur [DEFAULT] : on la redéfinit.
    for j in jails {
        s.push_str(&format!("\n[{j}]\nignoreip = {list}\n"));
    }
    s
}

/// Remplace la liste des adresses jamais bannies, sur tous les jails actifs.
pub async fn set_ignore(conn: &Connection, sudo: Option<&str>, addresses: &[String]) -> Result<String> {
    let mut list: Vec<String> = vec!["127.0.0.1/8".into(), "::1".into()];
    for a in addresses {
        let a = a.trim();
        if !valid_address(a) {
            return Err(Error::Other(format!("adresse invalide : {a}")));
        }
        if !list.iter().any(|x| x == a) {
            list.push(a.to_string());
        }
    }
    let jails: Vec<String> = state(conn, sudo).await?.jails.into_iter().map(|j| j.name).filter(|j| valid_jail(j)).collect();
    let content = ignore_file(&list, &jails);
    let f = shell_quote(IGNORE_FILE);
    let script = format!(
        "set -u\n[ -f {f} ] && cp -p {f} {f}.helm-avant\ncat > {f}\nchmod 644 {f}\nT=$(mktemp)\nif fail2ban-client -t >\"$T\" 2>&1; then\n  rm -f {f}.helm-avant\n  fail2ban-client reload 2>&1\n  echo @@OK\nelse\n  cat \"$T\"\n  if [ -f {f}.helm-avant ]; then mv -f {f}.helm-avant {f}; else rm -f {f}; fi\n  echo @@FAILED\nfi\nrm -f \"$T\"\n"
    );
    let out = conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, Some(content.as_bytes())).await?;
    let text = format!("{}{}", out.stdout, out.stderr);
    if !text.contains("@@OK") {
        return Err(Error::Remote(format!(
            "configuration refusée par fail2ban, rien n'a été changé :\n{}",
            text.replace("@@FAILED", "").trim()
        )));
    }
    Ok(text.replace("@@OK", "").trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@@VERSION 1.0.2
@@JAIL sshd
Status for the jail: sshd
|- Filter
|  |- Currently failed: 2
|  |- Total failed:     3
|  `- File list:        /var/log/auth.log
`- Actions
   |- Currently banned: 1
   |- Total banned:     4
   `- Banned IP list:   198.51.100.23
@@BANTIME 86400
@@FINDTIME 600
@@MAXRETRY 3
@@IGNORE
These IP addresses/networks are ignored:
|- 127.0.0.0/8
|- 198.51.100.23
`- ::1
@@END
";

    #[test]
    fn parses_status() {
        let s = parse_state(SAMPLE);
        assert!(s.installed && s.running);
        assert_eq!(s.version.as_deref(), Some("1.0.2"));
        let j = &s.jails[0];
        assert_eq!((j.name.as_str(), j.currently_failed, j.total_failed, j.currently_banned, j.total_banned), ("sshd", 2, 3, 1, 4));
        assert_eq!(j.banned, vec!["198.51.100.23"]);
        assert_eq!((j.bantime, j.findtime, j.maxretry), (86400, 600, 3));
        assert_eq!(j.ignoreip, vec!["127.0.0.0/8", "198.51.100.23", "::1"]);
    }

    #[test]
    fn absent_and_addresses() {
        assert!(!parse_state("@@ABSENT").installed);
        assert!(valid_address("198.51.100.23") && valid_address("2a01:cb05::/64") && valid_address("10.0.0.0/8"));
        assert!(!valid_address("1.2.3.4; rm -rf /") && !valid_address("1.2.3.4/33") && !valid_address(""));
        let f = ignore_file(&["127.0.0.1/8".into(), "1.2.3.4".into()], &["sshd".into()]);
        assert!(f.contains("[DEFAULT]\nignoreip = 127.0.0.1/8 1.2.3.4") && f.contains("[sshd]\nignoreip = 127.0.0.1/8 1.2.3.4"));
    }
}
