//! Docker via le CLI distant (`docker … --format '{{json .}}'`), avec repli sur sudo quand
//! l'utilisateur SSH n'appartient pas au groupe `docker`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::ssh::shell_quote;
use crate::{Connection, Error, ExecOutput, Result};

/// Comment exécuter `docker` sur ce serveur.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Direct,
    Sudo,
    /// Docker absent, ou aucun droit pour l'utiliser.
    Unavailable,
}

/// Podman (Rocky, Alma, Fedora) a une ligne de commande compatible avec Docker : si Docker est
/// absent, `docker` devient un alias de `podman` le temps de la commande.
pub const PODMAN_SHIM: &str = "command -v docker >/dev/null 2>&1 || docker() { podman \"$@\"; }; ";

const VERSION_COMMAND: &str =
    "if command -v docker >/dev/null 2>&1; then docker version --format '{{.Server.Version}}'; else podman version --format 'podman {{.Client.Version}}'; fi";

/// Détermine le mode d'accès : direct, sinon via sudo, sinon indisponible. La version renvoyée
/// commence par « podman » quand c'est Podman qui répond.
pub async fn access(conn: &Connection, sudo: Option<&str>) -> Result<(Access, String)> {
    let direct = conn.exec(VERSION_COMMAND, None).await?;
    if direct.success() {
        return Ok((Access::Direct, direct.stdout.trim().to_string()));
    }
    if conn.exec("command -v docker || command -v podman", None).await?.success() {
        // Refus de sudo (pas de mot de passe, pas de droits) : Docker est alors simplement inaccessible.
        let via_sudo = match conn.exec_sudo(VERSION_COMMAND, sudo, None).await {
            Ok(o) => o,
            Err(Error::Other(reason)) => return Ok((Access::Unavailable, reason)),
            Err(e) => return Err(e),
        };
        if via_sudo.success() {
            return Ok((Access::Sudo, via_sudo.stdout.trim().to_string()));
        }
    }
    Ok((Access::Unavailable, direct.stderr.trim().to_string()))
}

/// Exécute une commande docker selon le mode d'accès.
/// Dossier par défaut des projets compose créés par Helm.
pub const STACKS_DIR: &str = "/opt/stacks";

/// Nom de projet compose acceptable (et donc utilisable dans un chemin et une commande).
pub fn valid_project_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Modèle de départ d'un nouveau projet compose : un service, un port publié en local seulement.
pub fn compose_template(name: &str, image: &str, host_port: u16, container_port: u16) -> String {
    format!(
        "# {name} — créé par Helm\nservices:\n  app:\n    image: {image}\n    container_name: {name}\n    restart: unless-stopped\n    ports:\n      # Publié sur la boucle locale : le reverse proxy (nginx/Apache) y accède, pas Internet.\n      - \"127.0.0.1:{host_port}:{container_port}\"\n    environment:\n      TZ: Europe/Paris\n    volumes:\n      - ./data:/data\n"
    )
}

pub async fn run(conn: &Connection, access: Access, sudo: Option<&str>, args: &str) -> Result<ExecOutput> {
    let cmd = format!("{PODMAN_SHIM}docker {args}");
    match access {
        Access::Direct => conn.exec(&cmd, None).await,
        Access::Sudo => conn.exec_sudo(&cmd, sudo, None).await,
        Access::Unavailable => Err(Error::Other("Docker n'est pas accessible sur ce serveur".into())),
    }
}

async fn run_ok(conn: &Connection, access: Access, sudo: Option<&str>, args: &str) -> Result<String> {
    Ok(run(conn, access, sudo, args).await?.into_result()?.stdout)
}

fn json_lines<T: for<'de> Deserialize<'de>>(text: &str) -> Vec<T> {
    text.lines().filter(|l| l.starts_with('{')).filter_map(|l| serde_json::from_str(l).ok()).collect()
}

// ---------- Conteneurs ----------

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawContainer {
    #[serde(rename = "ID")]
    id: String,
    names: String,
    image: String,
    state: String,
    status: String,
    #[serde(default)]
    ports: String,
    #[serde(default)]
    labels: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
    pub host_ip: String,
    pub host_port: u16,
    pub container_port: u16,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// running, exited, paused, restarting, created, dead
    pub state: String,
    pub status: String,
    pub ports: Vec<PortMapping>,
    pub ports_raw: String,
    pub created_at: String,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
}

/// Analyse la liste de labels `k=v,k2=v2` de `docker ps` (une valeur peut contenir des virgules).
pub fn parse_labels(s: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut last: Option<String> = None;
    for part in s.split(',') {
        match part.split_once('=') {
            Some((k, v)) if !k.contains(' ') && !k.is_empty() => {
                out.insert(k.to_string(), v.to_string());
                last = Some(k.to_string());
            }
            _ => {
                if let Some(v) = last.as_ref().and_then(|k| out.get_mut(k)) {
                    v.push(',');
                    v.push_str(part);
                }
            }
        }
    }
    out
}

