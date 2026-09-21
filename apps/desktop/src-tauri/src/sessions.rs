//! Connexions SSH ouvertes et terminaux interactifs.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use helm_core::{Auth, ConnectParams, Connection};
use helm_core::russh::client::Msg;
use helm_core::russh::{ChannelMsg, ChannelWriteHalf};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::store::{secrets, AuthKind, Store};

/// Événements envoyés à l'UI pour un terminal.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    /// Octets bruts encodés en base64 (xterm.js décode l'UTF-8 lui-même, même coupé entre deux paquets).
    Data { data: String },
    Exit { code: Option<u32> },
}

pub struct Sessions {
    connections: Mutex<HashMap<String, Connection>>,
    terminals: Mutex<HashMap<u64, ChannelWriteHalf<Msg>>>,
    next_term: AtomicU64,
}

impl Sessions {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
            next_term: AtomicU64::new(1),
        }
    }

    /// Renvoie la connexion du serveur, en la (re)créant si elle n'existe pas ou a été coupée.
    pub async fn get(&self, store: &Store, server_id: &str) -> Result<Connection, String> {
        let mut conns = self.connections.lock().await;
        if let Some(c) = conns.get(server_id) {
            if !c.is_closed() {
                return Ok(c.clone());
            }
        }
        let profile = store.server(server_id)?;
        let host_key = format!("{}:{}", profile.host, profile.port);
        let auth = match profile.auth_kind {
            AuthKind::Password => Auth::Password {
                password: secrets::get(server_id, "password")
                    .ok_or("NEED_PASSWORD: aucun mot de passe enregistré pour ce serveur")?,
            },
            AuthKind::Key => Auth::KeyFile {
                path: profile.key_path.clone().ok_or("aucune clé privée configurée")?,
                passphrase: secrets::get(server_id, "passphrase"),
            },
            AuthKind::Agent => Auth::Agent,
        };
        let params = ConnectParams {
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            auth,
            known_fingerprint: store.read(|d| d.known_hosts.get(&host_key).cloned()),
        };
        let conn = Connection::connect(params).await.map_err(|e| e.to_string())?;
        conns.insert(server_id.to_string(), conn.clone());
        Ok(conn)
    }

    pub async fn is_connected(&self, server_id: &str) -> bool {
        self.connections.lock().await.get(server_id).is_some_and(|c| !c.is_closed())
    }

    pub async fn disconnect(&self, server_id: &str) {
        if let Some(c) = self.connections.lock().await.remove(server_id) {
            c.disconnect().await;
        }
    }

    /// Ouvre un terminal : un shell, ou une commande interactive (`docker exec -it …`) si fournie.
    pub async fn open_terminal(
        &self,
        conn: &Connection,
        cols: u32,
        rows: u32,
        command: Option<String>,
        events: Channel<TermEvent>,
    ) -> Result<u64, String> {
        let channel = match command {
            Some(cmd) => conn.open_exec(&cmd, Some((cols, rows))).await,
            None => conn.open_shell(cols, rows).await,
        }
        .map_err(|e| e.to_string())?;

        let id = self.next_term.fetch_add(1, Ordering::Relaxed);
        let (mut reader, writer) = channel.split();
        self.terminals.lock().await.insert(id, writer);

        tauri::async_runtime::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            let mut code = None;
            while let Some(msg) = reader.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        if events.send(TermEvent::Data { data: b64.encode(&data) }).is_err() {
                            break;
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let _ = events.send(TermEvent::Exit { code });
        });
        Ok(id)
    }

    pub async fn write_terminal(&self, id: u64, data: &[u8]) -> Result<(), String> {
        let terms = self.terminals.lock().await;
        let writer = terms.get(&id).ok_or("terminal fermé")?;
        writer.data(data).await.map_err(|e| e.to_string())
    }

    pub async fn resize_terminal(&self, id: u64, cols: u32, rows: u32) -> Result<(), String> {
        let terms = self.terminals.lock().await;
        let writer = terms.get(&id).ok_or("terminal fermé")?;
        writer.window_change(cols, rows, 0, 0).await.map_err(|e| e.to_string())
    }

    pub async fn close_terminal(&self, id: u64) {
        if let Some(writer) = self.terminals.lock().await.remove(&id) {
            let _ = writer.eof().await;
            let _ = writer.close().await;
        }
    }
}
