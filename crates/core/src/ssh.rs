//! Connexion SSH : authentification, vérification de la clé d'hôte, exécution et shell.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle, Msg};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Méthode d'authentification choisie pour un serveur.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    Password { password: String },
    KeyFile { path: String, passphrase: Option<String> },
    /// Agent SSH du système : Pageant ou OpenSSH sous Windows, `SSH_AUTH_SOCK` ailleurs.
    Agent,
}

/// Paramètres d'une connexion.
#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
    /// Empreinte SHA256 connue de la clé d'hôte ; `None` si le serveur n'a jamais été approuvé.
    pub known_fingerprint: Option<String>,
}

/// Résultat d'une commande exécutée à distance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u32,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.exit_code == 0
    }

    /// Convertit un code de sortie non nul en erreur, avec le stderr comme message.
    pub fn into_result(self) -> Result<Self> {
        if self.success() {
            Ok(self)
        } else {
            let msg = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
            Err(Error::Remote(format!("code {} : {}", self.exit_code, msg.trim())))
        }
    }
}

struct HostKeyCheck {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let fingerprint = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(cert) => {
                keys::PublicKey::from(cert.public_key().clone()).fingerprint(HashAlg::Sha256)
            }
        }
        .to_string();
        let trusted = self.expected.as_deref() == Some(fingerprint.as_str());
        *self.seen.lock().unwrap() = Some(fingerprint);
        Ok(trusted)
    }
}

/// Session SSH authentifiée. Clonable à moindre coût : les clones partagent la même connexion.
#[derive(Clone)]
pub struct Connection {
    handle: Arc<Handle<HostKeyCheck>>,
    pub fingerprint: String,
}

impl Connection {
    pub async fn connect(params: ConnectParams) -> Result<Self> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 4,
            ..Default::default()
        });
        let seen = Arc::new(Mutex::new(None));
        let handler = HostKeyCheck { expected: params.known_fingerprint.clone(), seen: seen.clone() };

        let addr = (params.host.as_str(), params.port);
        let result = tokio::time::timeout(Duration::from_secs(15), client::connect(config, addr, handler))
            .await
            .map_err(|_| {
                Error::Connection(format!("délai dépassé en se connectant à {}:{}", params.host, params.port))
            })?;

        let seen_fp = seen.lock().unwrap().clone();
        let mut handle = match result {
            Ok(h) => h,
            Err(e) => {
                // La clé a été rejetée par notre handler : on distingue hôte inconnu et clé modifiée.
                if let Some(fp) = seen_fp {
                    if params.known_fingerprint.as_deref() != Some(fp.as_str()) {
                        return Err(match params.known_fingerprint {
                            None => Error::UnknownHostKey(fp),
                            Some(expected) => Error::HostKeyMismatch { expected, got: fp },
                        });
                    }
                }
                return Err(Error::Connection(e.to_string()));
            }
        };
        let fingerprint = seen_fp.unwrap_or_default();

        authenticate(&mut handle, &params.username, &params.auth).await?;
        Ok(Self { handle: Arc::new(handle), fingerprint })
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn disconnect(&self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "fr").await;
    }

    /// Exécute une commande et attend sa fin. `stdin` est envoyé puis fermé s'il est fourni.
    pub async fn exec(&self, command: &str, stdin: Option<&[u8]>) -> Result<ExecOutput> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        if let Some(input) = stdin {
            channel.data(input).await?;
        }
        channel.eof().await?;

        let (mut stdout, mut stderr, mut exit_code) = (Vec::new(), Vec::new(), None);
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::ExitSignal { .. } => exit_code = exit_code.or(Some(255)),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: exit_code.unwrap_or(0),
        })
    }

    /// Exécute une commande, en échouant si son code de sortie est non nul.
    pub async fn run(&self, command: &str) -> Result<String> {
        Ok(self.exec(command, None).await?.into_result()?.stdout)
    }

    /// Exécute une commande en root : directement si l'utilisateur est root, sinon via sudo.
    /// Le mot de passe sudo est transmis sur stdin, jamais dans la ligne de commande.
    pub async fn exec_sudo(
        &self,
        command: &str,
        sudo_password: Option<&str>,
        stdin: Option<&[u8]>,
    ) -> Result<ExecOutput> {
        let q = shell_quote(command);
        match sudo_password {
            Some(pw) => {
                let mut input = format!("{pw}\n").into_bytes();
                input.extend_from_slice(stdin.unwrap_or_default());
                let cmd = format!(
                    "if [ \"$(id -u)\" = 0 ]; then read -r _; sh -c {q}; else sudo -S -p '' sh -c {q}; fi"
                );
                self.exec(&cmd, Some(&input)).await
            }
            None => {
                let cmd = format!("if [ \"$(id -u)\" = 0 ]; then sh -c {q}; else sudo -n sh -c {q}; fi");
                self.exec(&cmd, stdin).await
            }
        }
    }

    /// Ouvre un shell interactif avec pseudo-terminal.
    pub async fn open_shell(&self, cols: u32, rows: u32) -> Result<Channel<Msg>> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        channel.request_shell(true).await?;
        Ok(channel)
    }

    /// Ouvre un canal qui exécute une commande en flux continu (`docker logs -f`, `docker exec -it`…).
    pub async fn open_exec(&self, command: &str, pty: Option<(u32, u32)>) -> Result<Channel<Msg>> {
        let channel = self.handle.channel_open_session().await?;
        if let Some((cols, rows)) = pty {
            channel.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        }
        channel.exec(true, command).await?;
        Ok(channel)
    }

    /// Ouvre une session SFTP.
    pub async fn sftp(&self) -> Result<russh_sftp::client::SftpSession> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| Error::Sftp(e.to_string()))
    }
}

