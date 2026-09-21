//! Logique métier de Helm, indépendante de l'interface.
//!
//! Modules prévus : `ssh` (phase 1), `sftp` (phase 2), `docker` (phase 4), `nginx` (phase 5).

use serde::{Deserialize, Serialize};

/// Serveur enregistré dans l'app. Les secrets sont stockés dans le keyring de l'OS, jamais ici.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}