/// `0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp` → mappings publiés (doublons IPv6 retirés).
pub fn parse_ports(s: &str) -> Vec<PortMapping> {
    let mut out: Vec<PortMapping> = Vec::new();
    for item in s.split(',').map(str::trim).filter(|x| !x.is_empty()) {
        let Some((host, container)) = item.split_once("->") else { continue };
        let (cport, proto) = container.split_once('/').unwrap_or((container, "tcp"));
        let Some((ip, hport)) = host.rsplit_once(':') else { continue };
        // Plages « 8000-8010->8000-8010/tcp » : on ne garde que le premier port.
        let (Ok(hp), Ok(cp)) = (hport.split('-').next().unwrap_or("").parse(), cport.split('-').next().unwrap_or("").parse()) else {
            continue;
        };
        let ip = ip.trim_start_matches('[').trim_end_matches(']');
        let ip = if ip.is_empty() || ip == "::" { "0.0.0.0" } else { ip };
        let m = PortMapping { host_ip: ip.to_string(), host_port: hp, container_port: cp, protocol: proto.to_string() };
        if !out.iter().any(|x| x.host_port == m.host_port && x.protocol == m.protocol) {
            out.push(m);
        }
    }
    out
}

pub async fn containers(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<Container>> {
    let out = run_ok(conn, access, sudo, "ps -a --no-trunc --format '{{json .}}'").await?;
    let mut list: Vec<Container> = json_lines::<RawContainer>(&out)
        .into_iter()
        .map(|c| {
            let labels = parse_labels(&c.labels);
            Container {
                id: c.id.chars().take(12).collect(),
                name: c.names.split(',').next().unwrap_or("").to_string(),
                image: c.image,
                state: c.state,
                status: c.status,
                ports: parse_ports(&c.ports),
                ports_raw: c.ports,
                created_at: c.created_at,
                compose_project: labels.get("com.docker.compose.project").cloned(),
                compose_service: labels.get("com.docker.compose.service").cloned(),
            }
        })
        .collect();
    list.sort_by(|a, b| (a.state != "running").cmp(&(b.state != "running")).then(a.name.cmp(&b.name)));
    Ok(list)
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawStats {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "CPUPerc")]
    cpu_perc: String,
    mem_usage: String,
    mem_perc: String,
    #[serde(rename = "NetIO")]
    net_io: String,
    #[serde(rename = "PIDs", default)]
    pids: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub id: String,
    pub cpu: f32,
    pub mem_percent: f32,
    pub mem_usage: String,
    pub net_io: String,
    pub pids: String,
}

fn parse_percent(s: &str) -> f32 {
    s.trim().trim_end_matches('%').parse().unwrap_or(0.0)
}

pub async fn stats(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<Stats>> {
    let out = run_ok(conn, access, sudo, "stats --no-stream --format '{{json .}}'").await?;
    Ok(json_lines::<RawStats>(&out)
        .into_iter()
        .map(|s| Stats {
            id: s.id.chars().take(12).collect(),
            cpu: parse_percent(&s.cpu_perc),
            mem_percent: parse_percent(&s.mem_perc),
            mem_usage: s.mem_usage,
            net_io: s.net_io,
            pids: s.pids,
        })
        .collect())
}

fn valid_ref(s: &str) -> Result<&str> {
    let ok = !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-:/@".contains(c));
    if ok {
        Ok(s)
    } else {
        Err(Error::Other(format!("identifiant Docker invalide : {s}")))
    }
}

pub async fn container_action(conn: &Connection, access: Access, sudo: Option<&str>, id: &str, action: &str) -> Result<()> {
    let args = match action {
        "start" | "stop" | "restart" | "pause" | "unpause" | "kill" => format!("{action} {}", valid_ref(id)?),
        "remove" => format!("rm -f {}", valid_ref(id)?),
        _ => return Err(Error::Other(format!("action inconnue : {action}"))),
    };
    run_ok(conn, access, sudo, &args).await?;
    Ok(())
}

pub async fn inspect(conn: &Connection, access: Access, sudo: Option<&str>, id: &str) -> Result<String> {
    run_ok(conn, access, sudo, &format!("inspect {}", valid_ref(id)?)).await
}

pub async fn logs(conn: &Connection, access: Access, sudo: Option<&str>, id: &str, tail: u32) -> Result<String> {
    let out = run(conn, access, sudo, &format!("logs --timestamps --tail {} {} 2>&1", tail.min(10000), valid_ref(id)?)).await?;
    Ok(out.into_result()?.stdout)
}

// ---------- Projets compose ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    #[serde(alias = "Name")]
    pub name: String,
    #[serde(alias = "Status")]
    pub status: String,
    #[serde(alias = "ConfigFiles")]
    pub config_files: String,
}

