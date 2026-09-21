//! Accès au serveur : comptes pouvant se connecter, droits sudo, et clés SSH autorisées.
//!
//! Garde-fou : la clé avec laquelle Helm se connecte ne peut pas être retirée depuis Helm (tu te
//! couperais l'accès). Le fichier `authorized_keys` est réécrit en place, en root, après copie
//! de sauvegarde (`authorized_keys.helm-avant`), en conservant propriétaire et permissions.

use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

/// Comptes avec un shell de connexion : root et les utilisateurs « humains » (UID ≥ 1000).
const USERS_SCRIPT: &str = r#"getent passwd | while IFS=: read -r name _ uid gid gecos home shell; do
  case "$shell" in */nologin|*/false|"") continue;; esac
  [ "$uid" -eq 0 ] || [ "$uid" -ge 1000 ] || continue
  echo "@@USER $name:$uid:$home:$shell"
  echo "@@GROUPS $(id -nG "$name" 2>/dev/null)"
  echo "@@LAST $(lastlog -u "$name" 2>/dev/null | tail -n1 | tr -s ' ')"
  if [ -f "$home/.ssh/authorized_keys" ]; then echo "@@KEYS"; cat "$home/.ssh/authorized_keys"; fi
  echo "@@END"
done
"#;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    /// Ligne complète, identifiant exact pour la suppression.
    pub line: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: String,
    /// Options (`command="…"`, `restrict`…), par exemple les clés de déploiement.
    pub options: String,
    /// Clé utilisée par Helm pour se connecter à ce serveur.
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub name: String,
    pub uid: u32,
    pub home: String,
    pub shell: String,
    pub groups: Vec<String>,
    pub admin: bool,
    pub last_login: String,
    pub keys: Vec<Key>,
}

fn valid_user(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c)) && !name.starts_with('-')
}

/// Découpe une ligne `authorized_keys` : options éventuelles, type, clé, commentaire.
pub fn parse_key(line: &str, current: Option<&str>) -> Option<Key> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    // Les options précèdent le type ; elles peuvent contenir des espaces entre guillemets.
    let bytes = line.as_bytes();
    let (mut i, mut quoted) = (0, false);
    let mut start_of_key = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => quoted = !quoted,
            b' ' if !quoted => {
                let next = &line[i + 1..];
                if next.starts_with("ssh-") || next.starts_with("ecdsa-") || next.starts_with("sk-") {
                    start_of_key = i + 1;
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let (options, rest) = if line.starts_with("ssh-") || line.starts_with("ecdsa-") || line.starts_with("sk-") {
        ("", line)
    } else if start_of_key > 0 {
        (line[..start_of_key].trim(), &line[start_of_key..])
    } else {
        return None;
    };
    let mut parts = rest.splitn(3, ' ');
    let (algorithm, data) = (parts.next()?, parts.next()?);
    let comment = parts.next().unwrap_or("").trim().to_string();
    let fingerprint =
        PublicKey::from_openssh(&format!("{algorithm} {data}")).map(|k| k.fingerprint(HashAlg::Sha256).to_string()).unwrap_or_default();
    Some(Key {
        line: line.to_string(),
        algorithm: algorithm.to_string(),
        current: current.is_some_and(|c| !fingerprint.is_empty() && c == fingerprint),
        fingerprint,
        comment,
        options: options.to_string(),
    })
}

pub fn parse_users(out: &str, current_key: Option<&str>) -> Vec<User> {
    let mut users = Vec::new();
    let mut user: Option<User> = None;
    let mut in_keys = false;
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("@@USER ") {
            let f: Vec<&str> = rest.splitn(4, ':').collect();
            if f.len() == 4 {
                user = Some(User {
                    name: f[0].into(),
                    uid: f[1].parse().unwrap_or(0),
                    home: f[2].into(),
                    shell: f[3].into(),
                    groups: vec![],
                    admin: f[1] == "0",
                    last_login: String::new(),
                    keys: vec![],
                });
            }
            in_keys = false;
        } else if let Some(g) = line.strip_prefix("@@GROUPS ") {
            if let Some(u) = user.as_mut() {
                u.groups = g.split_whitespace().map(str::to_string).collect();
                u.admin |= u.groups.iter().any(|g| g == "sudo" || g == "wheel" || g == "admin");
            }
        } else if let Some(l) = line.strip_prefix("@@LAST ") {
            if let Some(u) = user.as_mut() {
                // « alice pts/0 198.51.100.23 Sun Sep 21 14:47:41 +0000 2026 » ou « **Never logged in** ».
                let parts: Vec<&str> = l.split(' ').collect();
                u.last_login =
                    if l.contains("Never") { "jamais".into() } else { parts.iter().skip(2).copied().collect::<Vec<_>>().join(" ") };
            }
        } else if line == "@@KEYS" {
            in_keys = true;
        } else if line == "@@END" {
            users.extend(user.take());
            in_keys = false;
        } else if in_keys {
            if let (Some(u), Some(k)) = (user.as_mut(), parse_key(line, current_key)) {
                u.keys.push(k);
            }
        }
    }
    users
}

