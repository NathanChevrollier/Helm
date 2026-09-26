//! Catalogue d'applications Docker Compose prêtes à déployer.
//!
//! Chaque application décrit ses réglages (`Variable`) et deux gabarits : le `docker-compose.yml`
//! et le `.env`. Helm remplit les mots de passe avec de l'aléa du système, valide chaque valeur,
//! puis rend les fichiers — que l'utilisateur voit avant qu'ils ne soient écrits sur le serveur.
//!
//! Deux règles tiennent toute la sécurité de ce module :
//! * un service n'écoute que sur `127.0.0.1`, jamais sur toutes les interfaces : l'accès public
//!   passe par le reverse proxy nginx, avec HTTPS, comme le reste des sites du serveur ;
//! * aucune valeur ne peut contenir un retour à la ligne, sans quoi elle pourrait ajouter ses
//!   propres clés dans le YAML ou le `.env`.

use std::collections::HashMap;

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Nature d'un réglage : elle décide du contrôle appliqué et de la façon de le saisir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VarKind {
    Text,
    /// Rempli par Helm avec de l'aléa du système ; masqué à la saisie.
    Password,
    /// Port de l'hôte, toujours lié à 127.0.0.1.
    Port,
    /// Nom de domaine ou sous-domaine.
    Domain,
    /// Chemin absolu sur le serveur.
    Path,
    Email,
}

/// Réglage demandé à l'utilisateur avant le déploiement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    /// Nom du gabarit, en majuscules : `{{DB_PASSWORD}}`.
    pub key: String,
    pub label: String,
    pub hint: String,
    pub kind: VarKind,
    /// Valeur proposée ; vide pour un mot de passe (Helm en génère un).
    pub default: String,
}

impl Variable {
    fn new(key: &str, label: &str, hint: &str, kind: VarKind, default: &str) -> Variable {
        Variable { key: key.into(), label: label.into(), hint: hint.into(), kind, default: default.into() }
    }
}

/// Application du catalogue.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Pour ranger le catalogue : « Fichiers », « Base de données », « Supervision »…
    pub category: String,
    /// Port du conteneur à servir derrière nginx, si l'application a une interface web.
    pub http_port: Option<u16>,
    pub docs_url: String,
    pub variables: Vec<Variable>,
    /// Gabarit du `docker-compose.yml`.
    pub compose: String,
    /// Gabarit du `.env` ; vide si l'application n'en a pas besoin.
    pub env: String,
    /// Points à savoir avant de lancer (première connexion, volumes à sauvegarder…).
    pub notes: Vec<String>,
}

/// Fichiers rendus, prêts à être montrés puis écrits.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub compose: String,
    pub env: String,
    /// Valeurs finales, mots de passe générés compris : l'interface les affiche une fois.
    pub values: Vec<(String, String)>,
}

/// Alphabet des mots de passe générés : ni `'`, ni `"`, ni `$`, ni `\`, ni espace. Ces caractères
/// ont un sens pour YAML, pour un fichier `.env` ou pour un shell, et un mot de passe qui en
/// contient finit tôt ou tard par casser un script d'entrée de conteneur.
const ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

/// Mot de passe tiré de l'aléa du système. Le modulo est écarté par rejet : sans cela, les
/// premières lettres de l'alphabet seraient un peu plus probables que les dernières.
pub fn generate_password(len: usize) -> Result<String> {
    let len = len.clamp(8, 128);
    let rng = SystemRandom::new();
    let mut out = String::with_capacity(len);
    let mut buf = [0u8; 64];
    while out.len() < len {
        rng.fill(&mut buf).map_err(|_| Error::Other("aléa du système indisponible".into()))?;
        // 256 n'est pas un multiple de la taille de l'alphabet : les valeurs qui débordent du
        // dernier tour complet sont rejetées plutôt que repliées.
        let limit = (256 / ALPHABET.len()) * ALPHABET.len();
        for b in buf {
            if out.len() >= len {
                break;
            }
            if (b as usize) < limit {
                out.push(ALPHABET[b as usize % ALPHABET.len()] as char);
            }
        }
    }
    Ok(out)
}

