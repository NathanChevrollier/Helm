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
/// Dossier par défaut des projets compose créés par Zenytt.
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
        "# {name} — créé par Zenytt\nservices:\n  app:\n    image: {image}\n    container_name: {name}\n    restart: unless-stopped\n    ports:\n      # Publié sur la boucle locale : le reverse proxy (nginx/Apache) y accède, pas Internet.\n      - \"127.0.0.1:{host_port}:{container_port}\"\n    environment:\n      TZ: Europe/Paris\n    volumes:\n      - ./data:/data\n"
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
    /// Code de sortie (« Exited (137) … », « Restarting (1) … »).
    pub exit_code: Option<i32>,
    /// État du healthcheck : `healthy`, `unhealthy`, `starting`.
    pub health: Option<String>,
    /// Tué par le noyau faute de mémoire (lu seulement pour les conteneurs sortis en 137).
    pub oom_killed: bool,
    /// Synthèse des champs ci-dessus (voir [`Container::condition`]), pour l'interface.
    pub condition: Condition,
}

/// Pourquoi un conteneur n'est pas (ou pas bien) en marche.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Condition {
    /// En marche et en bonne santé (ou sans healthcheck).
    Ok,
    /// En marche, mais son healthcheck échoue.
    Unhealthy,
    /// Redémarre en boucle.
    CrashLoop,
    /// Sorti avec une erreur (code ≠ 0, hors arrêt par signal).
    Crashed,
    /// Tué faute de mémoire.
    OutOfMemory,
    /// Arrêté par un signal (`docker stop`, `kill`) : le plus souvent un arrêt manuel.
    Stopped,
    /// Terminé normalement (code 0) : tâche finie ou arrêt propre.
    Finished,
    /// Créé mais jamais démarré.
    Created,
    /// En pause (`docker pause`).
    Paused,
}

impl Condition {
    /// Panne à signaler, quel que soit le réglage du conteneur.
    pub fn is_failure(self) -> bool {
        matches!(self, Self::Unhealthy | Self::CrashLoop | Self::Crashed | Self::OutOfMemory)
    }
}

/// `Exited (137) 3 hours ago` / `Restarting (1) 5 seconds ago` → le code entre parenthèses.
pub fn exit_code_of(status: &str) -> Option<i32> {
    let s = status.trim();
    let rest = s.strip_prefix("Exited (").or_else(|| s.strip_prefix("Restarting ("))?;
    rest.split(')').next()?.trim().parse().ok()
}

/// `Up 2 hours (unhealthy)` / `Up 3 minutes (health: starting)` → état du healthcheck.
pub fn health_of(status: &str) -> Option<String> {
    let inner = status.rsplit_once('(')?.1.strip_suffix(')')?.trim();
    match inner {
        "healthy" | "unhealthy" => Some(inner.to_string()),
        "health: starting" => Some("starting".into()),
        _ => None,
    }
}

impl Container {
    pub fn condition(&self) -> Condition {
        match self.state.as_str() {
            "running" if self.health.as_deref() == Some("unhealthy") => Condition::Unhealthy,
            "running" => Condition::Ok,
            "paused" => Condition::Paused,
            "restarting" => Condition::CrashLoop,
            "created" => Condition::Created,
            "dead" => Condition::Crashed,
            _ if self.oom_killed => Condition::OutOfMemory,
            _ => match self.exit_code {
                Some(0) => Condition::Finished,
                // SIGTERM (143) / SIGKILL (137, aussi en fin de délai de `docker stop`) / SIGINT (130).
                Some(130 | 137 | 143) => Condition::Stopped,
                Some(_) => Condition::Crashed,
                None => Condition::Stopped,
            },
        }
    }

