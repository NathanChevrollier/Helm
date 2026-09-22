//! Synchronisation des réglages avec les autres PC : fichier partagé ou serveur `helm-sync`.

use std::time::Duration;

use helm_profiles::sync::{self, Outcome, PushResult, Remote, SyncConfig, SyncMode, Transport, SECRET_OWNER};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::sessions::Sessions;
use crate::store::{secrets, Store};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncView {
    #[serde(flatten)]
    config: SyncConfig,
    has_passphrase: bool,
    has_token: bool,
}

/// Réglage de synchronisation, avec la présence (jamais la valeur) des secrets associés.
#[tauri::command]
pub fn sync_get(store: State<'_, Store>) -> SyncView {
    SyncView {
        config: store.read(|d| d.sync.clone()).unwrap_or_default(),
        has_passphrase: secrets::get(SECRET_OWNER, "passphrase").is_some(),
        has_token: secrets::get(SECRET_OWNER, "token").is_some(),
    }
}

/// Réglage modifiable depuis l'interface (l'état de la dernière synchronisation n'en fait pas partie).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    mode: SyncMode,
    path: Option<String>,
    url: Option<String>,
    include_secrets: bool,
    /// `None` : inchangé ; `Some("")` : supprimé.
    passphrase: Option<String>,
    token: Option<String>,
}

#[tauri::command]
pub fn sync_set(store: State<'_, Store>, settings: SyncSettings) -> Result<(), String> {
    let url = settings.url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty());
    if settings.mode == SyncMode::Server {
        let u = url.as_deref().ok_or("indique l'adresse du serveur de synchronisation")?;
        // Le jeton circule dans chaque requête : HTTPS obligatoire, sauf sur la machine elle-même.
        let local = ["http://127.0.0.1", "http://localhost", "http://[::1]"].iter().any(|p| u.starts_with(p));
        if !u.starts_with("https://") && !local {
            return Err("l'adresse doit commencer par https:// (le jeton ne doit pas circuler en clair)".into());
        }
    }
    let path = settings.path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if settings.mode == SyncMode::File && path.is_none() {
        return Err("choisis le fichier de synchronisation".into());
    }
    if let Some(p) = &settings.passphrase {
        if !p.is_empty() && p.chars().count() < 10 {
            return Err("phrase de passe trop courte (10 caractères minimum) : elle protège tous tes réglages".into());
        }
        secrets::set(SECRET_OWNER, "passphrase", p)?;
    }
    if let Some(t) = &settings.token {
        secrets::set(SECRET_OWNER, "token", t.trim())?;
    }
    store.write(|d| {
        let previous = d.sync.take().unwrap_or_default();
        // Autre destination : on repart de zéro (première synchronisation = fusion).
        let same_target = previous.mode == settings.mode && previous.path == path && previous.url == url;
        d.sync = Some(SyncConfig {
            mode: settings.mode,
            path,
            url,
            include_secrets: settings.include_secrets,
            last_rev: if same_target { previous.last_rev } else { 0 },
            last_hash: if same_target && previous.include_secrets == settings.include_secrets { previous.last_hash } else { None },
            last_sync: if same_target { previous.last_sync } else { None },
        });
    })
}

/// Serveur `helm-sync` (HTTP).
struct HttpTransport {
    url: String,
    token: String,
    agent: ureq::Agent,
}

impl HttpTransport {
    fn new(url: String, token: String) -> Self {
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).http_status_as_error(false).build().into();
        Self { url, token, agent }
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

fn http_error(status: u16, body: &str) -> String {
    let detail =
        serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v["error"].as_str().map(str::to_string)).unwrap_or_default();
    match status {
        401 => "jeton de synchronisation refusé par le serveur".into(),
        413 => "réglages trop volumineux pour le serveur".into(),
        _ => format!("serveur de synchronisation : erreur {status} {detail}").trim().to_string(),
    }
}

impl Transport for HttpTransport {
    fn fetch(&self) -> Result<Option<Remote>, String> {
        let mut res = self
            .agent
            .get(format!("{}/v1/state", self.url))
            .header("Authorization", self.auth())
            .call()
            .map_err(|e| format!("serveur injoignable : {e}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
        match status {
            200 => {
                let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| "réponse du serveur illisible".to_string())?;
                let rev = v["rev"].as_u64().ok_or("réponse du serveur illisible")?;
                let data = v["data"].as_str().ok_or("réponse du serveur illisible")?.to_string();
                Ok(Some(Remote { rev, data }))
            }
            404 => Ok(None),
            s => Err(http_error(s, &body)),
        }
    }

    fn push(&self, base_rev: u64, data: &str) -> Result<PushResult, String> {
        let mut res = self
            .agent
            .put(format!("{}/v1/state", self.url))
            .header("Authorization", self.auth())
            .send_json(serde_json::json!({ "baseRev": base_rev, "data": data }))
            .map_err(|e| format!("serveur injoignable : {e}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
        match status {
            200 => serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["rev"].as_u64())
                .map(PushResult::Ok)
                .ok_or_else(|| "réponse du serveur illisible".to_string()),
            409 => Ok(PushResult::Conflict),
            s => Err(http_error(s, &body)),
        }
    }
}

/// Lance une synchronisation. Les serveurs et tunnels supprimés sur un autre PC sont fermés ici.
#[tauri::command]
pub async fn sync_now(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    tunnels: State<'_, crate::commands::tunnels::Tunnels>,
) -> Result<Outcome, String> {
    let cfg = store.read(|d| d.sync.clone()).filter(|c| c.mode != SyncMode::Off).ok_or("synchronisation désactivée")?;
    let passphrase = secrets::get(SECRET_OWNER, "passphrase").ok_or("phrase de passe de synchronisation manquante")?;
    let transport: Box<dyn Transport + Send> = match cfg.mode {
        SyncMode::File => Box::new(sync::FileTransport { path: cfg.path.clone().ok_or("fichier de synchronisation non défini")?.into() }),
        SyncMode::Server => Box::new(HttpTransport::new(
            cfg.url.clone().ok_or("adresse du serveur non définie")?,
            secrets::get(SECRET_OWNER, "token").ok_or("jeton du serveur de synchronisation manquant")?,
        )),
        SyncMode::Off => unreachable!(),
    };
    // Le chiffrement (PBKDF2) et les entrées/sorties bloquent : hors du fil de l'interface.
    let store_ref: &Store = &store;
    let outcome = tokio::task::block_in_place(|| sync::run(store_ref, transport.as_ref(), &passphrase))?;
    for id in &outcome.removed_servers {
        sessions.disconnect(id).await;
    }
    for id in &outcome.removed_tunnels {
        tunnels.stop(id);
    }
    log::info!("synchronisation : {:?} (révision {})", outcome.action, outcome.rev);
    Ok(outcome)
}