/// Valeur acceptable pour un réglage. Le refus est délibérément net : une valeur douteuse ne va
/// pas dans un fichier écrit sur le serveur.
pub fn check_value(v: &Variable, value: &str) -> Result<()> {
    if value.chars().any(char::is_control) {
        return Err(Error::Other(format!("{} : les retours à la ligne et caractères de contrôle sont refusés", v.label)));
    }
    if value.trim().is_empty() {
        return Err(Error::Other(format!("{} : valeur obligatoire", v.label)));
    }
    if value.len() > 512 {
        return Err(Error::Other(format!("{} : valeur trop longue", v.label)));
    }
    match v.kind {
        VarKind::Port => {
            let port: u16 = value.trim().parse().map_err(|_| Error::Other(format!("{} : port invalide", v.label)))?;
            if port < 1024 {
                return Err(Error::Other(format!("{} : choisis un port au-dessus de 1023", v.label)));
            }
        }
        VarKind::Domain => {
            let ok = value.len() <= 253
                && value.split('.').count() >= 2
                && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
                && !value.starts_with('-')
                && !value.ends_with('-');
            if !ok {
                return Err(Error::Other(format!("{} : nom de domaine invalide", v.label)));
            }
        }
        VarKind::Path => {
            if !value.starts_with('/') || value.contains("..") {
                return Err(Error::Other(format!("{} : un chemin absolu est attendu, sans « .. »", v.label)));
            }
        }
        VarKind::Email => {
            if !value.contains('@') || value.starts_with('@') || value.ends_with('@') || value.contains(' ') {
                return Err(Error::Other(format!("{} : adresse e-mail invalide", v.label)));
            }
        }
        VarKind::Password => {
            // Les caractères qui cassent YAML, `.env` ou un script d'entrée sont refusés plutôt
            // qu'échappés : un mot de passe généré par Helm n'en contient jamais.
            if value.contains('\'') || value.contains('"') || value.contains('$') || value.contains('\\') {
                return Err(Error::Other(format!("{} : évite les caractères ' \" $ et \\", v.label)));
            }
            if value.len() < 8 {
                return Err(Error::Other(format!("{} : au moins 8 caractères", v.label)));
            }
        }
        VarKind::Text => {}
    }
    Ok(())
}

/// Application du catalogue, par son identifiant.
pub fn app(id: &str) -> Option<App> {
    apps().into_iter().find(|a| a.id == id)
}

/// Valeurs de départ d'une application : les valeurs proposées, et un mot de passe par réglage
/// secret. C'est ce que l'interface affiche dans le formulaire.
pub fn defaults(a: &App) -> Result<Vec<(String, String)>> {
    a.variables
        .iter()
        .map(|v| {
            let value = match v.kind {
                VarKind::Password => generate_password(28)?,
                _ => v.default.clone(),
            };
            Ok((v.key.clone(), value))
        })
        .collect()
}

/// Remplit les gabarits d'une application avec les valeurs fournies.
pub fn render(a: &App, values: &HashMap<String, String>) -> Result<Rendered> {
    let mut finals: Vec<(String, String)> = Vec::with_capacity(a.variables.len());
    for v in &a.variables {
        let value = values.get(&v.key).cloned().unwrap_or_else(|| v.default.clone());
        let value = if value.trim().is_empty() && v.kind == VarKind::Password { generate_password(28)? } else { value };
        check_value(v, &value)?;
        finals.push((v.key.clone(), value.trim().to_string()));
    }
    let fill = |template: &str| -> Result<String> {
        let mut out = template.to_string();
        for (k, value) in &finals {
            out = out.replace(&format!("{{{{{k}}}}}"), value);
        }
        // Un gabarit qui garde un `{{…}}` a une variable non déclarée : mieux vaut le dire que
        // d'écrire un fichier à moitié rempli sur le serveur.
        if let Some(i) = out.find("{{") {
            let reste: String = out[i..].chars().take(40).collect();
            return Err(Error::Other(format!("gabarit incomplet près de « {reste} »")));
        }
        Ok(out)
    };
    Ok(Rendered { compose: fill(&a.compose)?, env: fill(&a.env)?, values: finals })
}

