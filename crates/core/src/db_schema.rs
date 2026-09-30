//! Structure des bases sans écrire de SQL : créer, renommer, vider ou supprimer une table, ajouter,
//! renommer ou supprimer une colonne, supprimer une base.
//!
//! Chaque opération produit ici son SQL, que l'interface montre avant de l'exécuter (par
//! `db_query`, qui l'inscrit au journal). Les noms sont validés (jamais échappés « au mieux »), les
//! types viennent d'une liste fermée par moteur, et les valeurs par défaut sont citées.

use serde::{Deserialize, Serialize};

use crate::db::{quote_ident, quote_literal, valid_db_name, Engine};
use crate::{Error, Result};

/// Types proposés dans l'interface, par moteur. Tout autre type est refusé.
pub fn column_types(engine: Engine) -> &'static [&'static str] {
    match engine {
        Engine::Mysql => &[
            "INT",
            "BIGINT",
            "SMALLINT",
            "TINYINT",
            "DECIMAL",
            "FLOAT",
            "DOUBLE",
            "VARCHAR",
            "CHAR",
            "TEXT",
            "MEDIUMTEXT",
            "LONGTEXT",
            "BOOLEAN",
            "DATE",
            "DATETIME",
            "TIMESTAMP",
            "TIME",
            "JSON",
            "BLOB",
        ],
        Engine::Postgres => &[
            "INTEGER",
            "BIGINT",
            "SMALLINT",
            "NUMERIC",
            "REAL",
            "DOUBLE PRECISION",
            "VARCHAR",
            "CHAR",
            "TEXT",
            "BOOLEAN",
            "DATE",
            "TIMESTAMP",
            "TIMESTAMPTZ",
            "TIME",
            "JSONB",
            "JSON",
            "UUID",
            "BYTEA",
        ],
        Engine::Sqlite => &["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
    }
}

/// Types qui acceptent une longueur ou une précision (`VARCHAR(255)`, `DECIMAL(10,2)`).
fn takes_length(data_type: &str) -> bool {
    matches!(data_type, "VARCHAR" | "CHAR" | "DECIMAL" | "NUMERIC")
}

/// Mots-clés acceptés tels quels comme valeur par défaut.
const DEFAULT_KEYWORDS: &[&str] = &["NULL", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME", "TRUE", "FALSE"];

/// Colonne décrite dans l'interface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    /// `255`, ou `10,2` pour un décimal ; vide : pas de longueur.
    #[serde(default)]
    pub length: String,
    #[serde(default)]
    pub nullable: bool,
    /// Vide : pas de valeur par défaut. Nombre ou mot-clé tel quel, sinon texte cité.
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub auto_increment: bool,
}

/// Opération de structure demandée par l'interface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SchemaOp {
    CreateTable { table: String, columns: Vec<ColumnDef> },
    DropTable { table: String },
    TruncateTable { table: String },
    RenameTable { table: String, to: String },
    AddColumn { table: String, column: ColumnDef },
    DropColumn { table: String, column: String },
    RenameColumn { table: String, column: String, to: String },
    DropDatabase { database: String },
}

fn column_type(engine: Engine, c: &ColumnDef) -> Result<String> {
    let t = c.data_type.trim().to_ascii_uppercase();
    if !column_types(engine).contains(&t.as_str()) {
        return Err(Error::Other(format!("type non proposé pour ce moteur : {}", c.data_type)));
    }
    let len = c.length.trim().replace(' ', "");
    if len.is_empty() {
        // MySQL exige une longueur pour VARCHAR.
        return Ok(if engine == Engine::Mysql && t == "VARCHAR" { "VARCHAR(255)".into() } else { t });
    }
    let parts: Vec<&str> = len.split(',').collect();
    let ok = takes_length(&t)
        && (1..=2).contains(&parts.len())
        && parts.iter().all(|p| !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()));
    if !ok {
        return Err(Error::Other(format!("longueur invalide pour {t} : {}", c.length)));
    }
    Ok(format!("{t}({len})"))
}

fn default_sql(engine: Engine, value: &str) -> String {
    let v = value.trim();
    let upper = v.to_ascii_uppercase();
    if DEFAULT_KEYWORDS.contains(&upper.as_str()) {
        upper
    } else if engine == Engine::Postgres && upper == "NOW()" {
        "now()".into()
    } else if !v.is_empty() && v.parse::<f64>().is_ok() && v.chars().all(|c| c.is_ascii_digit() || "-.".contains(c)) {
        v.to_string()
    } else {
        quote_literal(engine, v)
    }
}

