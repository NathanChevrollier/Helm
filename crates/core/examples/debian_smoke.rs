//! Test de fumée contre le VPS Debian réaliste du `testenv` (localhost:2223, admin/admin, fail2ban).
//! `cargo run -p helm-core --example debian_smoke`
//!
//! Vérifie ce que le premier faux VPS (root, Ubuntu) ne montrait pas : détection des outils de
//! /usr/sbin pour un utilisateur normal, sudo avec mot de passe, fail2ban, écriture de fichiers
//! appartenant à root, et diagnostic d'un vrai bannissement. Débannit tout à la fin.

use std::time::Duration;

use helm_core::{diagnose, fail2ban, nginx, sftp, Auth, ConnectParams, Connection, Error};

const SUDO: Option<&str> = Some("admin");

async fn connect(pw: &str, fp: Option<String>) -> Result<Connection, Error> {
    Connection::connect(ConnectParams {
        host: "127.0.0.1".into(),
        port: 2223,
        username: "admin".into(),
        auth: Auth::Password { password: pw.into() },
        known_fingerprint: fp,
    })
    .await
}

fn check(ok: bool, what: &str) -> Result<(), Box<dyn std::error::Error>> {
    if ok {
        println!("ok  {what}");
        Ok(())
    } else {
        Err(format!("ÉCHEC : {what}").into())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fp = match connect("admin", None).await {
        Err(Error::UnknownHostKey(fp)) => fp,
        other => return Err(format!("attendu UnknownHostKey, obtenu {:?}", other.err()).into()),
    };
    let c = connect("admin", Some(fp.clone())).await?;

    // Outils de /usr/sbin, invisibles dans le PATH d'un utilisateur Debian normal.
    let st = nginx::discover(&c, SUDO).await?;
    check(!st.files.is_empty(), "nginx détecté pour un utilisateur non root")?;
    check(c.exec("command -v ufw", None).await?.success(), "ufw détecté")?;

    // sudo avec mot de passe.
    check(c.exec_sudo("id -u", SUDO, None).await?.stdout.trim() == "0", "sudo avec mot de passe")?;

    // Écriture d'un fichier root modifiable : le propriétaire est conservé.
    c.exec_sudo("printf v1 > /tmp/root-file && chmod 666 /tmp/root-file", SUDO, None).await?.into_result()?;
    let s = c.sftp().await?;
    sftp::write_text(&s, Some(&c), "/tmp/root-file", "v2").await?;
    check(c.run("stat -c %U /tmp/root-file").await?.trim() == "root", "propriétaire conservé à l'écriture")?;

    // fail2ban : état, bannissement manuel puis déblocage, exceptions.
    c.exec_sudo("fail2ban-client set sshd banip 203.0.113.9", SUDO, None).await?.into_result()?;
    let state = fail2ban::state(&c, SUDO).await?;
    let sshd = state.jails.iter().find(|j| j.name == "sshd").ok_or("jail sshd absent")?;
    check(sshd.banned.contains(&"203.0.113.9".to_string()) && sshd.maxretry == 3, "état fail2ban lu")?;
    fail2ban::unban(&c, SUDO, "sshd", "203.0.113.9").await?;
    check(fail2ban::state(&c, SUDO).await?.jails[0].banned.is_empty(), "déblocage")?;
    fail2ban::set_ignore(&c, SUDO, &["198.51.100.7".into()]).await?;
    check(fail2ban::state(&c, SUDO).await?.jails[0].ignoreip.contains(&"198.51.100.7".to_string()), "exception ajoutée")?;
    check(fail2ban::set_ignore(&c, SUDO, &["1.2.3.4; reboot".into()]).await.is_err(), "adresse invalide refusée")?;
    fail2ban::set_ignore(&c, SUDO, &[]).await?;
    drop(c);

    // Vrai bannissement : le diagnostic doit le reconnaître, sans tenter d'authentification.
    for _ in 0..4 {
        let _ = connect("mauvais", Some(fp.clone())).await;
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    let d = diagnose::diagnose("127.0.0.1", 2223).await;
    println!("    diagnostic : {}", d.verdict);
    let banned = d.probably_banned;
    let _ = std::process::Command::new("docker").args(["exec", "helm-test-debian", "fail2ban-client", "unban", "--all"]).status();
    check(banned, "bannissement reconnu par le diagnostic")?;
    println!("Tout est bon.");
    Ok(())
}
