//! Gestion Docker : conteneurs, projets compose, images et nettoyage.

use std::collections::HashMap;

use helm_core::docker::{self, Access, ComposeProject, Container, DiskUsage, Image, Stats};
use helm_core::Connection;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::commands::admin;
use crate::sessions::Sessions;
use crate::store::Store;

/// Mode d'accès à Docker mémorisé par serveur.
#[derive(Default)]
pub struct DockerAccess(Mutex<HashMap<String, Access>>);

fn err(e: impl ToString) -> String {
    e.to_string()
}

struct Ctx {
    conn: Connection,
    sudo: Option<String>,
    access: Access,
}

async fn ctx(store: &Store, sessions: &Sessions, cache: &DockerAccess, server_id: &str) -> Result<Ctx, String> {
    let (conn, sudo) = admin(store, sessions, server_id).await?;
    let known = cache.0.lock().await.get(server_id).copied();
    let access = match known {
        Some(a) if a != Access::Unavailable => a,
        _ => {
            let (a, _) = docker::access(&conn, sudo.as_deref()).await.map_err(err)?;
            cache.0.lock().await.insert(server_id.to_string(), a);
            a
        }
    };
    if access == Access::Unavailable {
        return Err("Docker n'est pas accessible sur ce serveur (absent, ou droits insuffisants : ajoute ton utilisateur au groupe docker ou renseigne le mot de passe sudo).".into());
    }
    Ok(Ctx { conn, sudo, access })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    access: Access,
    version: String,
    containers: Vec<Container>,
    projects: Vec<ComposeProject>,
}

#[tauri::command]
pub async fn docker_overview(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
) -> Result<Overview, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let (access, version) = docker::access(&conn, sudo.as_deref()).await.map_err(err)?;
    cache.0.lock().await.insert(server_id.clone(), access);
    if access == Access::Unavailable {
        return Ok(Overview { access, version, containers: vec![], projects: vec![] });
    }
    let s = sudo.as_deref();
    let (containers, projects) =
        tokio::try_join!(docker::containers(&conn, access, s), docker::compose_projects(&conn, access, s)).map_err(err)?;
    Ok(Overview { access, version, containers, projects })
}

#[tauri::command]
pub async fn docker_stats(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
) -> Result<Vec<Stats>, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::stats(&c.conn, c.access, c.sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn docker_container_action(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    id: String,
    action: String,
) -> Result<(), String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::container_action(&c.conn, c.access, c.sudo.as_deref(), &id, &action).await.map_err(err)
}

#[tauri::command]
pub async fn docker_inspect(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    id: String,
) -> Result<String, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::inspect(&c.conn, c.access, c.sudo.as_deref(), &id).await.map_err(err)
}

#[tauri::command]
pub async fn docker_logs(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    id: String,
    tail: u32,
) -> Result<String, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::logs(&c.conn, c.access, c.sudo.as_deref(), &id, tail).await.map_err(err)
}

#[tauri::command]
pub async fn docker_compose_action(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    project: ComposeProject,
    action: String,
) -> Result<String, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::compose_action(&c.conn, c.access, c.sudo.as_deref(), &project, &action).await.map_err(err)
}

/// Commande shell à lancer dans un terminal pour un projet compose (logs en direct…).
#[tauri::command]
pub fn docker_compose_command(project: ComposeProject, sub: String) -> Result<String, String> {
    docker::compose_command(&project, &sub).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    images: Vec<Image>,
    usage: Vec<DiskUsage>,
}

#[tauri::command]
pub async fn docker_storage(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
) -> Result<Storage, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    let s = c.sudo.as_deref();
    let (images, usage) = tokio::try_join!(docker::images(&c.conn, c.access, s), docker::disk_usage(&c.conn, c.access, s)).map_err(err)?;
    Ok(Storage { images, usage })
}

#[tauri::command]
pub async fn docker_remove_image(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    id: String,
) -> Result<(), String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::remove_image(&c.conn, c.access, c.sudo.as_deref(), &id).await.map_err(err)
}

#[tauri::command]
pub async fn docker_prune(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    what: String,
) -> Result<String, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::prune(&c.conn, c.access, c.sudo.as_deref(), &what).await.map_err(err)
}
