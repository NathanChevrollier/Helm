//! Bureaux à distance (RDP) : profils, et ouverture dans le client RDP du système (mstsc sous
//! Windows), directement ou à travers un tunnel SSH ouvert pour l'occasion.

use helm_profiles::{Identity, RemoteDesktop, TunnelDef};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::tunnels::Tunnels;
use crate::store::{secrets, Store};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopView {
    #[serde(flatten)]
    desktop: RemoteDesktop,
    has_password: bool,
}

#[tauri::command]
pub fn desktops_list(store: State<'_, Store>) -> Vec<DesktopView> {
    store
        .read(|d| d.desktops.clone())
        .into_iter()
        .map(|desktop| DesktopView { has_password: secrets::get(&RemoteDesktop::secret_owner(&desktop.id), "password").is_some(), desktop })
        .collect()
}

/// Hôte, utilisateur et domaine acceptables dans un fichier .rdp (une valeur par ligne).
fn clean(value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.chars().any(|c| c.is_control()) {
        return Err(format!("{what} invalide"));
    }
    Ok(v.to_string())
}

#[tauri::command]
pub fn desktop_save(store: State<'_, Store>, mut desktop: RemoteDesktop, password: Option<String>) -> Result<String, String> {
    desktop.host = clean(&desktop.host, "hôte")?;
    if desktop.host.is_empty() || desktop.host.contains(char::is_whitespace) {
        return Err("hôte invalide".into());
    }
    desktop.username = clean(&desktop.username, "utilisateur")?;
    desktop.domain = desktop.domain.as_deref().map(|d| clean(d, "domaine")).transpose()?.filter(|d| !d.is_empty());
    desktop.name = clean(&desktop.name, "nom")?;
    if desktop.name.is_empty() {
        desktop.name = desktop.host.clone();
    }
    desktop.identity_id = desktop.identity_id.filter(|i| !i.is_empty());
    desktop.via_server_id = desktop.via_server_id.filter(|i| !i.is_empty());
    if let Some(i) = &desktop.identity_id {
        store.identity(i)?;
    }
    if let Some(s) = &desktop.via_server_id {
        store.server(s)?;
    }
    if desktop.port == 0 {
        desktop.port = 3389;
    }
    if desktop.id.is_empty() {
        desktop.id = uuid::Uuid::new_v4().to_string();
    }
    let id = desktop.id.clone();
    if let Some(p) = password {
        secrets::set(&RemoteDesktop::secret_owner(&id), "password", &p)?;
    }
    store.write(|d| match d.desktops.iter_mut().find(|x| x.id == id) {
        Some(existing) => *existing = desktop,
        None => d.desktops.push(desktop),
    })?;
    Ok(id)
}

#[tauri::command]
pub fn desktop_delete(store: State<'_, Store>, tunnels: State<'_, Tunnels>, id: String) -> Result<(), String> {
    tunnels.stop(&tunnel_id(&id));
    store.write(|d| d.desktops.retain(|x| x.id != id))?;
    secrets::delete_all(&RemoteDesktop::secret_owner(&id));
    Ok(())
}

fn tunnel_id(desktop: &str) -> String {
    format!("rdp-{desktop}")
}

/// Contenu du fichier .rdp (options courantes de mstsc).
fn rdp_file(d: &RemoteDesktop, address: &str, username: &str) -> String {
    let mut lines = vec![
        format!("full address:s:{address}"),
        format!("username:s:{username}"),
        format!("screen mode id:i:{}", if d.fullscreen { 2 } else { 1 }),
        format!("use multimon:i:{}", u8::from(d.multimon)),
        "redirectclipboard:i:1".to_string(),
        "authentication level:i:2".to_string(),
        "prompt for credentials:i:0".to_string(),
        "autoreconnection enabled:i:1".to_string(),
        "smart sizing:i:1".to_string(),
        "dynamic resolution:i:1".to_string(),
    ];
    if !d.fullscreen {
        lines.push(format!("desktopwidth:i:{}", d.width.unwrap_or(1600)));
        lines.push(format!("desktopheight:i:{}", d.height.unwrap_or(900)));
    }
    if d.redirect_drives {
        lines.push("drivestoredirect:s:*".to_string());
    }
    lines.join("\r\n") + "\r\n"
}

/// Utilisateur (avec domaine) et mot de passe du bureau : ceux de l'identifiant de la banque s'il y en a un.
fn credentials(store: &Store, d: &RemoteDesktop) -> Result<(String, Option<String>), String> {
    let (user, password) = match &d.identity_id {
        Some(i) => (store.identity(i)?.username, secrets::get(&Identity::secret_owner(i), "password")),
        None => (d.username.clone(), secrets::get(&RemoteDesktop::secret_owner(&d.id), "password")),
    };
    let user = match d.domain.as_deref() {
        Some(domain) if !user.contains('\\') && !user.contains('@') => format!("{domain}\\{user}"),
        _ => user,
    };
    Ok((user, password))
}

/// Premier port local libre (sur 127.0.0.1) pour le tunnel.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

