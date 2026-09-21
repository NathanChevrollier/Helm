//! Connexion avec une clé PuTTY (.ppk v3 chiffrée) contre `testenv`.
//! `cargo run -p helm-core --example ppk_smoke -- <chemin.ppk> <passphrase>`

use helm_core::{Auth, ConnectParams, Connection, Error};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (path, pass) = (args[0].clone(), args.get(1).cloned());
    let mut params = ConnectParams {
        host: "127.0.0.1".into(),
        port: 2222,
        username: "deploy".into(),
        auth: Auth::KeyFile { path: path.clone(), passphrase: pass },
        known_fingerprint: None,
    };
    let conn = match Connection::connect(params.clone()).await {
        Err(Error::UnknownHostKey(fp)) => {
            params.known_fingerprint = Some(fp);
            Connection::connect(params.clone()).await?
        }
        other => other?,
    };
    println!("✓ connecté avec la clé PPK : whoami = {}", conn.run("whoami").await?.trim());

    params.auth = Auth::KeyFile { path, passphrase: Some("mauvaise".into()) };
    match Connection::connect(params).await {
        Err(Error::Auth(msg)) => println!("✓ mauvaise passphrase refusée : {msg}"),
        other => return Err(format!("attendu une erreur d'authentification, obtenu {:?}", other.err()).into()),
    }
    Ok(())
}
