//! Sauvegardes planifiées avec restic (chiffrées, dédupliquées) : dumps cohérents des bases dans
//! les conteneurs, volumes Docker et dossiers, vers un dossier du serveur ou un stockage S3.
//!
//! Fichiers sur le serveur (root uniquement) :
//! - `/etc/helm-backup/config.json` (0600) : configuration sans secret, relue par l'app ;
//! - `/etc/helm-backup/env` (0600) : dépôt, mot de passe restic, clés S3 ;
//! - `/etc/helm-backup/run.sh` (0700) : script généré ;
//! - `/var/lib/helm-backup/last.json` (0644) : résultat de la dernière sauvegarde (sans secret),
//!   lu par l'agent helmd pour alerter en cas d'échec.

use serde::{Deserialize, Serialize};

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub const CONFIG_PATH: &str = "/etc/helm-backup/config.json";
pub const ENV_PATH: &str = "/etc/helm-backup/env";
pub const SCRIPT_PATH: &str = "/etc/helm-backup/run.sh";
pub const LAST_PATH: &str = "/var/lib/helm-backup/last.json";
pub const RESTORE_ROOT: &str = "/var/lib/helm-backup/restore";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Destination {
    /// Dossier sur le serveur lui-même (protège des erreurs, pas d'une perte du serveur).
    Local { path: String },
    /// Stockage compatible S3 (Backblaze B2, Scaleway, OVH, AWS…).
    S3 { endpoint: String, bucket: String, prefix: String, access_key_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbSource {
    pub container: String,
    /// `mysql` (MySQL/MariaDB) ou `postgres`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    pub destination: Destination,
    /// Heure quotidienne `HH:MM`.
    pub schedule: String,
    pub keep_daily: u32,
    pub keep_weekly: u32,
    pub keep_monthly: u32,
    pub paths: Vec<String>,
    pub volumes: Vec<String>,
    pub databases: Vec<DbSource>,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            destination: Destination::Local { path: "/var/backups/helm/restic".into() },
            schedule: "03:00".into(),
            keep_daily: 7,
            keep_weekly: 4,
            keep_monthly: 6,
            paths: vec!["/etc/nginx".into(), "/opt/sites".into(), "/etc/letsencrypt".into()],
            volumes: vec![],
            databases: vec![],
        }
    }
}

fn safe_path(p: &str) -> bool {
    p.starts_with('/') && !p.contains("..") && p.len() < 400 && p.chars().all(|c| c.is_ascii_alphanumeric() || "/._-@".contains(c))
}

fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn safe_value(s: &str) -> bool {
    !s.is_empty() && !s.contains(['\n', '\r', '\'', '\0'])
}

