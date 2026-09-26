//! Recherche de fichiers et de texte sur le serveur, sans rien télécharger.
//!
//! `find` et `grep` tournent côté serveur : chercher une chaîne dans un dossier de plusieurs
//! gigaoctets coûte une seule commande, là où un explorateur qui rapatrie les fichiers pour les
//! lire y passerait la journée. Tout ce qui vient de l'interface est passé entre apostrophes
//! (`shell_quote`) : un nom de fichier contenant `;` ou `$(…)` est une donnée, jamais du code.

use serde::Serialize;

use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

/// Nombre maximal de résultats rapportés. Au-delà, la recherche est signalée comme tronquée :
/// une recherche trop large doit être affinée, pas attendue.
pub const MAX_RESULTS: usize = 500;

/// Dossiers jamais parcourus : ils sont soit virtuels, soit sans intérêt et immenses.
const SKIP: &[&str] = &["/proc", "/sys", "/dev", "/run", "node_modules", ".git", "/var/lib/docker"];

/// Fichier trouvé par nom.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub size: u64,
    /// Vrai pour un dossier.
    pub is_dir: bool,
}

/// Ligne trouvée par recherche plein texte.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub path: String,
    pub line: u32,
    /// Contenu de la ligne, coupé à 400 caractères.
    pub text: String,
}

/// Résultat d'une recherche, avec le drapeau de troncature.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Results<T> {
    pub items: Vec<T>,
    pub truncated: bool,
}

/// Racine acceptable : un chemin absolu, sans caractère de contrôle.
fn check_root(root: &str) -> Result<()> {
    if !root.starts_with('/') || root.chars().any(char::is_control) {
        return Err(Error::Other("dossier de recherche invalide".into()));
    }
    Ok(())
}

/// Exclusions `find` : `-name node_modules -prune -o` pour les noms, `-path /proc -prune -o`
/// pour les chemins absolus.
fn prune_args() -> String {
    SKIP.iter()
        .map(|s| {
            let flag = if s.starts_with('/') { "-path" } else { "-name" };
            format!("{flag} {} -prune -o ", shell_quote(s))
        })
        .collect()
}

/// Commande de recherche par nom. Le motif est cherché en morceau de nom, sans tenir compte de la
/// casse : `nginx.co` trouve `nginx.conf`.
pub fn find_command(root: &str, pattern: &str, depth: u8) -> Result<String> {
    check_root(root)?;
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(Error::Other("motif de recherche vide".into()));
    }
    // Un motif déjà pourvu de jokers est respecté tel quel ; sinon il est cherché en sous-chaîne.
    let glob = if pattern.contains('*') || pattern.contains('?') { pattern.to_string() } else { format!("*{pattern}*") };
    Ok(format!(
        "find {} -maxdepth {} {}\\( -iname {} \\) -printf '%y\\t%s\\t%p\\n' 2>/dev/null | head -n {}",
        shell_quote(root),
        depth.clamp(1, 20),
        prune_args(),
        shell_quote(&glob),
        MAX_RESULTS + 1
    ))
}

/// Sortie de [`find_command`] : `type<TAB>taille<TAB>chemin`.
pub fn parse_find(out: &str) -> Results<Hit> {
    let mut items: Vec<Hit> = out
        .lines()
        .filter_map(|l| {
            let mut parts = l.splitn(3, '\t');
            let kind = parts.next()?;
            let size = parts.next()?.parse().unwrap_or(0);
            let path = parts.next()?;
            (!path.is_empty()).then(|| Hit { path: path.to_string(), size, is_dir: kind == "d" })
        })
        .collect();
    let truncated = items.len() > MAX_RESULTS;
    items.truncate(MAX_RESULTS);
    Results { items, truncated }
}

/// Recherche de fichiers par nom dans toute l'arborescence d'un dossier.
pub async fn find(conn: &Connection, sudo: Option<&str>, root: &str, pattern: &str, depth: u8) -> Result<Results<Hit>> {
    let cmd = find_command(root, pattern, depth)?;
    let out = crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await?;
    Ok(parse_find(&out.stdout))
}

/// Commande de recherche plein texte. `grep -I` écarte les fichiers binaires, ce qui évite de
/// remonter des mégaoctets d'une image qui contient par hasard la suite d'octets cherchée.
pub fn grep_command(root: &str, needle: &str, glob: Option<&str>, case_sensitive: bool, regex: bool) -> Result<String> {
    check_root(root)?;
    let needle = needle.trim_end_matches('\n');
    if needle.is_empty() {
        return Err(Error::Other("texte à chercher vide".into()));
    }
    if needle.contains('\n') {
        return Err(Error::Other("la recherche porte sur une seule ligne".into()));
    }
    let mut flags = String::from("-rInH");
    if !case_sensitive {
        flags.push('i');
    }
    // Sans expression régulière, le texte est cherché littéralement (`-F`) : un point ou un
    // crochet tapé par l'utilisateur ne devient pas un motif.
    if !regex {
        flags.push('F');
    }
    let excludes: String = SKIP.iter().filter(|s| !s.starts_with('/')).map(|s| format!("--exclude-dir={} ", shell_quote(s))).collect();
    let include = glob.map(|g| format!("--include={} ", shell_quote(g))).unwrap_or_default();
    Ok(format!(
        "grep {flags} {excludes}{include}-e {} -- {} 2>/dev/null | head -n {}",
        shell_quote(needle),
        shell_quote(root),
        MAX_RESULTS + 1
    ))
}