    /// Identifiant stable du conteneur : `projet/service` pour un conteneur compose (le nom change
    /// quand il est recréé sous docker-compose v1), sinon son nom.
    pub fn key(&self) -> String {
        match (&self.compose_project, &self.compose_service) {
            (Some(p), Some(s)) => format!("{p}/{s}"),
            _ => self.name.clone(),
        }
    }
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
                exit_code: exit_code_of(&c.status),
                health: health_of(&c.status),
                oom_killed: false,
                condition: Condition::Ok,
                status: c.status,
                ports: parse_ports(&c.ports),
                ports_raw: c.ports,
                created_at: c.created_at,
                compose_project: labels.get("com.docker.compose.project").cloned(),
                compose_service: labels.get("com.docker.compose.service").cloned(),
            }
        })
        .collect();
    // Sortie en 137 : arrêt manuel (fin du délai de `docker stop`) ou manque de mémoire. Seul
    // `inspect` fait la différence, et seulement pour ces conteneurs-là.
    let killed: Vec<String> = list.iter().filter(|c| c.state == "exited" && c.exit_code == Some(137)).map(|c| c.id.clone()).collect();
    if !killed.is_empty() {
        let ids: Vec<String> = killed.iter().map(|i| shell_quote(i)).collect();
        if let Ok(out) =
            run_ok(conn, access, sudo, &format!("inspect --format '{{{{.Id}}}} {{{{.State.OOMKilled}}}}' {}", ids.join(" "))).await
        {
            for line in out.lines() {
                if let Some((id, "true")) = line.trim().split_once(' ') {
                    if let Some(c) = list.iter_mut().find(|c| id.starts_with(&c.id)) {
                        c.oom_killed = true;
                    }
                }
            }
        }
    }
    for c in &mut list {
        c.condition = c.condition();
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    #[serde(alias = "Name")]
    pub name: String,
    #[serde(alias = "Status")]
    pub status: String,
    #[serde(alias = "ConfigFiles")]
    pub config_files: String,
    /// Le fichier compose noté par Docker n'existe plus (dossier renommé, déplacé ou supprimé) :
    /// seules les actions qui se passent du fichier restent possibles.
    #[serde(default)]
    pub missing: bool,
}

impl ComposeProject {
    /// Premier fichier compose du projet (celui qui fixe le dossier de travail).
    pub fn file(&self) -> &str {
        self.config_files.split(',').map(str::trim).find(|f| !f.is_empty()).unwrap_or("")
    }

    /// Des conteneurs du projet tournent (`running(2)`, `running(1), exited(1)`…).
    pub fn is_running(&self) -> bool {
        self.status.contains("running")
    }
}

pub async fn compose_projects(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<ComposeProject>> {
    let out = run(conn, access, sudo, "compose ls -a --format json").await?;
    if !out.success() {
        // docker compose v1 ou plugin absent.
        return Ok(Vec::new());
    }
    let mut list: Vec<ComposeProject> =
        serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("docker compose ls : {e}")))?;
    resolve_relative(conn, access, sudo, &mut list).await;
    mark_missing(conn, access, sudo, &mut list).await;
    Ok(list)
}

/// docker-compose v1 note le nom du fichier sans son dossier (`docker-compose.prod.yml`) et le
/// dossier à part, dans l'étiquette `working_dir` des conteneurs : le chemin est recomposé, sans
/// quoi le fichier passerait pour introuvable et les actions viseraient le mauvais dossier.
async fn resolve_relative(conn: &Connection, access: Access, sudo: Option<&str>, list: &mut [ComposeProject]) {
    if list.iter().all(|p| p.config_files.split(',').map(str::trim).all(|f| f.is_empty() || f.starts_with('/'))) {
        return;
    }
    let format = r#"ps -a --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}'"#;
    let Ok(out) = run(conn, access, sudo, format).await else { return };
    let dirs = parse_working_dirs(&out.stdout);
    for p in list.iter_mut() {
        if let Some(dir) = dirs.get(&p.name) {
            p.config_files = resolve_config_files(&p.config_files, dir);
        }
    }
}

/// Dossier de travail de chaque projet, d'après les étiquettes de ses conteneurs (`projet|dossier`).
pub(crate) fn parse_working_dirs(text: &str) -> HashMap<String, String> {
    let mut dirs = HashMap::new();
    for line in text.lines() {
        if let Some((project, dir)) = line.split_once('|') {
            if !project.is_empty() && dir.starts_with('/') {
                dirs.entry(project.to_string()).or_insert_with(|| dir.trim_end_matches('/').to_string());
            }
        }
    }
    dirs
}

