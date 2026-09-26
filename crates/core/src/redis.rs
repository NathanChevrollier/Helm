//! Serveurs Redis / Valkey du serveur : exploration des clés, lecture des valeurs et console.
//!
//! Tout passe par `redis-cli` lancé sur le serveur (dans le conteneur, ou en local) : aucun port
//! Redis n'a besoin d'être ouvert, et le mot de passe n'apparaît jamais dans une ligne de commande
//! — il est lu dans l'environnement du conteneur (`REDIS_PASSWORD`).
//!
//! Les commandes sont écrites sur l'entrée standard de `redis-cli`, une par ligne, et l'option
//! `--no-raw` garantit qu'une réponse tient toujours sur une seule ligne : les chaînes sont citées
//! et leurs retours à la ligne échappés. C'est ce qui rend l'alignement « une commande envoyée =
//! une ligne lue » fiable, et donc la lecture par lots possible.

use serde::{Deserialize, Serialize};

use crate::db::safe_name;
use crate::{Connection, Error, Result};

/// Nombre maximal d'éléments lus dans une liste, un ensemble ou un hachage.
pub const MAX_ELEMENTS: usize = 200;

/// Serveur Redis joignable : un conteneur Docker, ou le service installé sur la machine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    /// `container:<nom>` ou `local:redis`.
    pub id: String,
    pub label: String,
    /// Conteneur Docker, ou `None` pour le service installé.
    pub container: Option<String>,
    #[serde(default)]
    pub version: String,
}

/// Est-ce une image Redis ou Valkey ?
pub fn is_redis_image(image: &str) -> bool {
    let i = image.to_ascii_lowercase();
    let name = i.rsplit('/').next().unwrap_or(&i);
    name.starts_with("redis") || name.starts_with("valkey") || name.starts_with("keydb")
}

/// Sonde des services Redis installés directement sur le serveur.
pub const LOCAL_PROBE: &str =
    "if pgrep -x redis-server >/dev/null 2>&1 || pgrep -x valkey-server >/dev/null 2>&1; then echo redis; fi\ntrue";

pub fn parse_local(out: &str) -> Vec<Server> {
    out.lines()
        .filter(|l| l.trim() == "redis")
        .map(|_| Server { id: "local:redis".into(), label: "Redis (serveur)".into(), container: None, version: String::new() })
        .collect()
}

/// Commande shell qui lance `redis-cli` en lisant ses commandes sur l'entrée standard.
fn cli(server: &Server, database: u8) -> Result<String> {
    if let Some(c) = &server.container {
        if !safe_name(c) {
            return Err(Error::Other("nom de conteneur invalide".into()));
        }
    }
    // `REDISCLI_AUTH` évite de passer le mot de passe en argument (donc dans la liste des processus).
    let inner = format!("exec redis-cli --no-raw -n {database}");
    Ok(match &server.container {
        Some(c) => format!(
            "docker exec -i -e REDISCLI_AUTH=\"${{REDIS_PASSWORD:-}}\" {c} sh -c 'REDISCLI_AUTH=\"${{REDIS_PASSWORD:-$REDISCLI_AUTH}}\"; {inner}'"
        ),
        None => inner,
    })
}

/// Envoie une série de commandes et renvoie autant de réponses qu'il y a de lignes reçues.
async fn send(conn: &Connection, sudo: Option<&str>, server: &Server, database: u8, commands: &[String]) -> Result<Vec<Reply>> {
    let input = format!("{}\n", commands.join("\n"));
    let out = conn.exec_sudo(&cli(server, database)?, sudo, Some(input.as_bytes())).await?;
    if out.stdout.trim().is_empty() && !out.success() {
        let why = out.stderr.trim();
        return Err(Error::Remote(if why.is_empty() { "redis-cli a échoué".into() } else { why.to_string() }));
    }
    Ok(parse_replies(&out.stdout))
}

/// Réponse de `redis-cli --no-raw`, telle qu'elle tient sur une ligne.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// Réponse de statut (`OK`, `string`, `none`…).
    Status(String),
    Int(i64),
    /// Chaîne, déjà déséchappée.
    Bulk(String),
    Nil,
    Error(String),
}

