//! Suivi du dossier courant d'un terminal, contre `testenv` (localhost:2222).
//! Reproduit ce que fait Helm : ouverture du shell, lecture du PID annoncé (OSC 7770), `cd`,
//! puis résolution du dossier — avec et sans tmux.
//! `cargo run -p helm-core --example cwd_smoke`

use std::time::Duration;

use helm_core::russh::ChannelMsg;
use helm_core::{tmux, Auth, ConnectParams, Connection};

/// Mêmes commandes que l'app (apps/desktop/src-tauri/src/commands/terminal.rs).
const SHELL_WITH_PID: &str = r#"exec sh -c 'printf "\033]7770;%s\007" "$$"; exec "${SHELL:-/bin/sh}" -l'"#;

fn cwd_of_pids(pids: &[u32]) -> String {
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" ");
    format!(
        "for base in {list}; do \
           for p in $(ps -o tpgid= -p $base 2>/dev/null) $base; do \
             d=$(readlink /proc/$p/cwd 2>/dev/null); \
             [ -n \"$d\" ] && {{ echo \"$d\"; exit 0; }}; \
           done; \
         done; true"
    )
}

/// Lit la sortie du terminal pendant `ms` millisecondes.
async fn read_for(channel: &mut helm_core::russh::ChannelReadHalf, ms: u64) -> String {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    while let Ok(Some(msg)) = tokio::time::timeout_at(deadline, channel.wait()).await {
        if let ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } = msg {
            out.extend_from_slice(&data);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let params = |fp: Option<String>| ConnectParams {
        host: "127.0.0.1".into(),
        port: 2222,
        username: "root".into(),
        auth: Auth::Password { password: "helm".into() },
        known_fingerprint: fp,
    };
    let fingerprint = match Connection::connect(params(None)).await {
        Err(helm_core::Error::UnknownHostKey(fp)) => fp,
        Ok(_) => return Err("hôte inconnu accepté".into()),
        Err(e) => return Err(e.into()),
    };
    let conn = Connection::connect(params(Some(fingerprint))).await?;

    // ---- 1. Shell simple : le PID est annoncé, et le dossier suit les « cd » ----
    let channel = conn.open_exec(SHELL_WITH_PID, Some((120, 30))).await?;
    let (mut reader, writer) = channel.split();
    let banner = read_for(&mut reader, 1500).await;
    let pid: u32 = banner
        .split("\u{1b}]7770;")
        .nth(1)
        .and_then(|rest| rest.split('\u{7}').next())
        .and_then(|p| p.trim().parse().ok())
        .ok_or_else(|| format!("PID non annoncé par le shell ; reçu : {banner:?}"))?;
    println!("✓ shell simple : PID annoncé = {pid}");

    writer.data("cd /etc\n".as_bytes()).await?;
    let _ = read_for(&mut reader, 800).await;
    let found = conn.run(&cwd_of_pids(&[pid])).await?.trim().to_string();
    if found != "/etc" {
        return Err(format!("dossier attendu /etc, obtenu {found:?}").into());
    }
    println!("✓ shell simple : « cd /etc » suivi correctement");

    // Programme au premier plan lancé depuis un autre dossier : c'est le sien qui compte.
    writer.data("cd /var/log && sleep 5\n".as_bytes()).await?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let found = conn.run(&cwd_of_pids(&[pid])).await?.trim().to_string();
    if found != "/var/log" {
        return Err(format!("programme au premier plan : attendu /var/log, obtenu {found:?}").into());
    }
    println!("✓ shell simple : dossier du programme au premier plan ({found})");
    let _ = writer.close().await;

    // ---- 2. Session tmux : même chose via tmux ----
    if conn.exec("command -v tmux", None).await?.success() {
        let name = "helm-cwdsmoke";
        let _ = conn.run(&format!("tmux kill-session -t {name} 2>/dev/null || true")).await;
        let channel = conn.open_exec(&tmux::attach_command(name)?, Some((120, 30))).await?;
        let (mut reader, writer) = channel.split();
        let _ = read_for(&mut reader, 1200).await;
        writer.data("cd /srv\n".as_bytes()).await?;
        let _ = read_for(&mut reader, 800).await;

        let out = conn.run(&tmux::pane_path_command(name)?).await?;
        let path = out.lines().map(str::trim).find(|l| l.starts_with('/')).unwrap_or_default().to_string();
        if path != "/srv" {
            return Err(format!("tmux : dossier attendu /srv, obtenu {path:?} (sortie {out:?})").into());
        }
        println!("✓ tmux : « cd /srv » suivi correctement");

        // La souris doit rester au terminal : sans cela, la sélection et la copie ne marchent plus.
        let mouse = conn.run(&format!("tmux show-options -t {name} mouse 2>/dev/null || echo absent")).await?;
        println!("✓ tmux : option souris = {}", mouse.trim());
        if mouse.contains("mouse on") {
            return Err("tmux capte la souris : la sélection à la souris ne fonctionnera pas".into());
        }
        let _ = writer.close().await;
        let _ = conn.run(&format!("tmux kill-session -t {name}")).await;
    } else {
        println!("· tmux absent du faux VPS : partie tmux non vérifiée");
    }

    println!("\nTout est bon.");
    Ok(())
}
