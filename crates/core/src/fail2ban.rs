//! fail2ban : état des jails, IP bannies, déblocage et liste des adresses jamais bannies.
//!
//! Les exceptions (`ignoreip`) sont écrites dans un fichier dédié, lu en dernier par fail2ban
//! (`jail.d/zz-zenytt-ignore.local`) : les fichiers de l'utilisateur ne sont jamais modifiés. La
//! configuration est testée (`fail2ban-client -t`) avant rechargement, et restaurée en cas d'échec.

use std::net::IpAddr;

use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub const IGNORE_FILE: &str = "/etc/fail2ban/jail.d/zz-zenytt-ignore.local";

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

// ---------- Bannissements manuels (durée choisie) ----------

/// Jails gérées par Zenytt pour bannir à la main, une par durée : fail2ban ne sait pas donner
/// une durée à une seule IP, seulement à un jail. Leur filtre ne reconnaît jamais rien : elles ne
/// bannissent que ce qu'on leur demande.
pub const MANUAL_JAILS: &[(&str, i64)] = &[("zenytt-7j", 7 * 86400), ("zenytt-30j", 30 * 86400), ("zenytt-definitif", -1)];
pub const MANUAL_JAIL_FILE: &str = "/etc/fail2ban/jail.d/zz-zenytt-manual.local";
pub const MANUAL_FILTER_FILE: &str = "/etc/fail2ban/filter.d/zenytt-manual.conf";
/// Garde les bannissements longs d'un redémarrage à l'autre (la base les purge sinon au bout d'un jour).
pub const MANUAL_DB_FILE: &str = "/etc/fail2ban/fail2ban.d/zz-zenytt.local";

/// Durée d'un bannissement manuel.
#[derive(Debug, Clone, Copy, serde::Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BanDuration {
    /// Durée du jail choisi (réglage fail2ban existant).
    Jail,
    Week,
    Month,
    Forever,
}

impl BanDuration {
    fn manual_jail(self) -> Option<&'static str> {
        match self {
            Self::Jail => None,
            Self::Week => Some(MANUAL_JAILS[0].0),
            Self::Month => Some(MANUAL_JAILS[1].0),
            Self::Forever => Some(MANUAL_JAILS[2].0),
        }
    }
}

pub fn manual_jail_file() -> String {
    let mut s = String::from(
        "# Géré par Zenytt : jails de bannissement manuel (une par durée).\n# Leur filtre ne reconnaît rien : seules les IP bannies depuis Zenytt y entrent.\n",
    );
    for (name, bantime) in MANUAL_JAILS {
        s.push_str(&format!(
            "\n[{name}]\nenabled = true\nfilter = zenytt-manual\nlogpath = /dev/null\nbackend = auto\nmaxretry = 1\nfindtime = 1\nbantime = {bantime}\n# Toutes les connexions de l'adresse sont refusées, pas seulement SSH.\nbanaction = %(banaction_allports)s\n"
        ));
    }
    s
}

const MANUAL_FILTER: &str = "# Géré par Zenytt : ne reconnaît jamais rien (bannissements manuels uniquement).\n[Definition]\nfailregex = ^ZENYTT-MANUEL-JAMAIS <HOST>$\nignoreregex =\n";
const MANUAL_DB: &str = "# Géré par Zenytt : garde un an les bannissements longs (7 j, 30 j, définitifs) après un redémarrage.\n[Definition]\ndbpurgeage = 365d\n";

/// Écrit des fichiers de configuration, teste la configuration de fail2ban et recharge ; en cas
/// de refus, chaque fichier retrouve son contenu d'avant (ou disparaît s'il n'existait pas).
async fn write_config(conn: &Connection, sudo: Option<&str>, files: &[(&str, &str)]) -> Result<String> {
    let mut script = String::from("set -u\n");
    for (i, (path, content)) in files.iter().enumerate() {
        let f = shell_quote(path);
        script.push_str(&format!(
            "[ -f {f} ] && cp -p {f} {f}.zenytt-avant\nmkdir -p \"$(dirname {f})\"\ncat > {f} <<'ZENYTT_EOF_{i}'\n{content}\nZENYTT_EOF_{i}\nchmod 644 {f}\n"
        ));
    }
    let restore: String = files
        .iter()
        .map(|(path, _)| {
            let f = shell_quote(path);
            format!("  if [ -f {f}.zenytt-avant ]; then mv -f {f}.zenytt-avant {f}; else rm -f {f}; fi\n")
        })
        .collect();
    let cleanup: String = files.iter().map(|(path, _)| format!("  rm -f {}.zenytt-avant\n", shell_quote(path))).collect();
    script.push_str(&format!(
        "T=$(mktemp)\nif fail2ban-client -t >\"$T\" 2>&1; then\n{cleanup}  fail2ban-client reload 2>&1\n  echo @@OK\nelse\n  cat \"$T\"\n{restore}  echo @@FAILED\nfi\nrm -f \"$T\"\n"
    ));
    let out = conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, None).await?;
    let text = format!("{}{}", out.stdout, out.stderr);
    if !text.contains("@@OK") {
        return Err(Error::Remote(format!(
            "configuration refusée par fail2ban, rien n'a été changé :\n{}",
            text.replace("@@FAILED", "").trim()
        )));
    }
    Ok(text.replace("@@OK", "").trim().to_string())
}