impl Reply {
    /// Texte affichable de la réponse.
    pub fn text(&self) -> String {
        match self {
            Reply::Status(s) => s.clone(),
            Reply::Int(i) => i.to_string(),
            Reply::Bulk(s) => s.clone(),
            Reply::Nil => String::new(),
            Reply::Error(e) => e.clone(),
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Reply::Int(i) => Some(*i),
            Reply::Bulk(s) | Reply::Status(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    /// L'erreur du serveur, s'il y en a une.
    pub fn error(&self) -> Option<&str> {
        match self {
            Reply::Error(e) => Some(e),
            _ => None,
        }
    }
}

/// Une ligne de sortie de `redis-cli --no-raw` par réponse. Les lignes vides sont conservées :
/// elles comptent comme réponse (élément vide d'une liste), sinon l'alignement se décale.
pub fn parse_replies(out: &str) -> Vec<Reply> {
    out.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !l.is_empty()).map(parse_reply).collect()
}

fn parse_reply(line: &str) -> Reply {
    let l = line.trim_end();
    if let Some(rest) = l.strip_prefix("(integer) ") {
        return rest.trim().parse().map(Reply::Int).unwrap_or_else(|_| Reply::Status(l.into()));
    }
    if l == "(nil)" || l == "(empty array)" || l == "(empty list or set)" {
        return Reply::Nil;
    }
    if let Some(rest) = l.strip_prefix("(error) ") {
        return Reply::Error(rest.to_string());
    }
    if l.starts_with("ERR ") || l.starts_with("NOAUTH") || l.starts_with("WRONGTYPE") {
        return Reply::Error(l.to_string());
    }
    if l.len() >= 2 && l.starts_with('"') && l.ends_with('"') {
        return Reply::Bulk(unquote(&l[1..l.len() - 1]));
    }
    Reply::Status(l.to_string())
}

/// Argument cité à la façon de `redis-cli` : guillemets doubles, échappements `\xHH` pour tout ce
/// qui n'est pas imprimable. Un argument ne peut donc jamais introduire une seconde commande.
pub fn quote_arg(arg: &str) -> String {
    let mut s = String::with_capacity(arg.len() + 2);
    s.push('"');
    for b in arg.bytes() {
        match b {
            b'"' => s.push_str("\\\""),
            b'\\' => s.push_str("\\\\"),
            b'\n' => s.push_str("\\n"),
            b'\r' => s.push_str("\\r"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(b as char),
            other => s.push_str(&format!("\\x{other:02x}")),
        }
    }
    s.push('"');
    s
}

/// Inverse de [`quote_arg`] : ce que `redis-cli --no-raw` a écrit entre guillemets.
pub fn unquote(body: &str) -> String {
    let mut out = Vec::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        match bytes[i + 1] {
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'a' => out.push(0x07),
            b'b' => out.push(0x08),
            b'x' if i + 3 < bytes.len() => match u8::from_str_radix(&body[i + 2..i + 4], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 4;
                    continue;
                }
                Err(_) => out.push(b'x'),
            },
            other => out.push(other),
        }
        i += 2;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Clé listée dans l'explorateur.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub key: String,
    /// `string`, `hash`, `list`, `set`, `zset`, `stream`.
    pub kind: String,
    /// Durée de vie restante en secondes ; `None` si la clé n'expire pas.
    pub ttl: Option<i64>,
    /// Mémoire occupée en octets, telle que l'estime `MEMORY USAGE` (0 si indisponible).
    pub size: u64,
}

/// Page de clés renvoyée par un `SCAN`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyPage {
    pub keys: Vec<KeyInfo>,
    /// Curseur à passer au prochain appel ; `"0"` quand le parcours est terminé.
    pub cursor: String,
}

/// Parcourt les clés par pages. `SCAN` ne bloque jamais le serveur, contrairement à `KEYS *`, ce qui
/// rend l'explorateur utilisable sur une base de plusieurs millions de clés.
pub async fn scan(
    conn: &Connection,
    sudo: Option<&str>,
    server: &Server,
    database: u8,
    cursor: &str,
    pattern: &str,
    count: usize,
) -> Result<KeyPage> {
    if !cursor.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::Other("curseur invalide".into()));
    }
    let pattern = if pattern.trim().is_empty() { "*" } else { pattern };
    let count = count.clamp(10, 1000);
    let replies = send(conn, sudo, server, database, &[format!("SCAN {cursor} MATCH {} COUNT {count}", quote_arg(pattern))]).await?;
    if let Some(e) = replies.iter().find_map(Reply::error) {
        return Err(Error::Remote(e.to_string()));
    }
    let mut it = replies.into_iter();
    let next = it.next().map(|r| r.text()).unwrap_or_else(|| "0".into());
    let keys: Vec<String> = it.map(|r| r.text()).filter(|k| !k.is_empty()).collect();
    if keys.is_empty() {
        return Ok(KeyPage { keys: Vec::new(), cursor: next });
    }
    // Les métadonnées partent en un seul aller-retour : une commande par clé, une réponse par ligne.
    let mut batch = Vec::with_capacity(keys.len() * 3);
    for k in &keys {
        batch.push(format!("TYPE {}", quote_arg(k)));
    }
    for k in &keys {
        batch.push(format!("TTL {}", quote_arg(k)));
    }
    for k in &keys {
        batch.push(format!("MEMORY USAGE {}", quote_arg(k)));
    }
    let meta = send(conn, sudo, server, database, &batch).await?;
    let n = keys.len();
    let at = |i: usize| meta.get(i).cloned().unwrap_or(Reply::Nil);
    Ok(KeyPage {
        keys: keys
            .into_iter()
            .enumerate()
            .map(|(i, key)| {
                let ttl = at(n + i).as_int().unwrap_or(-1);
                KeyInfo { key, kind: at(i).text(), ttl: (ttl >= 0).then_some(ttl), size: at(2 * n + i).as_int().unwrap_or(0).max(0) as u64 }
            })
            .collect(),
        cursor: next,
    })
}

