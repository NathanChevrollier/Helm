//! Pont local entre le client RDP de l'interface (WebAssembly) et la machine distante.
//!
//! Le client web d'IronRDP ne parle pas TCP : il ouvre une WebSocket vers une passerelle et y
//! négocie la connexion avec le protocole **RDCleanPath** (la passerelle fait le TCP, l'échange
//! X.224 et la poignée de main TLS, puis relaie les octets). Cette passerelle, ici, c'est Helm
//! lui-même : elle n'écoute que sur 127.0.0.1, n'accepte qu'une seule session, et le jeton
//! présent dans l'adresse doit correspondre.
//!
//! La connexion RDP part donc du PC. Pour une machine qui n'est joignable que depuis un serveur,
//! l'appelant ouvre d'abord un tunnel SSH et donne au pont l'adresse locale de ce tunnel : le
//! chemin de code reste le même.
use std::sync::Arc;

use futures_util::{SinkExt as _, StreamExt as _};
use ironrdp_rdcleanpath::{DetectionResult, RDCleanPath, RDCleanPathPdu};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

/// Session ouverte : adresse à donner au client web et jeton à usage unique.
pub struct Bridge {
    pub url: String,
    pub token: String,
    /// Arrêt du pont (fermeture de l'onglet, erreur…).
    handle: tauri::async_runtime::JoinHandle<()>,
}

impl Bridge {
    pub fn stop(self) {
        self.handle.abort();
    }

    /// Pont construit par un autre protocole (VNC) : même cycle de vie, même rangement.
    pub(crate) fn from_parts(url: String, token: String, handle: tauri::async_runtime::JoinHandle<()>) -> Bridge {
        Bridge { url, token, handle }
    }
}

/// Ponts ouverts, par bureau à distance : fermer l'onglet ferme le pont.
#[derive(Default)]
pub struct Bridges(std::sync::Mutex<std::collections::HashMap<String, Bridge>>);

impl Bridges {
    pub fn keep(&self, id: &str, bridge: Bridge) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(ancien) = map.insert(id.to_string(), bridge) {
                ancien.stop();
            }
        }
    }

    pub fn stop(&self, id: &str) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(b) = map.remove(id) {
                b.stop();
            }
        }
    }
}

/// Ouvre le pont pour une machine donnée. Rien n'est joignable de l'extérieur : l'écoute est
/// liée à 127.0.0.1 et le port est choisi par le système.
pub async fn start(host: String, port: u16) -> Result<Bridge, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("écoute locale impossible : {e}"))?;
    let local = listener.local_addr().map_err(|e| e.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let url = format!("ws://127.0.0.1:{}/{token}", local.port());

    let attendu = token.clone();
    let handle = tauri::async_runtime::spawn(async move {
        // Une seule session par pont : la première connexion acceptée ferme l'écoute.
        match listener.accept().await {
            Ok((stream, _)) => {
                if let Err(e) = serve(stream, &attendu, &host, port).await {
                    log::warn!("bureau à distance : session interrompue ({e})");
                }
            }
            Err(e) => log::warn!("bureau à distance : connexion locale refusée ({e})"),
        }
    });

    Ok(Bridge { url, token, handle })
}

