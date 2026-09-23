//! Bases de données du serveur : découverte des instances (conteneurs Docker ou service local),
//! exploration et exécution de SQL.

use helm_core::db::{self, Engine, Instance, Named, QueryResult};
use helm_core::docker::{self, Access};
use tauri::State;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// Instances trouvées : conteneurs MySQL/MariaDB/PostgreSQL en cours, puis services installés.
/// La recherche côté Docker et la sonde des services locaux partent ensemble, et aucune version
/// n'est demandée ici : chaque sonde lance un client SQL sur le serveur, ce qui rendait
/// l'ouverture de l'onglet très lente. L'interface demande ensuite `db_version` pour la seule
/// instance affichée.
#[tauri::command]
pub async fn db_instances(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Instance>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    let containers = async {
        let (access, _) = docker::access(&conn, pw.as_deref()).await?;
        if access == Access::Unavailable {
            return Ok(Vec::new());
        }
        docker::containers(&conn, access, pw.as_deref()).await
    };
    let (containers, local) = tokio::join!(containers, conn.exec(db::LOCAL_PROBE, None));

    let mut out = Vec::new();
    for c in containers.map_err(err)? {
        if c.state != "running" {
            continue;
        }
        if let Some(engine) = Engine::from_image(&c.image) {
            out.push(Instance {
                id: format!("container:{}", c.name),
                label: format!("{} ({})", c.name, c.image),
                engine,
                container: Some(c.name),
                version: String::new(),
            });
        }
    }
    out.extend(db::parse_local(&local.map_err(err)?.stdout));
    Ok(out)
}

/// Version d'une instance, demandée à part pour ne pas retarder la liste. Chaîne vide si
/// l'instance est injoignable (mot de passe absent du conteneur, client manquant) : l'erreur
/// s'affichera à la première requête.
#[tauri::command]
pub async fn db_version(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
) -> Result<String, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    Ok(db::version(&conn, pw.as_deref(), &instance).await)
}

/// Crée une base vide dans l'instance choisie. L'action est inscrite au journal.
#[tauri::command]
pub async fn db_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    name: String,
) -> Result<(), String> {
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db::create_database(&conn, pw.as_deref(), &instance, &name).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "db.create", &format!("{} · {name}", instance.label), r)
}

#[tauri::command]
pub async fn db_databases(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
) -> Result<Vec<Named>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    db::databases(&conn, pw.as_deref(), &instance).await.map_err(err)
}

#[tauri::command]
pub async fn db_tables(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    database: String,
) -> Result<Vec<Named>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    db::tables(&conn, pw.as_deref(), &instance, &database).await.map_err(err)
}

/// Exécute du SQL. Les requêtes qui modifient les données sont inscrites au journal d'actions.
#[tauri::command]
pub async fn db_query(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    instance: Instance,
    database: Option<String>,
    sql: String,
    limit: Option<usize>,
) -> Result<QueryResult, String> {
    let read_only = db::is_read_only(&sql);
    let r: Result<QueryResult, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        db::query(&conn, pw.as_deref(), &instance, database.as_deref(), &sql, limit.unwrap_or(500).min(5000)).await.map_err(err)
    }
    .await;
    if read_only {
        return r;
    }
    let detail =
        format!("{} · {} : {}", instance.label, database.unwrap_or_default(), sql.split_whitespace().collect::<Vec<_>>().join(" "));
    track(&audit, &store, &server_id, "db.query", &detail.chars().take(500).collect::<String>(), r)
}

/// Requête d'aperçu du contenu d'une table (identifiant vérifié côté Rust).
#[tauri::command]
pub fn db_preview_query(engine: Engine, table: String, limit: usize) -> Result<String, String> {
    db::preview_query(engine, &table, limit.min(5000)).map_err(err)
}
