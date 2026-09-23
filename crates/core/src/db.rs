//! Bases de données MySQL/MariaDB et PostgreSQL du serveur : découverte, exploration et
//! exécution de SQL, en passant par les clients en ligne de commande (`mysql`, `psql`).
//!
//! Le SQL est transmis sur l'entrée standard et les mots de passe ne sont jamais écrits dans une
//! ligne de commande : pour un conteneur, ils sont lus dans son propre environnement
//! (`MYSQL_ROOT_PASSWORD`, `POSTGRES_USER`) ; en local, l'authentification passe par le socket
//! (`sudo mysql`, `sudo -u postgres psql`).

use serde::{Deserialize, Serialize};

use crate::{Connection, Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    /// MySQL, MariaDB ou Percona.
    Mysql,
    Postgres,
}

impl Engine {
    pub fn label(self) -> &'static str {
        match self {
            Engine::Mysql => "MySQL / MariaDB",
            Engine::Postgres => "PostgreSQL",
        }
    }

    /// Moteur correspondant à une image Docker, le cas échéant.
    pub fn from_image(image: &str) -> Option<Engine> {
        let i = image.to_ascii_lowercase();
        let name = i.rsplit('/').next().unwrap_or(&i);
        if name.starts_with("mysql") || name.starts_with("mariadb") || name.starts_with("percona") {
            Some(Engine::Mysql)
        } else if name.starts_with("postgres")
            || name.starts_with("timescale")
            || name.starts_with("pgvector")
            || name.starts_with("supabase/postgres")
        {
            Some(Engine::Postgres)
        } else {
            None
        }
    }
}

/// Instance de base de données : un conteneur Docker, ou le service installé sur le serveur.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    /// `container:<nom>` ou `local:mysql` / `local:postgres`.
    pub id: String,
    pub label: String,
    pub engine: Engine,
    /// Conteneur Docker, ou `None` pour le service installé sur le serveur.
    pub container: Option<String>,
    /// Version rapportée par le serveur de base de données.
    #[serde(default)]
    pub version: String,
}

/// Nom d'objet SQL acceptable dans une commande (base, table) : pas d'injection possible.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '$')
}

fn check(instance: &Instance, database: Option<&str>) -> Result<()> {
    if let Some(c) = &instance.container {
        if !safe_name(c) {
            return Err(Error::Other("nom de conteneur invalide".into()));
        }
    }
    if let Some(d) = database {
        if !safe_name(d) {
            return Err(Error::Other(format!("nom de base invalide : {d}")));
        }
    }
    Ok(())
}

/// Commande shell qui lit le SQL sur son entrée standard et écrit le résultat sur stdout.
/// MySQL sort en mode « batch » (tabulations, valeurs échappées), PostgreSQL en CSV.
fn client_command(instance: &Instance, database: Option<&str>, limit: Option<usize>) -> Result<String> {
    check(instance, database)?;
    let mut cmd = match (instance.engine, &instance.container) {
        (Engine::Mysql, Some(c)) => format!(
            "docker exec -i {c} sh -c 'C=$(command -v mysql || command -v mariadb); exec \"$C\" --batch --raw --unbuffered -uroot -p\"${{MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}}\" {}'",
            database.unwrap_or("")
        ),
        (Engine::Mysql, None) => {
            format!("C=$(command -v mysql || command -v mariadb); \"$C\" --batch --raw --unbuffered {}", database.unwrap_or(""))
        }
        (Engine::Postgres, Some(c)) => format!(
            "docker exec -i {c} sh -c 'exec psql -U \"${{POSTGRES_USER:-postgres}}\" -d {} --csv -q -v ON_ERROR_STOP=1'",
            database.unwrap_or("postgres")
        ),
        (Engine::Postgres, None) => {
            format!("su -s /bin/sh postgres -c 'psql -d {} --csv -q -v ON_ERROR_STOP=1'", database.unwrap_or("postgres"))
        }
    };
    if let Some(n) = limit {
        // Une ligne de plus que demandé : elle signale un résultat tronqué.
        cmd = format!("{{ {cmd} ; }} | head -n {}", n + 2);
    }
    Ok(cmd)
}