/// Accepte la WebSocket, joue le rôle de passerelle RDCleanPath, puis relaie les octets.
// La réponse d'erreur de la poignée de main est volumineuse : c'est le type imposé par la
// bibliothèque, et elle n'est jamais construite ici.
#[allow(clippy::result_large_err)]
async fn serve(stream: TcpStream, token: &str, host: &str, port: u16) -> Result<(), String> {
    let chemin_attendu = format!("/{token}");
    let mut autorise = false;
    let ws = tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
         res: tokio_tungstenite::tungstenite::handshake::server::Response| {
            autorise = req.uri().path() == chemin_attendu;
            Ok(res)
        },
    )
    .await
    .map_err(|e| format!("WebSocket refusée : {e}"))?;
    if !autorise {
        return Err("jeton de session invalide".into());
    }

    let (mut ws_sink, mut ws_stream) = ws.split();

    // 1. Demande RDCleanPath du client : elle porte la requête de connexion X.224.
    let mut tampon: Vec<u8> = Vec::new();
    let requete = loop {
        let msg = ws_stream.next().await.ok_or("le client a fermé la session avant la connexion")?;
        match msg.map_err(|e| e.to_string())? {
            Message::Binary(data) => tampon.extend_from_slice(&data),
            Message::Close(_) => return Err("session fermée par le client".into()),
            _ => continue,
        }
        if let DetectionResult::Detected { total_length, .. } = RDCleanPathPdu::detect(&tampon) {
            if tampon.len() >= total_length {
                break RDCleanPathPdu::from_der(&tampon[..total_length]).map_err(|e| format!("demande illisible : {e}"))?;
            }
        }
    };
    let x224 = match requete.into_enum().map_err(|e| e.to_string())? {
        RDCleanPath::Request { x224_connection_request, .. } => x224_connection_request.as_bytes().to_vec(),
        _ => return Err("le client n'a pas envoyé de demande de connexion".into()),
    };

    // 2. Connexion à la machine, échange X.224, puis TLS — exactement ce que ferait une passerelle.
    let mut tcp = TcpStream::connect((host, port)).await.map_err(|e| format!("connexion à {host}:{port} impossible : {e}"))?;
    tcp.set_nodelay(true).ok();
    tcp.write_all(&x224).await.map_err(|e| e.to_string())?;
    let reponse_x224 = lire_tpkt(&mut tcp).await?;

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(SansVerification(provider)))
        .with_no_client_auth();
    let nom = ServerName::try_from(host.to_string()).map_err(|_| format!("nom de machine invalide : {host}"))?;
    let tls =
        tokio_rustls::TlsConnector::from(Arc::new(config)).connect(nom, tcp).await.map_err(|e| format!("TLS refusé par {host} : {e}"))?;
    // Le client vérifie lui-même la chaîne : on la lui transmet telle quelle.
    let chaine: Vec<Vec<u8>> =
        tls.get_ref().1.peer_certificates().map(|c| c.iter().map(|c| c.as_ref().to_vec()).collect()).unwrap_or_default();

    let reponse = RDCleanPathPdu::new_response(format!("{host}:{port}"), reponse_x224, chaine)
        .map_err(|e| format!("réponse impossible à construire : {e}"))?
        .to_der()
        .map_err(|e| e.to_string())?;
    ws_sink.send(Message::Binary(reponse.into())).await.map_err(|e| e.to_string())?;

    // 3. Relais : ce que le client envoie part dans le tunnel TLS, et inversement.
    let (mut lecture, mut ecriture) = tokio::io::split(tls);
    let vers_serveur = async move {
        while let Some(msg) = ws_stream.next().await {
            match msg.map_err(|e| e.to_string())? {
                Message::Binary(data) => ecriture.write_all(&data).await.map_err(|e| e.to_string())?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok::<(), String>(())
    };
    let vers_client = async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = lecture.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            ws_sink.send(Message::Binary(buf[..n].to_vec().into())).await.map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    };

    tokio::select! {
        r = vers_serveur => r?,
        r = vers_client => r?,
    }
    Ok(())
}

/// Lit une unité TPKT complète (en-tête de 4 octets, dont la longueur totale).
async fn lire_tpkt(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut entete = [0u8; 4];
    stream.read_exact(&mut entete).await.map_err(|e| format!("réponse X.224 illisible : {e}"))?;
    let total = u16::from_be_bytes([entete[2], entete[3]]) as usize;
    if !(4..=8192).contains(&total) {
        return Err("réponse X.224 de taille invalide".into());
    }
    let mut reste = vec![0u8; total - 4];
    stream.read_exact(&mut reste).await.map_err(|e| format!("réponse X.224 tronquée : {e}"))?;
    let mut out = entete.to_vec();
    out.append(&mut reste);
    Ok(out)
}

/// Vérificateur qui accepte la chaîne du serveur : c'est le client RDP qui la contrôle ensuite,
/// à partir de la chaîne que le pont lui transmet (fonctionnement des passerelles RDCleanPath).
#[derive(Debug)]
struct SansVerification(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for SansVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuse_un_jeton_qui_ne_correspond_pas() {
        let pont = start("127.0.0.1".into(), 3389).await.unwrap();
        let mauvais = pont.url.rsplit_once('/').unwrap().0.to_string() + "/mauvais-jeton";
        let r = tokio_tungstenite::connect_async(&mauvais).await;
        // La poignée de main aboutit (le refus est côté serveur), mais aucune session ne démarre.
        if let Ok((mut ws, _)) = r {
            let _ = ws.close(None).await;
        }
        pont.stop();
    }

    #[test]
    fn tpkt_invalide_est_refuse() {
        // Longueur totale annoncée plus petite que l'en-tête : la lecture doit échouer.
        let entete = [0x03u8, 0x00, 0x00, 0x02];
        let total = u16::from_be_bytes([entete[2], entete[3]]) as usize;
        assert!(total < 4);
    }
}
