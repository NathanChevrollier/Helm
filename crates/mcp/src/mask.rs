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

/// Secrets reconnaissables à leur forme, où qu'ils soient dans la ligne (logs, URL, code PHP…),
/// y compris quand le nom de la clé ne dit rien.
fn patterns() -> &'static [(regex::Regex, &'static str)] {
    use std::sync::OnceLock;
    static P: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        [
            // Identifiants dans une URL : scheme://user:motdepasse@hôte
            (r"([a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]+):[^@\s/]+@", "$1:***@"),
            // Paramètres de requête sensibles : ?token=…, &api_key=…
            (
                r#"(?i)([?&;](?:access_token|refresh_token|token|api_key|apikey|key|secret|password|passwd|pass|pwd|auth|signature|sig|code)=)[^&\s"']+"#,
                "${1}***",
            ),
            // En-têtes d'authentification
            (r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}", "$1 ***"),
            // JWT
            (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}", "***jwt***"),
            // Préfixes de jetons connus : Stripe, GitHub, GitLab, Slack, AWS, OpenAI, Anthropic…
            (
                r"\b(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})",
                "***jeton***",
            ),
            // PHP : define('DB_PASSWORD', 'x') et 'password' => 'x'
            (
                r#"(?i)(define\(\s*['"][A-Z0-9_]*(?:PASS|SECRET|KEY|SALT|TOKEN|AUTH|NONCE)[A-Z0-9_]*['"]\s*,\s*)(['"]).*?(['"])\s*\)"#,
                "$1$2***$3)",
            ),
            (r#"(?i)(['"][a-z0-9_]*(?:pass|secret|token|apikey|api_key|salt)[a-z0-9_]*['"]\s*=>\s*)(['"]).*?(['"])"#, "$1$2***$3"),
        ]
        .into_iter()
        .map(|(re, to)| (regex::Regex::new(re).expect("motif de masquage valide"), to))
        .collect()
    })
}

fn mask_patterns(line: &str) -> String {
    let mut out = std::borrow::Cow::Borrowed(line);
    for (re, to) in patterns() {
        if re.is_match(&out) {
            out = std::borrow::Cow::Owned(re.replace_all(&out, *to).into_owned());
        }
    }
    out.into_owned()
}

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
        out.push_str(&mask_patterns(&mask_line(line, dotenv)));
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
    fn masks_secrets_by_shape() {
        let cases = [
            ("url: mysql://app:motdepasse@db:3306/app", "motdepasse"),
            ("GET /api/login?token=abc123def&x=1 HTTP/1.1", "abc123def"),
            ("Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"),
            ("x eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 y", "SflKxwRJSMeKKF2QT4"),
            ("cle sk_live_51Habcdefghijkl utilisée", "sk_live_51Habcdefghijkl"),
            ("remote ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"),
            ("aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
            ("define( 'DB_PASSWORD', 'wp-s3cret' );", "wp-s3cret"),
            ("define('AUTH_KEY', 'x;y:z');", "x;y:z"),
            ("'password' => 'laravel-pw',", "laravel-pw"),
        ];
        for (text, secret) in cases {
            let m = mask(text, false);
            assert!(!m.contains(secret), "secret visible dans {m:?}");
        }
        let m = mask("define('DB_NAME', 'wordpress');", false);
        assert!(m.contains("wordpress"), "valeurs non sensibles conservées");
    }

    #[test]
    fn leaves_urls_and_times_alone() {
        let t = "proxy_pass http://127.0.0.1:8081;\nschedule: 03:00\n";
        assert_eq!(mask(t, false), t);
    }
}
