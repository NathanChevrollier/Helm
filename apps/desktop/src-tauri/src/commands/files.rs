//! Explorateur de fichiers SFTP et édition distante.

use std::path::PathBuf;

use helm_core::sftp::{self, Listing, Progress};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::commands::admin;
use crate::sessions::Sessions;
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
pub async fn fs_list(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
) -> Result<Listing, String> {
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
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    content: String,
    sudo: bool,
) -> Result<(), String> {
    if sudo {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        return conn.write_file_sudo(&path, &content, pw.as_deref()).await.map_err(err);
    }
    let sftp = sessions.sftp(&store, &server_id).await?;
    sftp::write_text(&sftp, &path, &content).await.map_err(err)
}

#[tauri::command]
pub async fn fs_mkdir(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String, path: String) -> Result<(), String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    sftp::mkdir(&sftp, &path).await.map_err(err)
}

#[tauri::command]
pub async fn fs_create(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String, path: String) -> Result<(), String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    sftp::create_file(&sftp, &path).await.map_err(err)
}

#[tauri::command]
pub async fn fs_rename(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    sftp::rename(&sftp, &from, &to).await.map_err(err)
}

#[tauri::command]
pub async fn fs_remove(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String, paths: Vec<String>) -> Result<(), String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    for p in paths {
        sftp::remove(&sftp, &p).await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_chmod(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    sftp::chmod(&sftp, &path, mode).await.map_err(err)
}

/// Télécharge des éléments distants dans `local_dir` (par défaut : le dossier Téléchargements).
#[tauri::command]
pub async fn fs_download(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    paths: Vec<String>,
    local_dir: Option<String>,
    on_progress: Channel<Progress>,
) -> Result<String, String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    let dir = match local_dir {
        Some(d) => PathBuf::from(d),
        None => app.path().download_dir().map_err(err)?,
    };
    let report = |p: Progress| {
        let _ = on_progress.send(p);
    };
    for p in &paths {
        sftp::download(&sftp, p, &dir, &report).await.map_err(err)?;
    }
    Ok(dir.display().to_string())
}

#[tauri::command]
pub async fn fs_upload(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let sftp = sessions.sftp(&store, &server_id).await?;
    let report = |p: Progress| {
        let _ = on_progress.send(p);
    };
    for p in &local_paths {
        sftp::upload(&sftp, &PathBuf::from(p), &remote_dir, &report).await.map_err(err)?;
    }
    Ok(())
}
