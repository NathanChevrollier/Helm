//! Registres d'images privés : connexion d'un serveur à Docker Hub, GitHub Packages, GitLab,
//! AWS ECR ou tout registre compatible, avec des identifiants tirés du coffre-fort de Helm.
//!
//! Le secret ne passe jamais dans une ligne de commande — il y serait visible de tous les
//! utilisateurs du serveur (`ps`, `/proc/*/cmdline`) : il part sur l'entrée standard de
//! `docker login --password-stdin`.
//!
//! Limite à connaître : une fois connecté, Docker garde lui-même le jeton sur le serveur, dans
//! `~/.docker/config.json`, simplement encodé en base64 si aucun « credential helper » n'est
//! installé. Helm le signale dans l'interface et recommande un jeton en lecture seule plutôt que le
//! mot de passe du compte.

use serde::{Deserialize, Serialize};

use crate::docker::{self, Access};
use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

/// Famille de registre : elle fixe l'adresse par défaut et la façon d'obtenir le jeton.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    DockerHub,
    Ghcr,
    Gitlab,
    /// AWS Elastic Container Registry : le jeton est demandé à AWS à chaque connexion.
    Ecr,
    /// Registre auto-hébergé ou autre fournisseur compatible.
    Custom,
}

impl Kind {
    /// Adresse du registre proposée par défaut.
    pub fn default_server(self) -> &'static str {
        match self {
            Kind::DockerHub => "docker.io",
            Kind::Ghcr => "ghcr.io",
            Kind::Gitlab => "registry.gitlab.com",
            Kind::Ecr | Kind::Custom => "",
        }
    }

    /// Ce que l'interface doit demander comme secret, et avec quels droits.
    pub fn secret_hint(self) -> &'static str {
        match self {
            Kind::DockerHub => "jeton d'accès Docker Hub (Account settings → Personal access tokens), en lecture seule",
            Kind::Ghcr => "jeton GitHub classique avec la seule portée read:packages",
            Kind::Gitlab => "jeton de déploiement GitLab avec la portée read_registry",
            Kind::Ecr => "clé secrète AWS d'un utilisateur limité à ecr:GetAuthorizationToken et à la lecture des dépôts",
            Kind::Custom => "mot de passe ou jeton du registre",
        }
    }
}

/// Adresse de registre acceptable : un nom d'hôte, éventuellement un port et un chemin court.
pub fn valid_server(server: &str) -> bool {
    !server.is_empty()
        && server.len() <= 253
        && server.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '/' | '_'))
        && !server.starts_with(['-', '/', '.'])
        && !server.contains("//")
}

/// Identifiant acceptable (utilisateur, région AWS) : rien qui puisse sortir de ses guillemets.
pub fn valid_word(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Adresse d'un registre ECR : `<compte>.dkr.ecr.<région>.amazonaws.com`.
pub fn ecr_server(account: &str, region: &str) -> Result<String> {
    if account.len() != 12 || !account.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::Other("numéro de compte AWS invalide : 12 chiffres attendus".into()));
    }
    if !valid_region(region) {
        return Err(Error::Other("région AWS invalide (ex. eu-west-3)".into()));
    }
    Ok(format!("{account}.dkr.ecr.{region}.amazonaws.com"))
}