/// Contenu d'une clé, quel que soit son type.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub kind: String,
    pub ttl: Option<i64>,
    /// Éléments : `(champ, valeur)` pour un hachage ou un ensemble trié, `(None, valeur)` sinon.
    pub entries: Vec<(Option<String>, String)>,
    /// Nombre total d'éléments de la clé, même au-delà de ceux renvoyés.
    pub total: u64,
    /// Vrai si la lecture s'est arrêtée à [`MAX_ELEMENTS`].
    pub truncated: bool,
}

/// Lit une clé : son type, sa durée de vie et son contenu (borné à [`MAX_ELEMENTS`] éléments).
pub async fn key_value(conn: &Connection, sudo: Option<&str>, server: &Server, database: u8, key: &str) -> Result<KeyValue> {
    let q = quote_arg(key);
    let head = send(conn, sudo, server, database, &[format!("TYPE {q}"), format!("TTL {q}")]).await?;
    let kind = head.first().map(Reply::text).unwrap_or_default();
    let ttl = head.get(1).and_then(Reply::as_int).unwrap_or(-1);
    let ttl = (ttl >= 0).then_some(ttl);
    if kind == "none" {
        return Err(Error::Other(format!("la clé « {key} » n'existe pas")));
    }
    let last = MAX_ELEMENTS - 1;
    let (count_cmd, read_cmd) = match kind.as_str() {
        "string" => (format!("STRLEN {q}"), format!("GET {q}")),
        "list" => (format!("LLEN {q}"), format!("LRANGE {q} 0 {last}")),
        "set" => (format!("SCARD {q}"), format!("SRANDMEMBER {q} {MAX_ELEMENTS}")),
        "zset" => (format!("ZCARD {q}"), format!("ZRANGE {q} 0 {last} WITHSCORES")),
        "hash" => (format!("HLEN {q}"), format!("HGETALL {q}")),
        "stream" => (format!("XLEN {q}"), format!("XRANGE {q} - + COUNT {MAX_ELEMENTS}")),
        other => return Err(Error::Other(format!("type de clé non géré : {other}"))),
    };
    let body = send(conn, sudo, server, database, &[count_cmd, read_cmd]).await?;
    if let Some(e) = body.iter().find_map(Reply::error) {
        return Err(Error::Remote(e.to_string()));
    }
    let total = body.first().and_then(Reply::as_int).unwrap_or(0).max(0) as u64;
    let values: Vec<String> = body.into_iter().skip(1).map(|r| r.text()).collect();
    // Un hachage et un ensemble trié arrivent à plat : champ, valeur, champ, valeur…
    let paired = kind == "hash" || kind == "zset";
    let entries: Vec<(Option<String>, String)> = if paired {
        values.chunks(2).map(|p| (Some(p[0].clone()), p.get(1).cloned().unwrap_or_default())).collect()
    } else {
        values.into_iter().map(|v| (None, v)).collect()
    };
    let truncated = entries.len() >= MAX_ELEMENTS && kind != "string";
    Ok(KeyValue { key: key.to_string(), kind, ttl, entries, total, truncated })
}

