//! Journal local des actions : chaque modification d'un serveur (et chaque lecture faite par le MCP)
//! y est inscrite. Format JSON-lines, rotation à 5 Mo.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const MAX_SIZE: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Horodatage Unix en millisecondes.
    pub t: i64,
    /// `app` ou `mcp`.
    pub origin: String,
    pub server_id: String,
    pub server_name: String,
    /// Identifiant stable de l'action (`docker.restart`, `nginx.write`…).
    pub action: String,
    /// Cible lisible (conteneur, fichier, domaine…). Jamais de secret.
    pub detail: String,
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

pub struct AuditLog {
    path: PathBuf,
    origin: &'static str,
    lock: Mutex<()>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl AuditLog {
    pub fn new(dir: &Path, origin: &'static str) -> Self {
        let _ = std::fs::create_dir_all(dir);
        Self { path: dir.join("audit.log"), origin, lock: Mutex::new(()) }
    }

    pub fn record(&self, server_id: &str, server_name: &str, action: &str, detail: &str, result: Result<(), &str>) {
        let entry = Entry {
            t: now_ms(),
            origin: self.origin.to_string(),
            server_id: server_id.to_string(),
            server_name: server_name.to_string(),
            action: action.to_string(),
            detail: detail.chars().take(500).collect(),
            ok: result.is_ok(),
            error: result.err().map(|e| e.chars().take(500).collect()),
        };
        let _guard = self.lock.lock().unwrap();
        if std::fs::metadata(&self.path).map(|m| m.len() > MAX_SIZE).unwrap_or(false) {
            let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = writeln!(f, "{}", serde_json::to_string(&entry).unwrap_or_default());
        }
    }

    /// Dernières entrées, de la plus récente à la plus ancienne.
    pub fn recent(&self, limit: usize) -> Vec<Entry> {
        let _guard = self.lock.lock().unwrap();
        let mut out: Vec<Entry> = std::fs::read_to_string(&self.path)
            .unwrap_or_default()
            .lines()
            .rev()
            .filter_map(|l| serde_json::from_str(l).ok())
            .take(limit)
            .collect();
        if out.len() < limit {
            let older = std::fs::read_to_string(self.path.with_extension("log.1")).unwrap_or_default();
            out.extend(older.lines().rev().filter_map(|l| serde_json::from_str(l).ok()).take(limit - out.len()));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_reads_back_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path(), "app");
        log.record("s1", "VPS", "docker.restart", "web", Ok(()));
        log.record("s1", "VPS", "nginx.write", "/etc/nginx/x", Err("nginx -t a échoué"));
        let r = log.recent(10);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].action, "nginx.write");
        assert!(!r[0].ok);
        assert_eq!(r[1].detail, "web");
    }
}
