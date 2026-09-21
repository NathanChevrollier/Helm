//! Déploiement d'un projet compose : pull → up → vérification → retour à l'image précédente si échec.
//!
//! Un seul script serveur (`/usr/local/bin/helm-deploy`) sert au bouton de l'app et à GitHub Actions.
//! Pour GitHub, une clé SSH dédiée est restreinte dans `authorized_keys` par une commande forcée :
//! elle ne peut que lancer le déploiement de SON projet (pas de shell, pas de redirection).

use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

pub const SCRIPT_PATH: &str = "/usr/local/bin/helm-deploy";
pub const CONF_DIR: &str = "/etc/helm-deploy";

pub const DEPLOY_SCRIPT: &str = r#"#!/bin/bash
# Généré par Helm : déploiement d'un projet docker compose avec retour arrière automatique.
set -uo pipefail
P="${1:-${SSH_ORIGINAL_COMMAND:-}}"
P="${P##* }"
[[ "$P" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "projet invalide"; exit 2; }
CONF="/etc/helm-deploy/$P.conf"
[ -f "$CONF" ] || { echo "le projet $P n'est pas configuré pour le déploiement"; exit 2; }
. "$CONF"
exec > >(tee -a /var/log/helm-deploy.log) 2>&1
echo "=== Déploiement de $P — $(date -Is)"
cd "$DIR" || { echo "@@DEPLOY FAILED dossier $DIR introuvable"; exit 1; }
dc() { docker compose --project-directory "$DIR" -p "$P" "${FILES[@]}" "$@"; }
declare -A OLD
for id in $(dc ps -q 2>/dev/null); do
  svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")
  OLD[$svc]="$(docker inspect -f '{{.Image}}' "$id") $(docker inspect -f '{{.Config.Image}}' "$id")"
done
rollback() {
  echo "!!! $1 : retour à la version précédente"
  for svc in "${!OLD[@]}"; do
    read -r img ref <<< "${OLD[$svc]}"
    docker tag "$img" "$ref"
  done
  dc up -d --remove-orphans
  echo "@@DEPLOY ROLLBACK $1"
  exit 1
}
echo "--- Téléchargement des images"
dc pull || { echo "@@DEPLOY FAILED téléchargement des images impossible"; exit 1; }
echo "--- Redémarrage"
dc up -d --remove-orphans || rollback "démarrage impossible"
echo "--- Vérification"
ok=0
for _ in $(seq 1 45); do
  state=0
  for id in $(dc ps -q); do
    st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
    case "$st" in
      "running healthy"|"running none") ;;
      "running starting") state=1 ;;
      *) state=2 ;;
    esac
  done
  if [ $state = 0 ]; then ok=1; break; fi
  if [ $state = 2 ]; then break; fi
  sleep 2
done
[ $ok = 1 ] || rollback "conteneurs arrêtés ou en mauvaise santé"
if [ -n "${CHECK_HOST:-}" ]; then
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "Host: $CHECK_HOST" http://127.0.0.1/)
  case "$code" in
    2*|3*) echo "Site $CHECK_HOST : HTTP $code" ;;
    *) rollback "le site $CHECK_HOST répond HTTP $code" ;;
  esac
fi
docker image prune -f >/dev/null 2>&1
echo "@@DEPLOY OK"
"#;

