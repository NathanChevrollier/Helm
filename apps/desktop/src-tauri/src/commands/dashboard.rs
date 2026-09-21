//! Vue d'ensemble : un résumé léger par serveur (santé, alertes, conteneurs, certificats).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use helm_core::docker::{self, Access};
use helm_core::{agent, nginx};
use helm_protocol::proc::{parse_collect, COLLECT_SCRIPT};
use helm_protocol::{ActiveAlert, Metrics};
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::commands::monitoring::Monitor;
use crate::sessions::Sessions;
use crate::store::{secrets, Store};

/// Certificats mis en cache : leur lecture demande sudo et change rarement.
#[derive(Default)]
pub struct DashboardCache(Mutex<HashMap<String, (Instant, Vec<CertSummary>)>>);

const CERT_TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertSummary {
    domains: Vec<String>,
    not_after: i64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    connected: bool,
    /// Erreur de connexion ; `NEED_*` / `UNKNOWN_HOST_KEY` = une action de l'utilisateur est nécessaire.
    error: Option<String>,
    metrics: Option<Metrics>,
    agent: bool,
    alerts: Vec<ActiveAlert>,
    docker: bool,
    containers_running: usize,
    containers_stopped: usize,
    stopped_names: Vec<String>,
    certificates: Vec<CertSummary>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
pub async fn dashboard_summary(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    monitor: State<'_, Monitor>,
    cache: State<'_, DashboardCache>,
    server_id: String,
) -> Result<Summary, String> {
    let work = async {
        let conn = match sessions.get(&store, &server_id).await {
            Ok(c) => c,
            Err(e) => return Summary { error: Some(e), ..Default::default() },
        };
        let sudo = secrets::get(&server_id, "sudo");
        let mut out = Summary { connected: true, ..Default::default() };

        match agent::info(&conn).await {
            Ok(info) if info.running => {
                out.agent = true;
                if let Some(st) = info.status {
                    out.metrics = st.latest;
                    out.alerts = st.active_alerts;
                }
            }
            _ => {
                // Sans agent : relevé direct (le CPU se calcule avec le relevé précédent).
                if let Ok(text) = conn.run(COLLECT_SCRIPT).await {
                    let raw = parse_collect(&text, now_ms());
                    let mut prev = monitor.prev.lock().await;
                    out.metrics = Some(helm_protocol::compute(prev.get(&server_id), &raw));
                    prev.insert(server_id.clone(), raw);
                }
            }
        }

        if let Ok((access, _)) = docker::access(&conn, sudo.as_deref()).await {
            if access != Access::Unavailable {
                out.docker = true;
                if let Ok(list) = docker::containers(&conn, access, sudo.as_deref()).await {
                    out.containers_running = list.iter().filter(|c| c.state == "running").count();
                    let stopped: Vec<_> = list.iter().filter(|c| c.state != "running").collect();
                    out.containers_stopped = stopped.len();
                    out.stopped_names = stopped.iter().take(5).map(|c| c.name.clone()).collect();
                }
            }
        }

        let cached = cache.0.lock().await.get(&server_id).filter(|(t, _)| t.elapsed() < CERT_TTL).map(|(_, c)| c.clone());
        out.certificates = match cached {
            Some(c) => c,
            None => {
                let certs: Vec<CertSummary> = nginx::discover(&conn, sudo.as_deref())
                    .await
                    .map(|st| st.certificates.into_iter().map(|c| CertSummary { domains: c.domains, not_after: c.not_after }).collect())
                    .unwrap_or_default();
                cache.0.lock().await.insert(server_id.clone(), (Instant::now(), certs.clone()));
                certs
            }
        };
        out
    };
    // Un serveur lent ou injoignable ne doit pas bloquer la vue d'ensemble.
    Ok(tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .unwrap_or_else(|_| Summary { error: Some("délai dépassé".into()), ..Default::default() }))
}
