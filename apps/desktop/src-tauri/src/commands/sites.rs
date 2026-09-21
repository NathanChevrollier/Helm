//! Sites : vhosts nginx, certificats, et assistant de création d'un nouveau site.

use helm_core::docker::{self, Access};
use helm_core::nginx::{self, ApplyResult, NginxState};
use helm_core::ssh::shell_quote;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::AuditLog;
use crate::store::Store;

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn sites_state(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<NginxState, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    nginx::discover(&conn, pw.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn sites_read(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String, path: String) -> Result<String, String> {
    if !path.starts_with("/etc/nginx/") {
        return Err("chemin hors de /etc/nginx".into());
    }
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    let direct = conn.exec(&format!("cat {}", shell_quote(&path)), None).await.map_err(err)?;
    if direct.success() {
        return Ok(direct.stdout);
    }
    conn.read_file_sudo(&path, pw.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn sites_write(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    path: String,
    content: String,
    enable_link: Option<String>,
) -> Result<ApplyResult, String> {
    let detail = path.clone();
    let r: Result<ApplyResult, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        nginx::write_config(&conn, pw.as_deref(), &path, &content, enable_link.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "nginx.write", &detail, r)
}

#[tauri::command]
pub async fn sites_set_enabled(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    available: String,
    link: String,
    enabled: bool,
) -> Result<ApplyResult, String> {
    let detail = format!("{} {available}", if enabled { "activer" } else { "désactiver" });
    let r: Result<ApplyResult, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        nginx::set_enabled(&conn, pw.as_deref(), &available, &link, enabled).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "nginx.enable", &detail, r)
}

#[tauri::command]
pub async fn sites_delete(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    available: String,
    link: String,
) -> Result<ApplyResult, String> {
    let detail = available.clone();
    let r: Result<ApplyResult, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        nginx::delete_site(&conn, pw.as_deref(), &available, &link).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "nginx.delete", &detail, r)
}

#[derive(Serialize)]
pub struct TestResult {
    ok: bool,
    output: String,
}

#[tauri::command]
pub async fn sites_test(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<TestResult, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    let (ok, output) = nginx::test(&conn, pw.as_deref()).await.map_err(err)?;
    Ok(TestResult { ok, output })
}

#[tauri::command]
pub async fn sites_reload(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let detail = String::new();
    let r: Result<String, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        nginx::reload(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "nginx.reload", &detail, r)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSitePlan {
    free_port: u16,
    used_ports: Vec<u16>,
    public_ip: Option<String>,
    docker: bool,
    certbot: bool,
}

/// Informations pour préparer l'assistant : port libre, IP publique, outils disponibles.
#[tauri::command]
pub async fn sites_plan(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<NewSitePlan, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    let mut used = nginx::used_ports(&conn).await.map_err(err)?;
    let (access, _) = docker::access(&conn, pw.as_deref()).await.map_err(err)?;
    if access != Access::Unavailable {
        // Ports réservés par des conteneurs arrêtés : ils reprendraient leur port au redémarrage.
        if let Ok(list) = docker::containers(&conn, access, pw.as_deref()).await {
            used.extend(list.iter().flat_map(|c| c.ports.iter().map(|p| p.host_port)));
        }
    }
    used.sort_unstable();
    used.dedup();
    let ip = conn
        .exec("curl -s -4 --max-time 5 https://api.ipify.org || wget -qO- -T 5 https://api.ipify.org", None)
        .await
        .ok()
        .map(|o| o.stdout.trim().to_string())
        .filter(|s| s.parse::<std::net::Ipv4Addr>().is_ok());
    let certbot = conn.exec("command -v certbot", None).await.map(|o| o.success()).unwrap_or(false);
    Ok(NewSitePlan {
        free_port: nginx::first_free(&used, 8100),
        used_ports: used,
        public_ip: ip,
        docker: access != Access::Unavailable,
        certbot,
    })
}

/// Adresse IPv4 vers laquelle pointe le domaine, vue depuis le serveur.
#[tauri::command]
pub async fn sites_resolve(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    domain: String,
) -> Result<Option<String>, String> {
    if !nginx::valid_domain(&domain) {
        return Err("domaine invalide".into());
    }
    let conn = sessions.get(&store, &server_id).await?;
    let out = conn.exec(&format!("getent ahostsv4 {} | awk 'NR==1{{print $1}}'", shell_quote(&domain)), None).await.map_err(err)?;
    let ip = out.stdout.trim().to_string();
    Ok((!ip.is_empty()).then_some(ip))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSpec {
    name: String,
    image: String,
    host_port: u16,
    container_port: u16,
    #[serde(default)]
    env: Vec<(String, String)>,
}

/// Crée /opt/sites/<nom>/docker-compose.yml et lance le conteneur.
#[tauri::command]
pub async fn sites_create_app(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    spec: AppSpec,
) -> Result<String, String> {
    let detail = format!("{} ({})", spec.name, spec.image);
    let r: Result<String, String> = async {
        let name_ok = !spec.name.is_empty() && spec.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let image_ok = !spec.image.is_empty() && spec.image.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/@".contains(c));
        if !name_ok || !image_ok {
            return Err("nom ou image invalide".into());
        }
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        let (access, _) = docker::access(&conn, pw.as_deref()).await.map_err(err)?;
        if access == Access::Unavailable {
            return Err("Docker n'est pas accessible sur ce serveur".into());
        }
        let dir = format!("/opt/sites/{}", spec.name);
        let file = format!("{dir}/docker-compose.yml");
        let exists = conn.exec(&format!("test -e {}", shell_quote(&file)), None).await.map_err(err)?.success();
        if exists {
            return Err(format!("{file} existe déjà : choisis un autre nom"));
        }
        conn.exec_sudo(&format!("mkdir -p {}", shell_quote(&dir)), pw.as_deref(), None).await.map_err(err)?.into_result().map_err(err)?;
        let compose = nginx::site_compose(&spec.name, &spec.image, spec.host_port, spec.container_port, &spec.env);
        conn.write_file_sudo(&file, &compose, pw.as_deref()).await.map_err(err)?;
        // Premier démarrage : le téléchargement de l'image peut être long.
        let out = helm_core::ssh::long(docker::run(
            &conn,
            access,
            pw.as_deref(),
            &format!("compose -f {} -p {} up -d 2>&1", shell_quote(&file), shell_quote(&spec.name)),
        ))
        .await
        .map_err(err)?;
        if !out.success() {
            return Err(format!("docker compose up a échoué :\n{}{}", out.stdout, out.stderr));
        }
        Ok(format!("{file}\n{}", out.stdout))
    }
    .await;
    track(&audit, &store, &server_id, "site.create_app", &detail, r)
}

#[tauri::command]
pub async fn sites_certbot(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    domain: String,
    email: String,
) -> Result<String, String> {
    let detail = domain.clone();
    let r: Result<String, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        nginx::certbot(&conn, pw.as_deref(), &domain, &email).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "site.certbot", &detail, r)
}

#[tauri::command]
pub async fn sites_renew(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
) -> Result<String, String> {
    let detail = String::new();
    let r: Result<String, String> = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        nginx::renew_certificates(&conn, pw.as_deref()).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "site.renew", &detail, r)
}

/// Code HTTP renvoyé par nginx pour ce domaine, en interrogeant le serveur lui-même.
#[tauri::command]
pub async fn sites_check(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    domain: String,
) -> Result<String, String> {
    if !nginx::valid_domain(&domain) {
        return Err("domaine invalide".into());
    }
    let conn = sessions.get(&store, &server_id).await?;
    let host = shell_quote(&format!("Host: {domain}"));
    let out = conn
        .exec(&format!("curl -s -o /dev/null -w '%{{http_code}}' --max-time 10 -H {host} http://127.0.0.1/ 2>&1 || echo 000"), None)
        .await
        .map_err(err)?;
    Ok(out.stdout.trim().to_string())
}

#[derive(Serialize)]
pub struct Preview {
    vhost: String,
    compose: Option<String>,
}

/// Fichiers que l'assistant va créer, pour les montrer avant de lancer.
#[tauri::command]
pub fn sites_preview(domain: String, host_port: u16, app: Option<AppSpec>) -> Preview {
    Preview {
        vhost: nginx::proxy_vhost(&domain, host_port),
        compose: app.map(|a| nginx::site_compose(&a.name, &a.image, a.host_port, a.container_port, &a.env)),
    }
}

#[tauri::command]
pub async fn nginx_backups(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Vec<String>, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    nginx::backups(&conn, pw.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn nginx_backup_diff(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    name: String,
) -> Result<String, String> {
    let (conn, pw) = admin(&store, &sessions, &server_id).await?;
    nginx::backup_diff(&conn, pw.as_deref(), &name).await.map_err(err)
}

#[tauri::command]
pub async fn nginx_backup_restore(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    name: String,
) -> Result<ApplyResult, String> {
    let r = async {
        let (conn, pw) = admin(&store, &sessions, &server_id).await?;
        nginx::restore_backup(&conn, pw.as_deref(), &name).await.map_err(err)
    }
    .await;
    track(&audit, &store, &server_id, "nginx.restore", &name, r)
}

/// DNS (pointe-t-il vers ce VPS ?) et expiration du domaine, pour les sites affichés.
#[tauri::command]
pub async fn domains_check(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    domains: Vec<String>,
) -> Result<Vec<helm_core::domains::DomainInfo>, String> {
    let host = store.server(&server_id)?.host;
    let mut ips: Vec<std::net::IpAddr> = tokio::net::lookup_host((host.as_str(), 22)).await.map(|a| a.map(|a| a.ip()).collect()).unwrap_or_default();
    // Adresse publique vue depuis le serveur (utile si le profil utilise un nom ou une IP privée).
    if let Ok(conn) = sessions.get(&store, &server_id).await {
        if let Ok(o) = conn.exec("curl -s -4 --max-time 5 https://api.ipify.org || wget -qO- -T 5 https://api.ipify.org", None).await {
            ips.extend(o.stdout.trim().parse::<std::net::IpAddr>());
        }
    }
    let domains: Vec<String> = domains.into_iter().filter(|d| d.contains('.') && !d.starts_with('*')).take(100).collect();
    Ok(helm_core::domains::check(&domains, &ips).await)
}