impl BackupConfig {
    pub fn validate(&self) -> Result<()> {
        let bad = |m: String| Err(Error::Other(m));
        let (h, m) = self.schedule.split_once(':').unwrap_or(("x", "x"));
        if !matches!((h.parse::<u32>(), m.parse::<u32>()), (Ok(h), Ok(m)) if h < 24 && m < 60) {
            return bad(format!("heure invalide : {}", self.schedule));
        }
        if let Some(p) = self.paths.iter().find(|p| !safe_path(p)) {
            return bad(format!("chemin refusé : {p}"));
        }
        if let Some(v) = self.volumes.iter().find(|v| !safe_name(v)) {
            return bad(format!("volume invalide : {v}"));
        }
        if let Some(d) = self.databases.iter().find(|d| !safe_name(&d.container) || !matches!(d.kind.as_str(), "mysql" | "postgres")) {
            return bad(format!("base invalide : {} ({})", d.container, d.kind));
        }
        match &self.destination {
            Destination::Local { path } if !safe_path(path) => bad(format!("dossier de destination refusé : {path}")),
            Destination::S3 { endpoint, bucket, prefix, access_key_id } => {
                if !endpoint.starts_with("https://") || !safe_value(endpoint) || endpoint.contains(' ') {
                    return bad("l'endpoint S3 doit commencer par https://".into());
                }
                if !safe_name(bucket) || !(prefix.is_empty() || safe_path(&format!("/{prefix}"))) || !safe_value(access_key_id) {
                    return bad("bucket, préfixe ou identifiant d'accès invalide".into());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Valeur de `RESTIC_REPOSITORY`.
    pub fn repository(&self) -> String {
        match &self.destination {
            Destination::Local { path } => path.clone(),
            Destination::S3 { endpoint, bucket, prefix, .. } => {
                let base = format!("s3:{}/{}", endpoint.trim_end_matches('/'), bucket);
                if prefix.is_empty() {
                    base
                } else {
                    format!("{base}/{}", prefix.trim_matches('/'))
                }
            }
        }
    }
}

/// Contenu du fichier d'environnement (secrets). `s3_secret` n'est utilisé que pour S3.
pub fn env_file(cfg: &BackupConfig, restic_password: &str, s3_secret: Option<&str>) -> Result<String> {
    if !safe_value(restic_password) {
        return Err(Error::Other("mot de passe restic invalide".into()));
    }
    let mut env = format!("RESTIC_REPOSITORY='{}'\nRESTIC_PASSWORD='{}'\n", cfg.repository(), restic_password);
    if let Destination::S3 { access_key_id, .. } = &cfg.destination {
        let secret = s3_secret.filter(|s| safe_value(s)).ok_or_else(|| Error::Other("clé secrète S3 manquante".into()))?;
        env.push_str(&format!("AWS_ACCESS_KEY_ID='{access_key_id}'\nAWS_SECRET_ACCESS_KEY='{secret}'\n"));
    }
    Ok(env)
}

/// Script de sauvegarde généré à partir de la configuration (toutes les valeurs sont validées).
pub fn run_script(cfg: &BackupConfig) -> String {
    let mut s = String::from(
        r#"#!/bin/bash
# Généré par Helm : ne pas modifier à la main (régénéré à chaque enregistrement).
set -uo pipefail
set -a; . /etc/helm-backup/env; set +a
STATE=/var/lib/helm-backup; STAGE=$STATE/stage
mkdir -p "$STATE"; chmod 755 "$STATE"
START=$(date +%s)
finish() {
  local msg; msg=$(printf '%s' "$2" | tr '\n\r' '  ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"startedAt":%s,"finishedAt":%s,"ok":%s,"message":"%s"}\n' "$START" "$(date +%s)" "$1" "$msg" > "$STATE/last.json"
  chmod 644 "$STATE/last.json"
}
fail() { finish false "$1"; echo "ÉCHEC : $1" >&2; rm -rf "$STAGE"; exit 1; }
trap 'fail "sauvegarde interrompue"' INT TERM
rm -rf "$STAGE"; mkdir -p "$STAGE/db"; chmod 700 "$STAGE"
PATHS=("$STAGE")
echo "Sauvegarde Helm — $(date)"
"#,
    );
    for db in &cfg.databases {
        let c = &db.container;
        if db.kind == "mysql" {
            s.push_str(&format!(
                "echo \"Dump MySQL/MariaDB : {c}\"\ndocker exec {c} sh -c 'D=$(command -v mysqldump || command -v mariadb-dump); exec \"$D\" --all-databases --single-transaction --routines --events -uroot -p\"${{MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}}\"' > \"$STAGE/db/{c}.sql\" || fail \"dump de {c}\"\n"
            ));
        } else {
            s.push_str(&format!(
                "echo \"Dump PostgreSQL : {c}\"\ndocker exec {c} sh -c 'exec pg_dumpall -U \"${{POSTGRES_USER:-postgres}}\"' > \"$STAGE/db/{c}.sql\" || fail \"dump de {c}\"\n"
            ));
        }
    }
    for v in &cfg.volumes {
        s.push_str(&format!(
            "VP=$(docker volume inspect -f '{{{{.Mountpoint}}}}' {v}) || fail \"volume {v} introuvable\"\nPATHS+=(\"$VP\")\n"
        ));
    }
    for p in &cfg.paths {
        s.push_str(&format!("[ -e {p} ] && PATHS+=({p})\n"));
    }
    s.push_str(&format!(
        r#"restic cat config >/dev/null 2>&1 || restic init >/dev/null || fail "initialisation du dépôt impossible"
restic backup --tag helm --host "$(hostname)" "${{PATHS[@]}}" 2>&1 | tee "$STATE/last-output.txt" | tail -n 5
RC=${{PIPESTATUS[0]}}
# 3 = sauvegarde faite mais quelques fichiers illisibles : ce n'est pas un échec.
[ "$RC" = 0 ] || [ "$RC" = 3 ] || fail "$(tail -n 3 "$STATE/last-output.txt")"
restic forget --tag helm --prune --keep-daily {} --keep-weekly {} --keep-monthly {} >/dev/null 2>&1 || fail "rétention (forget/prune) impossible"
if [ "$(date +%u)" = 7 ]; then restic check --read-data-subset=5% >/dev/null 2>&1 || fail "vérification du dépôt en échec"; fi
rm -rf "$STAGE"
finish true "$(grep -m1 '^snapshot' "$STATE/last-output.txt")"
echo "Terminé."
"#,
        cfg.keep_daily.max(1),
        cfg.keep_weekly,
        cfg.keep_monthly
    ));
    s
}

fn systemd_units(schedule: &str) -> (String, String) {
    let service = format!("[Unit]\nDescription=Sauvegarde Helm (restic)\nAfter=network-online.target docker.service\n\n[Service]\nType=oneshot\nExecStart={SCRIPT_PATH}\nNice=10\nIOSchedulingClass=idle\n");
    let timer = format!("[Unit]\nDescription=Sauvegarde Helm quotidienne\n\n[Timer]\nOnCalendar=*-*-* {schedule}:00\nPersistent=true\nRandomizedDelaySec=10m\n\n[Install]\nWantedBy=timers.target\n");
    (service, timer)
}

/// Installe restic si besoin puis écrit la configuration, les secrets, le script et la planification.
pub async fn install(conn: &Connection, sudo: Option<&str>, cfg: &BackupConfig, env: &str) -> Result<String> {
    cfg.validate()?;
    let prep = "set -e\ncommand -v restic >/dev/null || { if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y restic; elif command -v dnf >/dev/null; then dnf install -y restic; else echo 'installe restic manuellement' >&2; exit 1; fi; }\ninstall -d -m 700 /etc/helm-backup\ninstall -d -m 755 /var/lib/helm-backup\ninstall -d -m 700 /var/lib/helm-backup/restore";
    let mut log = conn.exec_sudo(prep, sudo, None).await?.into_result()?.stdout;
    if let Destination::Local { path } = &cfg.destination {
        conn.exec_sudo(&format!("install -d -m 700 {}", shell_quote(path)), sudo, None).await?.into_result()?;
    }
    let write = |path: &'static str, mode: &'static str, content: String| async move {
        conn.write_file_sudo(path, &content, sudo).await?;
        conn.exec_sudo(&format!("chmod {mode} {path} && chown root:root {path}"), sudo, None).await?.into_result()?;
        Ok::<_, Error>(())
    };
    // Le fichier est créé vide en 0600 AVANT d'y écrire les secrets.
    conn.exec_sudo(&format!("install -m 600 /dev/null {ENV_PATH}.new"), sudo, None).await?.into_result()?;
    conn.write_file_sudo(&format!("{ENV_PATH}.new"), env, sudo).await?;
    conn.exec_sudo(&format!("mv -f {ENV_PATH}.new {ENV_PATH} && chmod 600 {ENV_PATH}"), sudo, None).await?.into_result()?;
    write(CONFIG_PATH, "600", serde_json::to_string_pretty(cfg).map_err(|e| Error::Other(e.to_string()))?).await?;
    write(SCRIPT_PATH, "700", run_script(cfg)).await?;

    let (service, timer) = systemd_units(&cfg.schedule);
    let systemd = conn.exec("test -d /run/systemd/system", None).await?.success();
    if systemd {
        write("/etc/systemd/system/helm-backup.service", "644", service).await?;
        write("/etc/systemd/system/helm-backup.timer", "644", timer).await?;
        conn.exec_sudo("systemctl daemon-reload && systemctl enable --now helm-backup.timer", sudo, None).await?.into_result()?;
        log.push_str("Planification : timer systemd helm-backup.timer\n");
    } else {
        let (h, m) = cfg.schedule.split_once(':').unwrap_or(("3", "0"));
        let cron = format!(
            "{} {} * * * root {SCRIPT_PATH} >/var/log/helm-backup.log 2>&1\n",
            m.trim_start_matches('0').parse::<u32>().unwrap_or(0),
            h.trim_start_matches('0').parse::<u32>().unwrap_or(0)
        );
        write("/etc/cron.d/helm-backup", "644", cron).await?;
        log.push_str("Planification : /etc/cron.d/helm-backup (pas de systemd)\n");
    }
    // Vérifie que le dépôt est accessible (et l'initialise au besoin).
    let check =
        conn.exec_sudo(&format!("set -a; . {ENV_PATH}; set +a; restic cat config >/dev/null 2>&1 || restic init 2>&1"), sudo, None).await?;
    if !check.success() {
        return Err(Error::Remote(format!("dépôt restic inaccessible : {}{}", check.stdout, check.stderr)));
    }
    log.push_str("Dépôt restic prêt.\n");
    Ok(log)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub started_at: i64,
    pub finished_at: i64,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub restic: Option<String>,
    pub config: Option<BackupConfig>,
    pub last: Option<LastRun>,
    pub next_run: Option<String>,
}

pub async fn status(conn: &Connection, sudo: Option<&str>) -> Result<Status> {
    let restic = conn.exec("restic version 2>/dev/null | head -n1", None).await?;
    let config = conn.exec_sudo(&format!("cat {CONFIG_PATH} 2>/dev/null"), sudo, None).await?;
    let last = conn.exec(&format!("cat {LAST_PATH} 2>/dev/null"), None).await?;
    let next = conn.exec("systemctl list-timers helm-backup.timer --no-legend 2>/dev/null | awk '{print $1\" \"$2\" \"$3}'", None).await?;
    Ok(Status {
        restic: Some(restic.stdout.trim().to_string()).filter(|s| !s.is_empty()),
        config: serde_json::from_str(config.stdout.trim()).ok(),
        last: serde_json::from_str(last.stdout.trim()).ok(),
        next_run: Some(next.stdout.trim().to_string()).filter(|s| !s.is_empty()),
    })
}

/// Lit l'environnement actuel (pour conserver les secrets déjà enregistrés).
pub async fn current_secret(conn: &Connection, sudo: Option<&str>, key: &str) -> Result<Option<String>> {
    let out = conn.exec_sudo(&format!("cat {ENV_PATH} 2>/dev/null"), sudo, None).await?;
    Ok(out.stdout.lines().find_map(|l| l.strip_prefix(&format!("{key}='"))).map(|v| v.trim_end_matches('\'').to_string()))
}

fn restic(cmd: &str) -> String {
    format!("set -a; . {ENV_PATH}; set +a; restic {cmd}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub short_id: String,
    pub time: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub hostname: String,
}

pub async fn snapshots(conn: &Connection, sudo: Option<&str>) -> Result<Vec<Snapshot>> {
    let out = conn.exec_sudo(&restic("snapshots --json --tag helm"), sudo, None).await?.into_result()?;
    let mut list: Vec<Snapshot> =
        serde_json::from_str(out.stdout.trim()).map_err(|e| Error::Other(format!("réponse restic illisible : {e}")))?;
    list.reverse();
    Ok(list)
}

fn valid_snapshot(id: &str) -> bool {
    id == "latest" || (id.len() >= 8 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
}

/// Contenu d'un dossier d'une sauvegarde (un seul niveau).
pub async fn list(conn: &Connection, sudo: Option<&str>, snapshot: &str, path: &str) -> Result<Vec<Node>> {
    if !valid_snapshot(snapshot) || !safe_path(path) {
        return Err(Error::Other("sauvegarde ou chemin invalide".into()));
    }
    let out = conn.exec_sudo(&restic(&format!("ls --json {snapshot} {}", shell_quote(path))), sudo, None).await?.into_result()?;
    let base = path.trim_end_matches('/');
    Ok(out
        .stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|v| v.get("struct_type").and_then(|s| s.as_str()) == Some("node"))
        .filter_map(|v| {
            let p = v.get("path")?.as_str()?.to_string();
            let parent = p.rsplit_once('/').map(|x| x.0).unwrap_or("");
            (parent == base || (base.is_empty() && parent.is_empty())).then(|| Node {
                name: v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                kind: v.get("type").and_then(|n| n.as_str()).unwrap_or("file").to_string(),
                size: v.get("size").and_then(|n| n.as_u64()).unwrap_or(0),
                path: p,
            })
        })
        .collect())
}

/// Restaure un chemin d'une sauvegarde dans un dossier temporaire du serveur (jamais en place).
pub async fn restore_to_temp(conn: &Connection, sudo: Option<&str>, snapshot: &str, path: &str) -> Result<String> {
    if !valid_snapshot(snapshot) || !safe_path(path) {
        return Err(Error::Other("sauvegarde ou chemin invalide".into()));
    }
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let target = format!("{RESTORE_ROOT}/{ts}");
    conn.exec_sudo(&restic(&format!("restore {snapshot} --target {target} --include {} 2>&1", shell_quote(path))), sudo, None)
        .await?
        .into_result()?;
    Ok(format!("{target}{path}"))
}

/// Remet en place un élément restauré : l'actuel est d'abord mis de côté (`.helm-avant-restauration-…`).
pub async fn put_back(conn: &Connection, sudo: Option<&str>, restored: &str, original: &str) -> Result<String> {
    if !restored.starts_with(&format!("{RESTORE_ROOT}/")) || !safe_path(restored) || !safe_path(original) {
        return Err(Error::Other("chemins invalides".into()));
    }
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let aside = format!("{original}.helm-avant-restauration-{ts}");
    let cmd = format!(
        "set -e; [ -e {o} ] && mv {o} {a}; mkdir -p \"$(dirname {o})\"; cp -a {r} {o}; echo {a}",
        o = shell_quote(original),
        a = shell_quote(&aside),
        r = shell_quote(restored)
    );
    conn.exec_sudo(&cmd, sudo, None).await?.into_result()?;
    Ok(aside)
}

/// Réimporte un dump restauré dans son conteneur de base de données.
pub async fn import_dump(conn: &Connection, sudo: Option<&str>, dump: &str, db: &DbSource) -> Result<String> {
    if !dump.starts_with(&format!("{RESTORE_ROOT}/")) || !safe_path(dump) || !safe_name(&db.container) {
        return Err(Error::Other("paramètres invalides".into()));
    }
    let c = &db.container;
    let cmd = match db.kind.as_str() {
        "mysql" => format!("docker exec -i {c} sh -c 'C=$(command -v mysql || command -v mariadb); exec \"$C\" -uroot -p\"${{MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}}\"' < {}", shell_quote(dump)),
        "postgres" => format!("docker exec -i {c} sh -c 'exec psql -U \"${{POSTGRES_USER:-postgres}}\" -d postgres' < {}", shell_quote(dump)),
        _ => return Err(Error::Other("type de base inconnu".into())),
    };
    Ok(conn.exec_sudo(&format!("{cmd} 2>&1"), sudo, None).await?.into_result()?.stdout)
}

/// Vérifie l'intégrité du dépôt.
pub async fn check(conn: &Connection, sudo: Option<&str>) -> Result<String> {
    let out = conn.exec_sudo(&restic("check 2>&1"), sudo, None).await?;
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation() {
        let mut c = BackupConfig::default();
        assert!(c.validate().is_ok());
        c.paths.push("/etc/../root".into());
        assert!(c.validate().is_err());
        let mut c = BackupConfig { schedule: "25:00".into(), ..Default::default() };
        assert!(c.validate().is_err());
        c.schedule = "03:30".into();
        c.databases.push(DbSource { container: "db; rm -rf /".into(), kind: "mysql".into() });
        assert!(c.validate().is_err());
    }

    #[test]
    fn repository_and_env() {
        let c = BackupConfig {
            destination: Destination::S3 {
                endpoint: "https://s3.fr-par.scw.cloud/".into(),
                bucket: "mes-sauvegardes".into(),
                prefix: "vps".into(),
                access_key_id: "AK".into(),
            },
            ..Default::default()
        };
        assert!(c.validate().is_ok());
        assert_eq!(c.repository(), "s3:https://s3.fr-par.scw.cloud/mes-sauvegardes/vps");
        let env = env_file(&c, "motdepasse", Some("SK")).unwrap();
        assert!(env.contains("AWS_SECRET_ACCESS_KEY='SK'"));
        assert!(env_file(&c, "motdepasse", None).is_err());
        assert!(env_file(&c, "a'b", Some("SK")).is_err(), "une quote casserait le fichier");
    }

    #[test]
    fn script() {
        let c = BackupConfig {
            volumes: vec!["mypage_data".into()],
            databases: vec![
                DbSource { container: "nexus-mysql".into(), kind: "mysql".into() },
                DbSource { container: "pg".into(), kind: "postgres".into() },
            ],
            ..Default::default()
        };
        let s = run_script(&c);
        assert!(s.contains("docker exec nexus-mysql"));
        assert!(s.contains("--single-transaction"));
        assert!(s.contains("pg_dumpall"));
        assert!(s.contains("docker volume inspect -f '{{.Mountpoint}}' mypage_data"));
        assert!(s.contains("--keep-daily 7 --keep-weekly 4 --keep-monthly 6"));
        assert!(!s.contains("RESTIC_PASSWORD='"), "aucun secret dans le script");
    }

    #[test]
    fn snapshots_ids() {
        assert!(valid_snapshot("latest"));
        assert!(valid_snapshot("a1b2c3d4"));
        assert!(!valid_snapshot("a1b2; rm"));
    }
}
