//! Masquage des secrets avant d'envoyer du texte à une IA : ces données partent chez le
//! fournisseur du modèle, elles ne doivent contenir ni mot de passe, ni jeton, ni clé privée.

const SENSITIVE: &[&str] = &[
    "PASSWORD",
    "PASSWD",
    "PWD",
    "SECRET",
    "TOKEN",
    "APIKEY",
    "API_KEY",
    "PRIVATE",
    "ACCESS_KEY",
    "ACCESSKEY",
    "CREDENTIAL",
    "AUTH",
    "SALT",
    "DSN",
    "DATABASE_URL",
    "CONNECTION_STRING",
];

const MAX_OUTPUT: usize = 100_000;

fn is_sensitive_key(key: &str) -> bool {
    let k = key.to_uppercase().replace('-', "_");
    SENSITIVE.iter().any(|s| k.contains(s))
}

/// Masque la valeur d'une ligne `CLE=valeur` / `cle: valeur` si la clé est sensible (ou toujours si `all`).
fn mask_line(line: &str, all: bool) -> String {
    let body = line.trim_start();
    let indent = &line[..line.len() - body.len()];
    // Préfixes courants : liste YAML, chaîne JSON, `export`.
    let mut prefix_len = 0;
    for p in ["- ", "\"", "'", "export "] {
        if body[prefix_len..].starts_with(p) {
            prefix_len += p.len();
        }
    }
    let rest = &body[prefix_len..];
    let Some(sep) = rest.find(['=', ':']) else { return line.to_string() };
    let key = rest[..sep].trim().trim_matches(|c| c == '"' || c == '\'');
    let value = rest[sep + 1..].trim();
    // `http://…` ou une heure `12:30` ne sont pas des paires clé/valeur.
    let looks_like_key = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    if !looks_like_key || value.is_empty() || value.starts_with("//") {
        return line.to_string();
    }
    if all || is_sensitive_key(key) {
        let quote = if value.ends_with("\",") {
            "\","
        } else if value.ends_with('"') {
            "\""
        } else {
            ""
        };
        return format!("{indent}{}{}{} ***masqué***{quote}", &body[..prefix_len], &rest[..sep], &rest[sep..=sep]);
    }
    line.to_string()
}

/// Masque les secrets d'un texte (configuration, logs, inspection…) et le tronque à 100 Ko.
/// `dotenv` : fichier `.env`, dont toutes les valeurs sont masquées.
pub fn mask(text: &str, dotenv: bool) -> String {
    let mut out = String::with_capacity(text.len().min(MAX_OUTPUT));
    let mut in_private_key = false;
    for line in text.lines() {
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
            in_private_key = true;
            out.push_str("***clé privée masquée***\n");
            continue;
        }
        if in_private_key {
            if line.contains("-----END") {
                in_private_key = false;
            }
            continue;
        }
        out.push_str(&mask_line(line, dotenv));
        out.push('\n');
        if out.len() > MAX_OUTPUT {
            out.truncate(MAX_OUTPUT);
            out.push_str("\n… (tronqué)\n");
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_sensitive_values() {
        let t = "services:\n  db:\n    environment:\n      MYSQL_ROOT_PASSWORD: s3cret\n      - API_TOKEN=abc123\n      MYSQL_DATABASE: app\n    image: mysql:8.0\n";
        let m = mask(t, false);
        assert!(!m.contains("s3cret") && !m.contains("abc123"));
        assert!(m.contains("MYSQL_DATABASE: app"), "valeurs non sensibles conservées");
        assert!(m.contains("image: mysql:8.0"));
    }

    #[test]
    fn masks_docker_inspect_env() {
        let t = "\"Env\": [\n    \"POSTGRES_PASSWORD=hunter2\",\n    \"PATH=/usr/bin\"\n]";
        let m = mask(t, false);
        assert!(!m.contains("hunter2"));
        assert!(m.contains("PATH=/usr/bin"));
    }

    #[test]
    fn masks_private_keys_and_dotenv() {
        let t = "a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nb";
        let m = mask(t, false);
        assert!(!m.contains("AAAA") && m.contains("a\n") && m.contains("b\n"));
        let env = mask("APP_NAME=site\nSTRIPE=sk_live_x\n", true);
        assert!(!env.contains("site") && !env.contains("sk_live_x"));
    }

    #[test]
    fn leaves_urls_and_times_alone() {
        let t = "proxy_pass http://127.0.0.1:8081;\nschedule: 03:00\n";
        assert_eq!(mask(t, false), t);
    }
}