/// Chemins des fichiers compose rendus absolus par rapport au dossier de travail du projet.
pub(crate) fn resolve_config_files(config_files: &str, dir: &str) -> String {
    config_files
        .split(',')
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(|f| if f.starts_with('/') { f.to_string() } else { format!("{dir}/{}", f.trim_start_matches("./")) })
        .collect::<Vec<_>>()
        .join(",")
}

/// Signale les projets dont le fichier compose a disparu. Le test tourne avec les mêmes droits que
/// Docker : un dossier illisible pour l'utilisateur SSH ne passe pas pour absent.
async fn mark_missing(conn: &Connection, access: Access, sudo: Option<&str>, list: &mut [ComposeProject]) {
    // Seul un chemin absolu peut être vérifié : un chemin relatif resté sans dossier connu n'est
    // pas déclaré introuvable (ce serait une fausse alerte).
    let script: Vec<String> = list
        .iter()
        .map(|p| p.file())
        .filter(|f| f.starts_with('/'))
        .map(|f| format!("[ -e {q} ] || echo {q}", q = shell_quote(f)))
        .collect();
    if script.is_empty() {
        return;
    }
    let script = script.join("; ");
    let out = match access {
        Access::Sudo => conn.exec_sudo(&script, sudo, None).await,
        _ => conn.exec(&script, None).await,
    };
    let Ok(out) = out else { return };
    let gone: std::collections::HashSet<&str> = out.stdout.lines().collect();
    for p in list.iter_mut() {
        p.missing = gone.contains(p.file());
    }
}

/// Arguments `compose` d'un projet dont on n'a que le nom (fichier disparu) : suffisent pour
/// arrêter, supprimer, redémarrer et lire les journaux.
fn compose_args_by_name(project: &ComposeProject) -> Result<String> {
    Ok(format!("compose -p {}", shell_quote(valid_ref(&project.name)?)))
}

/// Actions possibles sans le fichier compose.
const WITHOUT_FILE: &[&str] = &["stop", "down", "restart"];

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
    let args = if project.missing { compose_args_by_name(project)? } else { compose_args(project)? };
    Ok(format!("{PODMAN_SHIM}docker {args} {sub}"))
}

pub async fn compose_action(
    conn: &Connection,
    access: Access,
    sudo: Option<&str>,
    project: &ComposeProject,
    action: &str,
) -> Result<String> {
    crate::ssh::long(async move {
        if project.missing {
            if !WITHOUT_FILE.contains(&action) {
                return Err(Error::Other(format!(
                    "le fichier compose de « {} » est introuvable ({}) : le dossier a sans doute été renommé ou déplacé. Utilise « Relier au nouveau dossier » pour le retrouver.",
                    project.name,
                    project.file()
                )));
            }
            return run_ok(conn, access, sudo, &format!("{} {action} 2>&1", compose_args_by_name(project)?)).await;
        }
        let sub = match action {
            "up" => "up -d --remove-orphans",
            "up-build" => "up -d --build --remove-orphans",
            "pull" => "pull",
            "update" => "pull",
            "rebuild" => "down",
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
        if action == "rebuild" {
            out.push_str(&run(conn, access, sudo, &format!("{base} pull 2>&1")).await?.into_result()?.stdout);
            out.push_str(&run(conn, access, sudo, &format!("{base} build --pull 2>&1")).await?.into_result()?.stdout);
            out.push_str(&run(conn, access, sudo, &format!("{base} up -d --remove-orphans 2>&1")).await?.into_result()?.stdout);
        }
        Ok(out)
    })
    .await
}

// ---------- Fichier compose ouvert depuis l'explorateur ----------

/// Ce que Docker fait déjà du projet décrit par un fichier compose.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ComposeFileState {
    /// Docker refuse le fichier (syntaxe, variable manquante…) : message de `docker compose config`.
    Invalid { message: String },
    /// Aucun projet de ce nom : on peut le lancer.
    NotRunning,
    /// Le projet existe déjà, lancé depuis ce fichier (`running` : au moins un conteneur tourne).
    Same { project: ComposeProject, running: bool },
    /// Un projet du même nom existe, lancé depuis un autre fichier (souvent : dossier déplacé).
    Conflict { project: ComposeProject },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComposeFileInfo {
    pub file: String,
    /// Nom du projet tel que Docker le calcule (clé `name:` du fichier, sinon nom du dossier).
    pub project: String,
    /// Au moins un service se construit depuis un Dockerfile (`build:`).
    pub has_build: bool,
    /// Ports publiés sur le serveur par ce fichier.
    pub ports: Vec<u16>,
    /// Ports publiés déjà occupés sur le serveur (vérifié seulement avant un premier lancement).
    pub busy_ports: Vec<u16>,
    pub state: ComposeFileState,
}

/// Nom du projet, présence d'un `build:` et ports publiés, d'après `docker compose config --format json`.
pub(crate) fn parse_compose_config(json: &str) -> Result<(String, bool, Vec<u16>)> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| Error::Other(format!("docker compose config : {e}")))?;
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let services = v.get("services").and_then(|s| s.as_object());
    let has_build = services.is_some_and(|s| s.values().any(|svc| svc.get("build").is_some()));
    let mut ports: Vec<u16> = services
        .into_iter()
        .flat_map(|s| s.values())
        .filter_map(|svc| svc.get("ports").and_then(|p| p.as_array()))
        .flatten()
        .filter_map(|p| {
            // `published` est une chaîne dans les versions récentes, un nombre dans les anciennes.
            let published = p.get("published")?;
            published.as_u64().map(|n| n as u16).or_else(|| published.as_str()?.split('-').next()?.parse().ok())
        })
        .collect();
    ports.sort_unstable();
    ports.dedup();
    Ok((name, has_build, ports))
}

