//! Gestion Docker : conteneurs, projets compose, images, volumes, nettoyage et catalogue
//! d'applications prêtes à déployer.

use std::collections::HashMap;

use helm_core::catalog;
use helm_core::docker::{self, Access, ComposeProject, Container, DiskUsage, Image, Stats, Volume};
use helm_core::registry as helm_registry;
use helm_core::ssh::shell_quote;
use helm_core::Connection;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::AuditLog;
use crate::store::{secrets, Store};
use helm_profiles::Registry;

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
    let s = sudo.as_deref();
    let known = cache.0.lock().await.get(&server_id).copied().filter(|a| *a != Access::Unavailable);
    // Accès déjà connu : sa vérification part en même temps que les listes (un aller-retour de moins).
    let (checked, lists) = match known {
        Some(a) => {
            let (checked, lists) = tokio::join!(docker::access(&conn, s), async {
                tokio::try_join!(docker::containers(&conn, a, s), docker::compose_projects(&conn, a, s))
            });
            (checked, Some((a, lists)))
        }
        None => (docker::access(&conn, s).await, None),
    };
    let (access, version) = checked.map_err(err)?;
    cache.0.lock().await.insert(server_id.clone(), access);
    let engine = if version.starts_with("podman") { "podman" } else { "docker" }.to_string();
    if access == Access::Unavailable {
        return Ok(Overview { access, version, engine, containers: vec![], projects: vec![] });
    }
    let (containers, projects) = match lists {
        Some((a, lists)) if a == access => lists.map_err(err)?,
        _ => tokio::try_join!(docker::containers(&conn, access, s), docker::compose_projects(&conn, access, s)).map_err(err)?,
    };
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeCreated {
    file: String,
    log: String,
    started: bool,
}

/// Crée un projet compose : dossier, `docker-compose.yml`, `.env` éventuel, puis vérification
/// (`docker compose config`) et démarrage optionnel.
#[tauri::command]
pub async fn docker_compose_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    name: String,
    directory: Option<String>,
    yaml: String,
    env: Option<String>,
    start: bool,
) -> Result<ComposeCreated, String> {
    let detail = name.clone();
    let r: Result<ComposeCreated, String> = async {
        if !docker::valid_project_name(&name) {
            return Err("nom de projet invalide : lettres minuscules, chiffres, - et _ seulement".into());
        }
        let dir =
            directory.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).unwrap_or_else(|| format!("{}/{name}", docker::STACKS_DIR));
        if !dir.starts_with('/') || dir.contains("..") || dir.contains('\n') {
            return Err("chemin de dossier invalide".into());
        }
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        let file = format!("{dir}/docker-compose.yml");
        if c.conn.exec(&format!("test -e {}", shell_quote(&file)), None).await.map_err(err)?.success() {
            return Err(format!("{file} existe déjà : choisis un autre nom ou un autre dossier"));
        }
        c.conn
            .exec_sudo(&format!("mkdir -p {}", shell_quote(&dir)), c.sudo.as_deref(), None)
            .await
            .map_err(err)?
            .into_result()
            .map_err(err)?;
        c.conn.write_file_sudo(&file, &yaml, c.sudo.as_deref()).await.map_err(err)?;
        if let Some(env) = env.as_deref().filter(|e| !e.trim().is_empty()) {
            let env_file = format!("{dir}/.env");
            c.conn.write_file_sudo(&env_file, env, c.sudo.as_deref()).await.map_err(err)?;
            // Le .env contient souvent des mots de passe : lui seul est restreint.
            let _ = c.conn.exec_sudo(&format!("chmod 600 {}", shell_quote(&env_file)), c.sudo.as_deref(), None).await;
        }
        // Vérification de la syntaxe avant tout démarrage : un fichier invalide n'est pas lancé.
        let check = docker::run(&c.conn, c.access, c.sudo.as_deref(), &format!("compose -f {} config -q 2>&1", shell_quote(&file)))
            .await
            .map_err(err)?;
        if !check.success() {
            return Err(format!(
                "fichier compose refusé par Docker (il est enregistré, corrige-le puis relance) :\n{}{}",
                check.stdout, check.stderr
            ));
        }
        if !start {
            return Ok(ComposeCreated { file, log: String::new(), started: false });
        }
        let out = helm_core::ssh::long(docker::run(
            &c.conn,
            c.access,
            c.sudo.as_deref(),
            &format!("compose -f {} -p {} up -d 2>&1", shell_quote(&file), shell_quote(&name)),
        ))
        .await
        .map_err(err)?;
        if !out.success() {
            return Err(format!("docker compose up a échoué :\n{}{}", out.stdout, out.stderr));
        }
        Ok(ComposeCreated { file, log: out.stdout, started: true })
    }
    .await;
    track(&audit, &store, &server_id, "docker.compose_create", &detail, r)
}