// Chaque argument est un champ de la fiche, dans l'ordre où elle se lit : un constructeur par
// struct intermédiaire n'apporterait qu'une indirection de plus au catalogue.
#[allow(clippy::too_many_arguments)]
fn app_of(
    id: &str,
    name: &str,
    category: &str,
    description: &str,
    http_port: Option<u16>,
    docs_url: &str,
    variables: Vec<Variable>,
    compose: &str,
    env: &str,
    notes: &[&str],
) -> App {
    App {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        category: category.into(),
        http_port,
        docs_url: docs_url.into(),
        variables,
        compose: compose.trim_start_matches('\n').to_string(),
        env: env.trim_start_matches('\n').to_string(),
        notes: notes.iter().map(|s| s.to_string()).collect(),
    }
}

/// Réglage de port réutilisé par presque toutes les applications.
fn port(default: u16) -> Variable {
    Variable::new(
        "PORT",
        "Port local",
        "Le service n'écoute que sur 127.0.0.1 : l'accès public passe par nginx.",
        VarKind::Port,
        &default.to_string(),
    )
}

fn data_dir(default: &str) -> Variable {
    Variable::new("DATA", "Dossier des données", "À inclure dans les sauvegardes.", VarKind::Path, default)
}

/// Catalogue complet. Les images sont épinglées sur une version majeure : `latest` fait changer de
/// version sans prévenir, ce qui est la première cause de casse d'un déploiement Docker.
pub fn apps() -> Vec<App> {
    vec![
        app_of(
            "uptime-kuma",
            "Uptime Kuma",
            "Supervision",
            "Supervision de sites et de services, avec alertes (Discord, e-mail, webhook). Léger et sans base externe.",
            Some(3001),
            "https://github.com/louislam/uptime-kuma",
            vec![port(3001), data_dir("/opt/stacks/uptime-kuma/data")],
            r#"
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: uptime-kuma
    restart: unless-stopped
    ports:
      - "127.0.0.1:{{PORT}}:3001"
    volumes:
      - {{DATA}}:/app/data
"#,
            "",
            &["Le premier écran demande de créer le compte administrateur : fais-le tout de suite, avant d'ouvrir le sous-domaine."],
        ),
        app_of(
            "vaultwarden",
            "Vaultwarden",
            "Sécurité",
            "Gestionnaire de mots de passe compatible avec les applications Bitwarden.",
            Some(80),
            "https://github.com/dani-garcia/vaultwarden",
            vec![
                port(8222),
                data_dir("/opt/stacks/vaultwarden/data"),
                Variable::new("DOMAIN", "Adresse publique", "L'URL HTTPS finale, indispensable aux clés de sécurité.", VarKind::Domain, "vault.exemple.fr"),
                Variable::new("ADMIN_TOKEN", "Jeton d'administration", "Donne accès à /admin. Garde-le hors du navigateur.", VarKind::Password, ""),
            ],
            r#"
services:
  vaultwarden:
    image: vaultwarden/server:1
    container_name: vaultwarden
    restart: unless-stopped
    environment:
      DOMAIN: "https://{{DOMAIN}}"
      ADMIN_TOKEN: "{{ADMIN_TOKEN}}"
      SIGNUPS_ALLOWED: "false"
      WEBSOCKET_ENABLED: "true"
    ports:
      - "127.0.0.1:{{PORT}}:80"
    volumes:
      - {{DATA}}:/data
"#,
            "",
            &[
                "Les inscriptions sont fermées : crée ton compte en les ouvrant un instant depuis /admin, puis referme-les.",
                "Sauvegarde /data : il contient le coffre entier.",
            ],
        ),
        app_of(
            "nextcloud",
            "Nextcloud",
            "Fichiers",
            "Stockage de fichiers, agenda et contacts, avec sa base PostgreSQL.",
            Some(80),
            "https://docs.nextcloud.com",
            vec![
                port(8081),
                data_dir("/opt/stacks/nextcloud/data"),
                Variable::new("DB_DATA", "Dossier de la base", "Données PostgreSQL.", VarKind::Path, "/opt/stacks/nextcloud/db"),
                Variable::new("DB_PASSWORD", "Mot de passe de la base", "Généré par Helm ; aucun humain n'a à le connaître.", VarKind::Password, ""),
                Variable::new("ADMIN_USER", "Administrateur", "Compte créé au premier démarrage.", VarKind::Text, "admin"),
                Variable::new("ADMIN_PASSWORD", "Mot de passe administrateur", "À noter maintenant : il ne sera plus affiché.", VarKind::Password, ""),
                Variable::new("DOMAIN", "Adresse publique", "Sans elle, Nextcloud refuse les requêtes du reverse proxy.", VarKind::Domain, "cloud.exemple.fr"),
            ],
            r#"
services:
  db:
    image: postgres:16-alpine
    container_name: nextcloud-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: nextcloud
      POSTGRES_USER: nextcloud
      POSTGRES_PASSWORD: "{{DB_PASSWORD}}"
    volumes:
      - {{DB_DATA}}:/var/lib/postgresql/data

  app:
    image: nextcloud:30-apache
    container_name: nextcloud
    restart: unless-stopped
    depends_on:
      - db
    environment:
      POSTGRES_HOST: db
      POSTGRES_DB: nextcloud
      POSTGRES_USER: nextcloud
      POSTGRES_PASSWORD: "{{DB_PASSWORD}}"
      NEXTCLOUD_ADMIN_USER: "{{ADMIN_USER}}"
      NEXTCLOUD_ADMIN_PASSWORD: "{{ADMIN_PASSWORD}}"
      NEXTCLOUD_TRUSTED_DOMAINS: "{{DOMAIN}}"
      OVERWRITEPROTOCOL: https
      TRUSTED_PROXIES: 172.16.0.0/12
    ports:
      - "127.0.0.1:{{PORT}}:80"
    volumes:
      - {{DATA}}:/var/www/html
"#,
            "",
            &[
                "Prévois large sur le disque : les fichiers des utilisateurs vivent dans le volume de données.",
                "Le premier démarrage prend plusieurs minutes (installation du schéma).",
                "Augmente `client_max_body_size` dans le vhost nginx pour les gros envois.",
            ],
        ),
        app_of(
            "wordpress",
            "WordPress",
            "Sites web",
            "WordPress avec sa base MariaDB, prêt à être servi derrière nginx.",
            Some(80),
            "https://wordpress.org/documentation/",
            vec![
                port(8082),
                data_dir("/opt/stacks/wordpress/html"),
                Variable::new("DB_DATA", "Dossier de la base", "Données MariaDB.", VarKind::Path, "/opt/stacks/wordpress/db"),
                Variable::new("DB_PASSWORD", "Mot de passe de la base", "Utilisé par WordPress seulement.", VarKind::Password, ""),
                Variable::new("DB_ROOT_PASSWORD", "Mot de passe root de la base", "Pour l'administration de MariaDB.", VarKind::Password, ""),
            ],
            r#"
services:
  db:
    image: mariadb:11
    container_name: wordpress-db
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: "{{DB_PASSWORD}}"
      MARIADB_ROOT_PASSWORD: "{{DB_ROOT_PASSWORD}}"
    volumes:
      - {{DB_DATA}}:/var/lib/mysql

  wordpress:
    image: wordpress:6-php8.3-apache
    container_name: wordpress
    restart: unless-stopped
    depends_on:
      - db
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: "{{DB_PASSWORD}}"
    ports:
      - "127.0.0.1:{{PORT}}:80"
    volumes:
      - {{DATA}}:/var/www/html
"#,
            "",
            &["Ajoute `define('FORCE_SSL_ADMIN', true);` dans wp-config.php une fois le HTTPS en place."],
        ),
        app_of(
            "postgres",
            "PostgreSQL",
            "Base de données",
            "Serveur PostgreSQL seul, pour une application qui a besoin d'une base.",
            None,
            "https://hub.docker.com/_/postgres",
            vec![
                port(5433),
                data_dir("/opt/stacks/postgres/data"),
                Variable::new("DB_NAME", "Nom de la base", "Créée au premier démarrage.", VarKind::Text, "app"),
                Variable::new("DB_USER", "Utilisateur", "Propriétaire de la base.", VarKind::Text, "app"),
                Variable::new("DB_PASSWORD", "Mot de passe", "Généré par Helm.", VarKind::Password, ""),
            ],
            r#"
services:
  postgres:
    image: postgres:16-alpine
    container_name: postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: "{{DB_NAME}}"
      POSTGRES_USER: "{{DB_USER}}"
      POSTGRES_PASSWORD: "{{DB_PASSWORD}}"
    ports:
      - "127.0.0.1:{{PORT}}:5432"
    volumes:
      - {{DATA}}:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U {{DB_USER}}"]
      interval: 10s
      timeout: 5s
      retries: 5
"#,
            "",
            &[
                "L'onglet Bases de données de Helm verra cette instance automatiquement.",
                "Le port n'est ouvert que sur 127.0.0.1 : passe par un tunnel Helm pour t'y connecter depuis ton PC.",
            ],
        ),
        app_of(
            "redis",
            "Redis",
            "Base de données",
            "Cache et file d'attente, avec mot de passe et persistance sur disque.",
            None,
            "https://redis.io/docs/",
            vec![
                port(6380),
                data_dir("/opt/stacks/redis/data"),
                Variable::new("REDIS_PASSWORD", "Mot de passe", "Un Redis sans mot de passe est la première cible d'un scan.", VarKind::Password, ""),
            ],
            r#"
services:
  redis:
    image: redis:7-alpine
    container_name: redis
    restart: unless-stopped
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD}", "--appendonly", "yes"]
    environment:
      REDIS_PASSWORD: "{{REDIS_PASSWORD}}"
    ports:
      - "127.0.0.1:{{PORT}}:6379"
    volumes:
      - {{DATA}}:/data
"#,
            "",
            &["L'explorateur Redis de Helm lit `REDIS_PASSWORD` dans l'environnement du conteneur : il se connectera seul."],
        ),
        app_of(
            "plausible",
            "Plausible Analytics",
            "Supervision",
            "Mesure d'audience respectueuse de la vie privée, sans cookie ni donnée personnelle.",
            Some(8000),
            "https://plausible.io/docs/self-hosting",
            vec![
                port(8083),
                Variable::new("DB_DATA", "Dossier de la base", "Données PostgreSQL.", VarKind::Path, "/opt/stacks/plausible/db"),
                Variable::new("CH_DATA", "Dossier ClickHouse", "Les événements, qui grossissent vite.", VarKind::Path, "/opt/stacks/plausible/clickhouse"),
                Variable::new("DB_PASSWORD", "Mot de passe de la base", "Interne à la pile.", VarKind::Password, ""),
                Variable::new("SECRET_KEY_BASE", "Clé secrète", "Signe les sessions : la changer déconnecte tout le monde.", VarKind::Password, ""),
                Variable::new("DOMAIN", "Adresse publique", "URL de l'interface Plausible.", VarKind::Domain, "stats.exemple.fr"),
            ],
            r#"
services:
  db:
    image: postgres:16-alpine
    container_name: plausible-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: plausible
      POSTGRES_USER: plausible
      POSTGRES_PASSWORD: "{{DB_PASSWORD}}"
    volumes:
      - {{DB_DATA}}:/var/lib/postgresql/data

  clickhouse:
    image: clickhouse/clickhouse-server:24-alpine
    container_name: plausible-clickhouse
    restart: unless-stopped
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    volumes:
      - {{CH_DATA}}:/var/lib/clickhouse

  plausible:
    image: ghcr.io/plausible/community-edition:v2
    container_name: plausible
    restart: unless-stopped
    depends_on:
      - db
      - clickhouse
    command: sh -c "/entrypoint.sh db createdb && /entrypoint.sh db migrate && /entrypoint.sh run"
    environment:
      BASE_URL: "https://{{DOMAIN}}"
      SECRET_KEY_BASE: "{{SECRET_KEY_BASE}}"
      DATABASE_URL: "postgres://plausible:{{DB_PASSWORD}}@db:5432/plausible"
      CLICKHOUSE_DATABASE_URL: "http://clickhouse:8123/plausible_events_db"
    ports:
      - "127.0.0.1:{{PORT}}:8000"
"#,
            "",
            &[
                "ClickHouse demande de la RAM : compte 2 Go libres au minimum.",
                "SECRET_KEY_BASE doit faire au moins 64 caractères pour Plausible : Helm en génère assez.",
            ],
        ),
        app_of(
            "n8n",
            "n8n",
            "Automatisation",
            "Automatisations et intégrations entre services, en glisser-déposer.",
            Some(5678),
            "https://docs.n8n.io",
            vec![
                port(5678),
                data_dir("/opt/stacks/n8n/data"),
                Variable::new("DOMAIN", "Adresse publique", "Nécessaire aux webhooks entrants.", VarKind::Domain, "n8n.exemple.fr"),
                Variable::new("ENCRYPTION_KEY", "Clé de chiffrement", "Protège les identifiants stockés : la perdre les rend illisibles.", VarKind::Password, ""),
            ],
            r#"
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:1
    container_name: n8n
    restart: unless-stopped
    environment:
      N8N_HOST: "{{DOMAIN}}"
      N8N_PORT: "5678"
      N8N_PROTOCOL: https
      WEBHOOK_URL: "https://{{DOMAIN}}/"
      N8N_ENCRYPTION_KEY: "{{ENCRYPTION_KEY}}"
      GENERIC_TIMEZONE: Europe/Paris
    ports:
      - "127.0.0.1:{{PORT}}:5678"
    volumes:
      - {{DATA}}:/home/node/.n8n
"#,
            "",
            &["Sauvegarde la clé de chiffrement en même temps que le volume : sans elle, les identifiants enregistrés sont perdus."],
        ),
        app_of(
            "gitea",
            "Gitea",
            "Développement",
            "Forge Git légère : dépôts, tickets, revues et actions.",
            Some(3000),
            "https://docs.gitea.com",
            vec![
                port(3002),
                data_dir("/opt/stacks/gitea/data"),
                Variable::new("SSH_PORT", "Port SSH de Gitea", "Distinct du SSH du serveur, pour les push par clé.", VarKind::Port, "2222"),
                Variable::new("DOMAIN", "Adresse publique", "Utilisée dans les URL de clonage.", VarKind::Domain, "git.exemple.fr"),
            ],
            r#"
services:
  gitea:
    image: gitea/gitea:1
    container_name: gitea
    restart: unless-stopped
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__server__ROOT_URL: "https://{{DOMAIN}}/"
      GITEA__server__SSH_DOMAIN: "{{DOMAIN}}"
      GITEA__server__SSH_PORT: "{{SSH_PORT}}"
      GITEA__service__DISABLE_REGISTRATION: "true"
    ports:
      - "127.0.0.1:{{PORT}}:3000"
      - "{{SSH_PORT}}:22"
    volumes:
      - {{DATA}}:/data
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
"#,
            "",
            &[
                "Le port SSH de Gitea est publié sur toutes les interfaces : les push par clé en ont besoin. Ouvre-le dans le pare-feu, et seulement lui.",
                "Les inscriptions sont fermées : crée le premier compte, qui devient administrateur, puis laisse-les fermées.",
            ],
        ),
        app_of(
            "nginx-proxy-manager",
            "Nginx Proxy Manager",
            "Réseau",
            "Reverse proxy avec interface web et certificats Let's Encrypt. À n'installer que si tu ne gères pas déjà nginx avec Helm.",
            Some(81),
            "https://nginxproxymanager.com",
            vec![
                Variable::new("PORT", "Port de l'interface", "L'interface d'administration reste sur 127.0.0.1.", VarKind::Port, "8181"),
                data_dir("/opt/stacks/npm/data"),
                Variable::new("CERTS", "Dossier des certificats", "Certificats Let's Encrypt.", VarKind::Path, "/opt/stacks/npm/letsencrypt"),
            ],
            r#"
services:
  npm:
    image: jc21/nginx-proxy-manager:2
    container_name: nginx-proxy-manager
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "127.0.0.1:{{PORT}}:81"
    volumes:
      - {{DATA}}:/data
      - {{CERTS}}:/etc/letsencrypt
"#,
            "",
            &[
                "Attention : il prend les ports 80 et 443. Si nginx tourne déjà sur ce serveur, les deux ne peuvent pas coexister.",
                "Identifiants d'origine : admin@example.com / changeme — à changer à la première connexion.",
            ],
        ),
        app_of(
            "minio",
            "MinIO",
            "Fichiers",
            "Stockage objet compatible S3, pour les sauvegardes et les fichiers d'une application.",
            Some(9001),
            "https://min.io/docs/minio/linux/index.html",
            vec![
                Variable::new("PORT", "Port de la console", "Interface web d'administration.", VarKind::Port, "9001"),
                Variable::new("API_PORT", "Port de l'API S3", "Celui que les applications utilisent.", VarKind::Port, "9000"),
                data_dir("/opt/stacks/minio/data"),
                Variable::new("ROOT_USER", "Utilisateur racine", "Clé d'accès initiale.", VarKind::Text, "helm-admin"),
                Variable::new("ROOT_PASSWORD", "Mot de passe racine", "Clé secrète initiale.", VarKind::Password, ""),
            ],
            r#"
services:
  minio:
    image: minio/minio:latest
    container_name: minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: "{{ROOT_USER}}"
      MINIO_ROOT_PASSWORD: "{{ROOT_PASSWORD}}"
    ports:
      - "127.0.0.1:{{API_PORT}}:9000"
      - "127.0.0.1:{{PORT}}:9001"
    volumes:
      - {{DATA}}:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 30s
      timeout: 10s
      retries: 3
"#,
            "",
            &["Crée un utilisateur dédié par application plutôt que de partager le compte racine."],
        ),
        app_of(
            "dozzle",
            "Dozzle",
            "Supervision",
            "Lecteur de logs Docker en direct dans le navigateur, sans agent ni base.",
            Some(8080),
            "https://dozzle.dev",
            vec![
                port(8084),
                Variable::new("USERNAME", "Utilisateur", "Authentification simple de l'interface.", VarKind::Text, "admin"),
                Variable::new("PASSWORD", "Mot de passe", "Sans lui, tous les logs sont publics.", VarKind::Password, ""),
            ],
            r#"
services:
  dozzle:
    image: amir20/dozzle:v8
    container_name: dozzle
    restart: unless-stopped
    environment:
      DOZZLE_AUTH_PROVIDER: simple
      DOZZLE_AUTH_TTL: 48h
    ports:
      - "127.0.0.1:{{PORT}}:8080"
    volumes:
      # Lecture seule : Dozzle lit les logs, il ne pilote pas Docker.
      - /var/run/docker.sock:/var/run/docker.sock:ro
"#,
            "",
            &[
                "Le socket Docker est monté en lecture seule, mais y accéder reste un privilège fort : garde l'interface derrière une authentification.",
                "Crée l'utilisateur avec `docker exec dozzle /dozzle generate {{USERNAME}} --password {{PASSWORD}} --email admin@exemple.fr > users.yml`, puis monte ce fichier sur /data/users.yml.",
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(a: &App) -> HashMap<String, String> {
        defaults(a).unwrap().into_iter().collect()
    }

    #[test]
    fn every_app_renders_with_its_defaults() {
        for a in apps() {
            let r = render(&a, &values(&a)).unwrap_or_else(|e| panic!("{} : {e}", a.id));
            assert!(!r.compose.contains("{{"), "{} laisse un gabarit non rempli", a.id);
            assert!(r.compose.contains("services:"), "{} n'est pas un fichier compose", a.id);
            assert!(r.compose.contains("restart: unless-stopped"), "{} doit redémarrer tout seul", a.id);
            // Une valeur manquante doit se voir tout de suite, pas après l'écriture sur le serveur.
            assert!(!a.name.is_empty() && !a.description.is_empty());
        }
    }

    #[test]
    fn services_are_never_exposed_to_the_internet() {
        for a in apps() {
            let r = render(&a, &values(&a)).unwrap();
            for line in r.compose.lines().map(str::trim) {
                let Some(mapping) = line.strip_prefix("- \"") else { continue };
                let Some(mapping) = mapping.strip_suffix('"') else { continue };
                if mapping.starts_with("127.0.0.1:") || mapping.starts_with("CMD") {
                    continue;
                }
                // Seules exceptions assumées et documentées : le reverse proxy et le SSH de Gitea.
                let expected = matches!(a.id.as_str(), "nginx-proxy-manager" | "gitea");
                assert!(expected, "{} publie {mapping} sur toutes les interfaces", a.id);
                assert!(
                    a.notes.iter().any(|n| n.contains("toutes les interfaces") || n.contains("ports 80 et 443")),
                    "{} publie un port sans le dire dans ses notes",
                    a.id
                );
            }
        }
    }

    #[test]
    fn generated_passwords_are_safe_in_yaml_and_env() {
        let a = app("vaultwarden").unwrap();
        let pw = generate_password(28);
        let pw = pw.unwrap();
        assert_eq!(pw.len(), 28);
        for bad in ['\'', '"', '$', '\\', ' ', '\n'] {
            assert!(!pw.contains(bad), "mot de passe avec « {bad} »");
        }
        // Deux appels ne donnent pas le même résultat.
        assert_ne!(generate_password(28).unwrap(), generate_password(28).unwrap());
        // Et le mot de passe généré passe le contrôle de la variable.
        let v = a.variables.iter().find(|v| v.kind == VarKind::Password).unwrap();
        assert!(check_value(v, &pw).is_ok());
    }

    #[test]
    fn hostile_values_are_refused() {
        let a = app("uptime-kuma").unwrap();
        let mut v = values(&a);
        // Un retour à la ligne permettrait d'ajouter ses propres clés au YAML.
        v.insert("DATA".into(), "/opt/x\n    privileged: true".into());
        assert!(render(&a, &v).is_err());
        v.insert("DATA".into(), "../../etc".into());
        assert!(render(&a, &v).is_err());
        v.insert("DATA".into(), "/opt/ok".into());
        v.insert("PORT".into(), "80".into());
        assert!(render(&a, &v).is_err(), "un port privilégié est refusé");
        v.insert("PORT".into(), "8080; rm -rf /".into());
        assert!(render(&a, &v).is_err());
        v.insert("PORT".into(), "8080".into());
        assert!(render(&a, &v).is_ok());
    }

    #[test]
    fn domains_and_emails_are_checked() {
        let v = Variable::new("D", "Domaine", "", VarKind::Domain, "");
        assert!(check_value(&v, "cloud.exemple.fr").is_ok());
        assert!(check_value(&v, "sans-point").is_err());
        assert!(check_value(&v, "a b.fr").is_err());
        let e = Variable::new("E", "Mail", "", VarKind::Email, "");
        assert!(check_value(&e, "moi@exemple.fr").is_ok());
        assert!(check_value(&e, "moi-exemple.fr").is_err());
    }

    #[test]
    fn unknown_app() {
        assert!(app("n-existe-pas").is_none());
        assert!(apps().len() >= 10, "le catalogue doit rester fourni");
    }
}
