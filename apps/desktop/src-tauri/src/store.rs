//! Persistance locale en JSON dans le dossier de configuration de l'app.
//! Aucun secret n'est écrit ici : mots de passe et passphrases vont dans le keyring de l'OS.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Password,
    Key,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    #[serde(default)]
    pub servers: Vec<ServerProfile>,
    /// `host:port` → empreinte SHA256 de la clé d'hôte approuvée.
    #[serde(default)]
    pub known_hosts: HashMap<String, String>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("helm.json");
        let data = read_json(&path).unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    pub fn read<T>(&self, f: impl FnOnce(&Data) -> T) -> T {
        f(&self.data.lock().unwrap())
    }

    /// Modifie les données puis les écrit sur disque de façon atomique (fichier temporaire + rename).
    pub fn write<T>(&self, f: impl FnOnce(&mut Data) -> T) -> Result<T, String> {
        let mut data = self.data.lock().unwrap();
        let out = f(&mut data);
        let json = serde_json::to_vec_pretty(&*data).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn server(&self, id: &str) -> Result<ServerProfile, String> {
        self.read(|d| d.servers.iter().find(|s| s.id == id).cloned()).ok_or_else(|| "serveur introuvable".to_string())
    }
}

fn read_json<T: DeserializeOwned>(path: &PathBuf) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Accès au keyring de l'OS (Windows Credential Manager, macOS Keychain, Secret Service).
pub mod secrets {
    const SERVICE: &str = "dev.helm.desktop";

    fn entry(server_id: &str, kind: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, &format!("{server_id}:{kind}")).map_err(|e| e.to_string())
    }

    pub fn get(server_id: &str, kind: &str) -> Option<String> {
        entry(server_id, kind).ok()?.get_password().ok()
    }

    /// Enregistre le secret, ou le supprime si la valeur est vide.
    pub fn set(server_id: &str, kind: &str, value: &str) -> Result<(), String> {
        let e = entry(server_id, kind)?;
        if value.is_empty() {
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            }
        } else {
            e.set_password(value).map_err(|e| e.to_string())
        }
    }

    pub fn delete_all(server_id: &str) {
        for kind in ["password", "passphrase", "sudo"] {
            let _ = set(server_id, kind, "");
        }
    }
}
