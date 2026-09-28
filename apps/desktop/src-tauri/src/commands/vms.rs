//! Machines virtuelles (libvirt) : inventaire, détail, activité, actions et suppression.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;
use zenytt_core::vm::{self, Access, Vm, VmAction, VmDetail};
use zenytt_core::Connection;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

/// Mode d'accès à libvirt mémorisé par serveur.
#[derive(Default)]
pub struct VmAccess(Mutex<HashMap<String, Access>>);

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub(crate) fn unavailable_message(reason: &str) -> String {
    if reason.contains("n'est pas installé") {
        return format!("{reason}. Le guide « Machines virtuelles » explique comment l'installer.");
    }
    format!("libvirt ne répond pas à ton utilisateur ({reason}). Ajoute-le au groupe libvirt (sudo usermod -aG libvirt $USER, puis reconnecte-toi) ou renseigne le mot de passe sudo dans le profil du serveur.")
}

struct Ctx {
    conn: Connection,
    sudo: Option<String>,
    access: Access,
}

async fn ctx(store: &Store, sessions: &Sessions, cache: &VmAccess, server_id: &str) -> Result<Ctx, String> {
    let (conn, sudo) = admin(store, sessions, server_id).await?;
    let known = cache.0.lock().await.get(server_id).copied().filter(|a| *a != Access::Unavailable);
    let access = match known {
        Some(a) => a,
        None => {
            let (a, reason) = vm::access(&conn, sudo.as_deref()).await.map_err(err)?;
            if a == Access::Unavailable {
                return Err(unavailable_message(&reason));
            }
            cache.0.lock().await.insert(server_id.to_string(), a);
            a
        }
    };
    Ok(Ctx { conn, sudo, access })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmOverview {
    access: Access,
    version: String,
    /// Explication quand libvirt est inaccessible (la section l'affiche à la place de la liste).
    reason: Option<String>,
    vms: Vec<Vm>,
}

#[tauri::command]
pub async fn vm_overview(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
) -> Result<VmOverview, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    let (access, version) = vm::access(&conn, sudo.as_deref()).await.map_err(err)?;
    cache.0.lock().await.insert(server_id.clone(), access);
    if access == Access::Unavailable {
        return Ok(VmOverview { access, version: String::new(), reason: Some(unavailable_message(&version)), vms: Vec::new() });
    }
    let vms = vm::list(&conn, access, sudo.as_deref()).await.map_err(err)?;
    Ok(VmOverview { access, version, reason: None, vms })
}

#[tauri::command]
pub async fn vm_detail(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
) -> Result<VmDetail, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    vm::detail(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmStatsView {
    uuid: String,
    cpu_percent: f64,
    memory_used_kib: Option<u64>,
}

#[tauri::command]
pub async fn vm_stats(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
) -> Result<Vec<VmStatsView>, String> {
    let c = ctx(&store, &sessions, &cache, &server_id).await?;
    let s = c.sudo.as_deref();
    let (vms, stats) = tokio::try_join!(vm::list(&c.conn, c.access, s), vm::stats(&c.conn, c.access, s)).map_err(err)?;
    // `domstats` désigne les VM par leur nom : retour à l'UUID par l'inventaire.
    let by_name: HashMap<&str, &str> = vms.iter().map(|v| (v.name.as_str(), v.uuid.as_str())).collect();
    Ok(stats
        .into_iter()
        .filter_map(|st| {
            by_name.get(st.name.as_str()).map(|u| VmStatsView {
                uuid: u.to_string(),
                cpu_percent: st.cpu_percent,
                memory_used_kib: st.memory_used_kib,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn vm_action(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
    name: String,
    action: VmAction,
) -> Result<(), String> {
    let r = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        vm::act(&c.conn, c.access, c.sudo.as_deref(), &uuid, action).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, &format!("vm.{}", serde_json::to_value(action).unwrap().as_str().unwrap_or("action")), &name, r)
}

#[tauri::command]
pub async fn vm_delete(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    cache: State<'_, VmAccess>,
    server_id: String,
    uuid: String,
    name: String,
    with_storage: bool,
) -> Result<(), String> {
    let r = async {
        let c = ctx(&store, &sessions, &cache, &server_id).await?;
        let d = vm::detail(&c.conn, c.access, c.sudo.as_deref(), &uuid).await.map_err(err)?;
        vm::delete(&c.conn, c.access, c.sudo.as_deref(), &uuid, with_storage, d.firmware == "uefi").await.map_err(err)
    }
    .await;
    let detail = if with_storage { format!("{name} (avec ses disques)") } else { name };
    track(&audit, &store, &server_id, "vm.delete", &detail, r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_unavailable_message() {
        let m = unavailable_message("libvirt (virsh) n'est pas installé sur ce serveur");
        assert!(m.contains("n'est pas installé"), "raison reprise telle quelle");
        let m = unavailable_message("error: failed to connect to the hypervisor");
        assert!(m.contains("groupe libvirt") && m.contains("mot de passe sudo"), "dit quoi faire : {m}");
    }
}
