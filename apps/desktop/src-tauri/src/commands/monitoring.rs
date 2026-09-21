//! Monitoring : métriques en direct (sans agent), processus, services, et pilotage de l'agent helmd.

use std::collections::HashMap;

use helm_core::agent::{self, AgentInfo};
use helm_core::schedule;
use helm_core::system::{self, Process, Service};
use helm_protocol::proc::{parse_collect, COLLECT_SCRIPT};
use helm_protocol::{AgentConfig, HistoryPoint, Metrics, RawSample};
use tauri::State;
use tokio::sync::Mutex;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::AuditLog;
use crate::store::Store;

/// Binaires de l'agent embarqués à la compilation (vides s'ils n'ont pas été construits).
const AGENT_X86_64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/helmd-x86_64"));
const AGENT_AARCH64: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/helmd-aarch64"));

/// Dernier relevé brut par serveur, pour calculer CPU % et débits.
#[derive(Default)]
pub struct Monitor {
    pub prev: Mutex<HashMap<String, RawSample>>,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
pub async fn mon_metrics(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    monitor: State<'_, Monitor>,
    server_id: String,
) -> Result<Metrics, String> {
    let conn = sessions.get(&store, &server_id).await?;
    let out = conn.run(COLLECT_SCRIPT).await.map_err(err)?;
    let raw = parse_collect(&out, now_ms());
    let mut prev = monitor.prev.lock().await;
    let metrics = helm_protocol::compute(prev.get(&server_id), &raw);
    prev.insert(server_id, raw);
    Ok(metrics)
}

#[tauri::command]
pub async fn mon_processes(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<Process>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    system::processes(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn mon_kill(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    pid: u32,
    force: bool,
) -> Result<(), String> {
    let detail = format!("pid {pid}{}", if force { " (KILL)" } else { "" });
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::kill(&conn, pid, force, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "process.kill", &detail, r)
}

#[tauri::command]
pub async fn mon_services(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<Option<Vec<Service>>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    system::services(&conn).await.map_err(err)
}

#[tauri::command]
pub async fn mon_service_action(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    unit: String,
    action: String,
) -> Result<(), String> {
    let detail = format!("{action} {unit}");
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        system::service_action(&conn, &unit, &action, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "service.action", &detail, r)
}

#[tauri::command]
pub async fn mon_service_logs(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    unit: String,
    lines: u32,
) -> Result<String, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    system::service_logs(&conn, &unit, lines, pw.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn agent_info(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<AgentInfo, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    agent::info_privileged(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn agent_history(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    range_secs: u64,
    points: usize,
) -> Result<Vec<HistoryPoint>, String> {
    let conn = sessions.get(&store, &server_id).await?;
    agent::history(&conn, range_secs, points).await.map_err(err)
}

#[tauri::command]
pub async fn agent_install(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let detail = String::new();
    let r: Result<String, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        let dir = std::env::temp_dir().join("helm-agents");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let binary_for = |arch: &str| {
            let bytes = match arch {
                "x86_64" => AGENT_X86_64,
                "aarch64" => AGENT_AARCH64,
                _ => return None,
            };
            if bytes.is_empty() {
                return None;
            }
            let path = dir.join(format!("helmd-{arch}"));
            std::fs::write(&path, bytes).ok()?;
            Some(path)
        };
        agent::install(&conn, pw.as_deref(), binary_for).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "agent.install", &detail, r)
}

#[tauri::command]
pub async fn agent_uninstall(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<(), String> {
    let detail = String::new();
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        agent::uninstall(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "agent.uninstall", &detail, r)
}

#[tauri::command]
pub async fn agent_save_config(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    config: AgentConfig,
) -> Result<(), String> {
    let detail = String::new();
    let r: Result<(), String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        agent::save_config(&conn, &config, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "agent.config", &detail, r)
}

#[tauri::command]
pub async fn agent_test_notify(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<String, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    agent::test_notify(&conn, sudo.as_deref()).await.map_err(err)
}

// ---------- Tâches planifiées ----------

#[tauri::command]
pub async fn schedule_list(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<schedule::Schedule, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    schedule::list(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn crontab_save(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    user: String,
    content: String,
) -> Result<(), String> {
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        schedule::save_crontab(&conn, sudo.as_deref(), &user, &content).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "crontab.save", &user, r)
}

#[tauri::command]
pub async fn timer_run(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    service: String,
) -> Result<(), String> {
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        schedule::run_timer_now(&conn, sudo.as_deref(), &service).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "timer.run", &service, r)
}
