//! Sauvegardes planifiées (restic) : configuration, sauvegardes existantes, restauration.

use helm_core::backup::{self, BackupConfig, DbSource, Destination, Node, Snapshot, Status};
use helm_core::docker::{self, Access};
use helm_core::ssh::shell_quote;
use serde::Serialize;
use tauri::State;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{secrets, AuditLog, Store};

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    status: Status,
    default_config: BackupConfig,
    volumes: Vec<String>,
    databases: Vec<DbSource>,
    /// Le mot de passe restic est aussi gardé dans le coffre de ce PC.
    password_in_keyring: bool,
}

#[tauri::command]
pub async fn backup_overview(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Overview, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let s = sudo.as_deref();
    let status = backup::status(&conn, s).await.map_err(err)?;
    let (mut volumes, mut databases) = (vec![], vec![]);
    if let Ok((access, _)) = docker::access(&conn, s).await {
        if access != Access::Unavailable {
            if let Ok(out) = docker::run(&conn, access, s, "volume ls --format '{{.Name}}'").await {
                // Les volumes anonymes (longs identifiants hexadécimaux) sont ignorés.
                volumes = out
                    .stdout
                    .lines()
                    .map(str::trim)
                    .filter(|v| !(v.is_empty() || v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit())))
                    .map(str::to_string)
                    .collect();
            }
            if let Ok(list) = docker::containers(&conn, access, s).await {
                for c in list {
                    let img = c.image.to_lowercase();
                    let kind = if img.contains("mysql") || img.contains("mariadb") {
                        "mysql"
                    } else if img.contains("postgres") || img.contains("postgis") || img.contains("timescale") {
                        "postgres"
                    } else {
                        continue;
                    };
                    databases.push(DbSource { container: c.name, kind: kind.into() });
                }
            }
        }
    }
    Ok(Overview {
        status,
        default_config: BackupConfig::default(),
        volumes,
        databases,
        password_in_keyring: secrets::get(&server_id, "restic").is_some(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    log: String,
    /// Mot de passe généré à l'instant : à conserver précieusement (affiché une seule fois).
    generated_password: Option<String>,
}

fn random_password() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

#[tauri::command]
pub async fn backup_save(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    config: BackupConfig,
    restic_password: Option<String>,
    s3_secret: Option<String>,
) -> Result<SaveResult, String> {
    let detail = config.repository();
    let r = async {
        config.validate().map_err(err)?;
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        let s = sudo.as_deref();
        let existing = backup::current_secret(&conn, s, "RESTIC_PASSWORD").await.ok().flatten();
        let mut generated = None;
        let password = match restic_password.filter(|p| !p.is_empty()).or(existing).or_else(|| secrets::get(&server_id, "restic")) {
            Some(p) => p,
            None => {
                let p = random_password();
                generated = Some(p.clone());
                p
            }
        };
        let s3 = match (&config.destination, s3_secret.filter(|x| !x.is_empty())) {
            (Destination::S3 { .. }, Some(x)) => Some(x),
            (Destination::S3 { .. }, None) => backup::current_secret(&conn, s, "AWS_SECRET_ACCESS_KEY").await.ok().flatten(),
            _ => None,
        };
        let env = backup::env_file(&config, &password, s3.as_deref()).map_err(err)?;
        let log = backup::install(&conn, s, &config, &env).await.map_err(err)?;
        // Sans ce mot de passe, les sauvegardes sont illisibles : on en garde une copie sur ce PC.
        secrets::set(&server_id, "restic", &password)?;
        Ok(SaveResult { log, generated_password: generated })
    }
    .await;
    track(&audit, &store, &server_id, "backup.configure", &detail, r)
}

#[tauri::command]
pub async fn backup_snapshots(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Snapshot>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    backup::snapshots(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn backup_list(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    snapshot: String,
    path: String,
) -> Result<Vec<Node>, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    backup::list(&conn, sudo.as_deref(), &snapshot, &path).await.map_err(err)
}

#[tauri::command]
pub async fn backup_restore(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    snapshot: String,
    path: String,
) -> Result<String, String> {
    let detail = format!("{snapshot} {path}");
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        backup::restore_to_temp(&conn, sudo.as_deref(), &snapshot, &path).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "backup.restore_temp", &detail, r)
}

#[tauri::command]
pub async fn backup_put_back(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    restored: String,
    original: String,
) -> Result<String, String> {
    let detail = original.clone();
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        backup::put_back(&conn, sudo.as_deref(), &restored, &original).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "backup.put_back", &detail, r)
}

#[tauri::command]
pub async fn backup_import_dump(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    dump: String,
    database: DbSource,
) -> Result<String, String> {
    let detail = format!("{} ← {dump}", database.container);
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        backup::import_dump(&conn, sudo.as_deref(), &dump, &database).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "backup.import_dump", &detail, r)
}

/// Copie un élément restauré dans le dossier personnel de l'utilisateur SSH, pour le télécharger via SFTP.
#[tauri::command]
pub async fn backup_stage_download(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    restored: String,
) -> Result<String, String> {
    if !restored.starts_with(&format!("{}/", backup::RESTORE_ROOT)) || restored.contains("..") {
        return Err("chemin invalide".into());
    }
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let user = conn.run("id -un").await.map_err(err)?.trim().to_string();
    let home = conn.run("printf %s \"$HOME\"").await.map_err(err)?;
    let dest = format!("{home}/helm-restauration");
    let cmd = format!(
        "mkdir -p {d} && cp -a {r} {d}/ && chown -R {u}: {d}",
        d = shell_quote(&dest),
        r = shell_quote(&restored),
        u = shell_quote(&user)
    );
    helm_core::ssh::long(conn.exec_sudo(&cmd, sudo.as_deref(), None)).await.map_err(err)?.into_result().map_err(err)?;
    let name = restored.rsplit('/').next().unwrap_or("");
    Ok(format!("{dest}/{name}"))
}

#[tauri::command]
pub async fn backup_check(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<String, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    backup::check(&conn, sudo.as_deref()).await.map_err(err)
}
