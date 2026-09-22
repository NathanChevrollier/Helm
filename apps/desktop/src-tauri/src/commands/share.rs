//! Terminaux partagés : diffuser un terminal à d'autres personnes (lecture seule ou avec le
//! contrôle), et rejoindre celui de quelqu'un d'autre.
//!
//! Tout passe par un serveur `helm-sync` auto-hébergé, qui ne fait que relayer : le contenu est
//! chiffré de bout en bout (AES-256-GCM) avec une clé tirée au hasard, présente uniquement dans
//! le lien d'invitation. Le relais ne voit jamais ce qui s'affiche ni ce qui est tapé.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message as Ws;

use crate::sessions::{Sessions, TermEvent};
use crate::store::{secrets, Store};

/// Préfixe d'une invitation à un terminal partagé.
pub const INVITE_PREFIX: &str = "helm-term:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareMode {
    /// Les invités regardent seulement.
    View,
    /// Les invités peuvent aussi taper dans le terminal.
    Control,
}

/// Contenu d'une invitation (jamais transmis au relais : il voyage de la main à la main).
#[derive(Serialize, Deserialize)]
struct Invite {
    /// Adresse du serveur relais.
    u: String,
    /// Identifiant de session.
    s: String,
    /// Clé de chiffrement (base64url).
    k: String,
    m: ShareMode,
    /// Étiquette affichée à l'invité.
    #[serde(default)]
    l: String,
}

fn encode_invite(inv: &Invite) -> Result<String, String> {
    Ok(format!("{INVITE_PREFIX}{}", B64URL.encode(serde_json::to_vec(inv).map_err(|e| e.to_string())?)))
}

fn decode_invite(code: &str) -> Result<Invite, String> {
    let raw = code.trim().strip_prefix(INVITE_PREFIX).ok_or("ce n'est pas une invitation Helm (elle commence par helm-term:)")?;
    let bytes = B64URL.decode(raw.trim()).map_err(|_| "invitation incomplète ou abîmée".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "invitation illisible".into())
}

/// Chiffrement d'un message du canal partagé : `base64(nonce || chiffré)`.
fn seal(key: &LessSafeKey, plain: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; 12];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "aléa indisponible")?;
    let mut data = plain.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data).map_err(|_| "chiffrement impossible")?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&data);
    Ok(B64.encode(out))
}

fn open(key: &LessSafeKey, message: &str) -> Result<Vec<u8>, String> {
    let raw = B64.decode(message.trim()).map_err(|_| "message illisible".to_string())?;
    if raw.len() < 13 {
        return Err("message tronqué".into());
    }
    let (nonce, rest) = raw.split_at(12);
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| "message illisible".to_string())?;
    let mut data = rest.to_vec();
    let plain =
        key.open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data).map_err(|_| "message refusé (clé différente)")?;
    Ok(plain.to_vec())
}

fn key_from(b64: &str) -> Result<LessSafeKey, String> {
    let bytes = B64URL.decode(b64).map_err(|_| "clé invalide".to_string())?;
    let unbound = UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| "clé invalide")?;
    Ok(LessSafeKey::new(unbound))
}

/// `wss://…` à partir de l'adresse du serveur (`https://…`).
fn ws_url(base: &str, session: &str, role: &str) -> String {
    let base = base.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{base}")
    };
    format!("{ws}/v1/relay/{session}?role={role}")
}

/// Envoie un bloc de sortie chiffré aux invités ; `false` si le relais a coupé.
async fn send_data<S>(tx: &mut S, key: &LessSafeKey, bytes: &[u8]) -> bool
where
    S: SinkExt<Ws> + Unpin,
{
    let msg = json!({ "t": "data", "d": B64.encode(bytes) }).to_string();
    match seal(key, msg.as_bytes()) {
        Ok(sealed) => tx.send(Ws::Text(sealed.into())).await.is_ok(),
        Err(_) => false,
    }
}

/// Évènements d'un partage, pour l'interface de celui qui partage.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShareEvent {
    /// Un invité vient d'arriver : l'interface envoie l'écran courant pour qu'il voie la suite.
    GuestJoined,
    Ended {
        reason: String,
    },
}

struct Share {
    task: tauri::async_runtime::JoinHandle<()>,
    /// Messages à envoyer aux invités (déjà en clair, chiffrés par la tâche).
    outbox: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    invite: String,
    mode: ShareMode,
}

#[derive(Default)]
pub struct Shares {
    hosted: Mutex<HashMap<u64, Share>>,
    joined: Mutex<HashMap<u64, Joined>>,
    next: AtomicU64,
}

struct Joined {
    task: tauri::async_runtime::JoinHandle<()>,
    outbox: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    /// Terminal partagé (identifiant local).
    term_id: u64,
    invite: String,
    mode: ShareMode,
}

