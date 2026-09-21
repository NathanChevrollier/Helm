pub mod files;
pub mod monitoring;
pub mod servers;
pub mod terminal;

use helm_core::Connection;

use crate::sessions::Sessions;
use crate::store::{secrets, Store};

/// Connexion + mot de passe sudo éventuel, pour les actions d'administration.
pub async fn admin(store: &Store, sessions: &Sessions, server_id: &str) -> Result<(Connection, Option<String>), String> {
    let conn = sessions.get(store, server_id).await?;
    Ok((conn, secrets::get(server_id, "sudo")))
}