/// Modèle de départ d'un projet compose.
#[tauri::command]
pub fn docker_compose_template(name: String, image: String, host_port: u16, container_port: u16) -> String {
    docker::compose_template(&name, &image, host_port, container_port)
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

/// Catalogue d'applications prêtes à déployer. La liste est intégrée à Helm : aucun appel réseau,
/// donc aucun dépôt tiers à faire confiance, et le catalogue fonctionne hors ligne.
#[tauri::command]
pub fn docker_catalog() -> Vec<catalog::App> {
    catalog::apps()
}

/// Valeurs de départ d'une application du catalogue : les valeurs proposées, et un mot de passe
/// tiré de l'aléa du système pour chaque réglage secret.
#[tauri::command]
pub fn docker_catalog_defaults(app_id: String) -> Result<Vec<(String, String)>, String> {
    let app = catalog::app(&app_id).ok_or_else(|| format!("application inconnue : {app_id}"))?;
    catalog::defaults(&app).map_err(err)
}

/// Rend le `docker-compose.yml` et le `.env` d'une application, pour les montrer avant écriture.
#[tauri::command]
pub fn docker_catalog_render(app_id: String, values: HashMap<String, String>) -> Result<catalog::Rendered, String> {
    let app = catalog::app(&app_id).ok_or_else(|| format!("application inconnue : {app_id}"))?;
    catalog::render(&app, &values).map_err(err)
}

/// Volumes du serveur, avec leur taille sur le disque et les conteneurs qui les montent.
#[tauri::command]
pub async fn docker_volumes(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
) -> Result<Vec<Volume>, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    docker::volumes(&c.conn, c.access, c.sudo.as_deref()).await.map_err(err)
}

/// Supprime un volume. Docker refuse de lui-même si un conteneur l'utilise encore.
#[tauri::command]
pub async fn docker_remove_volume(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    name: String,
) -> Result<(), String> {
    let detail = name.clone();
    let r: Result<(), String> = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        docker::remove_volume(&c.conn, c.access, c.sudo.as_deref(), &name).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "docker.volume_rm", &detail, r)
}

// ---------- Registres privés ----------

/// Registre enregistré, avec l'indication qu'un jeton est bien dans le coffre.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryView {
    #[serde(flatten)]
    registry: Registry,
    has_secret: bool,
    /// Ce qu'il faut demander comme secret, et avec quels droits.
    secret_hint: &'static str,
}

#[tauri::command]
pub fn registries_list(store: State<'_, Store>) -> Vec<RegistryView> {
    store
        .read(|d| d.registries.clone())
        .into_iter()
        .map(|r| RegistryView {
            has_secret: secrets::get(&Registry::secret_owner(&r.id), "password").is_some(),
            secret_hint: r.kind.secret_hint(),
            registry: r,
        })
        .collect()
}

/// Enregistre un registre ; le secret, s'il est fourni, va dans le keyring et nulle part ailleurs.
#[tauri::command]
pub fn registry_save(store: State<'_, Store>, mut registry: Registry, secret: Option<String>) -> Result<String, String> {
    registry.server = registry.server.trim().trim_start_matches("https://").trim_end_matches('/').to_string();
    if registry.server.is_empty() {
        registry.server = registry.kind.default_server().to_string();
    }
    if !helm_registry::valid_server(&registry.server) {
        return Err(format!("adresse de registre invalide : {}", registry.server));
    }
    if registry.kind == helm_registry::Kind::Ecr && helm_registry::ecr_region(&registry.server).is_none() {
        return Err("adresse ECR attendue : <compte>.dkr.ecr.<région>.amazonaws.com".into());
    }
    registry.username = registry.username.trim().to_string();
    if !helm_registry::valid_word(&registry.username) {
        return Err("nom d'utilisateur (ou identifiant de clé AWS) invalide".into());
    }
    registry.name = registry.name.trim().to_string();
    if registry.name.is_empty() {
        registry.name = registry.server.clone();
    }
    if registry.id.is_empty() {
        registry.id = uuid::Uuid::new_v4().to_string();
    }
    let id = registry.id.clone();
    if let Some(s) = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        if s.contains('\n') {
            return Err("le secret ne doit pas contenir de retour à la ligne".into());
        }
        secrets::set(&Registry::secret_owner(&id), "password", &s)?;
    }
    store.write(|d| match d.registries.iter_mut().find(|x| x.id == id) {
        Some(existing) => *existing = registry,
        None => d.registries.push(registry),
    })?;
    Ok(id)
}

#[tauri::command]
pub fn registry_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.write(|d| d.registries.retain(|r| r.id != id))?;
    secrets::delete_all(&Registry::secret_owner(&id));
    Ok(())
}

/// Registres auxquels un serveur est déjà connecté, lus dans le `config.json` de Docker. Les
/// jetons eux-mêmes ne sont jamais lus : seules les adresses remontent.
#[tauri::command]
pub async fn registry_sessions(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
) -> Result<Vec<helm_registry::Session>, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    helm_registry::sessions(&c.conn, c.access, c.sudo.as_deref()).await.map_err(err)
}

/// Connecte un serveur à un registre enregistré. Le secret est lu dans le keyring et transmis sur
/// l'entrée standard de `docker login` : il n'apparaît dans aucune ligne de commande.
#[tauri::command]
pub async fn registry_login(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    registry_id: String,
) -> Result<String, String> {
    let registry = store.read(|d| d.registries.iter().find(|r| r.id == registry_id).cloned()).ok_or("registre introuvable")?;
    let detail = format!("{} ({})", registry.name, registry.server);
    let r: Result<String, String> = async {
        let secret = secrets::get(&Registry::secret_owner(&registry.id), "password")
            .ok_or("aucun jeton enregistré pour ce registre : modifie-le pour en ajouter un")?;
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        helm_registry::login(&c.conn, c.access, c.sudo.as_deref(), registry.kind, &registry.server, &registry.username, &secret)
            .await
            .map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "docker.registry_login", &detail, r)
}

/// Déconnecte un serveur d'un registre : Docker efface le jeton de son `config.json`.
#[tauri::command]
pub async fn registry_logout(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, DockerAccess>,
    server_id: String,
    server: String,
) -> Result<(), String> {
    let detail = server.clone();
    let r: Result<(), String> = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        helm_registry::logout(&c.conn, c.access, c.sudo.as_deref(), &server).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "docker.registry_logout", &detail, r)
}