/// Sortie de `grep -n` : `chemin:ligne:texte`. Un chemin peut contenir « : », donc seule la
/// dernière paire `:<nombre>:` avant le texte est un séparateur fiable — on découpe depuis la fin
/// du préfixe numérique.
pub fn parse_grep(out: &str) -> Results<Match> {
    let mut items: Vec<Match> = out
        .lines()
        .filter_map(|l| {
            // On cherche le premier `:<chiffres>:` : `grep` écrit le chemin puis le numéro de ligne.
            let mut start = 0;
            while let Some(i) = l[start..].find(':') {
                let colon = start + i;
                let rest = &l[colon + 1..];
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if !digits.is_empty() && rest.as_bytes().get(digits.len()) == Some(&b':') {
                    return Some(Match {
                        path: l[..colon].to_string(),
                        line: digits.parse().unwrap_or(0),
                        text: rest[digits.len() + 1..].chars().take(400).collect(),
                    });
                }
                start = colon + 1;
            }
            None
        })
        .collect();
    let truncated = items.len() > MAX_RESULTS;
    items.truncate(MAX_RESULTS);
    Results { items, truncated }
}

/// Recherche plein texte dans les fichiers d'un dossier, sans les télécharger.
pub async fn grep(
    conn: &Connection,
    sudo: Option<&str>,
    root: &str,
    needle: &str,
    glob: Option<&str>,
    case_sensitive: bool,
    regex: bool,
) -> Result<Results<Match>> {
    let cmd = grep_command(root, needle, glob, case_sensitive, regex)?;
    let out = crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await?;
    Ok(parse_grep(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_escapes_everything() {
        let cmd = find_command("/var/www", "conf", 8).unwrap();
        assert!(cmd.contains("find '/var/www' -maxdepth 8"));
        assert!(cmd.contains("-iname '*conf*'"));
        assert!(cmd.contains("-path '/proc' -prune"));
        assert!(cmd.contains("-name 'node_modules' -prune"));
        // Un motif déjà pourvu de jokers est respecté tel quel.
        assert!(find_command("/", "*.log", 5).unwrap().contains("-iname '*.log'"));
        // Rien de ce qui vient de l'interface ne peut devenir une commande : l'apostrophe est
        // refermee, echappee, puis reouverte, si bien que tout reste un seul mot pour le shell.
        let hostile = find_command("/tmp", "a'; id; echo '", 3).unwrap();
        assert!(hostile.contains(r"-iname '*a'\''; id; echo '\''*'"), "{hostile}");
        assert!(find_command("relatif", "x", 3).is_err());
        assert!(find_command("/tmp", "  ", 3).is_err());
    }

    #[test]
    fn find_output_is_parsed() {
        let r = parse_find("f\t1024\t/var/www/a.conf\nd\t4096\t/var/www/sub\nbruit\n");
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0], Hit { path: "/var/www/a.conf".into(), size: 1024, is_dir: false });
        assert!(r.items[1].is_dir);
        assert!(!r.truncated);
        // Une ligne de plus que la limite signale la troncature.
        let many = (0..=MAX_RESULTS).map(|i| format!("f\t0\t/f{i}")).collect::<Vec<_>>().join("\n");
        let r = parse_find(&many);
        assert!(r.truncated);
        assert_eq!(r.items.len(), MAX_RESULTS);
    }

    #[test]
    fn grep_is_literal_by_default() {
        let cmd = grep_command("/etc/nginx", "proxy_pass", None, false, false).unwrap();
        assert!(cmd.contains("grep -rInHiF"), "{cmd}");
        assert!(cmd.contains("-e 'proxy_pass' -- '/etc/nginx'"));
        assert!(cmd.contains("--exclude-dir='node_modules'"));
        // Sensible à la casse et en expression régulière : ni « i » ni « F ».
        let re = grep_command("/srv", "^server", Some("*.conf"), true, true).unwrap();
        assert!(re.contains("grep -rInH "), "{re}");
        assert!(re.contains("--include='*.conf'"));
        assert!(grep_command("/srv", "a\nb", None, true, false).is_err());
        assert!(grep_command("/srv", "", None, true, false).is_err());
    }

    #[test]
    fn grep_output_survives_colons_in_paths() {
        let r = parse_grep("/etc/a.conf:12:  proxy_pass http://127.0.0.1:8080;\n/tmp/x:y:3:bonjour\nsans numero\n");
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].path, "/etc/a.conf");
        assert_eq!(r.items[0].line, 12);
        assert_eq!(r.items[0].text, "  proxy_pass http://127.0.0.1:8080;");
        // Le chemin contient « : » : c'est le premier « :<nombre>: » qui sépare.
        assert_eq!(r.items[1].path, "/tmp/x:y");
        assert_eq!(r.items[1].line, 3);
        assert_eq!(r.items[1].text, "bonjour");
    }
}