async fn authenticate(handle: &mut Handle<HostKeyCheck>, user: &str, auth: &Auth) -> Result<()> {
    let ok = match auth {
        Auth::Password { password } => {
            let res = handle.authenticate_password(user, password).await?;
            // Beaucoup de serveurs n'acceptent le mot de passe qu'en keyboard-interactive.
            res.success() || keyboard_interactive(handle, user, password).await?
        }
        Auth::KeyFile { path, passphrase } => {
            let key = keys::load_secret_key(expand_home(path), passphrase.as_deref())
                .map_err(|e| Error::Auth(format!("clé illisible ({path}) : {e}")))?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
                .success()
        }
        Auth::Agent => authenticate_with_agent(handle, user).await?,
    };
    if ok {
        Ok(())
    } else {
        Err(Error::Auth("identifiants refusés par le serveur".into()))
    }
}

async fn keyboard_interactive(handle: &mut Handle<HostKeyCheck>, user: &str, password: &str) -> Result<bool> {
    use russh::client::KeyboardInteractiveAuthResponse as R;
    let mut resp = handle.authenticate_keyboard_interactive_start(user, None::<String>).await?;
    for _ in 0..5 {
        match resp {
            R::Success => return Ok(true),
            R::Failure { .. } => return Ok(false),
            R::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

async fn authenticate_with_agent(handle: &mut Handle<HostKeyCheck>, user: &str) -> Result<bool> {
    use keys::agent::client::AgentClient;
    #[cfg(windows)]
    {
        // OpenSSH pour Windows d'abord, puis Pageant (l'agent de PuTTY).
        if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if try_agent(handle, user, agent).await? {
                return Ok(true);
            }
        }
        match AgentClient::connect_pageant().await {
            Ok(agent) => try_agent(handle, user, agent).await,
            Err(_) => Err(Error::Auth("aucun agent SSH trouvé (Pageant ou OpenSSH Agent)".into())),
        }
    }
    #[cfg(not(windows))]
    {
        let agent = AgentClient::connect_env()
            .await
            .map_err(|e| Error::Auth(format!("agent SSH indisponible : {e}")))?;
        try_agent(handle, user, agent).await
    }
}

async fn try_agent<S>(
    handle: &mut Handle<HostKeyCheck>,
    user: &str,
    mut agent: keys::agent::client::AgentClient<S>,
) -> Result<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await.map_err(|e| Error::Auth(e.to_string()))?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else { continue };
        if let Ok(res) = handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if res.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => {
            let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
            format!("{home}/{rest}")
        }
        None => path.to_string(),
    }
}

/// Entoure une chaîne de quotes simples pour un shell POSIX.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_escapes_single_quotes() {
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("a b"), "'a b'");
    }
}
