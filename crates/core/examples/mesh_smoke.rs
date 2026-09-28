//! Réseau privé de bout en bout sur les serveurs de test mesh-a (2225, root) et mesh-b (2226,
//! deploy avec sudo par mot de passe) : installation de WireGuard, clés, liaison, ping à travers
//! le réseau privé, réapplication sans coupure, puis retrait complet.
//!   docker compose -f testenv/docker-compose.yml up -d --build mesh-a mesh-b
//!   cargo run -p zenytt-core --example mesh_smoke

use zenytt_core::mesh::{self, Member};
use zenytt_core::{Auth, ConnectParams, Connection, Error};

async fn connect(port: u16, user: &str, pw: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    let params = |fp: Option<String>| ConnectParams {
        host: "127.0.0.1".into(),
        port,
        username: user.into(),
        auth: Auth::Password { password: pw.into() },
        known_fingerprint: fp,
    };
    let fp = match Connection::connect(params(None)).await {
        Err(Error::UnknownHostKey(fp)) => fp,
        other => return Err(format!("empreinte attendue, obtenu {:?}", other.err()).into()),
    };
    Ok(Connection::connect(params(Some(fp))).await?)
}

fn ok(what: &str) {
    println!("ok : {what}");
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a = connect(2225, "root", "zenytt").await?;
    let b = connect(2226, "deploy", "deploy").await?;
    let sudo_b = Some("deploy");

    let pa = mesh::prepare(&a, None).await?;
    let pb = mesh::prepare(&b, sudo_b).await?;
    ok("WireGuard installé et clés générées sur les deux serveurs");
    assert_eq!(mesh::prepare(&a, None).await?.public_key, pa.public_key, "la clé ne doit pas changer d'une préparation à l'autre");
    ok("préparer deux fois garde la même clé");

    let routes = format!("{}\n{}", pa.routes, pb.routes);
    let cidr = mesh::pick_subnet(&routes).expect("sous-réseau libre");
    let first = mesh::next_address(&cidr, &[]).unwrap();
    let second = mesh::next_address(&cidr, std::slice::from_ref(&first)).unwrap();
    // Les conteneurs n'ont pas d'IP publique : leurs noms sur le réseau Docker servent d'adresse joignable.
    let members = vec![
        Member { address: first, public_key: pa.public_key.clone(), endpoint: Some("mesh-a".into()), port: 51820 },
        Member { address: second, public_key: pb.public_key.clone(), endpoint: Some("mesh-b".into()), port: 51820 },
    ];
    let cfg = |i| mesh::node_config("smoke", "Test", &cidr, &members, i);
    mesh::apply(&a, None, &cfg(0)).await?;
    mesh::apply(&b, sudo_b, &cfg(1)).await?;
    ok(&format!("réseau {cidr} appliqué"));

    let key_exposed = a.run("grep -c '@ZENYTT_KEY@' /etc/wireguard/zenytt.conf || true").await?;
    assert_eq!(key_exposed.trim(), "0", "le marqueur de clé doit être remplacé sur le serveur");

    let ping = a.run(&format!("ping -c3 -W2 {}", members[1].address)).await?;
    assert!(ping.contains(" 0% packet loss"), "{ping}");
    ok("ping de mesh-a vers mesh-b par le réseau privé");

    mesh::apply(&a, None, &cfg(0)).await?;
    let ping = a.run(&format!("ping -c2 -W2 {}", members[1].address)).await?;
    assert!(ping.contains(" 0% packet loss"), "{ping}");
    ok("réappliquer ne coupe pas le lien");

    let st = mesh::status(&a, None).await?;
    assert!(st.up && st.network_id.as_deref() == Some("smoke"), "{st:?}");
    assert!(st.links.first().and_then(|l| l.last_handshake).is_some(), "{st:?}");
    let st_b = mesh::status(&b, sudo_b).await?;
    assert!(st_b.up, "{st_b:?}");
    ok("état lu, lien établi (sudo avec mot de passe compris)");

    mesh::remove(&a, None, 51820).await?;
    mesh::remove(&b, sudo_b, 51820).await?;
    let st = mesh::status(&a, None).await?;
    assert!(!st.up && st.network_id.is_none(), "{st:?}");
    ok("retrait : interface et fichiers supprimés");

    println!("mesh_smoke : tout est bon");
    Ok(())
}
