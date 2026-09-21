//! Audit de sécurité (en lecture seule) et corrections guidées.
//!
//! Les corrections qui touchent l'accès SSH ou le pare-feu sont vérifiées par l'appelant avec une
//! **nouvelle** connexion avant d'être conservées ; sinon `ROLLBACK_*` est exécuté par la connexion
//! d'origine, qui reste ouverte pendant toute l'opération.

use serde::Serialize;

use crate::{Connection, Error, Result};

const AUDIT_SCRIPT: &str = r#"echo @@sshd; sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|x11forwarding) '
echo @@ufw; if command -v ufw >/dev/null; then ufw status 2>/dev/null | head -n1; else echo absent; fi
echo @@f2b; if command -v fail2ban-client >/dev/null; then systemctl is-active fail2ban 2>/dev/null || echo inactive; else echo absent; fi
echo @@apt; if command -v apt-get >/dev/null; then apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst' > /tmp/.helm-upg; wc -l < /tmp/.helm-upg; grep -ci security /tmp/.helm-upg; rm -f /tmp/.helm-upg; else echo -1; echo -1; fi
echo @@unattended; if dpkg -s unattended-upgrades >/dev/null 2>&1; then echo yes; else echo no; fi
echo @@reboot; if [ -f /var/run/reboot-required ]; then echo yes; else echo no; fi
echo @@uid0; awk -F: '$3==0{print $1}' /etc/passwd
echo @@listen; ss -ltnpH 2>/dev/null
echo @@os; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
"#;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Ok,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// Correction proposée (identifiant pour `fix_script`).
    pub fix: Option<String>,
    pub fix_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub os: String,
    pub ssh_ports: Vec<u16>,
    pub findings: Vec<Finding>,
}

fn section<'a>(out: &'a str, name: &str) -> &'a str {
    let marker = format!("@@{name}\n");
    let Some(start) = out.find(&marker) else { return "" };
    let rest = &out[start + marker.len()..];
    &rest[..rest.find("\n@@").map(|i| i + 1).unwrap_or(rest.len())]
}

fn finding(id: &str, severity: Severity, title: &str, detail: &str, fix: Option<(&str, &str)>) -> Finding {
    Finding {
        id: id.into(),
        severity,
        title: title.into(),
        detail: detail.into(),
        fix: fix.map(|f| f.0.into()),
        fix_label: fix.map(|f| f.1.into()),
    }
}

