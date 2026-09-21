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
