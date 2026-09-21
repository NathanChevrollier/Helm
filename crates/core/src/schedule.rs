//! Tâches planifiées : crontabs des utilisateurs, /etc/crontab, /etc/cron.d et timers systemd.
//!
//! La crontab d'un utilisateur est modifiable : elle est installée avec `crontab -u … -`, qui
//! refuse une syntaxe invalide (l'ancienne reste alors en place).

use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

const LIST_SCRIPT: &str = r#"getent passwd | cut -d: -f1 | while read -r u; do
  c=$(crontab -l -u "$u" 2>/dev/null) || continue
  echo "@@CRONTAB $u"; printf '%s\n' "$c"
done
for f in /etc/crontab /etc/cron.d/*; do [ -f "$f" ] && { echo "@@FILE $f"; cat "$f"; }; done
# Sans systemd (conteneur, vieux système), pas de section timers.
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  echo "@@TIMERS"
  systemctl list-timers --all --no-legend --no-pager 2>/dev/null
fi
true
"#;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CronJob {
    pub schedule: String,
    /// Utilisateur qui exécute la commande (colonne dédiée dans /etc/crontab et /etc/cron.d).
    pub user: Option<String>,
    pub command: String,
    /// Description lisible du planning (« chaque jour à 03:00 »…), si reconnue.
    pub human: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CronSource {
    /// `user:<nom>` pour une crontab utilisateur, sinon le chemin du fichier.
    pub id: String,
    pub label: String,
    pub editable: bool,
    pub raw: String,
    pub jobs: Vec<CronJob>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub unit: String,
    pub activates: String,
    pub next: String,
    pub last: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub crontabs: Vec<CronSource>,
    pub timers: Vec<Timer>,
    pub systemd: bool,
}

/// Traduction des plannings les plus courants.
pub fn describe(schedule: &str) -> Option<String> {
    match schedule {
        "@reboot" => return Some("au démarrage".into()),
        "@hourly" => return Some("toutes les heures".into()),
        "@daily" | "@midnight" => return Some("chaque jour à 00:00".into()),
        "@weekly" => return Some("chaque dimanche à 00:00".into()),
        "@monthly" => return Some("le 1er de chaque mois à 00:00".into()),
        _ => {}
    }
    let f: Vec<&str> = schedule.split_whitespace().collect();
    let [min, hour, dom, mon, dow] = f.as_slice() else { return None };
    let num = |s: &str| s.parse::<u32>().ok();
    let at = |h: u32, m: u32| format!("{h:02}:{m:02}");
    const DAYS: [&str; 8] = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
    match (num(min), num(hour), *dom, *mon, *dow) {
        (Some(m), Some(h), "*", "*", "*") => Some(format!("chaque jour à {}", at(h, m))),
        (Some(m), Some(h), "*", "*", d) if num(d).is_some_and(|d| d < 8) => {
            Some(format!("chaque {} à {}", DAYS[num(d)? as usize], at(h, m)))
        }
        (Some(m), Some(h), d, "*", "*") if num(d).is_some() => {
            Some(format!("le {} de chaque mois à {}", if d == "1" { "1er" } else { d }, at(h, m)))
        }
        (Some(m), None, "*", "*", "*") if *hour == "*" => Some(format!("toutes les heures, à la minute {m}")),
        (None, None, "*", "*", "*") if *hour == "*" => match min.strip_prefix("*/") {
            Some(n) => Some(format!("toutes les {n} minutes")),
            None if *min == "*" => Some("chaque minute".into()),
            None => None,
        },
        _ => None,
    }
}

fn parse_jobs(text: &str, with_user: bool) -> Vec<CronJob> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        // Affectations de variables (SHELL=…, MAILTO=…) : pas des tâches.
        .filter(|l| !l.split_whitespace().next().is_some_and(|w| w.contains('=') && !w.starts_with('@')))
        .filter_map(|l| {
            let fields: Vec<&str> = l.split_whitespace().collect();
            let n = if l.starts_with('@') { 1 } else { 5 };
            let rest_at = n + usize::from(with_user);
            if fields.len() <= rest_at {
                return None;
            }
            let schedule = fields[..n].join(" ");
            // La commande est reprise telle quelle depuis la ligne (espaces conservés).
            let mut idx = 0;
            for f in &fields[..rest_at] {
                idx = l[idx..].find(f).map(|p| idx + p + f.len())?;
            }
            Some(CronJob {
                human: describe(&schedule),
                user: with_user.then(|| fields[n].to_string()),
                command: l[idx..].trim().to_string(),
                schedule,
            })
        })
        .collect()
}

fn parse_timer(line: &str) -> Option<Timer> {
    // NEXT (4 champs ou « - ») LEFT (…) LAST (…) PASSED (…) UNIT ACTIVATES : on repère les unités à la fin.
    let fields: Vec<&str> = line.split_whitespace().collect();
    let unit_idx = fields.iter().rposition(|f| f.ends_with(".timer"))?;
    let activates = fields.get(unit_idx + 1).copied().unwrap_or("").to_string();
    // « Mon 2026-09-22 00:00:00 UTC 3h 10min left Sun 2026-09-21 00:00:00 UTC 20h ago » :
    // une date fait 4 mots (ou « - »), suivie d'une durée de longueur variable close par left/ago.
    let mut i = 0;
    let mut date = |end: &str| -> String {
        if fields.get(i) == Some(&"-") {
            i += if fields.get(i + 1) == Some(&"-") { 2 } else { 1 };
            return "—".into();
        }
        let d = fields.get(i..(i + 4).min(unit_idx)).map(|d| d.join(" ")).unwrap_or_default();
        i += 4;
        while i < unit_idx && fields[i] != end {
            i += 1;
        }
        i += 1;
        if d.is_empty() {
            "—".into()
        } else {
            d
        }
    };
    let next = date("left");
    let last = date("ago");
    Some(Timer { unit: fields[unit_idx].to_string(), activates, next, last })
}

