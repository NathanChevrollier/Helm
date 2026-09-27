//! Vérifie la prise en compte du mot de passe sudo enregistré dans le profil, dans tous les cas :
//! sudo avec mot de passe (y compris des caractères spéciaux), sudo sans mot de passe (NOPASSWD)
//! avec ou sans mot de passe renseigné, mauvais mot de passe, utilisateur sans sudo, et root.
//!
//! Serveur de test : utilisateurs `avecmdp` (sudo, mot de passe `p@ss "w0rd" $x \y`), `sansmdp`
//! (NOPASSWD), `pasadmin` (sans sudo), root.
//! `ZENYTT_SMOKE_PORT=52623 cargo run -p zenytt-core --example sudo_smoke`

use zenytt_core::{Auth, ConnectParams, Connection, Error};

const SPECIAL: &str = "p@ss \"w0rd\" $x \\y";
/// Contenu écrit en root : sa première ligne ne doit jamais être remplacée par le mot de passe.
const CONTENT: &str = "ligne 1\nligne 2 $HOME `id`\n";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("ZENYTT_SMOKE_PORT")?.parse()?;
    let params = |user: &str, pw: &str, fp: Option<String>| ConnectParams {
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        auth: Auth::Password { password: pw.into() },
        known_fingerprint: fp,
    };
    let fp = match Connection::connect(params("root", "rootpw", None)).await {
        Err(Error::UnknownHostKey(fp)) => fp,
        other => return Err(format!("empreinte attendue, obtenu {:?}", other.err()).into()),
    };
    let connect = |user: &'static str, pw: &'static str| Connection::connect(params(user, pw, Some(fp.clone())));
    let mut failures = Vec::new();
    let mut check = |ok: bool, what: &str, detail: String| {
        println!("{} {what}{}", if ok { "✓" } else { "✗" }, if ok { String::new() } else { format!(" — {detail}") });
        if !ok {
            failures.push(what.to_string());
        }
    };

    // Écrit CONTENT en root dans un fichier propre à chaque cas, puis le relit tel qu'il est sur le disque.
    async fn write_and_read(c: &Connection, pw: Option<&str>, file: &str) -> Result<String, String> {
        c.write_file_sudo(file, CONTENT, pw).await.map_err(|e| e.to_string())?;
        c.exec_sudo(&format!("cat {file}"), pw, None).await.map_err(|e| e.to_string())?.into_result().map(|o| o.stdout).map_err(|e| e.to_string())
    }

    for (user, login_pw, sudo_pw, label) in [
        ("avecmdp", SPECIAL, Some(SPECIAL), "sudo avec mot de passe (caractères spéciaux)"),
        ("sansmdp", "sansmdp", None, "sudo sans mot de passe (NOPASSWD), rien de renseigné"),
        ("sansmdp", "sansmdp", Some("un mot de passe renseigné quand même"), "sudo sans mot de passe (NOPASSWD), mot de passe renseigné"),
        ("root", "rootpw", Some("inutile"), "root, mot de passe renseigné"),
        ("root", "rootpw", None, "root, rien de renseigné"),
    ] {
        let c = connect(user, login_pw).await?;
        let id = c.exec_sudo("id -u", sudo_pw, None).await.map(|o| o.stdout.trim().to_string());
        check(matches!(&id, Ok(u) if u == "0"), &format!("{label} : commande en root"), format!("{id:?}"));
        let file = format!("/tmp/zenytt-sudo-{user}-{}", sudo_pw.is_some());
        let read = write_and_read(&c, sudo_pw, &file).await;
        check(read.as_deref() == Ok(CONTENT), &format!("{label} : fichier écrit à l'identique"), format!("{read:?}"));
    }

    // Mauvais mot de passe : erreur claire, et le fichier n'est pas créé.
    let c = connect("avecmdp", SPECIAL).await?;
    let wrong = c.write_file_sudo("/tmp/zenytt-sudo-faux", CONTENT, Some("mauvais")).await;
    let exists = c.exec("test -e /tmp/zenytt-sudo-faux", None).await?.success();
    check(wrong.is_err() && !exists, "mauvais mot de passe : refusé, rien d'écrit", format!("{wrong:?}, fichier créé : {exists}"));
    if let Err(e) = &wrong {
        println!("  message : {e}");
    }
    // Mot de passe requis mais non renseigné : erreur qui dit quoi faire.
    let missing = c.exec_sudo("id -u", None, None).await;
    check(missing.is_err(), "mot de passe requis mais absent : refusé", format!("{missing:?}"));
    if let Err(e) = &missing {
        println!("  message : {e}");
    }
    // Utilisateur sans droits sudo.
    let c = connect("pasadmin", "pasadmin").await?;
    let denied = c.exec_sudo("id -u", Some("pasadmin"), None).await;
    check(denied.is_err(), "utilisateur sans sudo : refusé", format!("{denied:?}"));
    if let Err(e) = &denied {
        println!("  message : {e}");
    }

    if failures.is_empty() {
        println!("SUDO_SMOKE_OK");
        Ok(())
    } else {
        Err(format!("{} échec(s) : {}", failures.len(), failures.join(" ; ")).into())
    }
}