/// Adresse et jeton du relais : ceux de la synchronisation, déjà configurés.
fn relay_config(store: &Store) -> Result<(String, String), String> {
    let url = store
        .read(|d| d.sync.as_ref().and_then(|c| c.url.clone()))
        .filter(|u| !u.is_empty())
        .ok_or("configure d'abord un serveur de synchronisation (Réglages → Synchronisation) : il sert aussi de relais")?;
    let token = secrets::get(helm_profiles::sync::SECRET_OWNER, "token").ok_or("jeton du serveur manquant (Réglages → Synchronisation)")?;
    Ok((url, token))
}

/// Ouvre une session de partage sur le relais et renvoie l'invitation à transmettre.
#[tauri::command]
pub async fn term_share_start(
    app: AppHandle,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    shares: State<'_, Shares>,
    term_id: u64,
    label: String,
    mode: ShareMode,
    on_event: Channel<ShareEvent>,
) -> Result<ShareInfo, String> {
    if !sessions.is_open(term_id).await {
        return Err("ce terminal n'est pas connecté".into());
    }
    if shares.hosted.lock().await.contains_key(&term_id) {
        return Err("ce terminal est déjà partagé".into());
    }
    let (url, token) = relay_config(&store)?;

    // Ouverture de la session (le jeton ne sort que vers ton propre serveur).
    let (base, bearer) = (url.clone(), token.clone());
    let session: String = tokio::task::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(15))).build().into();
        let mut res = agent
            .post(format!("{}/v1/relay", base.trim_end_matches('/')))
            .header("Authorization", format!("Bearer {bearer}"))
            .send_empty()
            .map_err(|e| format!("relais injoignable : {e}"))?;
        let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["session"].as_str().map(str::to_string))
            .ok_or_else(|| "réponse du relais illisible (jeton refusé ?)".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut key_bytes = [0u8; 32];
    SystemRandom::new().fill(&mut key_bytes).map_err(|_| "aléa indisponible")?;
    let key_b64 = B64URL.encode(key_bytes);
    let invite = encode_invite(&Invite { u: url.clone(), s: session.clone(), k: key_b64.clone(), m: mode, l: label })?;
    let key = key_from(&key_b64)?;

    let (outbox, mut outbox_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let mut mirror = sessions.mirror(term_id).await;
    let (ws, _) =
        tokio_tungstenite::connect_async(ws_url(&url, &session, "host")).await.map_err(|e| format!("relais injoignable : {e}"))?;

    let task = tauri::async_runtime::spawn(async move {
        let (mut tx, mut rx) = ws.split();
        let reason = loop {
            tokio::select! {
                // Sortie du terminal : chiffrée puis diffusée.
                bytes = mirror.recv() => match bytes {
                    Some(b) => {
                        if !send_data(&mut tx, &key, &b).await {
                            break "relais déconnecté".to_string();
                        }
                    }
                    None => break "terminal fermé".to_string(),
                },
                // Messages de l'interface (écran initial pour un invité qui arrive).
                extra = outbox_rx.recv() => match extra {
                    Some(b) => {
                        if !send_data(&mut tx, &key, &b).await {
                            break "relais déconnecté".to_string();
                        }
                    }
                    None => break "partage arrêté".to_string(),
                },
                incoming = rx.next() => match incoming {
                    Some(Ok(Ws::Text(text))) => {
                        let Ok(plain) = open(&key, &text) else { continue };
                        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&plain) else { continue };
                        match v["t"].as_str() {
                            Some("hello") => {
                                let _ = on_event.send(ShareEvent::GuestJoined);
                            }
                            // Frappe d'un invité : appliquée seulement si le partage donne le contrôle.
                            Some("input") if mode == ShareMode::Control => {
                                if let Some(data) = v["d"].as_str().and_then(|d| B64.decode(d).ok()) {
                                    let _ = app.state::<Sessions>().write_terminal(term_id, &data).await;
                                }
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break "relais déconnecté".to_string(),
                },
            }
        };
        let _ = on_event.send(ShareEvent::Ended { reason });
    });

    shares.hosted.lock().await.insert(term_id, Share { task, outbox, invite: invite.clone(), mode });
    log::info!("terminal {term_id} partagé (session {session}, mode {mode:?})");
    Ok(ShareInfo { term_id, invite, mode })
}

/// Envoie un contenu supplémentaire aux invités (écran courant quand quelqu'un rejoint).
#[tauri::command]
pub async fn term_share_send(shares: State<'_, Shares>, term_id: u64, data: String) -> Result<(), String> {
    let hosted = shares.hosted.lock().await;
    let share = hosted.get(&term_id).ok_or("ce terminal n'est pas partagé")?;
    share.outbox.send(data.into_bytes()).map_err(|_| "partage terminé".to_string())
}

#[tauri::command]
pub async fn term_share_stop(sessions: State<'_, Sessions>, shares: State<'_, Shares>, term_id: u64) -> Result<(), String> {
    if let Some(share) = shares.hosted.lock().await.remove(&term_id) {
        share.task.abort();
    }
    sessions.stop_mirror(term_id).await;
    Ok(())
}

/// Partages en cours (l'interface les retrouve après un changement d'onglet).
#[tauri::command]
pub async fn term_shares(shares: State<'_, Shares>) -> Result<Vec<ShareInfo>, String> {
    Ok(shares.hosted.lock().await.iter().map(|(id, s)| ShareInfo { term_id: *id, invite: s.invite.clone(), mode: s.mode }).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedInfo {
    id: u64,
    label: String,
    mode: ShareMode,
}

/// Rejoint le terminal partagé d'une invitation : la sortie arrive comme celle d'un terminal.
#[tauri::command]
pub async fn term_join(shares: State<'_, Shares>, code: String, on_event: Channel<TermEvent>) -> Result<JoinedInfo, String> {
    let invite = decode_invite(&code)?;
    let key = key_from(&invite.k)?;
    let (ws, _) = tokio_tungstenite::connect_async(ws_url(&invite.u, &invite.s, "guest"))
        .await
        .map_err(|e| format!("session introuvable ou terminée ({e})"))?;
    let (outbox, mut outbox_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let id = shares.next.fetch_add(1, Ordering::Relaxed) + 1;

    let task = tauri::async_runtime::spawn(async move {
        let (mut tx, mut rx) = ws.split();
        // « hello » : l'hôte envoie alors l'écran courant.
        if let Ok(sealed) = seal(&key, json!({ "t": "hello" }).to_string().as_bytes()) {
            let _ = tx.send(Ws::Text(sealed.into())).await;
        }
        loop {
            tokio::select! {
                outgoing = outbox_rx.recv() => match outgoing {
                    Some(data) => {
                        let msg = json!({ "t": "input", "d": B64.encode(&data) }).to_string();
                        let Ok(sealed) = seal(&key, msg.as_bytes()) else { break };
                        if tx.send(Ws::Text(sealed.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                incoming = rx.next() => match incoming {
                    Some(Ok(Ws::Text(text))) => {
                        let Ok(plain) = open(&key, &text) else { continue };
                        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&plain) else { continue };
                        if v["t"] == "data" {
                            if let Some(d) = v["d"].as_str() {
                                if on_event.send(TermEvent::Data { data: d.to_string() }).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                },
            }
        }
        let _ = on_event.send(TermEvent::Exit { code: None });
    });

    shares.joined.lock().await.insert(id, Joined { task, outbox });
    Ok(JoinedInfo { id, label: invite.l, mode: invite.m })
}

/// Frappe envoyée à l'hôte (refusée par lui si le partage est en lecture seule).
#[tauri::command]
pub async fn term_join_write(shares: State<'_, Shares>, id: u64, data: String) -> Result<(), String> {
    let joined = shares.joined.lock().await;
    let session = joined.get(&id).ok_or("session quittée")?;
    session.outbox.send(data.into_bytes()).map_err(|_| "session terminée".to_string())
}

#[tauri::command]
pub async fn term_join_close(shares: State<'_, Shares>, id: u64) -> Result<(), String> {
    if let Some(j) = shares.joined.lock().await.remove(&id) {
        j.task.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invites_round_trip() {
        let inv = Invite {
            u: "https://sync.exemple.fr".into(),
            s: "abcd".into(),
            k: B64URL.encode([7u8; 32]),
            m: ShareMode::View,
            l: "VPS".into(),
        };
        let code = encode_invite(&inv).unwrap();
        assert!(code.starts_with(INVITE_PREFIX) && !code.contains('\n'));
        let back = decode_invite(&format!("  {code}  ")).unwrap();
        assert_eq!((back.u, back.s, back.m), (inv.u, inv.s, ShareMode::View));
        assert!(decode_invite("bonjour").is_err());
        assert!(decode_invite("helm-term:???").is_err());
    }

    #[test]
    fn messages_are_encrypted() {
        let key_b64 = B64URL.encode([3u8; 32]);
        let key = key_from(&key_b64).unwrap();
        let sealed = seal(&key, b"ls -la").unwrap();
        assert!(!sealed.contains("ls -la"));
        assert_eq!(open(&key, &sealed).unwrap(), b"ls -la");
        // Deux chiffrements du même texte diffèrent (nonce à chaque message).
        assert_ne!(sealed, seal(&key, b"ls -la").unwrap());
        let other = key_from(&B64URL.encode([4u8; 32])).unwrap();
        assert!(open(&other, &sealed).is_err(), "clé différente : message refusé");
    }

    #[test]
    fn websocket_urls() {
        assert_eq!(ws_url("https://sync.exemple.fr/", "abc", "host"), "wss://sync.exemple.fr/v1/relay/abc?role=host");
        assert_eq!(ws_url("http://127.0.0.1:8091", "abc", "guest"), "ws://127.0.0.1:8091/v1/relay/abc?role=guest");
    }
}