pub async fn compose_projects(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<ComposeProject>> {
    let out = run(conn, access, sudo, "compose ls -a --format json").await?;
    if !out.success() {
        // docker compose v1 ou plugin absent.
        return Ok(Vec::new());
    }
    serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("docker compose ls : {e}")))
}

/// Construit les arguments `compose` pour un projet : fichiers de config et dossier de travail.
fn compose_args(project: &ComposeProject) -> Result<String> {
    let files: Vec<&str> = project.config_files.split(',').map(str::trim).filter(|f| !f.is_empty()).collect();
    let first = files.first().ok_or_else(|| Error::Other("projet sans fichier compose".into()))?;
    let dir = crate::sftp::parent(first);
    let mut args = format!("compose --project-directory {} -p {}", shell_quote(&dir), shell_quote(valid_ref(&project.name)?));
    for f in &files {
        args.push_str(&format!(" -f {}", shell_quote(f)));
    }
    Ok(args)
}

/// Commande shell complète pour un projet compose (utilisée aussi pour les terminaux de logs).
pub fn compose_command(project: &ComposeProject, sub: &str) -> Result<String> {
    Ok(format!("{PODMAN_SHIM}docker {} {sub}", compose_args(project)?))
}

pub async fn compose_action(
    conn: &Connection,
    access: Access,
    sudo: Option<&str>,
    project: &ComposeProject,
    action: &str,
) -> Result<String> {
    crate::ssh::long(async move {
        let sub = match action {
            "up" => "up -d --remove-orphans",
            "pull" => "pull",
            "update" => "pull",
            "restart" => "restart",
            "stop" => "stop",
            "down" => "down",
            _ => return Err(Error::Other(format!("action inconnue : {action}"))),
        };
        let base = compose_args(project)?;
        let mut out = run(conn, access, sudo, &format!("{base} {sub} 2>&1")).await?.into_result()?.stdout;
        if action == "update" {
            out.push_str(&run(conn, access, sudo, &format!("{base} up -d --remove-orphans 2>&1")).await?.into_result()?.stdout);
        }
        Ok(out)
    })
    .await
}

// ---------- Images, volumes, nettoyage ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    #[serde(rename(deserialize = "ID"))]
    pub id: String,
    #[serde(rename(deserialize = "Repository"))]
    pub repository: String,
    #[serde(rename(deserialize = "Tag"))]
    pub tag: String,
    #[serde(rename(deserialize = "Size"))]
    pub size: String,
    #[serde(rename(deserialize = "CreatedSince"))]
    pub created_since: String,
    #[serde(rename(deserialize = "Containers"), default)]
    pub containers: String,
}