/// Analyse la sortie du script d'audit.
pub fn parse_report(out: &str) -> Report {
    let mut f = Vec::new();
    let sshd: std::collections::HashMap<String, String> =
        section(out, "sshd").lines().filter_map(|l| l.split_once(' ').map(|(k, v)| (k.to_lowercase(), v.trim().to_lowercase()))).collect();
    let ssh_ports: Vec<u16> =
        section(out, "sshd").lines().filter_map(|l| l.strip_prefix("port ")).filter_map(|p| p.trim().parse().ok()).collect();

    if sshd.is_empty() {
        f.push(finding(
            "ssh-unknown",
            Severity::Low,
            "Configuration SSH illisible",
            "`sshd -T` n'a rien renvoyé : droits root nécessaires.",
            None,
        ));
    } else {
        match sshd.get("permitrootlogin").map(String::as_str) {
            Some("yes") => f.push(finding(
                "root-password",
                Severity::High,
                "Connexion root par mot de passe autorisée",
                "Un attaquant peut tenter de deviner le mot de passe root. Avec « prohibit-password », root ne peut se connecter qu'avec une clé.",
                Some(("root-prohibit-password", "Autoriser root uniquement par clé")),
            )),
            _ => f.push(finding("root-password", Severity::Ok, "Root ne peut pas se connecter par mot de passe", "", None)),
        }
        if sshd.get("passwordauthentication").map(String::as_str) == Some("yes") {
            f.push(finding(
                "password-auth",
                Severity::High,
                "Connexion SSH par mot de passe autorisée",
                "Les robots testent en permanence des mots de passe sur le port SSH. Les clés SSH sont bien plus sûres.",
                Some(("disable-password-auth", "N'autoriser que les clés SSH")),
            ));
        } else {
            f.push(finding("password-auth", Severity::Ok, "Connexion SSH par clé uniquement", "", None));
        }
        if sshd.get("x11forwarding").map(String::as_str) == Some("yes") {
            f.push(finding(
                "x11",
                Severity::Low,
                "Redirection X11 activée",
                "Rarement utile sur un serveur ; peut être désactivée dans sshd_config.",
                None,
            ));
        }
    }

    match section(out, "ufw").trim() {
        "absent" => f.push(finding(
            "firewall",
            Severity::Medium,
            "Aucun pare-feu (ufw) installé",
            "Tout service qui écoute sur une interface publique est joignable depuis Internet. Note : les ports publiés par Docker contournent ufw.",
            Some(("enable-ufw", "Installer et activer ufw (SSH, HTTP, HTTPS autorisés)")),
        )),
        s if s.contains("inactive") => f.push(finding(
            "firewall",
            Severity::Medium,
            "Pare-feu ufw inactif",
            "ufw est installé mais désactivé. Note : les ports publiés par Docker contournent ufw.",
            Some(("enable-ufw", "Activer ufw (SSH, HTTP, HTTPS autorisés)")),
        )),
        _ => f.push(finding("firewall", Severity::Ok, "Pare-feu ufw actif", "", None)),
    }

    match section(out, "f2b").trim() {
        "active" => f.push(finding("fail2ban", Severity::Ok, "fail2ban actif", "", None)),
        "absent" => f.push(finding(
            "fail2ban",
            Severity::Medium,
            "fail2ban n'est pas installé",
            "fail2ban bannit temporairement les adresses qui multiplient les échecs de connexion SSH.",
            Some(("install-fail2ban", "Installer et activer fail2ban")),
        )),
        _ => f.push(finding(
            "fail2ban",
            Severity::Medium,
            "fail2ban installé mais arrêté",
            "",
            Some(("install-fail2ban", "Activer fail2ban")),
        )),
    }

    let apt: Vec<i64> = section(out, "apt").lines().filter_map(|l| l.trim().parse().ok()).collect();
    if let [total, security, ..] = apt[..] {
        if security > 0 {
            f.push(finding(
                "updates",
                Severity::High,
                &format!("{security} mise(s) à jour de sécurité en attente"),
                &format!("{total} paquet(s) à mettre à jour au total."),
                Some(("apply-updates", "Mettre à jour (dans un terminal)")),
            ));
        } else if total > 0 {
            f.push(finding(
                "updates",
                Severity::Low,
                &format!("{total} mise(s) à jour disponible(s)"),
                "",
                Some(("apply-updates", "Mettre à jour (dans un terminal)")),
            ));
        } else if total == 0 {
            f.push(finding("updates", Severity::Ok, "Système à jour", "", None));
        }
    }
    if section(out, "unattended").trim() == "no" && apt.first().is_some_and(|t| *t >= 0) {
        f.push(finding(
            "unattended",
            Severity::Medium,
            "Mises à jour de sécurité automatiques désactivées",
            "unattended-upgrades installe chaque nuit les correctifs de sécurité.",
            Some(("enable-unattended", "Activer les mises à jour de sécurité automatiques")),
        ));
    }
    if section(out, "reboot").trim() == "yes" {
        f.push(finding(
            "reboot",
            Severity::Medium,
            "Redémarrage nécessaire",
            "Des mises à jour (noyau…) ne seront effectives qu'après un redémarrage du serveur.",
            None,
        ));
    }
    let uid0: Vec<&str> = section(out, "uid0").lines().map(str::trim).filter(|u| !u.is_empty() && *u != "root").collect();
    if !uid0.is_empty() {
        f.push(finding(
            "uid0",
            Severity::Critical,
            "Comptes avec les droits root (UID 0)",
            &format!("{} : un compte UID 0 autre que root est un signe classique de compromission.", uid0.join(", ")),
            None,
        ));
    }

    // Services qui écoutent sur toutes les interfaces, hors SSH/HTTP/HTTPS.
    let mut exposed = Vec::new();
    for line in section(out, "listen").lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let Some(local) = cols.get(3) else { continue };
        let Some((addr, port)) = local.rsplit_once(':') else { continue };
        let Ok(port) = port.parse::<u16>() else { continue };
        let public = matches!(addr, "0.0.0.0" | "*" | "[::]" | "::");
        if !public || ssh_ports.contains(&port) || port == 80 || port == 443 {
            continue;
        }
        let process = line.split("((\"").nth(1).and_then(|p| p.split('"').next()).unwrap_or("?").to_string();
        if !exposed.iter().any(|(p, _): &(u16, String)| *p == port) {
            exposed.push((port, process));
        }
    }
    for (port, process) in exposed {
        let docker = process.starts_with("docker");
        f.push(finding(
            &format!("exposed-{port}"),
            Severity::Medium,
            &format!("Port {port} exposé sur Internet ({process})"),
            if docker {
                "Publié par Docker (qui contourne le pare-feu). Restreins-le à 127.0.0.1 depuis l'onglet Docker et accède-y par un tunnel."
            } else {
                "Si ce service n'a pas à être public, fais-le écouter sur 127.0.0.1 et accède-y par un tunnel."
            },
            None,
        ));
    }

    f.sort_by_key(|x| x.severity);
    Report { os: section(out, "os").trim().to_string(), ssh_ports, findings: f }
}

