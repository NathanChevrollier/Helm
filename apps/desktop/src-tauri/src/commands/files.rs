//! Explorateur de fichiers SFTP et édition distante.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use helm_core::sftp::{self, Listing, Progress};
use helm_core::ssh::shell_quote;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::AuditLog;
use crate::store::Store;

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn fs_home(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<String, String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    sftp::home(&sftp).await.map_err(err)
}

#[tauri::command]
pub async fn fs_list(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String, path: String) -> Result<Listing, String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    let mut listing = sftp::list(&sftp, &path).await.map_err(err)?;
    let conn = sessions.get(&store, &server_id).await?;
    let names = sessions.id_names(&conn, &server_id).await;
    let resolve = |v: &mut Option<String>, map: &std::collections::HashMap<u32, String>| {
        if let Some(name) = v.as_deref().and_then(|s| s.parse::<u32>().ok()).and_then(|id| map.get(&id)) {
            *v = Some(name.clone());
        }
    };
    for e in &mut listing.entries {
        resolve(&mut e.owner, &names.users);
        resolve(&mut e.group, &names.groups);
    }
    Ok(listing)
}

/// Lit un fichier texte. Avec `sudo`, passe par `cat` en root pour les fichiers système.
#[tauri::command]
pub async fn fs_read(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    sudo: bool,
) -> Result<String, String> {
    if sudo {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        let text = conn.read_file_sudo(&path, pw.as_deref()).await.map_err(err)?;
        return Ok(text);
    }
    let sftp = sessions.sftp(&store, &server_id).await?;
    sftp::read_text(&sftp, &path).await.map_err(err)
}

#[tauri::command]
pub async fn fs_write(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    content: String,
    sudo: bool,
) -> Result<(), String> {
    let detail = path.clone();
    let r: Result<(), String> = async {
        if sudo {
            let (conn, pw) = admin(&store, &sessions, &server_id).await?;
            return conn.write_file_sudo(&path, &content, pw.as_deref()).await.map_err(err);
        }
        let sftp = sessions.sftp(&store, &server_id).await?;
        sftp::write_text(&sftp, &path, &content).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "file.write", &detail, r)
}

#[tauri::command]
pub async fn fs_mkdir(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
) -> Result<(), String> {
    let detail = path.clone();
    let r: Result<(), String> = async {
        let sftp = sessions.sftp(&store, &server_id).await?;
        sftp::mkdir(&sftp, &path).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "file.mkdir", &detail, r)
}

#[tauri::command]
pub async fn fs_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
) -> Result<(), String> {
    let detail = path.clone();
    let r: Result<(), String> = async {
        let sftp = sessions.sftp(&store, &server_id).await?;
        sftp::create_file(&sftp, &path).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "file.create", &detail, r)
}

#[tauri::command]
pub async fn fs_rename(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let detail = format!("{from} → {to}");
    let r: Result<(), String> = async {
        let sftp = sessions.sftp(&store, &server_id).await?;
        sftp::rename(&sftp, &from, &to).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "file.rename", &detail, r)
}

#[tauri::command]
pub async fn fs_remove(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let detail = paths.join(", ");
    let r: Result<(), String> = async {
        let sftp = sessions.sftp(&store, &server_id).await?;
        for p in paths {
            sftp::remove(&sftp, &p).await.map_err(err)?;
        }
        Ok(())
    }
    .await;
    track(&audit, &store, &server_id, "file.delete", &detail, r)
}

#[tauri::command]
pub async fn fs_chmod(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let detail = format!("{path} {mode:o}");
    let r: Result<(), String> = async {
        let sftp = sessions.sftp(&store, &server_id).await?;
        sftp::chmod(&sftp, &path, mode).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "file.chmod", &detail, r)
}

/// Transferts en cours, annulables depuis l'interface.
#[derive(Default)]
pub struct Transfers(Mutex<HashMap<u64, Arc<AtomicBool>>>);

impl Transfers {
    fn start(&self, id: u64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(id, flag.clone());
        flag
    }

    fn finish(&self, id: u64) {
        self.0.lock().unwrap().remove(&id);
    }
}

#[tauri::command]
pub fn fs_cancel(transfers: State<'_, Transfers>, transfer_id: u64) {
    if let Some(f) = transfers.0.lock().unwrap().get(&transfer_id) {
        f.store(true, Ordering::Relaxed);
    }
}

/// Callback de progression : relaie vers l'UI et renvoie `false` si le transfert a été annulé.
fn reporter(channel: &Channel<Progress>, cancel: Arc<AtomicBool>) -> impl Fn(Progress) -> bool + Send + Sync + '_ {
    move |p: Progress| {
        let _ = channel.send(p);
        !cancel.load(Ordering::Relaxed)
    }
}

/// Télécharge des éléments distants dans `local_dir` (par défaut : le dossier Téléchargements).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_download(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    server_id: String,
    paths: Vec<String>,
    local_dir: Option<String>,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<String, String> {
    let cancel = transfers.start(transfer_id);
    let r = async {
        let sftp = sessions.sftp(&store, &server_id).await?;
        let dir = match local_dir {
            Some(d) => PathBuf::from(d),
            None => app.path().download_dir().map_err(err)?,
        };
        let report = reporter(&on_progress, cancel.clone());
        for p in &paths {
            sftp::download(&sftp, p, &dir, &report).await.map_err(err)?;
        }
        Ok(dir.display().to_string())
    }
    .await;
    transfers.finish(transfer_id);
    r
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_upload(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    server_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let detail = format!("{} → {remote_dir}", local_paths.len());
    let cancel = transfers.start(transfer_id);
    let r: Result<(), String> = async {
        let sftp = sessions.sftp(&store, &server_id).await?;
        let report = reporter(&on_progress, cancel.clone());
        for p in &local_paths {
            sftp::upload(&sftp, &PathBuf::from(p), &remote_dir, &report).await.map_err(err)?;
        }
        Ok(())
    }
    .await;
    transfers.finish(transfer_id);
    track(&audit, &store, &server_id, "file.upload", &detail, r)
}

/// Copie des éléments d'un serveur (ou dossier) vers un autre. Sur un même serveur : `cp -a`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_copy_between(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    src_server: String,
    paths: Vec<String>,
    dst_server: String,
    dst_dir: String,
    overwrite: bool,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let dst_name = store.server(&dst_server).map(|s| s.name).unwrap_or_default();
    let detail = format!("{} élément(s) → {dst_name}:{dst_dir}", paths.len());
    let cancel = transfers.start(transfer_id);
    let r: Result<(), String> = async {
        if src_server == dst_server {
            let conn = sessions.get(&store, &src_server).await?;
            for p in &paths {
                let name = p.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                let target = sftp::join(&dst_dir, name);
                if !overwrite && conn.exec(&format!("test -e {}", shell_quote(&target)), None).await.map_err(err)?.success() {
                    return Err(format!("EXISTS:{target}"));
                }
                conn.run(&format!("cp -a -- {} {}", shell_quote(p), shell_quote(&dst_dir))).await.map_err(err)?;
            }
            return Ok(());
        }
        let src = sessions.sftp(&store, &src_server).await?;
        let dst = sessions.sftp(&store, &dst_server).await?;
        let report = reporter(&on_progress, cancel.clone());
        for p in &paths {
            sftp::copy_between(&src, p, &dst, &dst_dir, overwrite, &report).await.map_err(err)?;
        }
        Ok(())
    }
    .await;
    transfers.finish(transfer_id);
    // L'écriture a lieu sur le serveur de destination : c'est lui qui figure au journal.
    track(&audit, &store, &dst_server, "file.copy_between", &detail, r)
}