pub async fn images(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<Image>> {
    let out = run_ok(conn, access, sudo, "images --format '{{json .}}'").await?;
    Ok(json_lines(&out))
}

pub async fn remove_image(conn: &Connection, access: Access, sudo: Option<&str>, id: &str) -> Result<()> {
    run_ok(conn, access, sudo, &format!("rmi {}", valid_ref(id)?)).await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    #[serde(rename(deserialize = "Type"))]
    pub kind: String,
    #[serde(rename(deserialize = "TotalCount"))]
    pub total_count: String,
    #[serde(rename(deserialize = "Active"))]
    pub active: String,
    #[serde(rename(deserialize = "Size"))]
    pub size: String,
    #[serde(rename(deserialize = "Reclaimable"))]
    pub reclaimable: String,
}

pub async fn disk_usage(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<DiskUsage>> {
    let out = run_ok(conn, access, sudo, "system df --format '{{json .}}'").await?;
    Ok(json_lines(&out))
}

/// Nettoyage ciblé. `images` ne supprime que les images inutilisées ET sans tag (sûr).
pub async fn prune(conn: &Connection, access: Access, sudo: Option<&str>, what: &str) -> Result<String> {
    crate::ssh::long(async move {
        let args = match what {
            "containers" => "container prune -f",
            "images" => "image prune -f",
            "images-all" => "image prune -a -f",
            "build-cache" => "builder prune -f",
            "networks" => "network prune -f",
            _ => return Err(Error::Other(format!("nettoyage inconnu : {what}"))),
        };
        run_ok(conn, access, sudo, args).await
    })
    .await
}

// ---------- Refermer un port exposé ----------

/// Réécrit, dans un fichier compose, le mapping court du port hôte `port` publié sur toutes les
/// interfaces (`"8080:80"`, `0.0.0.0:8080:80`, `[::]:8080:80`) pour ne l'exposer que sur 127.0.0.1.
/// Renvoie `None` si aucun mapping de ce port n'a été trouvé (syntaxe longue non prise en charge).
pub fn restrict_port_in_compose(text: &str, port: u16) -> Option<String> {
    let mut changed = false;
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let Some(item) = trimmed.strip_prefix("- ") else { return line.to_string() };
            let indent = &line[..line.len() - trimmed.len()];
            let value = item.trim().trim_matches(|c| c == '"' || c == '\'');
            let rest = value
                .strip_prefix("[::]:")
                .or_else(|| value.strip_prefix("0.0.0.0:"))
                .or_else(|| value.strip_prefix("::"))
                .unwrap_or(value);
            let parts: Vec<&str> = rest.split(':').collect();
            if parts.len() == 2 && parts[0] == port.to_string() && parts[1].split('/').next().is_some_and(|p| p.parse::<u16>().is_ok()) {
                changed = true;
                format!("{indent}- \"127.0.0.1:{}:{}\"", parts[0], parts[1])
            } else {
                line.to_string()
            }
        })
        .collect();
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn project_names_and_template() {
        assert!(valid_project_name("mon-app_2"));
        assert!(!valid_project_name("Mon App"), "espaces et majuscules refusés");
        assert!(!valid_project_name("-app"));
        assert!(!valid_project_name("app;rm"));
        let t = compose_template("blog", "ghcr.io/moi/blog:latest", 8100, 80);
        assert!(t.contains("image: ghcr.io/moi/blog:latest"));
        assert!(t.contains("\"127.0.0.1:8100:80\""), "port publié en local seulement");
    }

    use super::*;

    #[test]
    fn restrict_port_variants() {
        let src = "services:\n  db:\n    ports:\n      - \"3307:3306\"\n      - 8080:80\n  web:\n    ports:\n      - '0.0.0.0:9000:9000/udp'\n      - \"127.0.0.1:5000:5000\"\n";
        let out = restrict_port_in_compose(src, 3307).unwrap();
        assert!(out.contains("      - \"127.0.0.1:3307:3306\"\n"));
        assert!(out.contains("      - 8080:80\n"), "les autres ports restent intacts");
        let out = restrict_port_in_compose(src, 9000).unwrap();
        assert!(out.contains("- \"127.0.0.1:9000:9000/udp\""));
        assert!(restrict_port_in_compose(src, 5000).is_none(), "déjà restreint");
        assert!(restrict_port_in_compose(src, 1234).is_none());
        assert!(restrict_port_in_compose("ports:\n  - [::]:3307:3306\n", 3307).unwrap().contains("127.0.0.1:3307:3306"));
    }

    #[test]
    fn labels_with_commas() {
        let l = parse_labels("com.docker.compose.project=web,maintainer=A, B <a@b>,com.docker.compose.service=app");
        assert_eq!(l["com.docker.compose.project"], "web");
        assert_eq!(l["maintainer"], "A, B <a@b>");
        assert_eq!(l["com.docker.compose.service"], "app");
    }

    #[test]
    fn ports() {
        let p = parse_ports("0.0.0.0:8080->80/tcp, :::8080->80/tcp, 127.0.0.1:5432->5432/tcp, 443/tcp, [::1]:9000->9000/udp");
        assert_eq!(p.len(), 3);
        assert_eq!(p[0], PortMapping { host_ip: "0.0.0.0".into(), host_port: 8080, container_port: 80, protocol: "tcp".into() });
        assert_eq!(p[1].host_ip, "127.0.0.1");
        assert_eq!(p[2].host_ip, "::1");
    }

    #[test]
    fn compose_args_quote_paths() {
        let p = ComposeProject { name: "web".into(), status: "running(1)".into(), config_files: "/opt/web/docker-compose.yml".into() };
        assert!(compose_command(&p, "logs -f")
            .unwrap()
            .ends_with("docker compose --project-directory '/opt/web' -p 'web' -f '/opt/web/docker-compose.yml' logs -f"));
    }

    #[test]
    fn compose_project_accepts_docker_and_ui_json() {
        let from_docker: Vec<ComposeProject> =
            serde_json::from_str(r#"[{"Name":"web","Status":"running(1)","ConfigFiles":"/a.yml"}]"#).unwrap();
        let from_ui: ComposeProject = serde_json::from_str(r#"{"name":"web","status":"running(1)","configFiles":"/a.yml"}"#).unwrap();
        assert_eq!(from_docker[0].name, from_ui.name);
        assert_eq!(serde_json::to_string(&from_ui).unwrap(), r#"{"name":"web","status":"running(1)","configFiles":"/a.yml"}"#);
    }

    #[test]
    fn refs_are_validated() {
        assert!(valid_ref("helm-demo-app").is_ok());
        assert!(valid_ref("nginx:alpine").is_ok());
        assert!(valid_ref("x; rm -rf /").is_err());
    }
}