pub async fn audit(conn: &Connection, sudo: Option<&str>) -> Result<Report> {
    let out = conn.exec_sudo(AUDIT_SCRIPT, sudo, None).await?;
    Ok(parse_report(&out.stdout))
}

/// Modification de sshd : drop-in `00-helm.conf` (lu en premier, donc prioritaire sur
/// `50-cloud-init.conf`) si sshd_config inclut le dossier, sinon directive en tête du fichier.
/// `$1` = directives (une par ligne). Sauvegarde, `sshd -t`, puis reload.
const SSHD_SCRIPT: &str = r#"set -u
CONF=/etc/ssh/sshd_config
BK=/var/backups/helm/sshd_config.$(date +%Y%m%d-%H%M%S)
mkdir -p /var/backups/helm && cp -a "$CONF" "$BK" || { echo "@@FAILED sauvegarde"; exit 1; }
DROP=/etc/ssh/sshd_config.d/00-helm.conf
[ -f "$DROP" ] && cp -a "$DROP" "$BK.drop"
if grep -Eqi '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$CONF"; then
  touch "$DROP"
  printf '%s\n' "$1" | while IFS=' ' read -r key val; do
    [ -n "$key" ] || continue
    sed -i "/^[[:space:]]*$key[[:space:]]/Id" "$DROP"
    echo "$key $val" >> "$DROP"
  done
  chmod 644 "$DROP"
else
  printf '%s\n' "$1" | while IFS=' ' read -r key val; do
    [ -n "$key" ] || continue
    sed -i "s/^[[:space:]]*$key[[:space:]].*/# & (désactivé par Helm)/I" "$CONF"
    sed -i "1i $key $val" "$CONF"
  done
fi
if ! sshd -t 2>/tmp/.helm-sshd; then
  cp -a "$BK" "$CONF"; if [ -f "$BK.drop" ]; then cp -a "$BK.drop" "$DROP"; else rm -f "$DROP"; fi
  echo "@@FAILED"; cat /tmp/.helm-sshd; exit 2
fi
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload
echo "@@OK $BK"
"#;

/// Restaure sshd_config (et le drop-in) depuis la sauvegarde `$1`.
const SSHD_ROLLBACK: &str = r#"BK="$1"
cp -a "$BK" /etc/ssh/sshd_config
if [ -f "$BK.drop" ]; then cp -a "$BK.drop" /etc/ssh/sshd_config.d/00-helm.conf; else rm -f /etc/ssh/sshd_config.d/00-helm.conf; fi
sshd -t && { systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload; }
echo "@@ROLLEDBACK"
"#;

const UFW_SCRIPT: &str = r#"set -e
command -v ufw >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
for p in $(sshd -T 2>/dev/null | awk '/^port /{print $2}'); do ufw allow "$p/tcp"; done
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
echo "@@OK ufw"
"#;

const FAIL2BAN_SCRIPT: &str = "set -e\ncommand -v fail2ban-client >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban\nsystemctl enable --now fail2ban\necho '@@OK fail2ban'\n";

const UNATTENDED_SCRIPT: &str = "set -e\nDEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades\n\
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections\n\
DEBIAN_FRONTEND=noninteractive dpkg-reconfigure -f noninteractive unattended-upgrades\necho '@@OK unattended'\n";

/// Ce qu'une correction va faire, pour l'afficher avant exécution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixPlan {
    pub id: String,
    pub description: String,
    pub script: String,
    /// La correction touche l'accès SSH : une nouvelle connexion doit être vérifiée.
    pub needs_verification: bool,
}