fn valid_region(region: &str) -> bool {
    !region.is_empty() && region.len() <= 32 && region.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Région AWS lue dans l'adresse d'un registre ECR.
pub fn ecr_region(server: &str) -> Option<&str> {
    let rest = server.split(".dkr.ecr.").nth(1)?;
    let region = rest.strip_suffix(".amazonaws.com")?;
    valid_region(region).then_some(region)
}

/// Commande de connexion et entrée standard à lui fournir.
///
/// * Registre classique : `docker login <serveur> -u <utilisateur> --password-stdin`, le secret
///   sur l'entrée standard.
/// * ECR : la clé d'accès et la clé secrète arrivent sur l'entrée standard (deux lignes), sont
///   lues par `read` dans des variables d'environnement, puis `aws ecr get-login-password` fournit
///   le jeton du jour à `docker login`. Rien n'apparaît dans la liste des processus.
pub fn login_command(kind: Kind, server: &str, username: &str, secret: &str) -> Result<(String, Vec<u8>)> {
    if !valid_server(server) {
        return Err(Error::Other(format!("adresse de registre invalide : {server}")));
    }
    if secret.is_empty() || secret.contains('\n') || secret.contains('\r') {
        return Err(Error::Other("secret du registre absent ou invalide".into()));
    }
    let srv = shell_quote(server);
    match kind {
        Kind::Ecr => {
            let region = ecr_region(server).ok_or_else(|| Error::Other("adresse ECR invalide".into()))?;
            if !valid_word(username) {
                return Err(Error::Other("identifiant de clé d'accès AWS invalide".into()));
            }
            // Le shim Podman va en tête : placé après le `|`, c'est lui qui recevrait le jeton.
            let cmd = format!(
                "{}command -v aws >/dev/null 2>&1 || {{ echo 'le client aws (AWS CLI v2) est absent du serveur' >&2; exit 127; }}; \
                 IFS= read -r AWS_ACCESS_KEY_ID && IFS= read -r AWS_SECRET_ACCESS_KEY && export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY && \
                 aws ecr get-login-password --region {} | docker login --username AWS --password-stdin {srv}",
                docker::PODMAN_SHIM,
                shell_quote(region),
            );
            Ok((cmd, format!("{username}\n{secret}\n").into_bytes()))
        }
        _ => {
            if !valid_word(username) {
                return Err(Error::Other("nom d'utilisateur du registre invalide".into()));
            }
            let cmd = format!("{}docker login {srv} --username {} --password-stdin", docker::PODMAN_SHIM, shell_quote(username));
            Ok((cmd, secret.as_bytes().to_vec()))
        }
    }
}

/// Connecte le serveur au registre. Renvoie le message de Docker (« Login Succeeded »).
pub async fn login(
    conn: &Connection,
    access: Access,
    sudo: Option<&str>,
    kind: Kind,
    server: &str,
    username: &str,
    secret: &str,
) -> Result<String> {
    let (cmd, input) = login_command(kind, server, username, secret)?;
    let out = match access {
        Access::Direct => conn.exec(&cmd, Some(&input)).await?,
        Access::Sudo => conn.exec_sudo(&cmd, sudo, Some(&input)).await?,
        Access::Unavailable => return Err(Error::Other("Docker n'est pas accessible sur ce serveur".into())),
    };
    if !out.success() {
        let why = out.stderr.trim();
        return Err(Error::Remote(if why.is_empty() { "connexion au registre refusée".into() } else { why.to_string() }));
    }
    Ok(out.stdout.lines().chain(out.stderr.lines()).find(|l| l.contains("Succeeded")).unwrap_or("Connecté").trim().to_string())
}

/// Déconnecte le serveur du registre : Docker efface le jeton de son `config.json`.
pub async fn logout(conn: &Connection, access: Access, sudo: Option<&str>, server: &str) -> Result<()> {
    if !valid_server(server) {
        return Err(Error::Other(format!("adresse de registre invalide : {server}")));
    }
    docker::run(conn, access, sudo, &format!("logout {}", shell_quote(server))).await?.into_result()?;
    Ok(())
}

/// Registre auquel le serveur est connecté, tel que Docker l'a inscrit.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub server: String,
    /// Le jeton est rangé par un « credential helper » (pass, secretservice…) plutôt qu'en clair.
    pub helper: bool,
}

/// Lit les registres connus du `config.json` de Docker, sans jamais renvoyer les jetons.
pub const SESSIONS_COMMAND: &str = "cat \"${DOCKER_CONFIG:-$HOME/.docker}/config.json\" 2>/dev/null || true";

/// Registres connectés d'après `config.json`. Les jetons (`auth`) ne sont pas lus : seules les
/// adresses et la présence d'un « credential helper » intéressent l'interface.
pub fn parse_sessions(config: &str) -> Vec<Session> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(config) else { return Vec::new() };
    let global_helper = v.get("credsStore").and_then(|s| s.as_str()).is_some_and(|s| !s.is_empty());
    let helpers = v.get("credHelpers").and_then(|h| h.as_object());
    let mut out: Vec<Session> = v
        .get("auths")
        .and_then(|a| a.as_object())
        .map(|auths| {
            auths
                .keys()
                .map(|server| Session {
                    server: server.trim_start_matches("https://").trim_end_matches("/v1/").trim_end_matches('/').to_string(),
                    helper: global_helper || helpers.is_some_and(|h| h.contains_key(server)),
                })
                .collect()
        })
        .unwrap_or_default();
    // Un registre servi par un helper dédié peut ne pas figurer dans `auths`.
    if let Some(h) = helpers {
        for server in h.keys() {
            if !out.iter().any(|s| &s.server == server) {
                out.push(Session { server: server.clone(), helper: true });
            }
        }
    }
    out.sort_by(|a, b| a.server.cmp(&b.server));
    out
}

