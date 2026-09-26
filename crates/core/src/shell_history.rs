//! Historique des commandes du shell distant, lu pour la recherche inversée de Helm.
//!
//! Rien n'est installé sur le serveur : Helm lit les fichiers d'historique que le shell tient déjà
//! (`~/.bash_history`, `~/.zsh_history`, `~/.local/share/fish/fish_history`). Ce qu'on peut en
//! tirer dépend donc du shell :
//!
//! * **zsh** en mode `EXTENDED_HISTORY` écrit `: <horodatage>:<durée>;commande` — l'horodatage *et*
//!   la durée d'exécution sont disponibles ;
//! * **bash** n'écrit un horodatage (`#<epoch>`) que si `HISTTIMEFORMAT` est défini, et ne garde
//!   jamais la durée ;
//! * **fish** écrit un petit YAML avec `- cmd:` et `when:`, sans durée.
//!
//! Helm affiche donc la durée quand le shell la donne, et ne l'invente jamais sinon.

use std::collections::HashMap;

use serde::Serialize;

use crate::{Connection, Result};

/// Nombre maximal de commandes distinctes renvoyées.
pub const MAX_ENTRIES: usize = 3000;

/// Commande retenue dans l'historique.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub command: String,
    /// Nombre de fois qu'elle apparaît dans l'historique : c'est ce qui met en avant les habitudes.
    pub count: u32,
    /// Dernière exécution connue (epoch en secondes), si le shell l'a enregistrée.
    pub last: Option<u64>,
    /// Durée de la dernière exécution en secondes ; seul zsh en mode étendu la fournit.
    pub duration: Option<u64>,
}

/// Lit les fichiers d'historique existants. `cat` échoue en silence sur ceux qui manquent, et
/// chaque fichier est précédé d'un marqueur pour que l'analyse sache quel format elle lit.
pub const READ_COMMAND: &str = "for f in \"$HOME/.bash_history\" \"$HOME/.zsh_history\" \"$HOME/.local/share/fish/fish_history\"; do \
     [ -r \"$f\" ] || continue; printf '\\036%s\\n' \"$f\"; tail -c 1048576 \"$f\" 2>/dev/null; done; true";

/// Commandes qu'on ne remonte jamais : elles contiennent presque toujours un secret en clair, et
/// les proposer dans une liste, c'est le réafficher — voire le renvoyer tel quel au shell.
fn is_sensitive(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    const MARQUEURS: &[&str] = &[
        "password",
        "passwd",
        "mot-de-passe",
        "token",
        "secret",
        "api_key",
        "apikey",
        "private_key",
        "--pass",
        "-p'",
        "-p\"",
        "mysql -u",
        "openssl enc",
        "gpg --passphrase",
        "curl -u ",
        "export aws_secret",
        "htpasswd",
        "chpasswd",
        "smbpasswd",
    ];
    MARQUEURS.iter().any(|m| lower.contains(m))
}

/// Commande retenue dans l'historique ? On écarte le bruit qui n'a aucun intérêt à être reproposé.
fn is_useful(command: &str) -> bool {
    let c = command.trim();
    // Une commande d'un ou deux caractères (`ls`, `cd`) se retape plus vite qu'elle ne se cherche.
    c.len() > 2 && c.len() <= 2000 && !c.starts_with('#') && !is_sensitive(c)
}

/// Analyse la sortie de [`READ_COMMAND`]. Le format est deviné d'après le nom du fichier annoncé
/// par le marqueur `\u{1e}`, puis vérifié ligne par ligne : un `.bash_history` copié depuis zsh
/// existe, et une ligne mal formée est traitée comme une commande simple plutôt que perdue.
pub fn parse(out: &str) -> Vec<Entry> {
    let mut counts: HashMap<String, Entry> = HashMap::new();
    let mut fish = false;
    // Une commande bash peut s'étendre sur plusieurs lignes ; l'horodatage `#<epoch>` la précède.
    let mut pending_ts: Option<u64> = None;
    // fish écrit l'horodatage *après* sa commande : il faut savoir à laquelle le rattacher.
    let mut last_key: Option<String> = None;

    for line in out.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(path) = line.strip_prefix('\u{1e}') {
            fish = path.contains("fish_history");
            pending_ts = None;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }

        let (command, ts, duration) = if fish {
            // `- cmd: la commande` puis `  when: 1740000000`.
            if let Some(rest) = line.strip_prefix("- cmd: ") {
                (rest.to_string(), None, None)
            } else if let Some(rest) = line.trim_start().strip_prefix("when: ") {
                // L'horodatage suit sa commande : on le recolle à celle qui vient d'être retenue.
                if let (Ok(ts), Some(key)) = (rest.trim().parse::<u64>(), last_key.as_deref()) {
                    if let Some(e) = counts.get_mut(key) {
                        if e.last.is_none() || Some(ts) > e.last {
                            e.last = Some(ts);
                        }
                    }
                }
                continue;
            } else {
                continue;
            }
        } else if let Some(rest) = line.strip_prefix(": ") {
            // zsh étendu : `: 1740000000:12;la commande`.
            match parse_zsh(rest) {
                Some(x) => x,
                None => (line.to_string(), None, None),
            }
        } else if let Some(epoch) = line.strip_prefix('#').and_then(|e| e.trim().parse::<u64>().ok()) {
            // bash avec HISTTIMEFORMAT : l'horodatage seul, la commande est à la ligne suivante.
            pending_ts = Some(epoch);
            continue;
        } else {
            (line.to_string(), pending_ts.take(), None)
        };

        let command = command.trim().to_string();
        if !is_useful(&command) {
            continue;
        }
        last_key = Some(command.clone());
        let e = counts.entry(command.clone()).or_insert(Entry { command, count: 0, last: None, duration: None });
        e.count += 1;
        // On garde l'exécution la plus récente, et la durée qui va avec.
        if ts.is_some() && (e.last.is_none() || ts > e.last) {
            e.last = ts;
            e.duration = duration;
        } else if e.duration.is_none() {
            e.duration = duration;
        }
    }

    let mut list: Vec<Entry> = counts.into_values().collect();
    // Les plus récentes d'abord, puis les plus fréquentes : l'ordre par défaut de la liste.
    list.sort_by(|a, b| b.last.cmp(&a.last).then(b.count.cmp(&a.count)).then(a.command.cmp(&b.command)));
    list.truncate(MAX_ENTRIES);
    list
}