/// `current_key` : empreinte SHA256 de la clé utilisée par Helm, si connue.
pub async fn users(conn: &Connection, sudo: Option<&str>, current_key: Option<&str>) -> Result<Vec<User>> {
    let out = conn.exec_sudo(USERS_SCRIPT, sudo, None).await?.into_result()?;
    Ok(parse_users(&out.stdout, current_key))
}

async fn rewrite_keys(conn: &Connection, sudo: Option<&str>, user: &User, lines: &[String]) -> Result<()> {
    let dir = format!("{}/.ssh", user.home);
    let file = format!("{dir}/authorized_keys");
    let (d, f, u) = (shell_quote(&dir), shell_quote(&file), shell_quote(&user.name));
    let mut content = lines.join("\n");
    content.push('\n');
    let script = format!(
        "set -e\ninstall -d -m 700 -o {u} -g \"$(id -gn {u})\" {d}\n[ -f {f} ] && cp -p {f} {f}.helm-avant || true\ncat > {f}.helm-new\nchown {u}:\"$(id -gn {u})\" {f}.helm-new\nchmod 600 {f}.helm-new\nmv -f {f}.helm-new {f}\n"
    );
    conn.exec_sudo(&format!("sh -c {}", shell_quote(&script)), sudo, Some(content.as_bytes())).await?.into_result()?;
    Ok(())
}

async fn find_user(conn: &Connection, sudo: Option<&str>, name: &str, current_key: Option<&str>) -> Result<User> {
    if !valid_user(name) {
        return Err(Error::Other("nom d'utilisateur invalide".into()));
    }
    users(conn, sudo, current_key)
        .await?
        .into_iter()
        .find(|u| u.name == name)
        .ok_or_else(|| Error::Other(format!("utilisateur {name} introuvable")))
}

/// Ajoute une clé publique (une seule ligne OpenSSH, sans options).
pub async fn add_key(conn: &Connection, sudo: Option<&str>, name: &str, public_key: &str) -> Result<()> {
    let key = public_key.trim();
    if key.contains('\n') || PublicKey::from_openssh(key).is_err() {
        return Err(Error::Other("clé publique invalide : colle une seule ligne « ssh-ed25519 AAAA… commentaire »".into()));
    }
    let user = find_user(conn, sudo, name, None).await?;
    let new = parse_key(key, None).ok_or_else(|| Error::Other("clé publique invalide".into()))?;
    if user.keys.iter().any(|k| k.fingerprint == new.fingerprint) {
        return Err(Error::Other("cette clé est déjà autorisée pour cet utilisateur".into()));
    }
    let mut lines: Vec<String> = user.keys.iter().map(|k| k.line.clone()).collect();
    lines.push(key.to_string());
    rewrite_keys(conn, sudo, &user, &lines).await
}

/// Retire une clé (identifiée par sa ligne exacte). Refuse de retirer la clé qu'utilise Helm.
pub async fn remove_key(conn: &Connection, sudo: Option<&str>, name: &str, line: &str, current_key: Option<&str>) -> Result<()> {
    let user = find_user(conn, sudo, name, current_key).await?;
    let target = user
        .keys
        .iter()
        .find(|k| k.line == line.trim())
        .ok_or_else(|| Error::Other("clé introuvable (fichier modifié entre-temps ?)".into()))?;
    if target.current {
        return Err(Error::Other("c'est la clé avec laquelle Helm se connecte : la retirer te couperait l'accès.".into()));
    }
    let lines: Vec<String> = user.keys.iter().filter(|k| k.line != target.line).map(|k| k.line.clone()).collect();
    rewrite_keys(conn, sudo, &user, &lines).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    #[test]
    fn keys_with_options() {
        let k = parse_key(&format!("{ED} nathan@pc"), None).unwrap();
        assert_eq!((k.algorithm.as_str(), k.comment.as_str(), k.options.as_str()), ("ssh-ed25519", "nathan@pc", ""));
        assert!(k.fingerprint.starts_with("SHA256:"));
        let d =
            parse_key(&format!("command=\"sudo -n /usr/local/bin/helm-deploy app\",restrict {ED} helm-deploy:app"), Some(&k.fingerprint))
                .unwrap();
        assert_eq!(d.options, "command=\"sudo -n /usr/local/bin/helm-deploy app\",restrict");
        assert!(d.current, "même clé que celle de Helm");
        assert!(parse_key("# commentaire", None).is_none());
    }

    #[test]
    fn users() {
        let out = format!("@@USER root:0:/root:/bin/bash\n@@GROUPS root\n@@LAST root **Never logged in**\n@@END\n@@USER alice:1000:/home/alice:/bin/bash\n@@GROUPS alice sudo docker\n@@LAST alice pts/0 198.51.100.23 Sun Sep 21 14:47:41 +0000 2026\n@@KEYS\n{ED} pc\n@@END\n");
        let u = parse_users(&out, None);
        assert_eq!(u.len(), 2);
        assert!(u[0].admin && u[1].admin);
        assert_eq!(u[1].keys.len(), 1);
        assert_eq!(u[1].last_login, "198.51.100.23 Sun Sep 21 14:47:41 +0000 2026");
        assert_eq!(u[0].last_login, "jamais");
        assert!(!valid_user("a;rm") && valid_user("deploy"));
    }
}
