//! Accès au keyring de l'OS (Windows Credential Manager, macOS Keychain, Secret Service).

use crate::APP_ID;

fn entry(server_id: &str, kind: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(APP_ID, &format!("{server_id}:{kind}")).map_err(|e| e.to_string())
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
    for kind in ["password", "passphrase", "sudo", "restic"] {
        let _ = set(server_id, kind, "");
    }
}
