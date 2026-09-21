//! Tunnels SSH locaux : un port sur 127.0.0.1 du PC relayé vers un service vu depuis le serveur.
//! Jamais d'écoute sur une autre interface, jamais de redirection distante (`-R`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::sessions::Sessions;
use crate::store::{Store, TunnelDef};

#[derive(Default)]
struct Stats {
    active: AtomicUsize,
    total: AtomicU64,
    last_error: Mutex<Option<String>>,
}

struct Running {
    task: JoinHandle<()>,
    stats: Arc<Stats>,
}

#[derive(Default)]
pub struct Tunnels(Mutex<HashMap<String, Running>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelView {
    #[serde(flatten)]
    def: TunnelDef,
    running: bool,
    active_connections: usize,
    total_connections: u64,
    last_error: Option<String>,
}

fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:".contains(c))
}

fn validate(def: &TunnelDef) -> Result<(), String> {
    if def.local_port < 1024 {
        return Err("le port local doit être ≥ 1024".into());
    }
    if def.remote_port == 0 {
        return Err("port distant invalide".into());
    }
    if !valid_host(&def.remote_host) {
        return Err("hôte distant invalide".into());
    }
    Ok(())
}

impl Tunnels {
    pub async fn start(&self, app: &AppHandle, def: TunnelDef) -> Result<(), String> {
        validate(&def)?;
        if self.0.lock().unwrap().contains_key(&def.id) {
            return Ok(());
        }
        // Uniquement sur la boucle locale : le tunnel n'est jamais exposé au réseau du PC.
        let listener = TcpListener::bind(("127.0.0.1", def.local_port))
            .await
            .map_err(|e| format!("port local {} indisponible : {e}", def.local_port))?;
        let stats = Arc::new(Stats::default());
        let id = def.id.clone();
        let (app, st) = (app.clone(), stats.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { continue };
                let (app, st, def) = (app.clone(), st.clone(), def.clone());
                tokio::spawn(async move {
                    st.total.fetch_add(1, Ordering::Relaxed);
                    st.active.fetch_add(1, Ordering::Relaxed);
                    let result = async {
                        // La connexion SSH est (re)ouverte à la demande, à la première utilisation.
                        let conn = app.state::<Sessions>().get(&app.state::<Store>(), &def.server_id).await?;
                        let mut stream =
                            conn.open_direct_tcpip(&def.remote_host, def.remote_port, def.local_port).await.map_err(|e| e.to_string())?;
                        tokio::io::copy_bidirectional(&mut socket, &mut stream).await.map_err(|e| e.to_string())?;
                        Ok::<_, String>(())
                    }
                    .await;
                    if let Err(e) = result {
                        *st.last_error.lock().unwrap() = Some(e);
                    }
                    st.active.fetch_sub(1, Ordering::Relaxed);
                });
            }
        });
        self.0.lock().unwrap().insert(id, Running { task, stats });
        Ok(())
    }

    pub fn stop(&self, id: &str) {
        if let Some(r) = self.0.lock().unwrap().remove(id) {
            r.task.abort();
        }
    }

    /// Démarre les tunnels marqués « au lancement ».
    pub async fn autostart(&self, app: &AppHandle) {
        let defs = app.state::<Store>().read(|d| d.tunnels.clone());
        for def in defs.into_iter().filter(|d| d.auto_start) {
            let _ = self.start(app, def).await;
        }
    }
}

#[tauri::command]
pub fn tunnels_list(store: State<'_, Store>, tunnels: State<'_, Tunnels>) -> Vec<TunnelView> {
    let running = tunnels.0.lock().unwrap();
    store.read(|d| {
        d.tunnels
            .iter()
            .map(|def| {
                let r = running.get(&def.id);
                TunnelView {
                    def: def.clone(),
                    running: r.is_some(),
                    active_connections: r.map(|r| r.stats.active.load(Ordering::Relaxed)).unwrap_or(0),
                    total_connections: r.map(|r| r.stats.total.load(Ordering::Relaxed)).unwrap_or(0),
                    last_error: r.and_then(|r| r.stats.last_error.lock().unwrap().clone()),
                }
            })
            .collect()
    })
}

#[tauri::command]
pub fn tunnel_save(store: State<'_, Store>, tunnels: State<'_, Tunnels>, mut def: TunnelDef) -> Result<String, String> {
    validate(&def)?;
    let clash = store.read(|d| d.tunnels.iter().any(|t| t.id != def.id && t.local_port == def.local_port));
    if clash {
        return Err(format!("le port local {} est déjà utilisé par un autre tunnel", def.local_port));
    }
    if def.id.is_empty() {
        def.id = uuid::Uuid::new_v4().to_string();
    }
    // Un tunnel modifié est arrêté : il faudra le relancer avec ses nouveaux paramètres.
    tunnels.stop(&def.id);
    let id = def.id.clone();
    store.write(|d| match d.tunnels.iter_mut().find(|t| t.id == def.id) {
        Some(t) => *t = def,
        None => d.tunnels.push(def),
    })?;
    Ok(id)
}

#[tauri::command]
pub fn tunnel_delete(store: State<'_, Store>, tunnels: State<'_, Tunnels>, id: String) -> Result<(), String> {
    tunnels.stop(&id);
    store.write(|d| d.tunnels.retain(|t| t.id != id))
}

#[tauri::command]
pub async fn tunnel_start(app: AppHandle, store: State<'_, Store>, tunnels: State<'_, Tunnels>, id: String) -> Result<(), String> {
    let def = store.read(|d| d.tunnels.iter().find(|t| t.id == id).cloned()).ok_or("tunnel introuvable")?;
    tunnels.start(&app, def).await
}

#[tauri::command]
pub fn tunnel_stop(tunnels: State<'_, Tunnels>, id: String) {
    tunnels.stop(&id);
}

/// Premier port local libre à partir de `start` (sur 127.0.0.1).
#[tauri::command]
pub fn tunnel_free_port(store: State<'_, Store>, start: u16) -> u16 {
    let taken: Vec<u16> = store.read(|d| d.tunnels.iter().map(|t| t.local_port).collect());
    (start.max(1024)..u16::MAX).find(|p| !taken.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok()).unwrap_or(start)
}