/// Exécute du SQL sur l'instance et renvoie la sortie brute du client.
async fn run_sql(
    conn: &Connection,
    sudo: Option<&str>,
    instance: &Instance,
    database: Option<&str>,
    sql: &str,
    limit: Option<usize>,
) -> Result<String> {
    let cmd = client_command(instance, database, limit)?;
    let input = format!("{}\n", sql.trim_end().trim_end_matches(';'));
    // Le service local n'est joignable qu'en root (socket) ; un conteneur passe par Docker, qui
    // peut lui aussi demander sudo.
    let out = conn.exec_sudo(&cmd, sudo, Some(input.as_bytes())).await?;
    // Avec la limite de lignes, la commande se termine par `head` : son code de sortie masque
    // celui du client. L'erreur se lit donc dans stderr, une fois les avertissements écartés.
    let problem = real_errors(&out.stderr);
    if !problem.is_empty() && out.stdout.trim().is_empty() {
        return Err(Error::Remote(problem));
    }
    if !out.success() && out.stdout.trim().is_empty() {
        return Err(Error::Remote(if problem.is_empty() { "la requête a échoué".into() } else { problem }));
    }
    Ok(out.stdout)
}

/// Erreurs du client, sans ses avertissements habituels (mot de passe sur la ligne de commande…).
pub fn real_errors(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.contains("[Warning]") && !l.contains("Using a password on the command line"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// Lignes de valeurs ; `None` représente NULL.
    pub rows: Vec<Vec<Option<String>>>,
    /// Vrai si la limite d'affichage a coupé le résultat.
    pub truncated: bool,
    /// Durée d'exécution mesurée par Helm (aller-retour SSH compris), en millisecondes.
    pub duration_ms: u64,
}

/// Sortie « batch » de mysql : en-tête puis lignes, séparées par des tabulations.
/// Les valeurs échappent `\t`, `\n` et `\\`, et NULL s'écrit `NULL`.
pub fn parse_mysql(out: &str) -> QueryResult {
    let mut lines = out.split('\n').filter(|l| !l.is_empty());
    let Some(header) = lines.next() else { return QueryResult::default() };
    let unescape = |v: &str| {
        if v == "NULL" {
            return None;
        }
        let mut s = String::with_capacity(v.len());
        let mut chars = v.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                s.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => s.push('\n'),
                Some('t') => s.push('\t'),
                Some('r') => s.push('\r'),
                Some('0') => s.push('\0'),
                Some(other) => s.push(other),
                None => s.push('\\'),
            }
        }
        Some(s)
    };
    QueryResult {
        columns: header.split('\t').map(str::to_string).collect(),
        rows: lines.map(|l| l.split('\t').map(unescape).collect()).collect(),
        truncated: false,
        duration_ms: 0,
    }
}

/// Sortie CSV de psql (`--csv`) : guillemets doublés, valeur vide non citée = NULL.
pub fn parse_csv(out: &str) -> QueryResult {
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let (mut row, mut field, mut quoted, mut was_quoted) = (Vec::new(), String::new(), false, false);
    let mut chars = out.chars().peekable();
    let end_field = |row: &mut Vec<Option<String>>, field: &mut String, was_quoted: &mut bool| {
        row.push(if field.is_empty() && !*was_quoted { None } else { Some(std::mem::take(field)) });
        *was_quoted = false;
    };
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                was_quoted = true;
            }
            ',' => end_field(&mut row, &mut field, &mut was_quoted),
            '\r' => {}
            '\n' => {
                end_field(&mut row, &mut field, &mut was_quoted);
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        end_field(&mut row, &mut field, &mut was_quoted);
        rows.push(row);
    }
    if rows.is_empty() {
        return QueryResult::default();
    }
    let columns = rows.remove(0).into_iter().map(|c| c.unwrap_or_default()).collect();
    QueryResult { columns, rows, truncated: false, duration_ms: 0 }
}

fn parse(engine: Engine, out: &str) -> QueryResult {
    match engine {
        Engine::Mysql => parse_mysql(out),
        Engine::Postgres => parse_csv(out),
    }
}

