//! Gestion Docker : conteneurs, projets compose, images et nettoyage.

use std::collections::HashMap;

use helm_core::docker::{self, Access, ComposeProject, Container, DiskUsage, Image, Stats};
use helm_core::ssh::shell_quote;
use helm_core::Connection;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::AuditLog;
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
    /// `docker` ou `podman` : commande à utiliser dans les terminaux ouverts par l'interface.
    engine: String,
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
    let engine = if version.starts_with("podman") { "podman" } else { "docker" }.to_string();
    if access == Access::Unavailable {
        return Ok(Overview { access, version, engine, containers: vec![], projects: vec![] });
    }
    let s = sudo.as_deref();
    let (containers, projects) =
        tokio::try_join!(docker::containers(&conn, access, s), docker::compose_projects(&conn, access, s)).map_err(err)?;
    Ok(Overview { access, version, engine, containers, projects })
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
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    id: String,
    action: String,
) -> Result<(), String> {
    let detail = format!("{action} {id}");
    let r: Result<(), String> = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        docker::container_action(&c.conn, c.access, c.sudo.as_deref(), &id, &action).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "docker.container", &detail, r)
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
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    project: ComposeProject,
    action: String,
) -> Result<String, String> {
    let detail = format!("{action} {}", project.name);
    let r: Result<String, String> = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        docker::compose_action(&c.conn, c.access, c.sudo.as_deref(), &project, &action).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "docker.compose", &detail, r)
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
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    id: String,
) -> Result<(), String> {
    let detail = id.clone();
    let r: Result<(), String> = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        docker::remove_image(&c.conn, c.access, c.sudo.as_deref(), &id).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "docker.image.remove", &detail, r)
}

#[tauri::command]
pub async fn docker_prune(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    what: String,
) -> Result<String, String> {
    let detail = what.clone();
    let r: Result<String, String> = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        docker::prune(&c.conn, c.access, c.sudo.as_deref(), &what).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "docker.prune", &detail, r)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictPreview {
    file: String,
    before: String,
    after: String,
}

async fn read_any(conn: &Connection, sudo: Option<&str>, path: &str) -> Result<String, String> {
    let direct = conn.exec(&format!("cat -- {}", shell_quote(path)), None).await.map_err(err)?;
    if direct.success() {
        return Ok(direct.stdout);
    }
    conn.read_file_sudo(path, sudo).await.map_err(err)
}

/// Trouve, dans les fichiers du projet, celui qui publie `host_port` et calcule sa version restreinte.
async fn restrict_plan(conn: &Connection, sudo: Option<&str>, project: &ComposeProject, host_port: u16) -> Result<RestrictPreview, String> {
    for file in project.config_files.split(',').map(str::trim).filter(|f| f.starts_with('/')) {
        let before = read_any(conn, sudo, file).await?;
        if let Some(after) = docker::restrict_port_in_compose(&before, host_port) {
            return Ok(RestrictPreview { file: file.to_string(), before, after });
        }
    }
    Err(format!(
        "le port {host_port} n'a pas été trouvé sous forme « HÔTE:CONTENEUR » dans les fichiers du projet : modifie le fichier à la main (host_ip: 127.0.0.1)"
    ))
}

#[tauri::command]
pub async fn docker_restrict_preview(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    project: ComposeProject,
    host_port: u16,
) -> Result<RestrictPreview, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    restrict_plan(&conn, sudo.as_deref(), &project, host_port).await
}

/// Restreint un port à 127.0.0.1 : sauvegarde, validation, relance, restauration si le projet ne repart pas.
#[tauri::command]
pub async fn docker_restrict_apply(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    project: ComposeProject,
    host_port: u16,
) -> Result<String, String> {
    let detail = format!("{} port {host_port} → 127.0.0.1", project.name);
    let r: Result<String, String> = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        let s = c.sudo.as_deref();
        let plan = restrict_plan(&c.conn, s, &project, host_port).await?;
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let backup = format!("{}.helm-bak-{ts}", plan.file);
        let candidate = format!("{}.helm-new", plan.file);
        let dir = helm_core::sftp::parent(&plan.file);
        c.conn
            .exec_sudo(&format!("cp -a -- {} {}", shell_quote(&plan.file), shell_quote(&backup)), s, None)
            .await
            .map_err(err)?
            .into_result()
            .map_err(err)?;
        c.conn.write_file_sudo(&candidate, &plan.after, s).await.map_err(err)?;
        let validate = docker::run(
            &c.conn,
            c.access,
            s,
            &format!("compose --project-directory {} -f {} config -q 2>&1", shell_quote(&dir), shell_quote(&candidate)),
        )
        .await
        .map_err(err)?;
        if !validate.success() {
            let _ = c.conn.exec_sudo(&format!("rm -f -- {}", shell_quote(&candidate)), s, None).await;
            return Err(format!("fichier modifié invalide, rien n'a été changé :\n{}{}", validate.stdout, validate.stderr));
        }
        c.conn
            .exec_sudo(&format!("mv -f -- {} {}", shell_quote(&candidate), shell_quote(&plan.file)), s, None)
            .await
            .map_err(err)?
            .into_result()
            .map_err(err)?;
        let up = docker::compose_action(&c.conn, c.access, s, &project, "up").await;
        // Vérifie que plus rien n'écoute ce port sur toutes les interfaces et que le projet tourne.
        let check = async {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let list = docker::containers(&c.conn, c.access, s).await.map_err(err)?;
            let mine: Vec<_> = list.iter().filter(|x| x.compose_project.as_deref() == Some(project.name.as_str())).collect();
            let exposed = mine.iter().any(|x| x.ports.iter().any(|p| p.host_port == host_port && p.host_ip != "127.0.0.1"));
            let running = mine.iter().any(|x| x.ports.iter().any(|p| p.host_port == host_port) && x.state == "running");
            if exposed || !running {
                return Err("le conteneur n'a pas redémarré avec le nouveau mapping".to_string());
            }
            Ok(())
        };
        match up.map_err(err).and(Ok(())).and(check.await) {
            Ok(()) => Ok(format!("Port {host_port} désormais accessible uniquement depuis le serveur. Sauvegarde : {backup}")),
            Err(e) => {
                let _ = c.conn.exec_sudo(&format!("cp -a -- {} {}", shell_quote(&backup), shell_quote(&plan.file)), s, None).await;
                let _ = docker::compose_action(&c.conn, c.access, s, &project, "up").await;
                Err(format!("échec, configuration d'origine restaurée : {e}"))
            }
        }
    }
    .await;
    track(&audit, &store, &server_id, "docker.restrict_port", &detail, r)
}