/// Bannit une adresse : dans un jail existant (sa durée), ou pour 7 jours, 30 jours ou toujours
/// (jails Zenytt, installées au premier usage).
pub async fn ban(conn: &Connection, sudo: Option<&str>, jail: &str, ip: &str, duration: BanDuration) -> Result<()> {
    if !valid_address(ip) || ip.contains('/') {
        return Err(Error::Other("adresse IP invalide (une seule adresse, pas un réseau)".into()));
    }
    let target = match duration.manual_jail() {
        None => {
            if !valid_jail(jail) {
                return Err(Error::Other("jail invalide".into()));
            }
            jail.to_string()
        }
        Some(j) => {
            let st = state(conn, sudo).await?;
            if !st.jails.iter().any(|x| x.name == j) {
                write_config(
                    conn,
                    sudo,
                    &[(MANUAL_FILTER_FILE, MANUAL_FILTER), (MANUAL_JAIL_FILE, &manual_jail_file()), (MANUAL_DB_FILE, MANUAL_DB)],
                )
                .await?;
            }
            j.to_string()
        }
    };
    conn.exec_sudo(&format!("fail2ban-client set {target} banip {ip}"), sudo, None).await?.into_result()?;
    Ok(())
}

// ---------- Journal ----------

/// Événement du journal de fail2ban.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// « 2026-09-30 14:02:11 » (heure du serveur).
    pub time: String,
    pub jail: String,
    /// `found` (échec repéré), `ban`, `unban`, `restore` (rebanni au redémarrage), `ignore`.
    pub kind: String,
    pub ip: String,
}

/// Lignes de `fail2ban.log` : `2026-09-30 14:02:11,123 fail2ban.filter [812]: INFO [sshd] Found 203.0.113.9 - 2026-09-30 14:02:11`.
/// Aussi le format de journald (`-o short-iso`) : `2026-09-30T14:02:11+0200 hôte fail2ban-server[812]: … [sshd] Ban …`.
pub fn parse_log(text: &str) -> Vec<Event> {
    let mut out = Vec::new();
    for line in text.lines() {
        // Le jail est le `[nom]` suivi d'un mot d'action (les `[812]` de PID ne le sont pas).
        let found = line.match_indices('[').find_map(|(start, _)| {
            let end = start + line[start..].find(']')?;
            let jail = &line[start + 1..end];
            let mut words = line[end + 1..].split_whitespace();
            let (kind, ip) = match (words.next(), words.next(), words.next()) {
                (Some("Found"), Some(ip), _) => ("found", ip),
                (Some("Ban"), Some(ip), _) => ("ban", ip),
                (Some("Unban"), Some(ip), _) => ("unban", ip),
                (Some("Restore"), Some("Ban"), Some(ip)) => ("restore", ip),
                (Some("Ignore"), Some(ip), _) => ("ignore", ip),
                _ => return None,
            };
            (valid_jail(jail) && ip.parse::<IpAddr>().is_ok()).then_some((jail, kind, ip))
        });
        let Some((jail, kind, ip)) = found else { continue };
        let time = line.get(..19).filter(|t| t.as_bytes().first().is_some_and(u8::is_ascii_digit)).unwrap_or("").replace('T', " ");
        out.push(Event { time, jail: jail.to_string(), kind: kind.into(), ip: ip.to_string() });
    }
    out
}

/// Derniers événements de fail2ban (fichier journal, ou journald s'il n'y en a pas), les plus
/// récents à la fin. Avec `ip`, seulement ceux de cette adresse (dans les journaux archivés aussi).
pub async fn events(conn: &Connection, sudo: Option<&str>, ip: Option<&str>, limit: usize) -> Result<Vec<Event>> {
    if let Some(ip) = ip {
        if !valid_address(ip) {
            return Err(Error::Other("adresse IP invalide".into()));
        }
    }
    let limit = limit.clamp(10, 5000);
    let filter = match ip {
        Some(ip) => format!("grep -F -- {} | ", shell_quote(ip)),
        None => String::new(),
    };
    let script = format!(
        "if [ -f /var/log/fail2ban.log ]; then {{ zcat -f /var/log/fail2ban.log.[0-9]*.gz 2>/dev/null; cat /var/log/fail2ban.log.1 2>/dev/null; cat /var/log/fail2ban.log; }} | {filter}tail -n {limit}; \
         else journalctl -u fail2ban --no-pager -o short-iso -n 20000 2>/dev/null | {filter}tail -n {limit}; fi"
    );
    let out = conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, None).await?;
    Ok(parse_log(&out.stdout))
}