/// Situation d'un fichier au regard des projets existants.
pub(crate) fn file_state(file: &str, name: &str, projects: &[ComposeProject]) -> ComposeFileState {
    match projects.iter().find(|p| p.name == name) {
        None => ComposeFileState::NotRunning,
        Some(p) if p.file() == file => ComposeFileState::Same { running: p.is_running(), project: p.clone() },
        Some(p) => ComposeFileState::Conflict { project: p.clone() },
    }
}

/// Ports TCP en écoute d'après `ss -Htln` (colonne de l'adresse locale, `0.0.0.0:80`, `[::]:443`…).
pub(crate) fn listening_ports(ss: &str) -> std::collections::HashSet<u16> {
    ss.lines().filter_map(|l| l.split_whitespace().nth(3)?.rsplit(':').next()?.parse().ok()).collect()
}

pub async fn compose_file_info(conn: &Connection, access: Access, sudo: Option<&str>, file: &str) -> Result<ComposeFileInfo> {
    let dir = crate::sftp::parent(file);
    let config = run(
        conn,
        access,
        sudo,
        &format!("compose --project-directory {} -f {} config --format json 2>&1", shell_quote(&dir), shell_quote(file)),
    )
    .await?;
    let mut info = ComposeFileInfo {
        file: file.to_string(),
        project: String::new(),
        has_build: false,
        ports: Vec::new(),
        busy_ports: Vec::new(),
        state: ComposeFileState::NotRunning,
    };
    if !config.success() {
        info.state = ComposeFileState::Invalid { message: format!("{}{}", config.stdout, config.stderr).trim().to_string() };
        return Ok(info);
    }
    let (name, has_build, ports) = parse_compose_config(&config.stdout)?;
    let projects = compose_projects(conn, access, sudo).await?;
    info.state = file_state(file, &name, &projects);
    if info.state == ComposeFileState::NotRunning && !ports.is_empty() {
        if let Ok(out) = conn.exec("ss -Htln 2>/dev/null", None).await {
            let busy = listening_ports(&out.stdout);
            info.busy_ports = ports.iter().copied().filter(|p| busy.contains(p)).collect();
        }
    }
    (info.project, info.has_build, info.ports) = (name, has_build, ports);
    Ok(info)
}