/// Supprime des clés et renvoie le nombre réellement supprimé.
pub async fn delete(conn: &Connection, sudo: Option<&str>, server: &Server, database: u8, keys: &[String]) -> Result<i64> {
    if keys.is_empty() {
        return Err(Error::Other("aucune clé à supprimer".into()));
    }
    let args = keys.iter().map(|k| quote_arg(k)).collect::<Vec<_>>().join(" ");
    let replies = send(conn, sudo, server, database, &[format!("DEL {args}")]).await?;
    if let Some(e) = replies.iter().find_map(Reply::error) {
        return Err(Error::Remote(e.to_string()));
    }
    Ok(replies.first().and_then(Reply::as_int).unwrap_or(0))
}

/// Écrit une clé de type chaîne, en conservant ou en remplaçant sa durée de vie.
pub async fn set_string(
    conn: &Connection,
    sudo: Option<&str>,
    server: &Server,
    database: u8,
    key: &str,
    value: &str,
    ttl: Option<i64>,
) -> Result<()> {
    let mut cmd = format!("SET {} {}", quote_arg(key), quote_arg(value));
    match ttl {
        // `KEEPTTL` évite qu'une simple correction de valeur rende la clé éternelle.
        None => cmd.push_str(" KEEPTTL"),
        Some(s) if s > 0 => cmd.push_str(&format!(" EX {s}")),
        Some(_) => {}
    }
    let replies = send(conn, sudo, server, database, &[cmd]).await?;
    match replies.iter().find_map(Reply::error) {
        Some(e) => Err(Error::Remote(e.to_string())),
        None => Ok(()),
    }
}

/// Change la durée de vie d'une clé. `None` la rend éternelle (`PERSIST`).
pub async fn expire(conn: &Connection, sudo: Option<&str>, server: &Server, database: u8, key: &str, ttl: Option<i64>) -> Result<()> {
    let q = quote_arg(key);
    let cmd = match ttl {
        Some(s) if s > 0 => format!("EXPIRE {q} {s}"),
        _ => format!("PERSIST {q}"),
    };
    let replies = send(conn, sudo, server, database, &[cmd]).await?;
    match replies.iter().find_map(Reply::error) {
        Some(e) => Err(Error::Remote(e.to_string())),
        None => Ok(()),
    }
}

/// Commandes refusées par la console : elles bloquent le serveur ou détruisent tout, et rien dans
/// l'interface de Helm n'en a besoin. La liste est volontairement courte et explicite.
pub const BLOCKED: &[&str] = &["FLUSHALL", "FLUSHDB", "SHUTDOWN", "DEBUG", "MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "BLPOP", "BRPOP", "WAIT"];

/// Exécute une commande écrite par l'utilisateur dans la console et renvoie les lignes de réponse.
/// Une seule commande à la fois : un retour à la ligne est refusé plutôt que découpé.
pub async fn command(conn: &Connection, sudo: Option<&str>, server: &Server, database: u8, raw: &str) -> Result<Vec<String>> {
    let line = raw.trim();
    if line.is_empty() {
        return Err(Error::Other("commande vide".into()));
    }
    if line.contains('\n') || line.contains('\r') {
        return Err(Error::Other("une seule commande à la fois".into()));
    }
    let verb = line.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    if BLOCKED.contains(&verb.as_str()) {
        return Err(Error::Other(format!("commande refusée par Helm : {verb}")));
    }
    let replies = send(conn, sudo, server, database, &[line.to_string()]).await?;
    Ok(replies.iter().map(Reply::text).collect())
}

/// Résumé d'un serveur : version, nombre de clés par base, mémoire utilisée.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub version: String,
    /// Mémoire utilisée, telle que la rapporte `INFO` (`used_memory`).
    pub memory: u64,
    /// Nombre de clés par numéro de base, pour les bases non vides.
    pub databases: Vec<(u8, u64)>,
    pub uptime_days: u64,
}