pub fn valid_project(p: &str) -> bool {
    !p.is_empty() && p.len() <= 64 && p.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

fn safe_path(p: &str) -> bool {
    p.starts_with('/') && !p.contains("..") && p.chars().all(|c| c.is_ascii_alphanumeric() || "/._-@".contains(c))
}

/// Fichier de configuration d'un projet (valeurs validées puis entre quotes simples).
pub fn project_conf(dir: &str, files: &[String], check_host: Option<&str>) -> Result<String> {
    if !safe_path(dir) || files.is_empty() || !files.iter().all(|f| safe_path(f)) {
        return Err(Error::Other("dossier ou fichiers compose invalides".into()));
    }
    let mut s = format!("# Généré par Helm\nDIR='{dir}'\nFILES=(");
    for f in files {
        s.push_str(&format!(" -f '{f}'"));
    }
    s.push_str(" )\n");
    if let Some(h) = check_host.filter(|h| !h.is_empty()) {
        if !crate::nginx::valid_domain(h) {
            return Err(Error::Other(format!("domaine invalide : {h}")));
        }
        s.push_str(&format!("CHECK_HOST='{h}'\n"));
    }
    Ok(s)
}

/// Installe (ou met à jour) le script et la configuration du projet.
pub async fn configure(conn: &Connection, sudo: Option<&str>, project: &str, config_files: &str, check_host: Option<&str>) -> Result<()> {
    if !valid_project(project) {
        return Err(Error::Other("nom de projet invalide".into()));
    }
    let files: Vec<String> = config_files.split(',').map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
    let dir = files.first().map(|f| crate::sftp::parent(f)).ok_or_else(|| Error::Other("projet sans fichier compose".into()))?;
    let conf = project_conf(&dir, &files, check_host)?;
    conn.exec_sudo(
        &format!("install -d -m 755 {CONF_DIR} && touch /var/log/helm-deploy.log && chmod 640 /var/log/helm-deploy.log"),
        sudo,
        None,
    )
    .await?
    .into_result()?;
    conn.write_file_sudo(SCRIPT_PATH, DEPLOY_SCRIPT, sudo).await?;
    let conf_path = format!("{CONF_DIR}/{project}.conf");
    conn.write_file_sudo(&conf_path, &conf, sudo).await?;
    conn.exec_sudo(&format!("chown root:root {SCRIPT_PATH} {conf_path} && chmod 755 {SCRIPT_PATH} && chmod 644 {conf_path}"), sudo, None)
        .await?
        .into_result()?;
    Ok(())
}

/// Commande à lancer (dans un terminal) pour déployer, selon que l'utilisateur est root ou non.
pub async fn command(conn: &Connection, project: &str) -> Result<String> {
    if !valid_project(project) {
        return Err(Error::Other("nom de projet invalide".into()));
    }
    let root = conn.run("id -u").await?.trim() == "0";
    Ok(if root { format!("{SCRIPT_PATH} {project}") } else { format!("sudo {SCRIPT_PATH} {project}") })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployKey {
    pub project: String,
    /// Clé privée à placer dans le secret GitHub (affichée une seule fois, jamais stockée par Helm).
    pub private_key: String,
    pub known_hosts: String,
    pub user: String,
    pub workflow: String,
}

fn marker(project: &str) -> String {
    format!("helm-deploy:{project}")
}

/// Crée une clé de déploiement restreinte pour GitHub Actions.
pub async fn create_key(conn: &Connection, sudo: Option<&str>, project: &str, host: &str, port: u16) -> Result<DeployKey> {
    if !valid_project(project) {
        return Err(Error::Other("nom de projet invalide".into()));
    }
    let user = conn.run("id -un").await?.trim().to_string();
    let root = conn.run("id -u").await?.trim() == "0";
    // Clé générée dans un dossier temporaire privé, lue puis effacée aussitôt.
    let gen = conn
        .run(&format!(
            "set -e; D=$(mktemp -d); ssh-keygen -q -t ed25519 -N '' -C {m} -f \"$D/k\"; cat \"$D/k\"; echo @@PUB; cat \"$D/k.pub\"; rm -rf \"$D\"",
            m = shell_quote(&marker(project))
        ))
        .await?;
    let (private_key, public) = gen.split_once("@@PUB\n").ok_or_else(|| Error::Other("génération de la clé impossible".into()))?;
    let public = public.trim();
    if !root {
        // Autorise uniquement le script de déploiement sans mot de passe, et vérifie la syntaxe avant de l'installer.
        let rule = format!("{user} ALL=(root) NOPASSWD: {SCRIPT_PATH}\n");
        let file = format!("/etc/sudoers.d/helm-deploy-{user}");
        conn.write_file_sudo(&format!("{file}.new"), &rule, sudo).await?;
        conn.exec_sudo(
            &format!("visudo -cf {file}.new && chmod 440 {file}.new && mv -f {file}.new {file} || {{ rm -f {file}.new; exit 1; }}"),
            sudo,
            None,
        )
        .await?
        .into_result()?;
    }
    let forced = if root { format!("{SCRIPT_PATH} {project}") } else { format!("sudo -n {SCRIPT_PATH} {project}") };
    let line = format!("command=\"{forced}\",restrict {public}");
    let m = marker(project);
    conn.run(&format!(
        "set -e; umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; sed -i '/ {m}$/d' ~/.ssh/authorized_keys; printf '%s\\n' {l} >> ~/.ssh/authorized_keys",
        l = shell_quote(&line)
    ))
    .await?;

    let host_key = conn.run("cat /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $1\" \"$2}'").await?;
    let target = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
    let known_hosts = format!("{target} {}", host_key.trim());
    let workflow = format!(
        r#"name: Déploiement
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    # Si l'image est construite dans un autre job, ajoute : needs: <nom-du-job>
    steps:
      - name: Déployer {project} sur le VPS
        env:
          SSH_KEY: ${{{{ secrets.HELM_DEPLOY_KEY }}}}
        run: |
          install -m 600 /dev/null key
          printf '%s\n' "$SSH_KEY" > key
          echo '{known_hosts}' > known_hosts
          ssh -i key -p {port} -o UserKnownHostsFile=known_hosts -o StrictHostKeyChecking=yes {user}@{host} {project}
"#
    );
    Ok(DeployKey { project: project.into(), private_key: private_key.to_string(), known_hosts, user, workflow })
}

/// Projets qui ont une clé de déploiement active.
pub async fn keys(conn: &Connection) -> Result<Vec<String>> {
    let out = conn.exec("grep -o ' helm-deploy:[A-Za-z0-9_.-]*$' ~/.ssh/authorized_keys 2>/dev/null || true", None).await?;
    Ok(out.stdout.lines().filter_map(|l| l.trim().strip_prefix("helm-deploy:")).map(str::to_string).collect())
}

pub async fn revoke_key(conn: &Connection, project: &str) -> Result<()> {
    if !valid_project(project) {
        return Err(Error::Other("nom de projet invalide".into()));
    }
    conn.run(&format!("sed -i '/ {}$/d' ~/.ssh/authorized_keys", marker(project))).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conf() {
        let c = project_conf("/opt/sites/app", &["/opt/sites/app/docker-compose.yml".into()], Some("app.example.com")).unwrap();
        assert!(c.contains("DIR='/opt/sites/app'"));
        assert!(c.contains("FILES=( -f '/opt/sites/app/docker-compose.yml' )"));
        assert!(c.contains("CHECK_HOST='app.example.com'"));
        assert!(project_conf("/opt/x'; rm -rf /", &["/a.yml".into()], None).is_err());
        assert!(project_conf("/opt/x", &["/a.yml".into()], Some("x; reboot")).is_err());
    }

    #[test]
    fn projects() {
        assert!(valid_project("mypage"));
        assert!(!valid_project("a b"));
        assert!(!valid_project("x;id"));
    }
}
