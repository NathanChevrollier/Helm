//! Installation du serveur de synchronisation `zenytt-sync` sur un serveur, depuis l'app : le
//! binaire embarqué dans Zenytt est envoyé, puis lancé dans un conteneur Alpine par docker compose.
//! Il n'écoute que sur la boucle locale du serveur : joint par un tunnel SSH (mode privé) ou publié
//! par nginx en HTTPS (mode public).

use crate::agent::{target_for_arch, upload_binary};
use crate::ssh::shell_quote;
use crate::{Connection, Error, Result};

/// Dossier du projet compose sur le serveur.
pub const DIR: &str = "/opt/stacks/zenytt-sync";
/// Nom du projet compose (et du conteneur).
pub const PROJECT: &str = "zenytt-sync";
/// Premier port essayé sur la boucle locale du serveur.
pub const DEFAULT_PORT: u16 = 8091;

/// Installe ou met à jour. `$1` : binaire envoyé, `$2` : son empreinte SHA-256, `$3` : port.
/// Le jeton arrive sur l'entrée standard : il n'apparaît dans aucune ligne de commande.
const INSTALL_SCRIPT: &str = r#"set -e
DIR=/opt/stacks/zenytt-sync
BIN="$1"
[ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$2" ] || { echo "binaire modifié depuis l'envoi : installation annulée" >&2; rm -rf "$(dirname "$BIN")"; exit 1; }
command -v docker >/dev/null || { echo "Docker n'est pas installé sur ce serveur" >&2; exit 1; }
read -r TOKEN
[ -n "$TOKEN" ] || { echo "jeton absent" >&2; exit 1; }
# mkdir/chown/cp plutôt que `install` : présents sur toutes les distributions, même minimales.
mkdir -p "$DIR/data"
chmod 0755 "$DIR"
chown 10001:10001 "$DIR/data"
chmod 0700 "$DIR/data"
cp "$BIN" "$DIR/zenytt-sync.new"
chmod 0755 "$DIR/zenytt-sync.new"
mv -f "$DIR/zenytt-sync.new" "$DIR/zenytt-sync"
rm -rf "$(dirname "$BIN")"
umask 077
printf 'ZENYTT_SYNC_TOKENS=%s\nZENYTT_SYNC_PORT=%s\n' "$TOKEN" "$3" > "$DIR/.env"
# Lisible par le groupe docker : ses membres pilotent le projet depuis la section Docker.
chgrp docker "$DIR/.env" 2>/dev/null && chmod 640 "$DIR/.env" || chmod 600 "$DIR/.env"
umask 022
cat > "$DIR/docker-compose.yml" <<'EOF'
# Serveur de synchronisation de Zenytt : installé et mis à jour par l'app (Réglages → Synchronisation).
services:
  zenytt-sync:
    image: alpine:3
    container_name: zenytt-sync
    restart: unless-stopped
    user: "10001:10001"
    command: ["/app/zenytt-sync"]
    environment:
      ZENYTT_SYNC_TOKENS: ${ZENYTT_SYNC_TOKENS:?jeton absent du fichier .env}
      ZENYTT_SYNC_DATA: /data
    volumes:
      - ./zenytt-sync:/app/zenytt-sync:ro
      - ./data:/data
    ports:
      # Boucle locale seulement : joint par un tunnel SSH (mode privé) ou par nginx (mode public).
      - "127.0.0.1:${ZENYTT_SYNC_PORT:-8091}:8080"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]
      interval: 30s
      timeout: 3s
EOF
cd "$DIR"
docker compose -p zenytt-sync up -d 2>&1
# Binaire remplacé (mise à jour) : le conteneur le relit en redémarrant.
docker compose -p zenytt-sync restart 2>&1
"#;

/// Installation déjà présente : port et jeton lus dans son `.env` (pour la mettre à jour sans
/// changer de jeton, donc sans reconfigurer les autres PC).
pub async fn existing(conn: &Connection, sudo: Option<&str>) -> Result<Option<(u16, String)>> {
    let out =
        conn.exec_sudo(&format!("cat {} 2>/dev/null || true", shell_quote(&format!("{DIR}/.env"))), sudo, None).await?.into_result()?;
    Ok(parse_env(&out.stdout))
}

pub(crate) fn parse_env(env: &str) -> Option<(u16, String)> {
    let value = |key: &str| env.lines().find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('=')).map(|v| v.trim().to_string());
    let token = value("ZENYTT_SYNC_TOKENS").filter(|t| !t.is_empty())?;
    // Plusieurs jetons possibles (un par personne) : le premier sert à ce PC.
    let token = token.split(',').next().unwrap_or(&token).trim().to_string();
    let port = value("ZENYTT_SYNC_PORT").and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    Some((port, token))
}