pub fn fix_plan(id: &str) -> Result<FixPlan> {
    let plan = |description: &str, script: String, needs_verification: bool| FixPlan {
        id: id.into(),
        description: description.into(),
        script,
        needs_verification,
    };
    Ok(match id {
        "root-prohibit-password" => plan(
            "root ne pourra plus se connecter qu'avec une clé SSH. Une nouvelle connexion est testée ; en cas d'échec, l'ancienne configuration est restaurée automatiquement.",
            SSHD_SCRIPT.replace("\"$1\"", "'PermitRootLogin prohibit-password'"),
            true,
        ),
        "disable-password-auth" => plan(
            "Seules les clés SSH seront acceptées. Une nouvelle connexion est testée ; en cas d'échec, l'ancienne configuration est restaurée automatiquement.",
            SSHD_SCRIPT.replace("\"$1\"", "'PasswordAuthentication no\nKbdInteractiveAuthentication no'"),
            true,
        ),
        "enable-ufw" => plan(
            "Installe/active ufw en autorisant SSH (ton port actuel), HTTP et HTTPS ; tout le reste entrant est bloqué. Une nouvelle connexion est testée ; en cas d'échec, ufw est désactivé.",
            UFW_SCRIPT.to_string(),
            true,
        ),
        "install-fail2ban" => plan("Installe fail2ban avec sa protection SSH par défaut et l'active au démarrage.", FAIL2BAN_SCRIPT.to_string(), false),
        "enable-unattended" => plan("Installe unattended-upgrades et active l'installation automatique des correctifs de sécurité.", UNATTENDED_SCRIPT.to_string(), false),
        _ => return Err(Error::Other(format!("correction inconnue : {id}"))),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixOutcome {
    pub ok: bool,
    pub output: String,
    /// Identifiant de retour arrière (sauvegarde sshd, ou `ufw`), si la correction en a un.
    pub rollback: Option<String>,
}

pub async fn apply_fix(conn: &Connection, sudo: Option<&str>, id: &str) -> Result<FixOutcome> {
    crate::ssh::long(async move {
        let plan = fix_plan(id)?;
        let out = conn.exec_sudo(&format!("bash -c {} helm-fix", crate::ssh::shell_quote(&plan.script)), sudo, None).await?;
        let text = format!("{}{}", out.stdout, out.stderr);
        let ok = out.success() && text.contains("@@OK");
        let rollback = text
            .lines()
            .find_map(|l| l.strip_prefix("@@OK "))
            .map(|s| s.trim().to_string())
            .filter(|s| s != "fail2ban" && s != "unattended");
        Ok(FixOutcome { ok, output: text.replace("@@OK", "OK").replace("@@FAILED", "ÉCHEC"), rollback })
    })
    .await
}

/// Annule une correction SSH ou pare-feu (appelé si la connexion de contrôle échoue).
pub async fn rollback(conn: &Connection, sudo: Option<&str>, token: &str) -> Result<String> {
    let cmd = if token == "ufw" {
        "ufw --force disable && echo @@ROLLEDBACK".to_string()
    } else if token.starts_with("/var/backups/helm/sshd_config.") && !token.contains("..") && !token.contains(' ') {
        format!("bash -c {} helm-rollback {}", crate::ssh::shell_quote(SSHD_ROLLBACK), crate::ssh::shell_quote(token))
    } else {
        return Err(Error::Other("jeton de retour arrière invalide".into()));
    };
    Ok(conn.exec_sudo(&cmd, sudo, None).await?.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@@sshd\nport 6666\npermitrootlogin yes\npasswordauthentication yes\nx11forwarding yes\n@@ufw\nStatus: inactive\n@@f2b\nabsent\n@@apt\n12\n3\n@@unattended\nno\n@@reboot\nyes\n@@uid0\nroot\ntoor\n@@listen\nLISTEN 0 4096 0.0.0.0:6666 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\nLISTEN 0 4096 0.0.0.0:3307 0.0.0.0:* users:((\"docker-proxy\",pid=2,fd=4))\nLISTEN 0 4096 127.0.0.1:8081 0.0.0.0:* users:((\"docker-proxy\",pid=3,fd=4))\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:((\"nginx\",pid=4,fd=6))\n@@os\nUbuntu 24.04 LTS\n";

    #[test]
    fn report() {
        let r = parse_report(SAMPLE);
        assert_eq!(r.ssh_ports, vec![6666]);
        assert_eq!(r.os, "Ubuntu 24.04 LTS");
        let ids: Vec<&str> = r.findings.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(r.findings[0].id, "uid0", "le critique d'abord");
        for id in ["root-password", "password-auth", "firewall", "fail2ban", "updates", "unattended", "reboot", "exposed-3307", "x11"] {
            assert!(ids.contains(&id), "{id} manquant : {ids:?}");
        }
        assert!(!ids.contains(&"exposed-8081"), "127.0.0.1 n'est pas exposé");
        assert!(!ids.contains(&"exposed-6666"), "le port SSH est normal");
        let upd = r.findings.iter().find(|f| f.id == "updates").unwrap();
        assert_eq!(upd.severity, Severity::High);
    }

    #[test]
    fn plans() {
        let p = fix_plan("disable-password-auth").unwrap();
        assert!(p.needs_verification);
        assert!(p.script.contains("PasswordAuthentication no"));
        assert!(p.script.contains("00-helm.conf"));
        assert!(fix_plan("rm-rf").is_err());
    }
}