/// Première instruction SQL : `SELECT`, `INSERT`… en majuscules, commentaires ignorés.
pub fn first_keyword(sql: &str) -> String {
    let mut text = sql.trim_start();
    loop {
        if let Some(rest) = text.strip_prefix("--") {
            text = rest.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(rest) = text.strip_prefix("/*") {
            text = rest.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ';').find(|w| !w.is_empty()).unwrap_or("").to_ascii_uppercase()
}

/// Une requête qui ne fait que lire ? Les autres demandent confirmation dans l'interface.
pub fn is_read_only(sql: &str) -> bool {
    matches!(first_keyword(sql).as_str(), "SELECT" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "WITH" | "TABLE" | "VALUES" | "ANALYZE")
}

/// Exécute une requête libre et renvoie ses lignes (au plus `limit`).
pub async fn query(
    conn: &Connection,
    sudo: Option<&str>,
    instance: &Instance,
    database: Option<&str>,
    sql: &str,
    limit: usize,
) -> Result<QueryResult> {
    if sql.trim().is_empty() {
        return Err(Error::Other("requête vide".into()));
    }
    let started = std::time::Instant::now();
    let out = crate::ssh::long(run_sql(conn, sudo, instance, database, sql, Some(limit))).await?;
    let mut result = parse(instance.engine, &out);
    if result.rows.len() > limit {
        result.rows.truncate(limit);
        result.truncated = true;
    }
    result.duration_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

const MYSQL_DATABASES: &str = "SELECT s.schema_name AS nom, \
     COALESCE(SUM(t.data_length + t.index_length), 0) AS taille, \
     COUNT(t.table_name) AS tables \
     FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name \
     GROUP BY s.schema_name ORDER BY s.schema_name";

const PG_DATABASES: &str = "SELECT datname AS nom, pg_database_size(datname) AS taille, 0 AS tables \
     FROM pg_database WHERE NOT datistemplate ORDER BY datname";

const MYSQL_TABLES: &str = "SELECT table_name AS nom, COALESCE(table_rows, 0) AS lignes, \
     COALESCE(data_length + index_length, 0) AS taille FROM information_schema.tables \
     WHERE table_schema = DATABASE() ORDER BY table_name";

const PG_TABLES: &str = "SELECT c.relname AS nom, COALESCE(s.n_live_tup, 0) AS lignes, \
     pg_total_relation_size(c.oid) AS taille \
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY c.relname";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub name: String,
    /// Taille sur disque en octets (estimation du moteur).
    pub size: u64,
    /// Nombre de tables (base) ou de lignes (table), estimé.
    pub count: u64,
}

fn to_named(r: &QueryResult) -> Vec<Named> {
    r.rows
        .iter()
        .filter_map(|row| {
            let get = |i: usize| row.get(i).cloned().flatten().unwrap_or_default();
            let name = get(0);
            (!name.is_empty()).then(|| Named { name, size: get(1).parse().unwrap_or(0), count: get(2).parse().unwrap_or(0) })
        })
        .collect()
}

/// Nom de base acceptable : lettres, chiffres, tiret bas et tiret. Tout le reste est refusé plutôt
/// qu'échappé, car un nom de base ne peut pas être passé en paramètre lié.
pub fn valid_db_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 63 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Crée une base vide. L'encodage est fixé à UTF-8 pour éviter les surprises d'un serveur ancien.
pub async fn create_database(conn: &Connection, sudo: Option<&str>, instance: &Instance, name: &str) -> Result<()> {
    if !valid_db_name(name) {
        return Err(Error::Other("nom de base invalide : lettres, chiffres, « _ » et « - » seulement".into()));
    }
    let sql = match instance.engine {
        Engine::Mysql => format!("CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"),
        Engine::Postgres => format!("CREATE DATABASE \"{name}\" ENCODING 'UTF8'"),
    };
    let out = run_sql(conn, sudo, instance, None, &sql, None).await?;
    let lower = out.to_lowercase();
    if lower.contains("error") || lower.contains("échec") {
        return Err(Error::Other(out.trim().to_string()));
    }
    Ok(())
}

/// Bases de l'instance, avec leur taille.
pub async fn databases(conn: &Connection, sudo: Option<&str>, instance: &Instance) -> Result<Vec<Named>> {
    let sql = match instance.engine {
        Engine::Mysql => MYSQL_DATABASES,
        Engine::Postgres => PG_DATABASES,
    };
    let out = run_sql(conn, sudo, instance, None, sql, Some(500)).await?;
    Ok(to_named(&parse(instance.engine, &out)))
}

/// Tables d'une base, avec leur taille et un nombre de lignes estimé.
pub async fn tables(conn: &Connection, sudo: Option<&str>, instance: &Instance, database: &str) -> Result<Vec<Named>> {
    let sql = match instance.engine {
        Engine::Mysql => MYSQL_TABLES,
        Engine::Postgres => PG_TABLES,
    };
    let out = run_sql(conn, sudo, instance, Some(database), sql, Some(2000)).await?;
    Ok(to_named(&parse(instance.engine, &out)))
}

/// Requête d'aperçu du contenu d'une table (identifiant vérifié, jamais concaténé sans contrôle).
pub fn preview_query(engine: Engine, table: &str, limit: usize) -> Result<String> {
    if !safe_name(table) {
        return Err(Error::Other("nom de table invalide".into()));
    }
    Ok(match engine {
        Engine::Mysql => format!("SELECT * FROM `{table}` LIMIT {limit}"),
        Engine::Postgres => format!("SELECT * FROM \"{table}\" LIMIT {limit}"),
    })
}

/// Version du serveur de base de données, pour l'affichage.
pub async fn version(conn: &Connection, sudo: Option<&str>, instance: &Instance) -> String {
    let sql = match instance.engine {
        Engine::Mysql => "SELECT VERSION()",
        Engine::Postgres => "SHOW server_version",
    };
    match run_sql(conn, sudo, instance, None, sql, Some(2)).await {
        Ok(out) => parse(instance.engine, &out).rows.first().and_then(|r| r.first().cloned()).flatten().unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Instances installées directement sur le serveur (hors Docker).
pub const LOCAL_PROBE: &str = "if pgrep -x mysqld >/dev/null 2>&1 || pgrep -x mariadbd >/dev/null 2>&1; then echo mysql; fi\n\
     if pgrep -x postgres >/dev/null 2>&1; then echo postgres; fi\n\
     true";

pub fn parse_local(out: &str) -> Vec<Instance> {
    out.lines()
        .filter_map(|l| match l.trim() {
            "mysql" => Some(Instance {
                id: "local:mysql".into(),
                label: "MySQL / MariaDB (serveur)".into(),
                engine: Engine::Mysql,
                container: None,
                version: String::new(),
            }),
            "postgres" => Some(Instance {
                id: "local:postgres".into(),
                label: "PostgreSQL (serveur)".into(),
                engine: Engine::Postgres,
                container: None,
                version: String::new(),
            }),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(engine: Engine, name: &str) -> Instance {
        Instance { id: format!("container:{name}"), label: name.into(), engine, container: Some(name.into()), version: String::new() }
    }

    #[test]
    fn engines_from_images() {
        assert_eq!(Engine::from_image("mariadb:11"), Some(Engine::Mysql));
        assert_eq!(Engine::from_image("docker.io/library/postgres:16-alpine"), Some(Engine::Postgres));
        assert_eq!(Engine::from_image("ghcr.io/moi/mysql-backup"), Some(Engine::Mysql));
        assert_eq!(Engine::from_image("nginx:alpine"), None);
    }

    #[test]
    fn commands_are_safe() {
        let cmd = client_command(&container(Engine::Mysql, "nexus-mysql"), Some("app"), Some(100)).unwrap();
        assert!(cmd.contains("docker exec -i nexus-mysql") && cmd.contains("MYSQL_ROOT_PASSWORD"));
        assert!(cmd.ends_with("| head -n 102"));
        assert!(!cmd.contains("-p'"), "aucun mot de passe en clair dans la commande");
        let pg = client_command(&container(Engine::Postgres, "pg"), Some("app"), None).unwrap();
        assert!(pg.contains("psql -U \"${POSTGRES_USER:-postgres}\" -d app --csv"));
        assert!(client_command(&container(Engine::Mysql, "db; rm -rf /"), None, None).is_err());
        assert!(client_command(&container(Engine::Mysql, "db"), Some("app; DROP"), None).is_err());
    }

    #[test]
    fn mysql_output() {
        let r = parse_mysql("id\tnom\tnote\n1\tAlice\tdeux\\nlignes\n2\tNULL\tavec\\ttab\n");
        assert_eq!(r.columns, ["id", "nom", "note"]);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[0][2], Some("deux\nlignes".into()));
        assert_eq!(r.rows[1][1], None, "NULL");
        assert_eq!(r.rows[1][2], Some("avec\ttab".into()));
    }

    #[test]
    fn csv_output() {
        let r = parse_csv("id,nom,note\n1,\"Alice, dite \"\"Al\"\"\",\n2,Bob,\"deux\nlignes\"\n");
        assert_eq!(r.columns, ["id", "nom", "note"]);
        assert_eq!(r.rows[0][1], Some("Alice, dite \"Al\"".into()));
        assert_eq!(r.rows[0][2], None, "champ vide non cité = NULL");
        assert_eq!(r.rows[1][2], Some("deux\nlignes".into()));
    }

    #[test]
    fn read_only_detection() {
        assert!(is_read_only("  -- commentaire\n SELECT 1"));
        assert!(is_read_only("/* x */ with a as (select 1) select * from a"));
        assert!(!is_read_only("DELETE FROM users"));
        assert!(!is_read_only("update t set a=1"));
        assert_eq!(first_keyword("INSERT INTO t VALUES (1)"), "INSERT");
        assert!(preview_query(Engine::Mysql, "users", 100).unwrap().contains("`users`"));
        assert!(preview_query(Engine::Postgres, "users; DROP TABLE x", 10).is_err());
    }

    #[test]
    fn warnings_are_not_errors() {
        assert_eq!(
            real_errors(
                "mysql: [Warning] Using a password on the command line interface can be insecure.
"
            ),
            ""
        );
        assert_eq!(
            real_errors(
                "ERROR 1064 (42000) at line 1: You have an error
"
            ),
            "ERROR 1064 (42000) at line 1: You have an error"
        );
    }

    #[test]
    fn local_instances() {
        let l = parse_local("mysql\npostgres\n");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].engine, Engine::Mysql);
        assert!(l[1].container.is_none());
    }
}