/// Premier port libre sur le serveur à partir de `start` (d'après `ss -Htln`).
pub async fn free_port(conn: &Connection, start: u16) -> Result<u16> {
    let out = conn.exec("ss -Htln 2>/dev/null", None).await?;
    Ok(first_free(&crate::docker::listening_ports(&out.stdout), start))
}

pub(crate) fn first_free(busy: &std::collections::HashSet<u16>, start: u16) -> u16 {
    (start..u16::MAX).find(|p| !busy.contains(p)).unwrap_or(start)
}

/// Nouveau jeton aléatoire (256 bits, hexadécimal).
pub fn new_token() -> Result<String> {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut bytes).map_err(|_| Error::Other("aléa indisponible".into()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Envoie le binaire adapté au processeur du serveur, écrit le projet compose et le (re)lance.
pub async fn install(
    conn: &Connection,
    sudo: Option<&str>,
    binary_for: impl Fn(&str) -> Option<&'static [u8]>,
    port: u16,
    token: &str,
) -> Result<String> {
    let env = conn.run("uname -s; uname -m").await?;
    let mut lines = env.lines().map(str::trim);
    let (os, arch) = (lines.next().unwrap_or(""), lines.next().unwrap_or(""));
    if os != "Linux" {
        return Err(Error::Other(format!("le serveur de synchronisation ne fonctionne que sous Linux (ce serveur : {os})")));
    }
    let target = target_for_arch(arch)
        .ok_or_else(|| Error::Other(format!("processeur {arch} non pris en charge (x86_64 et ARM 64 bits seulement)")))?;
    let bytes = binary_for(target).filter(|b| !b.is_empty()).ok_or_else(|| {
        Error::Other(format!(
            "serveur de synchronisation absent de cette version de Zenytt pour {target} (pnpm build:agent en développement)"
        ))
    })?;
    let sha256: String = ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let remote = upload_binary(conn, bytes).await?;
    let cmd = format!("sh -c {} zenytt-sync-install {} {sha256} {port}", shell_quote(INSTALL_SCRIPT), shell_quote(&remote));
    let out = crate::ssh::long(conn.exec_sudo(&cmd, sudo, Some(format!("{token}\n").as_bytes()))).await?.into_result()?;
    Ok(out.stdout)
}

/// Le serveur répond-il sur son port local ? Interrogé à travers la connexion SSH elle-même
/// (canal direct-tcpip) : rien à installer sur le serveur, rien d'exposé.
pub async fn healthy(conn: &Connection, port: u16) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let attempt = async {
        let mut stream = conn.open_direct_tcpip("127.0.0.1", port, 0).await.ok()?;
        stream.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").await.ok()?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.ok()?;
        let text = String::from_utf8_lossy(&buf);
        Some(text.starts_with("HTTP/1.") && text.split_whitespace().nth(1) == Some("200"))
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), attempt).await.ok().flatten().unwrap_or(false)
}

/// Attend que le serveur réponde (démarrage du conteneur), 30 s au plus.
pub async fn wait_healthy(conn: &Connection, port: u16) -> bool {
    for _ in 0..15 {
        if healthy(conn, port).await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_gives_port_and_first_token() {
        assert_eq!(parse_env("ZENYTT_SYNC_TOKENS=abc,def\nZENYTT_SYNC_PORT=8095\n"), Some((8095, "abc".into())));
        assert_eq!(parse_env("ZENYTT_SYNC_TOKENS=abc\n"), Some((DEFAULT_PORT, "abc".into())));
        assert_eq!(parse_env(""), None);
        assert_eq!(parse_env("ZENYTT_SYNC_TOKENS=\n"), None);
    }

    #[test]
    fn free_port_skips_busy_ones() {
        let busy = [8091, 8092].into_iter().collect();
        assert_eq!(first_free(&busy, 8091), 8093);
        assert_eq!(first_free(&Default::default(), 8091), 8091);
    }

    #[test]
    fn tokens_are_random_hex() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn install_script_keeps_the_token_out_of_command_lines() {
        assert!(INSTALL_SCRIPT.contains("read -r TOKEN"));
        assert!(INSTALL_SCRIPT.contains("\"127.0.0.1:${ZENYTT_SYNC_PORT:-8091}:8080\""), "boucle locale seulement");
    }
}
