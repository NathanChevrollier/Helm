//! Connexions SSH ouvertes et terminaux interactifs.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use helm_core::russh::client::Msg;
use helm_core::russh::{ChannelMsg, ChannelWriteHalf};
use helm_core::russh_sftp::client::SftpSession;
use helm_core::Connection;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::store::Store;

/// Événements envoyés à l'UI pour un terminal.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    /// Octets bruts encodés en base64 (xterm.js décode l'UTF-8 lui-même, même coupé entre deux paquets).
    Data {
        data: String,
    },
    Exit {
        code: Option<u32>,
    },
}

pub struct Sessions {
    connections: Mutex<HashMap<String, Connection>>,
    sftp: Mutex<HashMap<String, (Connection, Arc<SftpSession>)>>,
    terminals: Mutex<HashMap<u64, ChannelWriteHalf<Msg>>>,
    next_term: AtomicU64,
    /// Noms d'utilisateurs et de groupes par serveur (uid/gid → nom), pour l'explorateur.
    id_names: Mutex<HashMap<String, Arc<IdNames>>>,
    /// Serveurs dont l'authentification a échoué : plus aucune tentative automatique tant que
    /// l'utilisateur n'a pas relancé la connexion lui-même (sinon fail2ban bannit son IP).
    auth_blocked: std::sync::Mutex<HashMap<String, String>>,
}

#[derive(Default)]
pub struct IdNames {
    pub users: HashMap<u32, String>,
    pub groups: HashMap<u32, String>,
}

impl Sessions {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            sftp: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
            next_term: AtomicU64::new(1),
            id_names: Mutex::new(HashMap::new()),
            auth_blocked: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Table uid/gid → nom du serveur, lue une fois via `getent`.
    pub async fn id_names(&self, conn: &Connection, server_id: &str) -> Arc<IdNames> {
        if let Some(n) = self.id_names.lock().await.get(server_id) {
            return n.clone();
        }
        let mut names = IdNames::default();
        if let Ok(out) = conn.exec("getent passwd; echo ---; getent group", None).await {
            let mut in_groups = false;
            for line in out.stdout.lines() {
                if line == "---" {
                    in_groups = true;
                    continue;
                }
                let mut parts = line.split(':');
                let (Some(name), _, Some(id)) = (parts.next(), parts.next(), parts.next()) else { continue };
                let Ok(id) = id.parse() else { continue };
                let map = if in_groups { &mut names.groups } else { &mut names.users };
                map.insert(id, name.to_string());
            }
        }
        let names = Arc::new(names);
        self.id_names.lock().await.insert(server_id.to_string(), names.clone());
        names
    }

    /// Session SFTP du serveur, réutilisée tant que la connexion SSH sous-jacente est vivante.
    pub async fn sftp(&self, store: &Store, server_id: &str) -> Result<Arc<SftpSession>, String> {
        let conn = self.get(store, server_id).await?;
        let mut cache = self.sftp.lock().await;
        if let Some((owner, s)) = cache.get(server_id) {
            if owner.same_as(&conn) {
                return Ok(s.clone());
            }
        }
        let session = Arc::new(conn.sftp().await.map_err(|e| e.to_string())?);
        cache.insert(server_id.to_string(), (conn, session.clone()));
        Ok(session)
    }

    /// Renvoie la connexion du serveur, en la (re)créant si elle n'existe pas ou a été coupée.
    pub async fn get(&self, store: &Store, server_id: &str) -> Result<Connection, String> {
        let mut conns = self.connections.lock().await;
        if let Some(c) = conns.get(server_id) {
            if !c.is_closed() {
                return Ok(c.clone());
            }
        }
        if let Some(reason) = self.auth_blocked.lock().unwrap().get(server_id) {
            return Err(format!("AUTH_BLOCKED: {reason} — reconnexion automatique suspendue, clique « Connecter » pour réessayer"));
        }
        let params = store.connect_params(server_id)?;
        let conn = match Connection::connect(params).await {
            Ok(c) => c,
            Err(helm_core::Error::Auth(reason)) => {
                self.auth_blocked.lock().unwrap().insert(server_id.to_string(), reason.clone());
                return Err(format!("Authentification échouée : {reason}"));
            }
            Err(e) => return Err(e.to_string()),
        };
        conns.insert(server_id.to_string(), conn.clone());
        Ok(conn)
    }

    /// Autorise de nouveau les tentatives (action explicite de l'utilisateur, ou profil modifié).
    pub fn unblock(&self, server_id: &str) {
        self.auth_blocked.lock().unwrap().remove(server_id);
    }

    pub async fn is_connected(&self, server_id: &str) -> bool {
        self.connections.lock().await.get(server_id).is_some_and(|c| !c.is_closed())
    }

    pub async fn disconnect(&self, server_id: &str) {
        self.sftp.lock().await.remove(server_id);
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
