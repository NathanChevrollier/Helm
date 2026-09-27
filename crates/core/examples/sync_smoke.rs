//! Test de bout en bout de l'installation du serveur de synchronisation, contre un serveur Linux
//! avec Docker joignable en SSH (root). Le binaire `zenytt-sync` doit avoir été compilé
//! (`pnpm build:agent`).
//!
//! `ZENYTT_SMOKE_PORT=52622 ZENYTT_SMOKE_PASSWORD=… cargo run -p zenytt-core --example sync_smoke`

use zenytt_core::{sync_server, Auth, ConnectParams, Connection, Error};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("ZENYTT_SMOKE_PORT")?.parse()?;
    let password = std::env::var("ZENYTT_SMOKE_PASSWORD")?;
    let params = |fp: Option<String>| ConnectParams {
        host: "127.0.0.1".into(),
        port,
        username: "root".into(),
        auth: Auth::Password { password: password.clone() },
        known_fingerprint: fp,
    };
    let fp = match Connection::connect(params(None)).await {
        Err(Error::UnknownHostKey(fp)) => fp,
        other => return Err(format!("empreinte attendue, obtenu {:?}", other.err()).into()),
    };
    let conn = Connection::connect(params(Some(fp))).await?;

    let binary: &'static [u8] = Box::leak(std::fs::read("target/x86_64-unknown-linux-musl/release/zenytt-sync")?.into_boxed_slice());
    let binary_for = |arch: &str| (arch == "x86_64").then_some(binary);

    // Test rejouable : on repart d'un serveur sans synchronisation.
    conn.run(&format!(
        "cd {d} 2>/dev/null && docker compose -p {p} down >/dev/null 2>&1; rm -rf {d}; true",
        d = sync_server::DIR,
        p = sync_server::PROJECT
    ))
    .await?;

    // 1. Première installation : nouveau port et nouveau jeton.
    assert!(sync_server::existing(&conn, None).await?.is_none(), "serveur vierge attendu");
    let sync_port = sync_server::free_port(&conn, sync_server::DEFAULT_PORT).await?;
    let token = sync_server::new_token()?;
    sync_server::install(&conn, None, binary_for, sync_port, &token).await?;
    assert!(sync_server::wait_healthy(&conn, sync_port).await, "le serveur ne répond pas");
    println!("✓ installé et joignable sur 127.0.0.1:{sync_port}");

    // 2. Le jeton n'apparaît dans aucune ligne de commande, le .env n'est lisible que par root (et docker).
    let env_mode = conn.run(&format!("stat -c %a {}/.env", sync_server::DIR)).await?;
    assert!(env_mode.trim() == "600" || env_mode.trim() == "640", "droits du .env : {env_mode}");
    assert_eq!(sync_server::existing(&conn, None).await?, Some((sync_port, token.clone())));
    println!("✓ .env protégé ({}) et relu à l'identique", env_mode.trim());

    // 3. Le jeton est exigé, et accepté.
    let curl =
        |auth: &str| format!("wget -qS -O- --header='Authorization: Bearer {auth}' http://127.0.0.1:{sync_port}/v1/state 2>&1 | head -1");
    let refused = conn.run(&format!("docker run --rm --network host alpine:3 sh -c \"{}\" || true", curl("faux"))).await?;
    let accepted = conn.run(&format!("docker run --rm --network host alpine:3 sh -c \"{}\" || true", curl(&token))).await?;
    println!("  jeton faux : {} / bon jeton : {}", refused.trim(), accepted.trim());
    assert!(refused.contains("401"), "jeton faux accepté : {refused}");
    assert!(accepted.contains("404") || accepted.contains("200"), "bon jeton refusé : {accepted}");
    println!("✓ jeton exigé");

    // 4. Mise à jour : même port, même jeton, toujours joignable.
    sync_server::install(&conn, None, binary_for, sync_port, &token).await?;
    assert!(sync_server::wait_healthy(&conn, sync_port).await, "ne répond plus après la mise à jour");
    println!("✓ mise à jour sans changer de jeton");

    // 5. Le port n'est publié que sur la boucle locale du serveur.
    let listen = conn.run(&format!("netstat -tln 2>/dev/null | grep ':{sync_port} ' || true")).await?;
    // Colonne de l'adresse locale (la suivante, « 0.0.0.0:* », est l'adresse distante).
    let local: Vec<&str> = listen.lines().filter_map(|l| l.split_whitespace().nth(3)).collect();
    assert!(!local.is_empty() && local.iter().all(|a| a.starts_with("127.0.0.1:")), "port exposé : {listen}");
    println!("✓ écoute limitée à 127.0.0.1\nSYNC_SMOKE_OK");
    Ok(())
}