/// Lance le projet décrit par `file` sous le nom `name`. `replace` : projet du même nom lancé
/// depuis un autre fichier, supprimé d'abord (par son nom : son fichier a pu disparaître) pour que
/// les conteneurs soient recréés avec le nouveau chemin.
pub async fn compose_launch(
    conn: &Connection,
    access: Access,
    sudo: Option<&str>,
    file: &str,
    name: &str,
    build: bool,
    replace: Option<&str>,
) -> Result<String> {
    crate::ssh::long(async move {
        let mut log = String::new();
        if let Some(old) = replace {
            let old = ComposeProject { name: old.to_string(), status: String::new(), config_files: String::new(), missing: true };
            log.push_str(&run_ok(conn, access, sudo, &format!("{} down 2>&1", compose_args_by_name(&old)?)).await?);
        }
        let project = ComposeProject { name: name.to_string(), status: String::new(), config_files: file.to_string(), missing: false };
        let up = if build { "up -d --build --remove-orphans" } else { "up -d --remove-orphans" };
        log.push_str(&run_ok(conn, access, sudo, &format!("{} {up} 2>&1", compose_args(&project)?)).await?);
        Ok(log)
    })
    .await
}

/// Projets dont le fichier compose se trouve dans `dir` (ou un de ses sous-dossiers).
pub fn projects_under(projects: &[ComposeProject], dir: &str) -> Vec<ComposeProject> {
    let prefix = format!("{}/", dir.trim_end_matches('/'));
    projects.iter().filter(|p| p.file().starts_with(&prefix)).cloned().collect()
}

/// Chemin d'un fichier après le déplacement de `from` vers `to` (`None` s'il n'est pas dedans).
pub fn relocate(file: &str, from: &str, to: &str) -> Option<String> {
    let rest = file.strip_prefix(&format!("{}/", from.trim_end_matches('/')))?;
    Some(format!("{}/{rest}", to.trim_end_matches('/')))
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
            // Supprime les données des volumes que plus aucun conteneur n'utilise : l'interface
            // montre ce qui va disparaître, et son gain en octets, avant de le demander.
            "volumes" => "volume prune -f",
            _ => return Err(Error::Other(format!("nettoyage inconnu : {what}"))),
        };
        run_ok(conn, access, sudo, args).await
    })
    .await
}

// ---------- Volumes ----------

/// Volume Docker, avec l'espace qu'il occupe et l'indication qu'aucun conteneur ne s'en sert.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub driver: String,
    /// Dossier de l'hôte où le volume est stocké.
    pub mountpoint: String,
    /// Aucun conteneur, même arrêté, ne l'utilise : c'est lui que `docker volume prune` supprime.
    pub orphan: bool,
    /// Taille mesurée sur le disque en octets ; 0 si la mesure n'a pas abouti.
    pub size: u64,
    /// Conteneurs qui le montent, à l'arrêt comme en marche.
    pub used_by: Vec<String>,
}

/// Sépare la sortie de `volume ls` (nom, pilote, dossier) et celle de `volume ls -q -f dangling`.
pub fn parse_volumes(listing: &str, dangling: &str, used: &str) -> Vec<Volume> {
    let orphans: std::collections::HashSet<&str> = dangling.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    // `used` aligne un conteneur et ses volumes : `nom<TAB>vol1,vol2`.
    let mut by_volume: HashMap<String, Vec<String>> = HashMap::new();
    for line in used.lines() {
        let Some((container, volumes)) = line.split_once('\t') else { continue };
        for v in volumes.split(',').map(str::trim).filter(|v| !v.is_empty()) {
            by_volume.entry(v.to_string()).or_default().push(container.trim().to_string());
        }
    }
    listing
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let name = parts.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let driver = parts.next().unwrap_or("local").trim().to_string();
            let mountpoint = parts.next().unwrap_or("").trim().to_string();
            let used_by = by_volume.get(&name).cloned().unwrap_or_default();
            Some(Volume { orphan: orphans.contains(name.as_str()) && used_by.is_empty(), name, driver, mountpoint, size: 0, used_by })
        })
        .collect()
}

