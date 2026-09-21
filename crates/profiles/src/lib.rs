//! Données locales de Helm, partagées par l'app desktop et le serveur MCP :
//! profils de serveurs, clés d'hôte approuvées, snippets, tunnels, état de l'interface,
//! secrets (dans le keyring de l'OS) et journal d'actions.

pub mod audit;
pub mod export;
pub mod secrets;
pub mod ssh_config;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use helm_core::{Auth, ConnectParams};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Identifiant de l'app : nom du dossier de configuration et du service keyring.
pub const APP_ID: &str = "dev.helm.desktop";

/// Dossier de configuration de Helm (identique à `app_config_dir` de Tauri).
pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join(APP_ID)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
    /// Le serveur MCP (lecture seule) peut-il interroger ce serveur ? Désactivé par défaut.
    #[serde(default)]
    pub ai_access: bool,
    /// Serveur de rebond (bastion) par lequel passer pour joindre celui-ci (`ssh -J`).
    #[serde(default)]
    pub jump_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
}

/// Tunnel SSH local : 127.0.0.1:`local_port` sur le PC → `remote_host`:`remote_port` vu du serveur.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDef {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub auto_start: bool,
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
    #[serde(default)]
    pub tunnels: Vec<TunnelDef>,
    /// État de l'interface (onglets, dossiers ouverts…), opaque côté Rust.
    #[serde(default)]
    pub ui_state: serde_json::Value,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
    /// Problème rencontré au chargement (fichier illisible), à signaler à l'utilisateur.
    warning: Option<String>,
}