pub fn parse_schedule(out: &str) -> Schedule {
    let mut s = Schedule { crontabs: vec![], timers: vec![], systemd: false };
    let mut current: Option<(String, String, bool, bool, String)> = None; // id, label, editable, with_user, raw
    let mut in_timers = false;
    let flush = |c: &mut Option<(String, String, bool, bool, String)>, s: &mut Schedule| {
        if let Some((id, label, editable, with_user, raw)) = c.take() {
            s.crontabs.push(CronSource { jobs: parse_jobs(&raw, with_user), id, label, editable, raw });
        }
    };
    for line in out.lines() {
        if let Some(u) = line.strip_prefix("@@CRONTAB ") {
            flush(&mut current, &mut s);
            current = Some((format!("user:{u}"), format!("crontab de {u}"), true, false, String::new()));
        } else if let Some(f) = line.strip_prefix("@@FILE ") {
            flush(&mut current, &mut s);
            current = Some((f.to_string(), f.to_string(), false, true, String::new()));
        } else if line == "@@TIMERS" {
            flush(&mut current, &mut s);
            in_timers = true;
            s.systemd = true;
        } else if in_timers {
            s.timers.extend(parse_timer(line));
        } else if let Some(c) = current.as_mut() {
            c.4.push_str(line);
            c.4.push('\n');
        }
    }
    flush(&mut current, &mut s);
    s
}

pub async fn list(conn: &Connection, sudo: Option<&str>) -> Result<Schedule> {
    let out = conn.exec_sudo(LIST_SCRIPT, sudo, None).await?.into_result()?;
    Ok(parse_schedule(&out.stdout))
}

fn valid_user(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c)) && !name.starts_with('-')
}

/// Remplace la crontab d'un utilisateur. `crontab` valide la syntaxe avant d'installer.
pub async fn save_crontab(conn: &Connection, sudo: Option<&str>, user: &str, content: &str) -> Result<()> {
    if !valid_user(user) {
        return Err(Error::Other("utilisateur invalide".into()));
    }
    let mut text = content.replace("\r\n", "\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let out = conn.exec_sudo(&format!("crontab -u {} - 2>&1", shell_quote(user)), sudo, Some(text.as_bytes())).await?;
    if !out.success() {
        return Err(Error::Remote(format!("crontab refusée, l'ancienne est conservée : {}", out.stdout.trim())));
    }
    Ok(())
}

/// Lance tout de suite le service d'un timer systemd.
pub async fn run_timer_now(conn: &Connection, sudo: Option<&str>, service: &str) -> Result<()> {
    if !service.ends_with(".service") || !service.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:".contains(c)) {
        return Err(Error::Other("service invalide".into()));
    }
    conn.exec_sudo(&format!("systemctl start --no-block {service}"), sudo, None).await?.into_result()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions() {
        assert_eq!(describe("0 3 * * *").as_deref(), Some("chaque jour à 03:00"));
        assert_eq!(describe("30 4 * * 1").as_deref(), Some("chaque lundi à 04:30"));
        assert_eq!(describe("*/5 * * * *").as_deref(), Some("toutes les 5 minutes"));
        assert_eq!(describe("15 * * * *").as_deref(), Some("toutes les heures, à la minute 15"));
        assert_eq!(describe("@reboot").as_deref(), Some("au démarrage"));
        assert_eq!(describe("0 0 1,15 * *"), None);
    }

    #[test]
    fn parses_everything() {
        let out = "@@CRONTAB alice
# m h dom mon dow command
MAILTO=\"\"
0 3 * * * /usr/local/bin/backup.sh  --full > /tmp/log 2>&1
@reboot cd /opt/app && ./start.sh
@@FILE /etc/cron.d/certbot
SHELL=/bin/sh
0 */12 * * * root test -x /usr/bin/certbot && certbot -q renew
@@TIMERS
Mon 2026-09-22 00:00:00 UTC 3h 10min left Sun 2026-09-21 00:00:00 UTC 20h ago logrotate.timer logrotate.service
- - Sun 2026-09-21 06:00:00 UTC 14h ago helm-backup.timer helm-backup.service
";
        let s = parse_schedule(out);
        assert_eq!(s.crontabs.len(), 2);
        let user = &s.crontabs[0];
        assert!(user.editable && user.id == "user:alice" && user.raw.contains("MAILTO"));
        assert_eq!(user.jobs.len(), 2);
        assert_eq!(user.jobs[0].command, "/usr/local/bin/backup.sh  --full > /tmp/log 2>&1");
        assert_eq!(user.jobs[1].human.as_deref(), Some("au démarrage"));
        let file = &s.crontabs[1];
        assert_eq!(file.jobs[0].user.as_deref(), Some("root"));
        assert_eq!(file.jobs[0].command, "test -x /usr/bin/certbot && certbot -q renew");
        assert_eq!(s.timers.len(), 2);
        assert_eq!((s.timers[0].unit.as_str(), s.timers[0].activates.as_str()), ("logrotate.timer", "logrotate.service"));
        assert_eq!(s.timers[0].next, "Mon 2026-09-22 00:00:00 UTC");
        assert_eq!(s.timers[1].next, "—");
    }
}