/// Définition d'une colonne. `inline_pk` : clé primaire posée sur la colonne elle-même (SQLite
/// l'exige avec AUTOINCREMENT).
fn column_sql(engine: Engine, c: &ColumnDef, inline_pk: bool) -> Result<String> {
    let name = quote_ident(engine, c.name.trim())?;
    let mut ty = column_type(engine, c)?;
    let mut parts = Vec::new();
    if c.auto_increment {
        match engine {
            Engine::Mysql => {
                if !ty.contains("INT") {
                    return Err(Error::Other(format!("l'auto-incrément demande un type entier ({})", c.name)));
                }
                parts.push(format!("{name} {ty} NOT NULL AUTO_INCREMENT"));
            }
            Engine::Postgres => {
                if !matches!(ty.as_str(), "INTEGER" | "BIGINT" | "SMALLINT") {
                    return Err(Error::Other(format!("l'auto-incrément demande un type entier ({})", c.name)));
                }
                parts.push(format!("{name} {ty} GENERATED BY DEFAULT AS IDENTITY"));
            }
            Engine::Sqlite => {
                if !c.primary {
                    return Err(Error::Other("SQLite n'auto-incrémente que la clé primaire".into()));
                }
                ty = "INTEGER".into();
                return Ok(format!("{name} {ty} PRIMARY KEY AUTOINCREMENT"));
            }
        }
    } else {
        parts.push(format!("{name} {ty}{}", if c.nullable && !c.primary { "" } else { " NOT NULL" }));
    }
    if !c.default.trim().is_empty() && !c.auto_increment {
        parts.push(format!("DEFAULT {}", default_sql(engine, &c.default)));
    }
    if inline_pk {
        parts.push("PRIMARY KEY".into());
    }
    Ok(parts.join(" "))
}

fn table_name(engine: Engine, name: &str) -> Result<String> {
    quote_ident(engine, name.trim())
}

