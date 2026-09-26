//! Pont local entre le client VNC de l'interface (noVNC) et la machine distante.
//!
//! noVNC ne parle pas TCP : il ouvre une WebSocket et y fait passer le protocole RFB tel quel.
//! Contrairement au RDP, aucune négociation n'est à jouer côté passerelle — le pont se contente de
//! relayer les octets dans les deux sens, comme `websockify`. Il n'écoute que sur 127.0.0.1,
//! n'accepte qu'une seule session, et le jeton présent dans l'adresse doit correspondre.
//!
//! Pour une machine qui n'est joignable que depuis un serveur, l'appelant ouvre d'abord un tunnel
//! SSH et donne au pont l'adresse locale de ce tunnel : l'écran ne traverse alors Internet que
//! chiffré par SSH, ce qui compte d'autant plus que VNC, lui, ne chiffre souvent rien.
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

use crate::rdp_bridge::Bridge;

/// Ouvre le pont vers `host:port`. Rien n'est joignable de l'extérieur : l'écoute est liée à
/// 127.0.0.1, sur un port choisi par le système.
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
                    log::warn!("bureau VNC : session interrompue ({e})");
                }
            }
            Err(e) => log::warn!("bureau VNC : connexion locale refusée ({e})"),
        }
    });
    Ok(Bridge::from_parts(url, token, handle))
}

/// Accepte la WebSocket (jeton vérifié), ouvre la connexion TCP, puis relaie les octets.
// Comme dans le pont RDP : la réponse d'erreur de la poignée de main est volumineuse, c'est le
// type imposé par la bibliothèque, et elle n'est jamais construite ici.
#[allow(clippy::result_large_err)]
async fn serve(stream: TcpStream, token: &str, host: &str, port: u16) -> Result<(), String> {
    let chemin_attendu = format!("/{token}");
    let mut autorise = false;
    let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, mut res: Response| {
        autorise = req.uri().path() == chemin_attendu;
        // noVNC ne demande pas de sous-protocole par défaut ; s'il réclame « binary » (anciennes
        // versions), le navigateur exige qu'on le lui confirme, sinon il ferme la connexion.
        let wants_binary = req
            .headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|p| p.trim() == "binary"));
        if wants_binary {
            res.headers_mut().insert("Sec-WebSocket-Protocol", "binary".parse().expect("en-tête valide"));
        }
        Ok(res)
    })
    .await
    .map_err(|e| format!("WebSocket refusée : {e}"))?;
    if !autorise {
        return Err("jeton de session invalide".into());
    }

    let tcp = TcpStream::connect((host, port)).await.map_err(|e| format!("connexion à {host}:{port} impossible : {e}"))?;
    tcp.set_nodelay(true).ok();
    relay(ws, tcp).await
}

/// Relais dans les deux sens. Le premier côté qui ferme met fin à la session.
async fn relay<S>(ws: tokio_tungstenite::WebSocketStream<S>, tcp: TcpStream) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut ws_sink, mut ws_stream) = ws.split();
    let (mut lecture, mut ecriture) = tcp.into_split();
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
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = lecture.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            ws_sink.send(Message::Binary(buf[..n].to_vec().into())).await.map_err(|e| e.to_string())?;
        }
        let _ = ws_sink.close().await;
        Ok::<(), String>(())
    };
    tokio::select! {
        r = vers_serveur => r?,
        r = vers_client => r?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Faux serveur VNC : envoie la bannière RFB, puis renvoie tout ce qu'il reçoit.
    async fn faux_serveur() -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            s.write_all(b"RFB 003.008\n").await.unwrap();
            let mut buf = [0u8; 64];
            let n = s.read(&mut buf).await.unwrap();
            s.write_all(&buf[..n]).await.unwrap();
        });
        port
    }

    #[tokio::test]
    async fn relaie_les_octets_dans_les_deux_sens() {
        let port = faux_serveur().await;
        let pont = start("127.0.0.1".into(), port).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(&pont.url).await.unwrap();
        // Bannière du serveur, reçue telle quelle.
        let Some(Ok(Message::Binary(banniere))) = ws.next().await else { panic!("bannière attendue") };
        assert_eq!(&banniere[..], b"RFB 003.008\n");
        // Ce que le client envoie arrive au serveur (qui le renvoie).
        ws.send(Message::Binary(b"RFB 003.008\n".to_vec().into())).await.unwrap();
        let Some(Ok(Message::Binary(echo))) = ws.next().await else { panic!("écho attendu") };
        assert_eq!(&echo[..], b"RFB 003.008\n");
        pont.stop();
    }

    #[tokio::test]
    async fn refuse_un_jeton_qui_ne_correspond_pas() {
        let port = faux_serveur().await;
        let pont = start("127.0.0.1".into(), port).await.unwrap();
        let mauvais = pont.url.rsplit_once('/').unwrap().0.to_string() + "/mauvais-jeton";
        // La poignée de main WebSocket aboutit, mais le pont ferme sans jamais joindre la machine :
        // aucune bannière RFB ne doit arriver.
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&mauvais).await {
            let recu = tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await;
            assert!(!matches!(recu, Ok(Some(Ok(Message::Binary(_))))), "aucune donnée ne doit passer avec un mauvais jeton");
        }
        pont.stop();
    }
}
