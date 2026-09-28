//! Réseau privé entre serveurs (WireGuard) : le PC orchestre, les serveurs gardent leurs clés.

use futures_util::future::join_all;
use serde::Serialize;
use tauri::State;
use zenytt_core::mesh::{self, Member, NodeStatus};
use zenytt_profiles::{MeshMember, MeshNetwork};

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

/// Compte rendu d'une action sur un membre.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberResult {
    server_id: String,
    ok: bool,
    message: String,
}

impl MemberResult {
    fn from_result<T>(server_id: &str, r: Result<T, String>, done: &str) -> Self {
        match r {
            Ok(_) => Self { server_id: server_id.into(), ok: true, message: done.into() },
            Err(e) => Self { server_id: server_id.into(), ok: false, message: e },
        }
    }

    fn outcome(&self) -> Result<(), String> {
        if self.ok {
            Ok(())
        } else {
            Err(self.message.clone())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshReport {
    network: Option<MeshNetwork>,
    results: Vec<MemberResult>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshMemberStatus {
    server_id: String,
    error: Option<String>,
    status: Option<NodeStatus>,
}

fn valid_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 || n.chars().any(char::is_control) {
        return Err("donne au réseau un nom d'1 à 40 caractères, sur une ligne".into());
    }
    Ok(n.to_string())
}

/// Adresse publique du serveur : IP publique détectée, sinon l'hôte du profil s'il n'est pas privé.
fn endpoint_for(public_ips: &[String], profile_host: &str) -> Option<String> {
    if let Some(ip) = public_ips.first() {
        return Some(ip.clone());
    }
    let host = profile_host.trim();
    let private_ip = host.parse::<std::net::Ipv4Addr>().is_ok() && !mesh::is_public_ipv4(host);
    if private_ip || host.is_empty() || host == "localhost" {
        return None;
    }
    Some(host.to_string())
}

fn to_core(net: &MeshNetwork) -> Vec<Member> {
    net.members
        .iter()
        .map(|m| Member { address: m.address.clone(), public_key: m.public_key.clone(), endpoint: m.endpoint.clone(), port: m.port })
        .collect()
}

fn nat_warnings(net: &MeshNetwork, name_of: impl Fn(&str) -> String) -> Vec<String> {
    mesh::unreachable_pairs(&to_core(net))
        .into_iter()
        .map(|(i, j)| {
            format!(
                "{} et {} sont tous deux derrière un NAT : ils ne peuvent pas se joindre directement (relais prévu dans une prochaine version). Chacun joint les serveurs publics.",
                name_of(&net.members[i].server_id),
                name_of(&net.members[j].server_id)
            )
        })
        .collect()
}

fn server_name(store: &Store, id: &str) -> String {
    store.server(id).map(|s| s.name).unwrap_or_else(|_| "serveur supprimé".into())
}

fn record(audit: &AuditLog, store: &Store, action: &str, net: &MeshNetwork, results: &[MemberResult]) {
    for r in results {
        let _ = track(audit, store, &r.server_id, action, &net.name, r.outcome());
    }
}

/// Pousse la configuration à chaque membre, en parallèle.
async fn apply_all(store: &Store, sessions: &Sessions, net: &MeshNetwork) -> Vec<MemberResult> {
    let members = to_core(net);
    join_all(net.members.iter().enumerate().map(|(i, m)| {
        let cfg = mesh::node_config(&net.id, &net.name, &net.cidr, &members, i);
        async move {
            let r = async {
                let (conn, sudo) = admin(store, sessions, &m.server_id).await?;
                mesh::apply(&conn, sudo.as_deref(), &cfg).await.map_err(|e| e.to_string())
            }
            .await;
            MemberResult::from_result(&m.server_id, r, "configuration appliquée")
        }
    }))
    .await
}

/// Prépare un serveur et en fait un membre (port choisi, appartenance à un autre réseau refusée).
/// Sans `cidr` (création), l'adresse est attribuée après le choix du sous-réseau.
async fn new_member(
    store: &Store,
    sessions: &Sessions,
    server_id: &str,
    net_id: Option<&str>,
    cidr: Option<&str>,
    used: &[String],
) -> Result<(MeshMember, mesh::Prepared), String> {
    let (conn, sudo) = admin(store, sessions, server_id).await?;
    let p = mesh::prepare(&conn, sudo.as_deref()).await.map_err(|e| e.to_string())?;
    if let Some((id, name)) = &p.existing {
        if Some(id.as_str()) != net_id {
            return Err(format!(
                "{} appartient déjà au réseau privé « {name} » : retire-le d'abord de ce réseau",
                server_name(store, server_id)
            ));
        }
    }
    if let Some(c) = cidr {
        if mesh::overlaps(c, &p.routes) {
            return Err(format!("{} utilise déjà des adresses de {c} (Docker, LAN ou autre VPN)", server_name(store, server_id)));
        }
    }
    let port = p.existing_port.or_else(|| mesh::free_port(&p.busy_udp)).ok_or("aucun port UDP libre entre 51820 et 51899")?;
    let host = store.server(server_id).map(|s| s.host).unwrap_or_default();
    let address = match cidr {
        Some(c) => mesh::next_address(c, used).ok_or("réseau plein (254 serveurs)")?,
        None => String::new(),
    };
    let member = MeshMember {
        server_id: server_id.into(),
        address,
        public_key: p.public_key.clone(),
        endpoint: endpoint_for(&p.public_ips, &host),
        port,
    };
    Ok((member, p))
}

fn network(store: &Store, id: &str) -> Result<MeshNetwork, String> {
    store.read(|d| d.meshes.iter().find(|n| n.id == id).cloned()).ok_or_else(|| "réseau introuvable".to_string())
}

fn save(store: &Store, net: &MeshNetwork) -> Result<(), String> {
    store.write(|d| {
        if let Some(n) = d.meshes.iter_mut().find(|n| n.id == net.id) {
            *n = net.clone();
        }
    })
}

#[tauri::command]
pub fn mesh_list(store: State<'_, Store>) -> Vec<MeshNetwork> {
    store.read(|d| d.meshes.clone())
}

#[tauri::command]
pub async fn mesh_create(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    name: String,
    server_ids: Vec<String>,
) -> Result<MeshReport, String> {
    let name = valid_name(&name)?;
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<String> = server_ids.into_iter().filter(|id| seen.insert(id.clone())).collect();
    if ids.len() < 2 {
        return Err("choisis au moins deux serveurs".into());
    }
    let prepared = join_all(ids.iter().map(|id| new_member(&store, &sessions, id, None, None, &[]))).await;
    let mut errors = Vec::new();
    let mut members = Vec::new();
    let mut routes = String::new();
    for (id, r) in ids.iter().zip(prepared) {
        match r {
            Ok((m, p)) => {
                routes.push_str(&p.routes);
                routes.push('\n');
                members.push(m);
            }
            Err(e) => errors.push(format!("{} : {e}", server_name(&store, id))),
        }
    }
    if !errors.is_empty() {
        return Err(format!("réseau non créé :\n{}", errors.join("\n")));
    }
    let cidr = mesh::pick_subnet(&routes).ok_or("aucun sous-réseau libre entre 10.77.0.0/24 et 10.99.0.0/24 sur ces serveurs")?;
    let mut used = Vec::new();
    for m in &mut members {
        m.address = mesh::next_address(&cidr, &used).ok_or("réseau plein")?;
        used.push(m.address.clone());
    }
    let net = MeshNetwork { id: uuid::Uuid::new_v4().to_string(), name, cidr, members };
    store.write(|d| d.meshes.push(net.clone()))?;
    let results = apply_all(&store, &sessions, &net).await;
    record(&audit, &store, "mesh.create", &net, &results);
    let warnings = nat_warnings(&net, |id| server_name(&store, id));
    Ok(MeshReport { network: Some(net), results, warnings })
}

#[tauri::command]
pub async fn mesh_add(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    network_id: String,
    server_id: String,
) -> Result<MeshReport, String> {
    let mut net = network(&store, &network_id)?;
    if net.members.iter().any(|m| m.server_id == server_id) {
        return Err("ce serveur fait déjà partie du réseau".into());
    }
    let used: Vec<String> = net.members.iter().map(|m| m.address.clone()).collect();
    let r = new_member(&store, &sessions, &server_id, Some(&net.id), Some(&net.cidr), &used).await.map(|(m, _)| m);
    let m = track(&audit, &store, &server_id, "mesh.add", &net.name, r)?;
    net.members.push(m);
    save(&store, &net)?;
    let results = apply_all(&store, &sessions, &net).await;
    let warnings = nat_warnings(&net, |id| server_name(&store, id));
    Ok(MeshReport { network: Some(net), results, warnings })
}

#[tauri::command]
pub async fn mesh_remove(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    network_id: String,
    server_id: String,
) -> Result<MeshReport, String> {
    let mut net = network(&store, &network_id)?;
    let Some(pos) = net.members.iter().position(|m| m.server_id == server_id) else {
        return Err("ce serveur n'est pas dans le réseau".into());
    };
    let gone = net.members.remove(pos);
    // Retiré de la liste même s'il est injoignable : les autres cessent de l'accepter.
    save(&store, &net)?;
    let r = async {
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        mesh::remove(&conn, sudo.as_deref(), gone.port).await.map_err(|e| e.to_string())
    }
    .await;
    let r = track(&audit, &store, &server_id, "mesh.remove", &net.name, r);
    let mut results = vec![MemberResult::from_result(
        &server_id,
        r.map_err(|e| format!("{e} — l'interface zenytt est peut-être restée sur ce serveur")),
        "retiré du réseau",
    )];
    results.extend(apply_all(&store, &sessions, &net).await);
    Ok(MeshReport { network: Some(net), results, warnings: Vec::new() })
}

#[tauri::command]
pub async fn mesh_repair(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    network_id: String,
) -> Result<MeshReport, String> {
    let net = network(&store, &network_id)?;
    let results = apply_all(&store, &sessions, &net).await;
    record(&audit, &store, "mesh.repair", &net, &results);
    let warnings = nat_warnings(&net, |id| server_name(&store, id));
    Ok(MeshReport { network: Some(net), results, warnings })
}

#[tauri::command]
pub async fn mesh_delete(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    network_id: String,
) -> Result<MeshReport, String> {
    let net = network(&store, &network_id)?;
    let (st, se) = (&*store, &*sessions);
    let results = join_all(net.members.iter().map(|m| async move {
        let r = async {
            let (conn, sudo) = admin(st, se, &m.server_id).await?;
            mesh::remove(&conn, sudo.as_deref(), m.port).await.map_err(|e| e.to_string())
        }
        .await;
        MemberResult::from_result(&m.server_id, r, "retiré du réseau")
    }))
    .await;
    record(&audit, &store, "mesh.delete", &net, &results);
    store.write(|d| d.meshes.retain(|n| n.id != net.id))?;
    Ok(MeshReport { network: None, results, warnings: Vec::new() })
}

#[tauri::command]
pub async fn mesh_status(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    network_id: String,
) -> Result<Vec<MeshMemberStatus>, String> {
    let net = network(&store, &network_id)?;
    let (st, se) = (&*store, &*sessions);
    Ok(join_all(net.members.iter().map(|m| async move {
        let r = async {
            let (conn, sudo) = admin(st, se, &m.server_id).await?;
            mesh::status(&conn, sudo.as_deref()).await.map_err(|e| e.to_string())
        }
        .await;
        match r {
            Ok(s) => MeshMemberStatus { server_id: m.server_id.clone(), error: None, status: Some(s) },
            Err(e) => MeshMemberStatus { server_id: m.server_id.clone(), error: Some(e), status: None },
        }
    }))
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, addr: &str, endpoint: Option<&str>) -> MeshMember {
        MeshMember {
            server_id: id.into(),
            address: addr.into(),
            public_key: format!("K{id}"),
            endpoint: endpoint.map(Into::into),
            port: 51820,
        }
    }

    #[test]
    fn name_is_validated() {
        assert!(valid_name("Prod").is_ok());
        assert!(valid_name("  ").is_err());
        assert!(valid_name(&"x".repeat(41)).is_err());
        assert!(valid_name("a\nb").is_err());
    }

    #[test]
    fn endpoint_prefers_detected_public_ip_then_profile_host() {
        assert_eq!(endpoint_for(&["51.0.0.1".into()], "vps.example.com"), Some("51.0.0.1".into()));
        assert_eq!(endpoint_for(&[], "203.0.113.9"), Some("203.0.113.9".into()));
        assert_eq!(endpoint_for(&[], "192.168.1.20"), None, "IP privée dans le profil : derrière NAT");
        assert_eq!(endpoint_for(&[], "vps.example.com"), Some("vps.example.com".into()), "nom de domaine : supposé public");
    }

    #[test]
    fn warnings_name_unreachable_servers() {
        let net = MeshNetwork {
            id: "n".into(),
            name: "N".into(),
            cidr: "10.77.0.0/24".into(),
            members: vec![member("a", "10.77.0.1", Some("1.1.1.1")), member("b", "10.77.0.2", None), member("c", "10.77.0.3", None)],
        };
        let w = nat_warnings(&net, |id| id.to_uppercase());
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("B") && w[0].contains("C"), "{}", w[0]);
    }

    #[test]
    fn remove_reports_offline_member() {
        let r = MemberResult::from_result("s1", Err::<(), _>("connexion refusée".to_string()), "retiré");
        assert!(!r.ok && r.message.contains("connexion refusée"));
    }
}