impl Store {
    /// Lecture seule, sans jamais toucher au fichier (serveur MCP).
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("helm.json");
        let data = read_json(&path).unwrap_or_default();
        Self { path, data: Mutex::new(data), warning: None }
    }

    /// Chargement par l'app. Un fichier illisible n'est jamais écrasé : il est mis de côté et
    /// la copie de secours (`helm.json.bak`, version précédente) est utilisée si elle est valide.
    pub fn open(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join("helm.json");
        let Ok(bytes) = std::fs::read(&path) else {
            return Self { path, data: Mutex::default(), warning: None };
        };
        if let Ok(data) = serde_json::from_slice(&bytes) {
            return Self { path, data: Mutex::new(data), warning: None };
        }
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let aside = dir.join(format!("helm.json.corrompu-{stamp}"));
        let moved = std::fs::rename(&path, &aside).is_ok();
        let kept = if moved { format!("Il a été conservé sous {}.", aside.display()) } else { String::new() };
        let (data, warning) = match read_json::<Data>(&path.with_extension("json.bak")) {
            Some(d) => (d, format!("Le fichier de configuration de Helm était illisible : la version précédente a été restaurée. {kept}")),
            None => (
                Data::default(),
                format!("Le fichier de configuration de Helm était illisible et aucune copie de secours n'est valide. {kept}"),
            ),
        };
        Self { path, data: Mutex::new(data), warning: Some(warning) }
    }

    pub fn warning(&self) -> Option<String> {
        self.warning.clone()
    }

    /// Relit le fichier (le serveur MCP tourne dans un autre processus que l'app).
    pub fn reload(&self) {
        if let Some(d) = read_json(&self.path) {
            *self.data.lock().unwrap() = d;
        }
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
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(&json).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        // La version précédente, valide, sert de copie de secours.
        if read_json::<Data>(&self.path).is_some() {
            let _ = std::fs::copy(&self.path, self.path.with_extension("json.bak"));
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn server(&self, id: &str) -> Result<ServerProfile, String> {
        self.read(|d| d.servers.iter().find(|s| s.id == id).cloned()).ok_or_else(|| "serveur introuvable".to_string())
    }

    /// Chaîne des serveurs de rebond de `id` (le premier est celui à joindre d'abord). Refuse une
    /// boucle (A passe par B qui passe par A) ou un rebond vers un serveur supprimé.
    pub fn jump_chain(&self, id: &str) -> Result<Vec<String>, String> {
        let mut chain: Vec<String> = Vec::new();
        let mut current = self.server(id)?.jump_id.filter(|j| !j.is_empty());
        while let Some(j) = current {
            if j == id || chain.contains(&j) {
                return Err("les serveurs de rebond forment une boucle : corrige le profil".into());
            }
            let next = self.server(&j).map_err(|_| "le serveur de rebond de ce profil n'existe plus".to_string())?;
            chain.push(j);
            current = next.jump_id.filter(|j| !j.is_empty());
        }
        Ok(chain)
    }

    /// Paramètres de connexion SSH d'un serveur, secrets lus dans le keyring.
    pub fn connect_params(&self, server_id: &str) -> Result<ConnectParams, String> {
        let profile = self.server(server_id)?;
        let auth = match profile.auth_kind {
            AuthKind::Password => Auth::Password {
                password: secrets::get(server_id, "password").ok_or("NEED_PASSWORD: aucun mot de passe enregistré pour ce serveur")?,
            },
            AuthKind::Key => Auth::KeyFile {
                path: profile.key_path.clone().ok_or("aucune clé privée configurée")?,
                passphrase: secrets::get(server_id, "passphrase"),
            },
            AuthKind::Agent => Auth::Agent { key_path: profile.key_path.clone() },
        };
        let host_key = format!("{}:{}", profile.host, profile.port);
        Ok(ConnectParams {
            host: profile.host,
            port: profile.port,
            username: profile.username,
            auth,
            known_fingerprint: self.read(|d| d.known_hosts.get(&host_key).cloned()),
        })
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_files_still_load() {
        // Fichier de la v1 : sans tunnels, ui_state ni ai_access.
        let v1 = r#"{"servers":[{"id":"a","name":"VPS","host":"h","port":22,"username":"root","authKind":"password"}],"knownHosts":{},"snippets":[]}"#;
        let d: Data = serde_json::from_str(v1).unwrap();
        assert!(!d.servers[0].ai_access);
        assert!(d.tunnels.is_empty());
    }

    #[test]
    fn corrupt_file_is_kept_and_backup_restored() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        s.write(|d| d.snippets.push(Snippet { id: "1".into(), name: "a".into(), command: "ls".into() })).unwrap();
        s.write(|d| d.snippets.push(Snippet { id: "2".into(), name: "b".into(), command: "ls".into() })).unwrap();
        std::fs::write(dir.path().join("helm.json"), b"{ tronqu").unwrap();

        let s = Store::open(dir.path());
        assert!(s.warning().is_some());
        assert_eq!(s.read(|d| d.snippets.len()), 1, "la version précédente est restaurée");
        let aside =
            std::fs::read_dir(dir.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("helm.json.corrompu-"));
        assert!(aside, "le fichier illisible est conservé");
    }

    #[test]
    fn jump_chains() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        let p = |id: &str, jump: Option<&str>| ServerProfile {
            id: id.into(),
            name: id.into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth_kind: AuthKind::Agent,
            key_path: None,
            color: None,
            group: None,
            ai_access: false,
            jump_id: jump.map(str::to_string),
        };
        s.write(|d| d.servers.extend([p("a", Some("b")), p("b", Some("c")), p("c", None), p("x", Some("y")), p("y", Some("x"))])).unwrap();
        assert_eq!(s.jump_chain("a").unwrap(), vec!["b", "c"]);
        assert!(s.jump_chain("c").unwrap().is_empty());
        assert!(s.jump_chain("x").is_err(), "boucle détectée");
    }

    #[test]
    fn write_then_reload() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::load(dir.path());
        s.write(|d| d.snippets.push(Snippet { id: "1".into(), name: "n".into(), command: "ls".into() })).unwrap();
        let other = Store::load(dir.path());
        assert_eq!(other.read(|d| d.snippets.len()), 1);
    }
}
