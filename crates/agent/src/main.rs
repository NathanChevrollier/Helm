//! Agent `helmd` : collecte des métriques, historique, alertes et supervision HTTP.
//! Exposé uniquement sur un socket unix local : aucun port réseau n'est ouvert.
//!
//! Commandes :
//!   helmd run [--config PATH] [--data DIR] [--socket PATH]   démarre l'agent
//!   helmd query '<json>'                                      interroge l'agent local
//!   helmd default-config                                      affiche la configuration par défaut
//!   helmd version

// Sous Windows, seul le squelette compile (pour `cargo check --workspace`) : le daemon est Linux uniquement.
#![cfg_attr(not(unix), allow(dead_code))]

mod alerts;
mod collector;
mod history;
mod notify;
#[cfg(unix)]
mod server;
mod state;

use helm_protocol::AgentConfig;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]),
        Some("query") => query(args.get(1).map(String::as_str).unwrap_or(r#"{"type":"status"}"#)),
        Some("default-config") => {
            println!("{}", serde_json::to_string_pretty(&AgentConfig::default()).unwrap());
            0
        }
        Some("version") | Some("--version") => {
            println!("helmd {} (protocole v{})", env!("CARGO_PKG_VERSION"), helm_protocol::PROTOCOL_VERSION);
            0
        }
        _ => {
            eprintln!("usage : helmd run | query '<json>' | default-config | version");
            2
        }
    };
    std::process::exit(code);
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

#[cfg(unix)]
fn run(args: &[String]) -> i32 {
    let paths = state::Paths {
        config: flag(args, "--config").unwrap_or(helm_protocol::CONFIG_PATH).into(),
        data_dir: flag(args, "--data").unwrap_or("/var/lib/helmd").into(),
        socket: flag(args, "--socket").unwrap_or(helm_protocol::SOCKET_PATH).into(),
    };
    match state::start(paths) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("helmd : {e}");
            1
        }
    }
}

#[cfg(not(unix))]
fn run(_args: &[String]) -> i32 {
    eprintln!("helmd ne fonctionne que sous Linux");
    let _ = flag;
    1
}

#[cfg(unix)]
fn query(request: &str) -> i32 {
    use std::io::{Read, Write};
    let socket = std::env::var("HELMD_SOCKET").unwrap_or_else(|_| helm_protocol::SOCKET_PATH.into());
    let mut stream = match std::os::unix::net::UnixStream::connect(&socket) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("agent injoignable sur {socket} : {e}");
            return 3;
        }
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    if stream.write_all(format!("{request}\n").as_bytes()).is_err() {
        return 3;
    }
    let mut out = String::new();
    if let Err(e) = stream.read_to_string(&mut out) {
        eprintln!("lecture impossible : {e}");
        return 3;
    }
    print!("{out}");
    0
}

#[cfg(not(unix))]
fn query(_request: &str) -> i32 {
    eprintln!("helmd ne fonctionne que sous Linux");
    1
}
