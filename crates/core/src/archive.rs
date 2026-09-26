//! Compression et extraction d'archives côté serveur.
//!
//! Tout se passe sur la machine distante : compresser un dossier de 10 Go ne fait transiter aucun
//! octet sur le réseau, là où un explorateur classique demanderait de tout télécharger, d'archiver
//! en local, puis de tout renvoyer. Les chemins sont passés entre apostrophes (`shell_quote`).

use serde::{Deserialize, Serialize};

use crate::sftp;
use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

/// Format d'archive proposé.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// `tar.gz` : le format attendu partout sous Linux, conserve droits et liens.
    TarGz,
    /// `zip` : lisible sans outil supplémentaire sous Windows.
    Zip,
    /// `tar.zst` : bien plus rapide et plus compact, si `zstd` est présent.
    TarZst,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::TarGz => "tar.gz",
            Format::Zip => "zip",
            Format::TarZst => "tar.zst",
        }
    }

    /// Outil qui doit être installé sur le serveur.
    pub fn tool(self) -> &'static str {
        match self {
            Format::TarGz => "tar",
            Format::Zip => "zip",
            Format::TarZst => "zstd",
        }
    }
}

/// Chemin acceptable : absolu, sans caractère de contrôle.
fn check(path: &str) -> Result<()> {
    if !path.starts_with('/') || path.chars().any(char::is_control) {
        return Err(Error::Other(format!("chemin invalide : {path}")));
    }
    Ok(())
}

/// Nom d'archive proposé pour une sélection : le nom de l'élément s'il est seul, sinon celui du
/// dossier qui les contient.
pub fn suggested_name(paths: &[String], format: Format) -> String {
    let base = match paths {
        [only] => only.trim_end_matches('/').rsplit('/').next().unwrap_or("archive").to_string(),
        _ => {
            let parent = paths.first().map(|p| sftp::parent(p)).unwrap_or_else(|| "/".into());
            let name = parent.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            if name.is_empty() {
                "archive".into()
            } else {
                name
            }
        }
    };
    format!("{base}.{}", format.extension())
}

/// Commande qui archive `paths` vers `dest`. Les chemins sont donnés relativement à leur dossier
/// parent (`tar -C`) : l'archive ne contient pas `/var/www/...` mais seulement les noms choisis,
/// ce qui évite qu'une extraction n'écrase des dossiers système.
pub fn create_command(paths: &[String], dest: &str, format: Format) -> Result<String> {
    if paths.is_empty() {
        return Err(Error::Other("aucun élément à compresser".into()));
    }
    check(dest)?;
    for p in paths {
        check(p)?;
    }
    let parent = sftp::parent(&paths[0]);
    // Tous les éléments doivent partager le même dossier : c'est le cas d'une sélection dans
    // l'explorateur, et cela garde des chemins relatifs dans l'archive.
    if paths.iter().any(|p| sftp::parent(p) != parent) {
        return Err(Error::Other("tous les éléments doivent être dans le même dossier".into()));
    }
    let names: Vec<String> = paths
        .iter()
        .map(|p| {
            let name = p.trim_end_matches('/').rsplit('/').next().unwrap_or(p);
            shell_quote(name)
        })
        .collect();
    let names = names.join(" ");
    let dir = shell_quote(&parent);
    let out = shell_quote(dest);
    Ok(match format {
        Format::TarGz => format!("tar -czf {out} -C {dir} -- {names}"),
        Format::TarZst => format!("tar -c -C {dir} -- {names} | zstd -q -o {out} -f"),
        // `zip -r` n'a pas d'option « changer de dossier » : un sous-shell s'en charge.
        Format::Zip => format!("cd {dir} && zip -qr {out} -- {names}"),
    })
}

/// Compresse une sélection et renvoie la taille de l'archive produite, en octets.
pub async fn create(conn: &Connection, sudo: Option<&str>, paths: &[String], dest: &str, format: Format) -> Result<u64> {
    let cmd = create_command(paths, dest, format)?;
    let out = crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await?;
    if !out.success() {
        let why = out.stderr.trim();
        return Err(Error::Remote(if why.is_empty() {
            format!("la compression a échoué (l'outil {} est-il installé ?)", format.tool())
        } else {
            why.to_string()
        }));
    }
    let size = conn.exec_sudo(&format!("stat -c %s {}", shell_quote(dest)), sudo, None).await?;
    Ok(size.stdout.trim().parse().unwrap_or(0))
}

/// Format deviné d'après l'extension du fichier.
pub fn detect(path: &str) -> Option<&'static str> {
    let p = path.to_ascii_lowercase();
    for (suffix, kind) in [
        (".tar.gz", "tar.gz"),
        (".tgz", "tar.gz"),
        (".tar.bz2", "tar.bz2"),
        (".tbz2", "tar.bz2"),
        (".tar.xz", "tar.xz"),
        (".txz", "tar.xz"),
        (".tar.zst", "tar.zst"),
        (".tar", "tar"),
        (".zip", "zip"),
        (".gz", "gz"),
        (".bz2", "bz2"),
        (".xz", "xz"),
        (".zst", "zst"),
    ] {
        if p.ends_with(suffix) {
            return Some(kind);
        }
    }
    None
}

