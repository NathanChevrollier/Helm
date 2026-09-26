// Détection des requêtes en lecture seule, mêmes règles que `is_read_only` côté Rust
// (crates/core/src/db.rs) : une seule instruction, commençant par un mot de lecture, sans aucun
// mot d'écriture nulle part (CTE et sous-requêtes comprises). Les autres demandent confirmation.

const READ_FIRST = new Set(["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "WITH", "TABLE", "VALUES", "ANALYZE"]);
const WRITE_WORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE", "GRANT", "REVOKE", "MERGE", "REPLACE", "UPSERT", "CALL", "DO", "COPY",
  "LOCK", "RENAME", "VACUUM", "REINDEX", "CLUSTER", "REFRESH", "IMPORT", "LOAD", "HANDLER", "INTO", "OUTFILE", "DUMPFILE", "SET", "RESET",
  "KILL", "SHUTDOWN", "FLUSH", "PURGE", "INSTALL", "UNINSTALL", "COMMENT", "SECURITY", "DISCARD", "NOTIFY", "PREPARE", "EXECUTE",
  "EXEC", "DEALLOCATE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "START", "ATTACH", "DETACH", "PRAGMA",
]);

/**
 * Requête sans commentaires `--` et `/* *\/`, chaînes, identifiants entre guillemets ni chaînes
 * `$$…$$`. Ni `#` ni l'antislash ne sont interprétés (leur sens dépend du moteur) : dans le doute,
 * on garde du texte, ce qui ne peut que faire demander une confirmation de trop.
 */
export function sqlSkeleton(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (!m) {
        out += c;
        i++;
        continue;
      }
      const end = sql.indexOf(m[0], i + m[0].length);
      i = end < 0 ? sql.length : end + m[0].length;
    } else {
      out += c;
      i++;
      continue;
    }
    out += " ";
  }
  return out;
}

export function isReadOnly(sql: string): boolean {
  const statements = sqlSkeleton(sql)
    .split(";")
    .filter((s) => s.trim());
  if (statements.length !== 1) return false;
  const words = statements[0]
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  return READ_FIRST.has(words[0] ?? "") && !words.some((w) => WRITE_WORDS.has(w));
}