/// Volumes du serveur. Les tailles sont mesurées avec `du`, borné dans le temps : sur un volume de
/// plusieurs centaines de gigaoctets, la mesure peut être longue, et une taille inconnue (0) vaut
/// mieux qu'un onglet qui ne s'ouvre pas.
pub async fn volumes(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<Volume>> {
    let listing = run_ok(conn, access, sudo, "volume ls --format '{{.Name}}\t{{.Driver}}\t{{.Mountpoint}}'").await?;
    let dangling = run_ok(conn, access, sudo, "volume ls -q -f dangling=true").await?;
    // Un conteneur arrêté compte aussi : supprimer son volume lui ferait perdre ses données.
    let used = run_ok(conn, access, sudo, "ps -a --format '{{.Names}}\t{{.Mounts}}'").await?;
    let mut list = parse_volumes(&listing, &dangling, &used);

    let points: Vec<String> = list.iter().filter(|v| !v.mountpoint.is_empty()).map(|v| shell_quote(&v.mountpoint)).collect();
    if !points.is_empty() {
        let cmd = format!("timeout 30 du -sb {} 2>/dev/null", points.join(" "));
        if let Ok(out) = crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await {
            let sizes: HashMap<&str, u64> = out
                .stdout
                .lines()
                .filter_map(|l| {
                    let (size, path) = l.split_once('\t')?;
                    Some((path.trim(), size.trim().parse().ok()?))
                })
                .collect();
            for v in &mut list {
                v.size = sizes.get(v.mountpoint.as_str()).copied().unwrap_or(0);
            }
        }
    }
    Ok(list)
}

/// Supprime un volume. Docker refuse de lui-même si un conteneur l'utilise encore.
pub async fn remove_volume(conn: &Connection, access: Access, sudo: Option<&str>, name: &str) -> Result<()> {
    run_ok(conn, access, sudo, &format!("volume rm {}", valid_ref(name)?)).await?;
    Ok(())
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
        let p = ComposeProject {
            name: "web".into(),
            status: "running(1)".into(),
            config_files: "/opt/web/docker-compose.yml".into(),
            missing: false,
        };
        assert!(compose_command(&p, "logs -f")
            .unwrap()
            .ends_with("docker compose --project-directory '/opt/web' -p 'web' -f '/opt/web/docker-compose.yml' logs -f"));
    }

    fn project(name: &str, status: &str, file: &str) -> ComposeProject {
        ComposeProject { name: name.into(), status: status.into(), config_files: file.into(), missing: false }
    }

    #[test]
    fn missing_file_limits_actions_to_project_name() {
        let mut p = project("bot", "running(1)", "/opt/ancien/bot/docker-compose.yml");
        p.missing = true;
        assert!(compose_command(&p, "logs -f").unwrap().ends_with("docker compose -p 'bot' logs -f"), "journaux sans le fichier");
        assert!(WITHOUT_FILE.contains(&"down") && WITHOUT_FILE.contains(&"stop") && !WITHOUT_FILE.contains(&"up"));
    }

    #[test]
    fn container_keys() {
        let mut c = Container {
            id: "a".into(),
            name: "infra_migrator_1".into(),
            image: "x".into(),
            state: "exited".into(),
            status: "Exited (0)".into(),
            ports: vec![],
            ports_raw: String::new(),
            created_at: String::new(),
            compose_project: Some("infra".into()),
            compose_service: Some("migrator".into()),
            exit_code: Some(0),
            health: None,
            oom_killed: false,
            condition: Condition::Finished,
        };
        assert_eq!(c.key(), "infra/migrator", "stable quand le conteneur est recréé");
        c.compose_project = None;
        assert_eq!(c.key(), "infra_migrator_1");
    }

    #[test]
    fn container_conditions() {
        assert_eq!(exit_code_of("Exited (137) 3 hours ago"), Some(137));
        assert_eq!(exit_code_of("Restarting (1) 5 seconds ago"), Some(1));
        assert_eq!(exit_code_of("Up 2 hours"), None);
        assert_eq!(health_of("Up 2 hours (unhealthy)").as_deref(), Some("unhealthy"));
        assert_eq!(health_of("Up 3 minutes (health: starting)").as_deref(), Some("starting"));
        assert_eq!(health_of("Exited (1) 2 minutes ago"), None, "un code de sortie n'est pas un état de santé");

        let c = |state: &str, status: &str, oom: bool| {
            let mut c = Container {
                id: "a".into(),
                name: "n".into(),
                image: "x".into(),
                state: state.into(),
                status: status.into(),
                ports: vec![],
                ports_raw: String::new(),
                created_at: String::new(),
                compose_project: None,
                compose_service: None,
                exit_code: exit_code_of(status),
                health: health_of(status),
                oom_killed: oom,
                condition: Condition::Ok,
            };
            c.condition = c.condition();
            c.condition
        };
        assert_eq!(c("running", "Up 2 hours", false), Condition::Ok);
        assert_eq!(c("running", "Up 2 hours (unhealthy)", false), Condition::Unhealthy);
        assert_eq!(c("restarting", "Restarting (1) 5 seconds ago", false), Condition::CrashLoop);
        assert_eq!(c("exited", "Exited (1) 2 minutes ago", false), Condition::Crashed);
        assert_eq!(c("exited", "Exited (0) 2 minutes ago", false), Condition::Finished);
        assert_eq!(c("exited", "Exited (143) 2 minutes ago", false), Condition::Stopped);
        assert_eq!(c("exited", "Exited (137) 2 minutes ago", false), Condition::Stopped);
        assert_eq!(c("exited", "Exited (137) 2 minutes ago", true), Condition::OutOfMemory);
        assert_eq!(c("created", "Created", false), Condition::Created);
        assert!(Condition::Crashed.is_failure() && !Condition::Stopped.is_failure() && !Condition::Finished.is_failure());
    }

    #[test]
    fn compose_v1_relative_files_are_resolved() {
        let ps = "infra|/srv/infra\ninfra|/srv/infra\nlaravel|/var/www/laravel/\n|\nsans-dossier|\n";
        let dirs = parse_working_dirs(ps);
        assert_eq!(dirs.get("infra").map(String::as_str), Some("/srv/infra"));
        assert_eq!(dirs.get("laravel").map(String::as_str), Some("/var/www/laravel"), "barre finale retirée");
        assert!(!dirs.contains_key("sans-dossier"));
        assert_eq!(resolve_config_files("docker-compose.prod.yml", "/srv/infra"), "/srv/infra/docker-compose.prod.yml");
        assert_eq!(
            resolve_config_files("./docker-compose.yml, override.yml", "/srv/app"),
            "/srv/app/docker-compose.yml,/srv/app/override.yml"
        );
        assert_eq!(resolve_config_files("/opt/web/compose.yaml", "/ailleurs"), "/opt/web/compose.yaml", "chemin absolu inchangé");
    }

    #[test]
    fn compose_config_name_build_and_ports() {
        let json = r#"{"name":"discord-bot","services":{
            "bot":{"build":{"context":"."},"ports":[{"published":"8080","target":80},{"published":8443,"target":443}]},
            "db":{"image":"postgres","ports":[{"published":"8080","target":5432}]},
            "range":{"image":"x","ports":[{"published":"9000-9001","target":9000}]},
            "internal":{"image":"redis"}}}"#;
        let (name, build, ports) = parse_compose_config(json).unwrap();
        assert_eq!(name, "discord-bot");
        assert!(build);
        assert_eq!(ports, vec![8080, 8443, 9000], "triés, sans doublon, début d'une plage");
        let (_, build, ports) = parse_compose_config(r#"{"name":"x","services":{"a":{"image":"nginx"}}}"#).unwrap();
        assert!(!build && ports.is_empty());
    }

    #[test]
    fn file_state_detects_moved_project() {
        let projects =
            vec![project("bot", "running(1)", "/opt/helm/bot/docker-compose.yml"), project("web", "exited(1)", "/srv/web/compose.yaml")];
        assert_eq!(file_state("/opt/zenytt/bot/docker-compose.yml", "blog", &projects), ComposeFileState::NotRunning);
        assert_eq!(
            file_state("/srv/web/compose.yaml", "web", &projects),
            ComposeFileState::Same { project: projects[1].clone(), running: false }
        );
        assert_eq!(
            file_state("/opt/zenytt/bot/docker-compose.yml", "bot", &projects),
            ComposeFileState::Conflict { project: projects[0].clone() },
            "même nom, autre fichier : le dossier a été déplacé"
        );
    }

    #[test]
    fn listening_ports_from_ss() {
        let ss = "LISTEN 0      4096         0.0.0.0:8080      0.0.0.0:*\nLISTEN 0      511             [::]:443          [::]:*\nLISTEN 0      128      127.0.0.1%lo:53        0.0.0.0:*\n";
        let ports = listening_ports(ss);
        assert!(ports.contains(&8080) && ports.contains(&443) && ports.contains(&53));
        assert!(!ports.contains(&80));
    }

    #[test]
    fn projects_under_and_relocate() {
        let projects = vec![
            project("bot", "running(1)", "/opt/helm/apps/bot/docker-compose.yml"),
            project("helmet", "running(1)", "/opt/helmet/compose.yaml"),
        ];
        let under = projects_under(&projects, "/opt/helm/");
        assert_eq!(under.len(), 1, "/opt/helmet n'est pas dans /opt/helm");
        assert_eq!(under[0].name, "bot");
        assert_eq!(
            relocate("/opt/helm/apps/bot/docker-compose.yml", "/opt/helm", "/opt/zenytt").as_deref(),
            Some("/opt/zenytt/apps/bot/docker-compose.yml")
        );
        assert_eq!(relocate("/opt/helmet/compose.yaml", "/opt/helm", "/opt/zenytt"), None);
    }

    #[test]
    fn compose_project_accepts_docker_and_ui_json() {
        let from_docker: Vec<ComposeProject> =
            serde_json::from_str(r#"[{"Name":"web","Status":"running(1)","ConfigFiles":"/a.yml"}]"#).unwrap();
        let from_ui: ComposeProject = serde_json::from_str(r#"{"name":"web","status":"running(1)","configFiles":"/a.yml"}"#).unwrap();
        assert_eq!(from_docker[0].name, from_ui.name);
        assert_eq!(
            serde_json::to_string(&from_ui).unwrap(),
            r#"{"name":"web","status":"running(1)","configFiles":"/a.yml","missing":false}"#
        );
        let gone: ComposeProject =
            serde_json::from_str(r#"{"name":"web","status":"running(1)","configFiles":"/a.yml","missing":true}"#).unwrap();
        assert!(gone.missing, "l'interface renvoie l'état « fichier introuvable » avec le projet");
    }

    #[test]
    fn refs_are_validated() {
        assert!(valid_ref("zenytt-demo-app").is_ok());
        assert!(valid_ref("nginx:alpine").is_ok());
        assert!(valid_ref("x; rm -rf /").is_err());
    }

    #[test]
    fn volumes_know_what_uses_them() {
        let listing = "app_data\tlocal\t/var/lib/docker/volumes/app_data/_data\norphelin\tlocal\t/var/lib/docker/volumes/orphelin/_data\n";
        let dangling = "orphelin\n";
        // Un conteneur arrêté compte : supprimer son volume lui ferait perdre ses données.
        let used = "app\tapp_data,/etc/localtime\narrete\tapp_data\n";
        let v = parse_volumes(listing, dangling, used);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "app_data");
        assert!(!v[0].orphan, "un volume monté n'est jamais orphelin");
        assert_eq!(v[0].used_by, vec!["app".to_string(), "arrete".to_string()]);
        assert!(v[1].orphan);
        assert!(v[1].used_by.is_empty());
        assert_eq!(v[1].mountpoint, "/var/lib/docker/volumes/orphelin/_data");
    }

    #[test]
    fn dangling_but_mounted_is_not_an_orphan() {
        // Docker peut signaler un volume comme « dangling » alors qu'un conteneur arrêté le monte :
        // Zenytt ne le propose alors pas à la suppression.
        let v = parse_volumes("v\tlocal\t/m\n", "v\n", "arrete\tv\n");
        assert!(!v[0].orphan);
    }
}
