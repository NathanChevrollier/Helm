//! Apache (httpd) : analyse des `<VirtualHost>`, découverte des sites et nouveau vhost en
//! reverse proxy. Les modifications passent par l'application sûre commune avec nginx
//! (`nginx::write_config_for(…, Engine::Apache, …)` : sauvegarde, `configtest`, reload, restauration).

use crate::nginx::{self, Location, NginxState, ServerBlock};
use crate::{Connection, Result};

/// Mots d'une ligne de configuration Apache (les guillemets regroupent un argument).
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in line.chars() {
        match (c, quote) {
            ('"' | '\'', None) => quote = Some(c),
            (q, Some(open)) if q == open => quote = None,
            (c, None) if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            (c, _) => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Lignes logiques (continuations `\` recollées, commentaires retirés), avec leur numéro de ligne.
fn logical_lines(src: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut pending: Option<(usize, String)> = None;
    for (i, raw) in src.lines().enumerate() {
        let line = raw.trim();
        let (start, mut text) = match pending.take() {
            Some((n, t)) => (n, t),
            None => (i + 1, String::new()),
        };
        if text.is_empty() && line.starts_with('#') {
            continue;
        }
        if let Some(cont) = line.strip_suffix('\\') {
            text.push_str(cont);
            text.push(' ');
            pending = Some((start, text));
            continue;
        }
        text.push_str(line);
        if !text.trim().is_empty() {
            out.push((start, text.trim().to_string()));
        }
    }
    out
}

/// Résumé des `<VirtualHost>` d'un fichier Apache, au même format que les server blocks nginx.
pub fn servers(src: &str) -> Vec<ServerBlock> {
    let mut out = Vec::new();
    let mut current: Option<ServerBlock> = None;
    // Chemin de la section <Location> ouverte dans le vhost, le cas échéant.
    let mut location: Option<String> = None;
    for (line, text) in logical_lines(src) {
        let w = words(&text);
        let Some(first) = w.first() else { continue };
        let name = first.to_ascii_lowercase();
        if name == "<virtualhost" {
            let listen = w[1..].iter().map(|a| a.trim_end_matches('>').to_string()).filter(|a| !a.is_empty()).collect();
            current = Some(ServerBlock {
                server_names: vec![],
                listen,
                ssl: false,
                root: None,
                ssl_certificate: None,
                returns: None,
                locations: vec![],
                line,
                upstream_ports: vec![],
            });
            continue;
        }
        let Some(vh) = current.as_mut() else { continue };
        match name.as_str() {
            "</virtualhost>" => {
                let mut vh = current.take().unwrap();
                vh.ssl = vh.ssl || vh.listen.iter().any(|l| l.ends_with(":443"));
                vh.upstream_ports = vh.locations.iter().filter_map(|l| l.proxy_pass.as_deref().and_then(nginx::local_port)).collect();
                vh.upstream_ports.dedup();
                out.push(vh);
            }
            "<location" | "<locationmatch" => location = w.get(1).map(|p| p.trim_end_matches('>').to_string()),
            "</location>" | "</locationmatch>" => location = None,
            "servername" => {
                if let Some(n) = w.get(1) {
                    vh.server_names.insert(0, n.split(':').next().unwrap_or(n).to_string());
                }
            }
            "serveralias" => vh.server_names.extend(w[1..].iter().cloned()),
            "documentroot" => vh.root = w.get(1).cloned(),
            "sslengine" => vh.ssl = vh.ssl || w.get(1).is_some_and(|v| v.eq_ignore_ascii_case("on")),
            "sslcertificatefile" => vh.ssl_certificate = w.get(1).cloned(),
            // ProxyPass /chemin cible — ou, dans une <Location>, ProxyPass cible.
            "proxypass" => {
                let (path, target) = match (&location, w.get(1), w.get(2)) {
                    (Some(loc), Some(t), None) => (loc.clone(), t.clone()),
                    (_, Some(p), Some(t)) => (p.clone(), t.clone()),
                    _ => continue,
                };
                if target != "!" {
                    vh.locations.push(Location { path, proxy_pass: Some(target), root: None, returns: None });
                }
            }
            "redirect" | "redirectmatch" | "redirectpermanent" => {
                if vh.returns.is_none() {
                    vh.returns = Some(w[1..].join(" "));
                }
            }
            // Redirection HTTPS classique (certbot) : RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [R=301]
            "rewriterule" if vh.returns.is_none() && w.iter().any(|a| a.starts_with("https://")) => vh.returns = Some(w[1..].join(" ")),
            "alias" => {
                if let (Some(p), Some(dir)) = (w.get(1), w.get(2)) {
                    vh.locations.push(Location { path: p.clone(), proxy_pass: None, root: Some(dir.clone()), returns: None });
                }
            }
            _ => {}
        }
    }
    out
}

/// Découverte : sites activés (sites-enabled, ou conf.d sur RHEL), sites désactivés
/// (sites-available non liés), version, état du service, certbot.
const DISCOVER_SCRIPT: &str = r#"for b in nginx caddy traefik lighttpd haproxy; do command -v "$b" >/dev/null 2>&1 && echo "@@OTHER $b"; done
if [ -d /etc/apache2 ]; then CONF=/etc/apache2; elif [ -d /etc/httpd ]; then CONF=/etc/httpd; else echo @@NOAPACHE; exit 0; fi
BIN=$(command -v apache2 || command -v httpd || command -v apache2ctl || command -v apachectl)
[ -n "$BIN" ] || { echo @@NOAPACHE; exit 0; }
echo "@@ROOT $CONF"
echo "@@VERSION $("$BIN" -v 2>/dev/null | head -n 1)"
if pgrep -x apache2 >/dev/null 2>&1 || pgrep -x httpd >/dev/null 2>&1; then echo @@RUNNING; fi
command -v certbot >/dev/null 2>&1 && echo @@CERTBOT
for f in "$CONF"/sites-enabled/* "$CONF"/conf.d/*.conf; do
  [ -f "$f" ] || continue
  echo "@@FILE enabled $f $(readlink -f "$f")"
  cat "$f"; echo
done
enabled_real="
$(readlink -f "$CONF"/sites-enabled/* 2>/dev/null)
"
for f in "$CONF"/sites-available/*; do
  [ -f "$f" ] || continue
  real=$(readlink -f "$f")
  case "$enabled_real" in *"
$real
"*) continue ;; esac
  echo "@@FILE disabled $f $real"
  cat "$f"; echo
done
"#;

pub fn parse_discovery(out: &str) -> NginxState {
    let mut state = nginx::parse_discovery_with(out, "@@NOAPACHE", "Server version: ", servers);
    // Les autres serveurs web sont signalés à la page Apache comme à la page nginx.
    if out.lines().any(|l| l == "@@OTHER nginx") && !state.others.iter().any(|o| o == "nginx") {
        state.others.insert(0, "nginx".into());
    }
    state
}

pub async fn discover(conn: &Connection, sudo: Option<&str>) -> Result<NginxState> {
    let out = conn.exec(DISCOVER_SCRIPT, None).await?.into_result()?;
    let mut state = parse_discovery(&out.stdout);
    nginx::read_certificates(conn, sudo, &mut state).await?;
    Ok(state)
}

/// Active les modules nécessaires à un reverse proxy (Debian) avant d'écrire un vhost. Sur
/// RHEL, mod_proxy est chargé par défaut. Passée comme commande préalable à l'application sûre.
pub const PROXY_MODULES: &str = "command -v a2enmod >/dev/null 2>&1 && a2enmod -q proxy proxy_http proxy_wstunnel headers || true";

/// vhost HTTP en reverse proxy vers un port local, prêt à recevoir HTTPS via certbot.
pub fn proxy_vhost(domain: &str, port: u16) -> String {
    format!(
        r#"# Généré par Helm
<VirtualHost *:80>
    ServerName {domain}

    ProxyPreserveHost On
    ProxyRequests Off
    RequestHeader set X-Forwarded-Proto "http"
    ProxyPass / http://127.0.0.1:{port}/
    ProxyPassReverse / http://127.0.0.1:{port}/
    ProxyTimeout 300
    LimitRequestBody 52428800
</VirtualHost>
"#
    )
}

/// Chemins d'un nouveau site : fichier dans sites-available et lien dans sites-enabled (Debian),
/// ou fichier dans conf.d (RHEL, sans lien).
pub fn new_site_paths(conf_root: &str, domain: &str) -> (String, Option<String>) {
    if conf_root == "/etc/httpd" {
        (format!("/etc/httpd/conf.d/{domain}.conf"), None)
    } else {
        (format!("/etc/apache2/sites-available/{domain}.conf"), Some(format!("/etc/apache2/sites-enabled/{domain}.conf")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO: &str = r#"
# Site de démonstration
<VirtualHost *:80>
    ServerName demo.example.com
    ServerAlias www.demo.example.com
    RewriteEngine on
    RewriteCond %{SERVER_NAME} =demo.example.com
    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>

<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName demo.example.com:443
    DocumentRoot "/var/www/demo"
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/demo.example.com/fullchain.pem
    ProxyPass /api/ http://127.0.0.1:3000/ \
        retry=0
    ProxyPass /static/ !
    <Location /app>
        ProxyPass http://localhost:8080/app
    </Location>
    Alias /media /srv/media
</VirtualHost>
</IfModule>
"#;

    #[test]
    fn parses_virtual_hosts() {
        let s = servers(DEMO);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].server_names, vec!["demo.example.com", "www.demo.example.com"]);
        assert_eq!(s[0].listen, vec!["*:80"]);
        assert!(!s[0].ssl);
        assert!(s[0].returns.as_deref().unwrap().contains("https://"));
        assert!(s[1].ssl);
        assert_eq!(s[1].server_names, vec!["demo.example.com"]);
        assert_eq!(s[1].root.as_deref(), Some("/var/www/demo"));
        assert_eq!(s[1].ssl_certificate.as_deref(), Some("/etc/letsencrypt/live/demo.example.com/fullchain.pem"));
        assert_eq!(s[1].upstream_ports, vec![3000, 8080]);
        assert_eq!(s[1].locations.len(), 3, "ProxyPass ! ignoré, Alias gardé");
        assert_eq!(s[1].locations[1].path, "/app");
        assert_eq!(s[1].line, 12);
    }

    #[test]
    fn generated_vhost_is_understood() {
        let v = servers(&proxy_vhost("app.example.com", 8102));
        assert_eq!(v[0].server_names, vec!["app.example.com"]);
        assert_eq!(v[0].upstream_ports, vec![8102]);
        assert_eq!(new_site_paths("/etc/httpd", "a.fr").1, None);
        assert_eq!(new_site_paths("/etc/apache2", "a.fr").1.as_deref(), Some("/etc/apache2/sites-enabled/a.fr.conf"));
    }

    #[test]
    fn discovery_output() {
        let out = format!(
            "@@OTHER nginx\n@@VERSION Server version: Apache/2.4.62 (Debian)\n@@RUNNING\n@@FILE enabled /etc/apache2/sites-enabled/demo.conf /etc/apache2/sites-available/demo.conf\n{DEMO}\n@@FILE disabled /etc/apache2/sites-available/old.conf /etc/apache2/sites-available/old.conf\n<VirtualHost *:80>\nServerName old.example.com\n</VirtualHost>\n"
        );
        let st = parse_discovery(&format!("@@ROOT /etc/apache2\n{out}"));
        assert_eq!(st.conf_root, "/etc/apache2");
        assert!(st.installed && st.running);
        assert_eq!(st.version, "Apache/2.4.62 (Debian)");
        assert_eq!(st.files[0].servers.len(), 2);
        assert_eq!(st.disabled[0].servers[0].server_names, vec!["old.example.com"]);
        assert_eq!(st.others, vec!["nginx"]);
        assert!(!parse_discovery("@@NOAPACHE\n").installed);
    }

    #[test]
    fn engine_paths() {
        use nginx::Engine;
        assert!(Engine::Apache.valid_conf_path("/etc/apache2/sites-available/a.conf").is_ok());
        assert!(Engine::Apache.valid_conf_path("/etc/httpd/conf.d/a.conf").is_ok());
        assert!(Engine::Apache.valid_conf_path("/etc/nginx/sites-available/a").is_err());
        assert!(Engine::Nginx.valid_conf_path("/etc/apache2/x").is_err());
        assert!(Engine::Apache.valid_conf_path("/etc/apache2/../shadow").is_err());
    }
}