/// Lit `INFO server`, `INFO memory` et `INFO keyspace` en un seul aller-retour.
pub async fn overview(conn: &Connection, sudo: Option<&str>, server: &Server) -> Result<Overview> {
    let out = send(conn, sudo, server, 0, &["INFO".to_string()]).await?;
    Ok(parse_info(&out.iter().map(Reply::text).collect::<Vec<_>>().join("\n")))
}

/// Champs utiles de `INFO`. Les lignes inconnues et les sections sont ignorées.
pub fn parse_info(text: &str) -> Overview {
    let mut o = Overview::default();
    for line in text.lines() {
        let line = line.trim();
        let Some((k, v)) = line.split_once(':') else { continue };
        match k {
            "redis_version" | "valkey_version" => o.version = v.trim().to_string(),
            "used_memory" => o.memory = v.trim().parse().unwrap_or(0),
            "uptime_in_days" => o.uptime_days = v.trim().parse().unwrap_or(0),
            _ if k.starts_with("db") => {
                if let (Ok(n), Some(keys)) = (k[2..].parse::<u8>(), v.split(',').next()) {
                    let count = keys.strip_prefix("keys=").unwrap_or("0").parse().unwrap_or(0);
                    o.databases.push((n, count));
                }
            }
            _ => {}
        }
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(name: &str) -> Server {
        Server { id: format!("container:{name}"), label: name.into(), container: Some(name.into()), version: String::new() }
    }

    #[test]
    fn images_are_recognised() {
        assert!(is_redis_image("redis:7-alpine"));
        assert!(is_redis_image("docker.io/valkey/valkey:8"));
        assert!(!is_redis_image("postgres:16"));
    }

    #[test]
    fn cli_never_carries_a_password_as_argument() {
        let cmd = cli(&container("cache"), 3).unwrap();
        assert!(cmd.contains("docker exec -i") && cmd.contains("REDISCLI_AUTH"));
        assert!(cmd.contains("redis-cli --no-raw -n 3"));
        assert!(!cmd.contains("-a "), "jamais de mot de passe en argument");
        assert!(cli(&container("bad; rm -rf /"), 0).is_err());
    }

    #[test]
    fn arguments_cannot_escape_their_line() {
        assert_eq!(quote_arg("simple"), "\"simple\"");
        assert_eq!(quote_arg("a\nb"), "\"a\\nb\"", "un retour à la ligne ne coupe pas la commande");
        assert_eq!(quote_arg("gui\"llemet"), "\"gui\\\"llemet\"");
        assert_eq!(quote_arg("\u{1}"), "\"\\x01\"");
        // Aller-retour : ce que redis-cli écrit, Helm sait le relire.
        for s in ["simple", "a\nb", "gui\"llemet", "back\\slash", "accentué"] {
            let quoted = quote_arg(s);
            assert_eq!(unquote(&quoted[1..quoted.len() - 1]), s, "{s}");
        }
    }

    #[test]
    fn replies_are_typed() {
        let r = parse_replies("(integer) 42\n\"texte\"\n(nil)\nOK\n(error) WRONGTYPE bad\n");
        assert_eq!(
            r,
            vec![Reply::Int(42), Reply::Bulk("texte".into()), Reply::Nil, Reply::Status("OK".into()), Reply::Error("WRONGTYPE bad".into())]
        );
        assert_eq!(r[0].as_int(), Some(42));
        assert_eq!(r[4].error(), Some("WRONGTYPE bad"));
    }

    #[test]
    fn info_is_summarised() {
        let o = parse_info(
            "# Server\nredis_version:7.2.4\nuptime_in_days:12\n# Memory\nused_memory:1048576\n# Keyspace\ndb0:keys=1234,expires=3,avg_ttl=0\ndb1:keys=7,expires=0\n",
        );
        assert_eq!(o.version, "7.2.4");
        assert_eq!(o.memory, 1048576);
        assert_eq!(o.uptime_days, 12);
        assert_eq!(o.databases, vec![(0, 1234), (1, 7)]);
    }

    #[test]
    fn local_services() {
        assert_eq!(parse_local("redis\n").len(), 1);
        assert!(parse_local("").is_empty());
    }
}