/// Ouvre le bureau à distance. Avec un serveur de rebond, un tunnel SSH local est ouvert et
/// refermé quand la fenêtre RDP se ferme (Windows).
#[tauri::command]
pub async fn desktop_launch(app: AppHandle, store: State<'_, Store>, tunnels: State<'_, Tunnels>, id: String) -> Result<String, String> {
    let d = store.read(|data| data.desktops.iter().find(|x| x.id == id).cloned()).ok_or("bureau à distance introuvable")?;
    let (user, password) = credentials(&store, &d)?;
    let tid = tunnel_id(&d.id);
    let (host, port) = match &d.via_server_id {
        Some(server) => {
            tunnels.stop(&tid);
            let local_port = free_port()?;
            let def = TunnelDef {
                id: tid.clone(),
                server_id: server.clone(),
                name: format!("RDP {}", d.name),
                local_port,
                remote_host: d.host.clone(),
                remote_port: d.port,
                auto_start: false,
            };
            tunnels.start(&app, def).await?;
            ("127.0.0.1".to_string(), local_port)
        }
        None => (d.host.clone(), d.port),
    };
    let address = if port == 3389 { host.clone() } else { format!("{host}:{port}") };
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("rdp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.rdp", d.id));
    std::fs::write(&file, rdp_file(&d, &address, &user)).map_err(|e| e.to_string())?;
    log::info!("bureau à distance « {} » ouvert ({address}{})", d.name, if d.via_server_id.is_some() { ", via un tunnel SSH" } else { "" });
    launch(&app, &file, &host, port, &user, password.as_deref(), d.via_server_id.as_ref().map(|_| tid))
}

#[cfg(windows)]
fn launch(
    app: &AppHandle,
    file: &std::path::Path,
    host: &str,
    _port: u16,
    user: &str,
    password: Option<&str>,
    tunnel: Option<String>,
) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Identifiants lus par mstsc (TERMSRV/<hôte>) : enregistrés dans le Gestionnaire d'identification
    // de Windows, comme le fait « Mémoriser mes informations » de la connexion Bureau à distance.
    if let Some(pw) = password {
        let status = std::process::Command::new("cmdkey")
            .arg(format!("/generic:TERMSRV/{host}"))
            .arg(format!("/user:{user}"))
            .arg(format!("/pass:{pw}"))
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("cmdkey : {e}"))?;
        if !status.success() {
            log::warn!("cmdkey a échoué : le mot de passe sera demandé par mstsc");
        }
    }
    let mut child = std::process::Command::new("mstsc").arg(file).spawn().map_err(|e| format!("mstsc introuvable : {e}"))?;
    // Le tunnel vit aussi longtemps que la fenêtre RDP.
    if let Some(tid) = tunnel {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = child.wait();
            app.state::<Tunnels>().stop(&tid);
        });
    }
    Ok("Connexion Bureau à distance ouverte".into())
}

#[cfg(target_os = "macos")]
fn launch(
    _app: &AppHandle,
    file: &std::path::Path,
    _host: &str,
    _port: u16,
    _user: &str,
    _password: Option<&str>,
    tunnel: Option<String>,
) -> Result<String, String> {
    // Windows App (ex-Microsoft Remote Desktop) ouvre les fichiers .rdp et demande le mot de passe.
    std::process::Command::new("open").arg(file).status().map_err(|e| e.to_string())?;
    Ok(if tunnel.is_some() {
        "Fichier .rdp ouvert (le tunnel SSH reste actif jusqu'à la fermeture de Helm)".into()
    } else {
        "Fichier .rdp ouvert dans Windows App".into()
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launch(
    app: &AppHandle,
    _file: &std::path::Path,
    host: &str,
    port: u16,
    user: &str,
    password: Option<&str>,
    tunnel: Option<String>,
) -> Result<String, String> {
    use std::io::Write;
    // FreeRDP : le mot de passe passe par l'entrée standard, jamais par la ligne de commande.
    let bin = ["xfreerdp3", "xfreerdp", "wlfreerdp"]
        .into_iter()
        .find(|b| {
            std::process::Command::new("sh").arg("-c").arg(format!("command -v {b}")).output().map(|o| o.status.success()).unwrap_or(false)
        })
        .ok_or("FreeRDP n'est pas installé (paquet freerdp3-x11 ou freerdp2-x11)")?;
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("/v:{host}:{port}")).arg(format!("/u:{user}")).arg("+clipboard").arg("/dynamic-resolution");
    if password.is_some() {
        cmd.arg("/from-stdin:force").stdin(std::process::Stdio::piped());
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let (Some(pw), Some(mut stdin)) = (password, child.stdin.take()) {
        let _ = writeln!(stdin, "{pw}");
    }
    if let Some(tid) = tunnel {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = child.wait();
            app.state::<Tunnels>().stop(&tid);
        });
    }
    Ok("Connexion Bureau à distance ouverte".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desktop() -> RemoteDesktop {
        RemoteDesktop {
            id: "a".into(),
            name: "PC".into(),
            host: "pc.lan".into(),
            port: 3389,
            username: "alice".into(),
            domain: Some("MAISON".into()),
            identity_id: None,
            via_server_id: None,
            fullscreen: false,
            width: None,
            height: None,
            multimon: true,
            redirect_drives: true,
            color: None,
            group: None,
        }
    }

    #[test]
    fn rdp_file_content() {
        let f = rdp_file(&desktop(), "127.0.0.1:50000", "MAISON\\alice");
        assert!(f.contains("full address:s:127.0.0.1:50000\r\n"));
        assert!(f.contains("username:s:MAISON\\alice\r\n"));
        assert!(f.contains("screen mode id:i:1") && f.contains("desktopwidth:i:1600"));
        assert!(f.contains("use multimon:i:1") && f.contains("drivestoredirect:s:*"));
        let full = rdp_file(&RemoteDesktop { fullscreen: true, redirect_drives: false, ..desktop() }, "h", "u");
        assert!(full.contains("screen mode id:i:2") && !full.contains("desktopwidth") && !full.contains("drivestoredirect"));
    }

    #[test]
    fn values_are_single_line() {
        assert!(clean("pc.lan\r\nusername:s:x", "hôte").is_err());
        assert_eq!(clean("  pc.lan ", "hôte").unwrap(), "pc.lan");
    }
}