/// Registres auxquels le serveur est connecté (compte qui lance Docker : root si Helm passe par sudo).
pub async fn sessions(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<Session>> {
    let out = match access {
        Access::Direct => conn.exec(SESSIONS_COMMAND, None).await?,
        Access::Sudo => conn.exec_sudo(SESSIONS_COMMAND, sudo, None).await?,
        Access::Unavailable => return Ok(Vec::new()),
    };
    Ok(parse_sessions(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_secret_never_reaches_the_command_line() {
        let (cmd, input) = login_command(Kind::Ghcr, "ghcr.io", "alice", "ghp_secret123").unwrap();
        assert!(cmd.contains("docker login 'ghcr.io' --username 'alice' --password-stdin"), "{cmd}");
        assert!(!cmd.contains("ghp_secret123"), "le jeton ne doit jamais apparaître dans la commande");
        assert_eq!(input, b"ghp_secret123");
    }

    #[test]
    fn ecr_reads_its_keys_from_stdin() {
        let server = ecr_server("123456789012", "eu-west-3").unwrap();
        assert_eq!(server, "123456789012.dkr.ecr.eu-west-3.amazonaws.com");
        let (cmd, input) = login_command(Kind::Ecr, &server, "AKIAEXEMPLE", "clé-secrète").unwrap();
        assert!(cmd.contains("aws ecr get-login-password --region 'eu-west-3' | docker login --username AWS --password-stdin"), "{cmd}");
        assert!(cmd.starts_with(crate::docker::PODMAN_SHIM), "le shim Podman doit précéder le pipe");
        assert!(cmd.contains("read -r AWS_ACCESS_KEY_ID") && cmd.contains("read -r AWS_SECRET_ACCESS_KEY"));
        assert!(!cmd.contains("AKIAEXEMPLE") && !cmd.contains("clé-secrète"));
        assert_eq!(input, "AKIAEXEMPLE\nclé-secrète\n".as_bytes());
        assert!(ecr_server("123", "eu-west-3").is_err());
        assert!(ecr_server("123456789012", "eu west").is_err());
    }

    #[test]
    fn hostile_values_are_refused() {
        assert!(login_command(Kind::Custom, "reg.exemple.fr; rm -rf /", "a", "b").is_err());
        assert!(login_command(Kind::Custom, "reg.exemple.fr", "a b", "s").is_err());
        // Un retour à la ligne dans le secret ajouterait une seconde entrée à `docker login`.
        assert!(login_command(Kind::Custom, "reg.exemple.fr", "a", "s\nautre").is_err());
        assert!(login_command(Kind::Custom, "reg.exemple.fr", "a", "").is_err());
        assert!(valid_server("registry.exemple.fr:5000"));
        assert!(!valid_server("-oProxyCommand=x"));
    }

    #[test]
    fn sessions_never_expose_tokens() {
        let config = r#"{
            "auths": {
                "https://index.docker.io/v1/": { "auth": "YWxpY2U6c2VjcmV0" },
                "ghcr.io": { "auth": "Ym9iOnRva2Vu" }
            },
            "credHelpers": { "123456789012.dkr.ecr.eu-west-3.amazonaws.com": "ecr-login" }
        }"#;
        let s = parse_sessions(config);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].server, "123456789012.dkr.ecr.eu-west-3.amazonaws.com");
        assert!(s[0].helper);
        assert_eq!(s[1].server, "ghcr.io");
        assert!(!s[1].helper, "jeton en base64 dans config.json : à signaler");
        assert_eq!(s[2].server, "index.docker.io");
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("YWxpY2U6c2VjcmV0") && !json.contains("Ym9iOnRva2Vu"), "aucun jeton ne sort");
        // Un credsStore global couvre tous les registres.
        assert!(parse_sessions(r#"{"auths":{"ghcr.io":{}},"credsStore":"pass"}"#)[0].helper);
        assert!(parse_sessions("pas du json").is_empty());
    }

    #[test]
    fn defaults_per_kind() {
        assert_eq!(Kind::Ghcr.default_server(), "ghcr.io");
        assert_eq!(ecr_region("123456789012.dkr.ecr.us-east-1.amazonaws.com"), Some("us-east-1"));
        assert_eq!(ecr_region("ghcr.io"), None);
    }
}