/// Tentatives d'une adresse dans les journaux du service surveillé (SSH surtout) : les lignes
/// brutes qui ont mené au bannissement.
pub async fn attempts(conn: &Connection, sudo: Option<&str>, ip: &str, limit: usize) -> Result<Vec<String>> {
    if !valid_address(ip) || ip.contains('/') {
        return Err(Error::Other("adresse IP invalide".into()));
    }
    let q = shell_quote(ip);
    let limit = limit.clamp(10, 1000);
    let script = format!(
        "{{ for f in /var/log/auth.log /var/log/secure /var/log/nginx/error.log /var/log/nginx/access.log; do [ -f \"$f\" ] && grep -hF -- {q} \"$f\"; done; \
         command -v journalctl >/dev/null 2>&1 && [ ! -f /var/log/auth.log ] && [ ! -f /var/log/secure ] && journalctl -u ssh -u sshd --no-pager -o short-iso -n 20000 2>/dev/null | grep -F -- {q}; }} | tail -n {limit}"
    );
    let out = conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, None).await?;
    Ok(out.stdout.lines().map(str::to_string).collect())
}

/// Contenu du fichier d'exceptions : la même liste pour tous les jails (et par défaut).
pub fn ignore_file(addresses: &[String], jails: &[String]) -> String {
    let list = addresses.join(" ");
    let mut s = format!("# Géré par Zenytt : adresses jamais bannies par fail2ban.\n# Modifie-les depuis Zenytt (Sécurité → fail2ban).\n\n[DEFAULT]\nignoreip = {list}\n");
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
        "set -u\n[ -f {f} ] && cp -p {f} {f}.zenytt-avant\ncat > {f}\nchmod 644 {f}\nT=$(mktemp)\nif fail2ban-client -t >\"$T\" 2>&1; then\n  rm -f {f}.zenytt-avant\n  fail2ban-client reload 2>&1\n  echo @@OK\nelse\n  cat \"$T\"\n  if [ -f {f}.zenytt-avant ]; then mv -f {f}.zenytt-avant {f}; else rm -f {f}; fi\n  echo @@FAILED\nfi\nrm -f \"$T\"\n"
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
    fn parses_log_file_and_journal() {
        let text = "2026-09-30 14:02:11,123 fail2ban.filter         [812]: INFO    [sshd] Found 203.0.113.9 - 2026-09-30 14:02:11
2026-09-30 14:02:15,001 fail2ban.actions        [812]: NOTICE  [sshd] Ban 203.0.113.9
2026-09-30 15:02:15,001 fail2ban.actions        [812]: NOTICE  [sshd] Unban 203.0.113.9
2026-09-30 16:00:00,000 fail2ban.actions        [812]: NOTICE  [zenytt-definitif] Restore Ban 2001:db8::7
2026-09-30T16:05:00+0200 vps fail2ban-server[812]: fail2ban.actions [812]: NOTICE [recidive] Ban 198.51.100.4
2026-09-30 16:06:00,000 fail2ban.server [812]: INFO Reload finished.";
        let e = parse_log(text);
        assert_eq!(e.len(), 5);
        assert_eq!(
            (e[0].kind.as_str(), e[0].jail.as_str(), e[0].ip.as_str(), e[0].time.as_str()),
            ("found", "sshd", "203.0.113.9", "2026-09-30 14:02:11")
        );
        assert_eq!((e[3].kind.as_str(), e[3].jail.as_str(), e[3].ip.as_str()), ("restore", "zenytt-definitif", "2001:db8::7"));
        assert_eq!((e[4].jail.as_str(), e[4].time.as_str()), ("recidive", "2026-09-30 16:05:00"), "format journald");
    }

    #[test]
    fn manual_jails_are_complete() {
        let f = manual_jail_file();
        for (name, bantime) in MANUAL_JAILS {
            assert!(f.contains(&format!("[{name}]\nenabled = true")), "{name}");
            assert!(f.contains(&format!("bantime = {bantime}\n")));
        }
        assert_eq!(BanDuration::Forever.manual_jail(), Some("zenytt-definitif"));
        assert_eq!(BanDuration::Jail.manual_jail(), None);
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