/// `1740000000:12;la commande` → horodatage, durée, commande.
fn parse_zsh(rest: &str) -> Option<(String, Option<u64>, Option<u64>)> {
    let (meta, command) = rest.split_once(';')?;
    let (ts, duration) = meta.split_once(':')?;
    let ts = ts.trim().parse::<u64>().ok()?;
    let duration = duration.trim().parse::<u64>().ok();
    Some((command.to_string(), Some(ts), duration.filter(|d| *d > 0)))
}

/// Historique du serveur, dédoublonné et classé.
pub async fn history(conn: &Connection) -> Result<Vec<Entry>> {
    let out = crate::ssh::long(conn.exec(READ_COMMAND, None)).await?;
    Ok(parse(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(list: &[Entry], command: &str) -> Entry {
        list.iter().find(|e| e.command == command).unwrap_or_else(|| panic!("« {command} » absente")).clone()
    }

    #[test]
    fn bash_without_timestamps() {
        let out = "\u{1e}/home/alice/.bash_history\ndocker ps -a\nsystemctl restart nginx\ndocker ps -a\n";
        let list = parse(out);
        assert_eq!(find(&list, "docker ps -a").count, 2, "les répétitions sont comptées");
        assert!(find(&list, "docker ps -a").last.is_none(), "bash sans HISTTIMEFORMAT ne donne pas de date");
        assert!(find(&list, "docker ps -a").duration.is_none());
    }

    #[test]
    fn bash_with_timestamps() {
        let out = "\u{1e}/home/alice/.bash_history\n#1740000000\ndocker compose up -d\n#1740000900\ndocker compose logs\n";
        let list = parse(out);
        assert_eq!(find(&list, "docker compose up -d").last, Some(1740000000));
        assert_eq!(find(&list, "docker compose logs").last, Some(1740000900));
        // La plus récente d'abord.
        assert_eq!(list[0].command, "docker compose logs");
    }

    #[test]
    fn zsh_extended_gives_duration() {
        let out = "\u{1e}/home/alice/.zsh_history\n: 1740000000:0;docker ps\n: 1740001000:42;apt-get upgrade -y\n";
        let list = parse(out);
        assert_eq!(find(&list, "apt-get upgrade -y").duration, Some(42), "zsh étendu donne la durée");
        assert_eq!(find(&list, "apt-get upgrade -y").last, Some(1740001000));
        // Une durée de 0 seconde n'apporte rien : elle n'est pas affichée.
        assert_eq!(find(&list, "docker ps").duration, None);
    }

    #[test]
    fn zsh_lines_that_are_not_extended() {
        // Un `.zsh_history` sans EXTENDED_HISTORY contient des commandes nues.
        let list = parse("\u{1e}/home/alice/.zsh_history\nrestic snapshots\n");
        assert_eq!(find(&list, "restic snapshots").count, 1);
    }

    #[test]
    fn fish_history() {
        let out = "\u{1e}/home/alice/.local/share/fish/fish_history\n- cmd: git status\n  when: 1740000000\n- cmd: git push\n  when: 1740000100\n";
        let list = parse(out);
        assert_eq!(list.len(), 2);
        assert_eq!(find(&list, "git push").count, 1);
        // fish écrit `when:` après sa commande : l'horodatage doit quand même la rejoindre.
        assert_eq!(find(&list, "git push").last, Some(1740000100));
        assert_eq!(find(&list, "git status").last, Some(1740000000));
        assert_eq!(list[0].command, "git push", "la plus récente d'abord");
    }

    #[test]
    fn secrets_never_come_back() {
        let out = "\u{1e}/home/alice/.bash_history\nmysql -uroot -phunter2 app\nexport TOKEN=abcdef\ncurl -u alice:secret https://x\ndocker ps\nhtpasswd -b /etc/nginx/.htpasswd bob motdepasse\n";
        let list = parse(out);
        assert_eq!(list.len(), 1, "seule « docker ps » est reproposable : {list:?}");
        assert_eq!(list[0].command, "docker ps");
    }

    #[test]
    fn noise_is_dropped() {
        let list = parse("\u{1e}/home/alice/.bash_history\nls\ncd\n# un commentaire\n\nhtop\n");
        // `ls` et `cd` se retapent plus vite qu'elles ne se cherchent ; les commentaires ne sont pas des commandes.
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].command, "htop");
    }

    #[test]
    fn several_files_are_merged() {
        let out = "\u{1e}/home/alice/.bash_history\ndocker ps\n\u{1e}/home/alice/.zsh_history\n: 1740000000:3;docker ps\n";
        let list = parse(out);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].count, 2);
        assert_eq!(list[0].last, Some(1740000000));
        assert_eq!(list[0].duration, Some(3));
    }
}