/// Commande qui extrait `path` dans `dest`. `tar` reconnaît seul la compression (`-a`), et les
/// fichiers simplement compressés (`.gz` isolé) sont décompressés sans être désarchivés.
pub fn extract_command(path: &str, dest: &str) -> Result<String> {
    check(path)?;
    check(dest)?;
    let kind = detect(path).ok_or_else(|| Error::Other("format d'archive non reconnu".into()))?;
    let src = shell_quote(path);
    let dir = shell_quote(dest);
    Ok(match kind {
        "zip" => format!("mkdir -p {dir} && unzip -o -q {src} -d {dir}"),
        // Un `.gz` seul n'est pas une archive : il contient un unique fichier.
        "gz" | "bz2" | "xz" | "zst" => {
            let tool = match kind {
                "gz" => "gzip",
                "bz2" => "bzip2",
                "xz" => "xz",
                _ => "zstd",
            };
            let name = path.rsplit('/').next().unwrap_or("fichier");
            let stem = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name);
            format!("mkdir -p {dir} && {tool} -dc {src} > {}", shell_quote(&sftp::join(dest, stem)))
        }
        // `tar --no-same-owner` évite qu'une archive fabriquée attribue des fichiers à root.
        _ => format!("mkdir -p {dir} && tar -xaf {src} -C {dir} --no-same-owner"),
    })
}

/// Extrait une archive dans un dossier (créé au besoin).
pub async fn extract(conn: &Connection, sudo: Option<&str>, path: &str, dest: &str) -> Result<()> {
    let cmd = extract_command(path, dest)?;
    let out = crate::ssh::long(conn.exec_sudo(&cmd, sudo, None)).await?;
    if !out.success() {
        let why = out.stderr.trim();
        return Err(Error::Remote(if why.is_empty() { "l'extraction a échoué".into() } else { why.to_string() }));
    }
    Ok(())
}

/// Liste le contenu d'une archive sans l'extraire, pour montrer ce qu'elle va déposer.
pub async fn list(conn: &Connection, sudo: Option<&str>, path: &str, limit: usize) -> Result<Vec<String>> {
    check(path)?;
    let kind = detect(path).ok_or_else(|| Error::Other("format d'archive non reconnu".into()))?;
    let src = shell_quote(path);
    let cmd = match kind {
        "zip" => format!("unzip -Z1 {src}"),
        "gz" | "bz2" | "xz" | "zst" => return Ok(Vec::new()),
        _ => format!("tar -taf {src}"),
    };
    let out = crate::ssh::long(conn.exec_sudo(&format!("{cmd} 2>/dev/null | head -n {}", limit.clamp(1, 5000)), sudo, None)).await?;
    Ok(out.stdout.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_names_are_relative_to_their_folder() {
        let paths = vec!["/var/www/site".to_string(), "/var/www/notes.txt".to_string()];
        let cmd = create_command(&paths, "/var/www/site.tar.gz", Format::TarGz).unwrap();
        // -C sur le dossier parent, puis les seuls noms : l'archive ne contient pas /var/www.
        assert_eq!(cmd, "tar -czf '/var/www/site.tar.gz' -C '/var/www' -- 'site' 'notes.txt'");
        let zip = create_command(&paths[..1], "/tmp/a.zip", Format::Zip).unwrap();
        assert_eq!(zip, "cd '/var/www' && zip -qr '/tmp/a.zip' -- 'site'");
        assert!(create_command(&paths, "/tmp/a.tar.zst", Format::TarZst).unwrap().contains("| zstd -q -o '/tmp/a.tar.zst' -f"));
    }

    #[test]
    fn archive_refuses_what_it_cannot_handle() {
        assert!(create_command(&[], "/tmp/a.tar.gz", Format::TarGz).is_err());
        // Des éléments de dossiers différents donneraient des chemins absolus dans l'archive.
        let mixed = vec!["/var/www/a".to_string(), "/etc/nginx/b".to_string()];
        assert!(create_command(&mixed, "/tmp/a.tar.gz", Format::TarGz).is_err());
        assert!(create_command(&["relatif".to_string()], "/tmp/a.tar.gz", Format::TarGz).is_err());
        // Un nom hostile reste une donnee : il ressort comme un seul mot cite pour le shell.
        let cmd = create_command(&["/tmp/a';id;'".to_string()], "/tmp/x.tar.gz", Format::TarGz).unwrap();
        assert_eq!(cmd, r"tar -czf '/tmp/x.tar.gz' -C '/tmp' -- 'a'\'';id;'\'''");
    }

    #[test]
    fn formats_are_detected() {
        assert_eq!(detect("/tmp/a.TAR.GZ"), Some("tar.gz"));
        assert_eq!(detect("/tmp/a.tgz"), Some("tar.gz"));
        assert_eq!(detect("/tmp/sauvegarde.tar.zst"), Some("tar.zst"));
        assert_eq!(detect("/tmp/dump.sql.gz"), Some("gz"));
        assert_eq!(detect("/tmp/a.txt"), None);
    }

    #[test]
    fn extraction_matches_the_format() {
        assert_eq!(
            extract_command("/tmp/a.zip", "/var/www/site").unwrap(),
            "mkdir -p '/var/www/site' && unzip -o -q '/tmp/a.zip' -d '/var/www/site'"
        );
        let tar = extract_command("/tmp/a.tar.xz", "/opt/x").unwrap();
        assert!(tar.contains("tar -xaf '/tmp/a.tar.xz' -C '/opt/x' --no-same-owner"));
        // Un fichier simplement compressé est décompressé sous son nom sans l'extension.
        let gz = extract_command("/tmp/dump.sql.gz", "/tmp").unwrap();
        assert!(gz.contains("gzip -dc '/tmp/dump.sql.gz' > '/tmp/dump.sql'"), "{gz}");
        assert!(extract_command("/tmp/a.txt", "/tmp").is_err());
    }

    #[test]
    fn suggested_names() {
        assert_eq!(suggested_name(&["/var/www/site".into()], Format::TarGz), "site.tar.gz");
        assert_eq!(suggested_name(&["/var/www/a".into(), "/var/www/b".into()], Format::Zip), "www.zip");
    }
}
