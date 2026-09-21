//! Test de fumée contre l'environnement `testenv` (localhost:2222).
//! `cargo run -p helm-core --example smoke`

use helm_core::{Auth, ConnectParams, Connection, Error};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let params = |user: &str, pw: &str, fp: Option<String>| ConnectParams {
        host: "127.0.0.1".into(),
        port: 2222,
        username: user.into(),
        auth: Auth::Password { password: pw.into() },
        known_fingerprint: fp,
    };

    // 1. Hôte inconnu : la connexion doit être refusée avec l'empreinte.
    let fp = match Connection::connect(params("root", "helm", None)).await {
        Err(Error::UnknownHostKey(fp)) => fp,
        Err(e) => return Err(format!("attendu UnknownHostKey, obtenu {e}").into()),
        Ok(_) => return Err("un hôte inconnu a été accepté".into()),
    };
    println!("✓ hôte inconnu détecté : {fp}");

    // 2. Mauvaise empreinte : refus.
    match Connection::connect(params("root", "helm", Some("SHA256:faux".into()))).await {
        Err(Error::HostKeyMismatch { .. }) => println!("✓ empreinte modifiée détectée"),
        Err(e) => return Err(format!("attendu HostKeyMismatch, obtenu {e}").into()),
        Ok(_) => return Err("empreinte fausse acceptée".into()),
    }

    // 3. Mauvais mot de passe.
    match Connection::connect(params("root", "nope", Some(fp.clone()))).await {
        Err(Error::Auth(_)) => println!("✓ mauvais mot de passe refusé"),
        other => return Err(format!("attendu Auth, obtenu {:?}", other.err()).into()),
    }

    // 4. Connexion root + exec.
    let root = Connection::connect(params("root", "helm", Some(fp.clone()))).await?;
    println!("✓ connecté en root, whoami = {}", root.run("whoami").await?.trim());
    let out = root.exec("echo err >&2; exit 3", None).await?;
    assert_eq!((out.exit_code, out.stderr.trim()), (3, "err"));
    println!("✓ code de sortie et stderr récupérés");
    let out = root.exec("cat", Some(b"via stdin")).await?;
    assert_eq!(out.stdout, "via stdin");
    println!("✓ stdin transmis");

    // 5. sudo avec mot de passe pour un utilisateur non root.
    let deploy = Connection::connect(params("deploy", "deploy", Some(fp.clone()))).await?;
    let out = deploy.exec_sudo("id -u", Some("deploy"), None).await?;
    assert_eq!(out.stdout.trim(), "0", "sudo : {out:?}");
    println!("✓ sudo -S fonctionne pour deploy");
    let out = deploy.exec_sudo("id -u", Some("mauvais"), None).await?;
    assert!(!out.success());
    println!("✓ mauvais mot de passe sudo refusé");

    // 6. SFTP.
    let sftp = root.sftp().await?;
    let entries: Vec<_> = sftp.read_dir("/etc/nginx").await?.map(|e| e.file_name()).collect();
    assert!(entries.iter().any(|n| n == "nginx.conf"));
    println!("✓ SFTP : {} entrées dans /etc/nginx", entries.len());

    // 6b. Transferts : envoi d'un dossier local puis téléchargement et comparaison.
    use helm_core::sftp as fs;
    let tmp = std::env::temp_dir().join("helm-smoke");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(tmp.join("src/sub"))?;
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(tmp.join("src/big.bin"), &big)?;
    std::fs::write(tmp.join("src/sub/a.txt"), "hello")?;
    let _ = fs::remove(&sftp, "/tmp/src").await;
    let noop = |_p: fs::Progress| {};
    fs::upload(&sftp, &tmp.join("src"), "/tmp", &noop).await?;
    std::fs::create_dir_all(tmp.join("back"))?;
    fs::download(&sftp, "/tmp/src", &tmp.join("back"), &noop).await?;
    assert_eq!(std::fs::read(tmp.join("back/src/big.bin"))?, big);
    assert_eq!(std::fs::read_to_string(tmp.join("back/src/sub/a.txt"))?, "hello");
    fs::remove(&sftp, "/tmp/src").await?;
    assert!(!sftp.try_exists("/tmp/src").await?);
    println!("✓ envoi/téléchargement récursif (3 Mo) identiques, suppression récursive");

    // 6c. Écriture atomique en conservant les permissions.
    fs::write_text(&sftp, "/tmp/perm.txt", "v1").await?;
    fs::chmod(&sftp, "/tmp/perm.txt", 0o640).await?;
    fs::write_text(&sftp, "/tmp/perm.txt", "v2").await?;
    assert_eq!(fs::read_text(&sftp, "/tmp/perm.txt").await?, "v2");
    assert_eq!(sftp.metadata("/tmp/perm.txt").await?.permissions.unwrap() & 0o777, 0o640);
    println!("✓ écriture atomique, permissions conservées");

    // 6d. Lecture/écriture sudo d'un fichier root pour deploy.
    root.run("printf secret > /root/only-root.txt && chmod 600 /root/only-root.txt").await?;
    assert_eq!(deploy.read_file_sudo("/root/only-root.txt", Some("deploy")).await?, "secret");
    deploy.write_file_sudo("/root/only-root.txt", "modifié", Some("deploy")).await?;
    assert_eq!(root.run("cat /root/only-root.txt; stat -c %a /root/only-root.txt").await?, "modifié600\n");
    println!("✓ lecture/écriture sudo, permissions conservées");

    // 7. Shell interactif.
    let mut shell = root.open_shell(80, 24).await?;
    shell.data(&b"echo HELM_OK; exit\n"[..]).await?;
    let mut seen = String::new();
    while let Some(msg) = shell.wait().await {
        if let helm_core::russh::ChannelMsg::Data { data } = msg {
            seen.push_str(&String::from_utf8_lossy(&data));
        }
    }
    assert!(seen.contains("HELM_OK"));
    println!("✓ shell interactif avec PTY");
    Ok(())
}
