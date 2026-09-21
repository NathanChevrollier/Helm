//! Logique métier de Helm, indépendante de l'interface.

pub mod agent;
pub mod docker;
pub mod sftp;
pub mod ssh;
pub mod system;

pub use russh;
pub use russh_sftp;

pub use ssh::{Auth, ConnectParams, Connection, ExecOutput};

/// Erreurs remontées à l'interface. Le préfixe de certains messages sert de code côté UI.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("UNKNOWN_HOST_KEY:{0}")]
    UnknownHostKey(String),
    #[error("HOST_KEY_MISMATCH:{expected}|{got}")]
    HostKeyMismatch { expected: String, got: String },
    #[error("Connexion impossible : {0}")]
    Connection(String),
    #[error("Authentification échouée : {0}")]
    Auth(String),
    #[error("Erreur SSH : {0}")]
    Ssh(#[from] russh::Error),
    #[error("Erreur SFTP : {0}")]
    Sftp(String),
    #[error("Commande distante en échec : {0}")]
    Remote(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