/// SQL d'une opération de structure.
pub fn schema_sql(engine: Engine, op: &SchemaOp) -> Result<String> {
    Ok(match op {
        SchemaOp::CreateTable { table, columns } => {
            let t = table_name(engine, table)?;
            if columns.is_empty() {
                return Err(Error::Other("une table a besoin d'au moins une colonne".into()));
            }
            let mut names: Vec<String> = columns.iter().map(|c| c.name.trim().to_ascii_lowercase()).collect();
            names.sort();
            names.dedup();
            if names.len() != columns.len() {
                return Err(Error::Other("deux colonnes portent le même nom".into()));
            }
            let sqlite_auto = engine == Engine::Sqlite && columns.iter().any(|c| c.auto_increment);
            let mut defs = Vec::new();
            for c in columns {
                defs.push(format!("  {}", column_sql(engine, c, false)?));
            }
            let pk: Vec<String> =
                columns.iter().filter(|c| c.primary).map(|c| quote_ident(engine, c.name.trim())).collect::<Result<_>>()?;
            if !pk.is_empty() && !sqlite_auto {
                defs.push(format!("  PRIMARY KEY ({})", pk.join(", ")));
            }
            let suffix = if engine == Engine::Mysql { " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci" } else { "" };
            format!("CREATE TABLE {t} (\n{}\n){suffix}", defs.join(",\n"))
        }
        SchemaOp::DropTable { table } => format!("DROP TABLE {}", table_name(engine, table)?),
        SchemaOp::TruncateTable { table } => match engine {
            Engine::Sqlite => format!("DELETE FROM {}", table_name(engine, table)?),
            _ => format!("TRUNCATE TABLE {}", table_name(engine, table)?),
        },
        SchemaOp::RenameTable { table, to } => match engine {
            Engine::Mysql => format!("RENAME TABLE {} TO {}", table_name(engine, table)?, table_name(engine, to)?),
            // `RENAME TO` n'accepte qu'un nom simple : la table reste dans son schéma.
            _ => {
                let to = to.trim().rsplit('.').next().unwrap_or_default();
                format!("ALTER TABLE {} RENAME TO {}", table_name(engine, table)?, table_name(engine, to)?)
            }
        },
        SchemaOp::AddColumn { table, column } => {
            if column.primary {
                return Err(Error::Other("une clé primaire se choisit à la création de la table".into()));
            }
            format!("ALTER TABLE {} ADD COLUMN {}", table_name(engine, table)?, column_sql(engine, column, false)?)
        }
        SchemaOp::DropColumn { table, column } => {
            format!("ALTER TABLE {} DROP COLUMN {}", table_name(engine, table)?, quote_ident(engine, column.trim())?)
        }
        SchemaOp::RenameColumn { table, column, to } => {
            format!(
                "ALTER TABLE {} RENAME COLUMN {} TO {}",
                table_name(engine, table)?,
                quote_ident(engine, column.trim())?,
                quote_ident(engine, to.trim())?
            )
        }
        SchemaOp::DropDatabase { database } => {
            if !valid_db_name(database) {
                return Err(Error::Other("nom de base invalide".into()));
            }
            if matches!(
                database.as_str(),
                "mysql" | "information_schema" | "performance_schema" | "sys" | "postgres" | "template0" | "template1"
            ) {
                return Err(Error::Other(format!("« {database} » est une base système : Zenytt ne la supprime pas")));
            }
            match engine {
                Engine::Mysql => format!("DROP DATABASE `{database}`"),
                Engine::Postgres => format!("DROP DATABASE \"{database}\""),
                Engine::Sqlite => return Err(Error::Other("un fichier SQLite se supprime depuis l'explorateur de fichiers".into())),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, t: &str) -> ColumnDef {
        ColumnDef {
            name: name.into(),
            data_type: t.into(),
            length: String::new(),
            nullable: true,
            default: String::new(),
            primary: false,
            auto_increment: false,
        }
    }

    fn id(t: &str) -> ColumnDef {
        ColumnDef { primary: true, auto_increment: true, nullable: false, ..col("id", t) }
    }

    #[test]
    fn create_table_per_engine() {
        let email = ColumnDef { nullable: false, length: "190".into(), ..col("email", "VARCHAR") };
        let created = ColumnDef { default: "current_timestamp".into(), ..col("cree_le", "TIMESTAMP") };
        let op = |t: &str| SchemaOp::CreateTable { table: "clients".into(), columns: vec![id(t), email.clone(), created.clone()] };

        let m = schema_sql(Engine::Mysql, &op("INT")).unwrap();
        assert!(m.starts_with("CREATE TABLE `clients` (") && m.contains("`id` INT NOT NULL AUTO_INCREMENT"), "{m}");
        assert!(m.contains("`email` VARCHAR(190) NOT NULL") && m.contains("`cree_le` TIMESTAMP DEFAULT CURRENT_TIMESTAMP"));
        assert!(m.contains("PRIMARY KEY (`id`)") && m.ends_with("utf8mb4_unicode_ci"));

        let p = schema_sql(Engine::Postgres, &op("INTEGER")).unwrap();
        assert!(p.contains("\"id\" INTEGER GENERATED BY DEFAULT AS IDENTITY") && p.contains("PRIMARY KEY (\"id\")"), "{p}");

        let s = schema_sql(Engine::Sqlite, &SchemaOp::CreateTable { table: "t".into(), columns: vec![id("INTEGER"), col("nom", "TEXT")] })
            .unwrap();
        assert!(s.contains("\"id\" INTEGER PRIMARY KEY AUTOINCREMENT") && !s.contains("PRIMARY KEY (\"id\")"), "{s}");
    }

    #[test]
    fn values_are_quoted_and_names_checked() {
        let c = ColumnDef { default: "l'été".into(), ..col("note", "TEXT") };
        let sql = schema_sql(Engine::Postgres, &SchemaOp::AddColumn { table: "t".into(), column: c }).unwrap();
        assert!(sql.ends_with("DEFAULT 'l''été'"), "{sql}");
        assert!(schema_sql(Engine::Mysql, &SchemaOp::DropTable { table: "t; DROP DATABASE x".into() }).is_err());
        assert!(schema_sql(Engine::Mysql, &SchemaOp::AddColumn { table: "t".into(), column: col("x", "INT); DROP TABLE t; --") }).is_err());
        assert!(schema_sql(
            Engine::Mysql,
            &SchemaOp::AddColumn { table: "t".into(), column: ColumnDef { length: "1) x".into(), ..col("x", "VARCHAR") } }
        )
        .is_err());
        assert_eq!(default_sql(Engine::Mysql, "42"), "42");
        assert_eq!(default_sql(Engine::Mysql, "12abc"), "'12abc'");
    }

    #[test]
    fn other_operations() {
        assert_eq!(
            schema_sql(Engine::Mysql, &SchemaOp::RenameTable { table: "a".into(), to: "b".into() }).unwrap(),
            "RENAME TABLE `a` TO `b`"
        );
        assert_eq!(schema_sql(Engine::Sqlite, &SchemaOp::TruncateTable { table: "a".into() }).unwrap(), "DELETE FROM \"a\"");
        assert_eq!(
            schema_sql(Engine::Postgres, &SchemaOp::RenameTable { table: "pgboss.queue".into(), to: "pgboss.file".into() }).unwrap(),
            "ALTER TABLE \"pgboss\".\"queue\" RENAME TO \"file\"",
            "hors du schéma public : le nouveau nom reste simple"
        );
        assert_eq!(
            schema_sql(Engine::Postgres, &SchemaOp::DropTable { table: "pgboss.job".into() }).unwrap(),
            "DROP TABLE \"pgboss\".\"job\""
        );
        assert_eq!(
            schema_sql(Engine::Postgres, &SchemaOp::RenameColumn { table: "a".into(), column: "x".into(), to: "y".into() }).unwrap(),
            "ALTER TABLE \"a\" RENAME COLUMN \"x\" TO \"y\""
        );
        assert!(schema_sql(Engine::Mysql, &SchemaOp::DropDatabase { database: "mysql".into() }).is_err(), "base système protégée");
        assert_eq!(schema_sql(Engine::Mysql, &SchemaOp::DropDatabase { database: "test".into() }).unwrap(), "DROP DATABASE `test`");
        let dup = SchemaOp::CreateTable { table: "t".into(), columns: vec![col("a", "INT"), col("A", "INT")] };
        assert!(schema_sql(Engine::Mysql, &dup).is_err());
    }
}
