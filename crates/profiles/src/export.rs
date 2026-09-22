//! Export et import des réglages de Helm (profils, clés d'hôte approuvées, snippets, tunnels),
//! pour changer de PC ou garder une copie de secours.
//!
//! Le fichier est chiffré (AES-256-GCM, clé dérivée du mot de passe par PBKDF2-SHA256) dès qu'un
//! mot de passe est fourni ; les secrets du coffre (mots de passe SSH, passphrases, sudo, restic)
//! ne peuvent être inclus que dans un fichier chiffré.

use std::collections::BTreeMap;
use std::num::NonZeroU32;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::{secrets, Identity, ServerProfile, Snippet, Store, TunnelDef};

const FORMAT: &str = "helm-export";
const ITERATIONS: u32 = 600_000;
pub(crate) const SECRET_KINDS: &[&str] = &["password", "passphrase", "sudo", "restic"];

/// Réglages transportés par un export ou une synchronisation. Les tables sont triées
/// (`BTreeMap`) : deux contenus identiques donnent le même JSON, donc la même empreinte.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Payload {
    pub servers: Vec<ServerProfile>,
    pub known_hosts: BTreeMap<String, String>,
    pub snippets: Vec<Snippet>,
    pub tunnels: Vec<TunnelDef>,
    /// Banque d'identifiants (absente des exports antérieurs).
    #[serde(default)]
    pub identities: Vec<Identity>,
    /// `id du serveur` (ou `identity-<id>`) → (`type de secret` → valeur). Vide si les secrets ne
    /// sont pas exportés.
    #[serde(default)]
    pub secrets: BTreeMap<String, BTreeMap<String, String>>,
}

/// Réglages actuels, avec les secrets du coffre si demandé.
pub(crate) fn snapshot(store: &Store, include_secrets: bool) -> Payload {
    let mut payload = store.read(|d| Payload {
        servers: d.servers.clone(),
        known_hosts: d.known_hosts.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        snippets: d.snippets.clone(),
        tunnels: d.tunnels.clone(),
        identities: d.identities.clone(),
        secrets: BTreeMap::new(),
    });
    if include_secrets {
        let owners: Vec<String> =
            payload.servers.iter().map(|s| s.id.clone()).chain(payload.identities.iter().map(|i| Identity::secret_owner(&i.id))).collect();
        for owner in owners {
            let found: BTreeMap<String, String> =
                SECRET_KINDS.iter().filter_map(|k| secrets::get(&owner, k).map(|v| (k.to_string(), v))).collect();
            if !found.is_empty() {
                payload.secrets.insert(owner, found);
            }
        }
    }
    payload
}

/// Enregistre dans le coffre les secrets d'un export (types connus uniquement).
pub(crate) fn store_secrets(from: &BTreeMap<String, BTreeMap<String, String>>) -> Result<(), String> {
    for (owner, kinds) in from {
        for (kind, value) in kinds {
            if SECRET_KINDS.contains(&kind.as_str()) {
                secrets::set(owner, kind, value)?;
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format: String,
    version: u32,
    encrypted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    /// JSON en clair, ou chiffré puis encodé en base64.
    data: serde_json::Value,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub servers: usize,
    pub identities: usize,
    pub snippets: usize,
    pub tunnels: usize,
    pub secrets: usize,
}

fn key(password: &str, salt: &[u8], iterations: u32) -> Result<LessSafeKey, String> {
    let mut k = [0u8; 32];
    let iterations = NonZeroU32::new(iterations).ok_or("paramètres de chiffrement invalides")?;
    ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, iterations, salt, password.as_bytes(), &mut k);
    Ok(LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &k).map_err(|_| "clé invalide")?))
}

/// Contenu du fichier d'export. `password` vide : export en clair, sans secrets.
pub fn export(store: &Store, password: &str, include_secrets: bool) -> Result<String, String> {
    if include_secrets && password.is_empty() {
        return Err("un mot de passe est obligatoire pour exporter les secrets".into());
    }
    seal(&snapshot(store, include_secrets), password)
}

/// Enveloppe d'export d'un contenu : chiffrée si `password` n'est pas vide.
pub(crate) fn seal(payload: &Payload, password: &str) -> Result<String, String> {
    let json = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let envelope = if password.is_empty() {
        Envelope {
            format: FORMAT.into(),
            version: 1,
            encrypted: false,
            iterations: None,
            salt: None,
            nonce: None,
            data: serde_json::from_slice(&json).map_err(|e| e.to_string())?,
        }
    } else {
        let rng = SystemRandom::new();
        let (mut salt, mut nonce) = ([0u8; 16], [0u8; 12]);
        rng.fill(&mut salt).map_err(|_| "aléa indisponible")?;
        rng.fill(&mut nonce).map_err(|_| "aléa indisponible")?;
        let mut sealed = json;
        key(password, &salt, ITERATIONS)?
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(FORMAT), &mut sealed)
            .map_err(|_| "chiffrement impossible")?;
        Envelope {
            format: FORMAT.into(),
            version: 1,
            encrypted: true,
            iterations: Some(ITERATIONS),
            salt: Some(B64.encode(salt)),
            nonce: Some(B64.encode(nonce)),
            data: serde_json::Value::String(B64.encode(sealed)),
        }
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())
}

/// Le fichier est-il chiffré (faut-il demander un mot de passe) ?
pub fn is_encrypted(text: &str) -> Result<bool, String> {
    let e: Envelope = serde_json::from_str(text).map_err(|_| "ce fichier n'est pas un export de Helm")?;
    if e.format != FORMAT {
        return Err("ce fichier n'est pas un export de Helm".into());
    }
    Ok(e.encrypted)
}

pub(crate) fn open(text: &str, password: &str) -> Result<Payload, String> {
    let e: Envelope = serde_json::from_str(text).map_err(|_| "ce fichier n'est pas un export de Helm")?;
    if e.format != FORMAT || e.version != 1 {
        return Err("format d'export inconnu (fichier d'une version plus récente de Helm ?)".into());
    }
    if !e.encrypted {
        return serde_json::from_value(e.data).map_err(|err| format!("export illisible : {err}"));
    }
    let bad = || "export chiffré illisible".to_string();
    let salt = B64.decode(e.salt.ok_or_else(bad)?).map_err(|_| bad())?;
    let nonce: [u8; 12] = B64.decode(e.nonce.ok_or_else(bad)?).map_err(|_| bad())?.try_into().map_err(|_| bad())?;
    let mut data = B64.decode(e.data.as_str().ok_or_else(bad)?).map_err(|_| bad())?;
    let plain = key(password, &salt, e.iterations.unwrap_or(ITERATIONS))?
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(FORMAT), &mut data)
        .map_err(|_| "mot de passe incorrect (ou fichier modifié)".to_string())?;
    serde_json::from_slice(plain).map_err(|err| format!("export illisible : {err}"))
}

/// Fusionne un export dans la configuration : un élément de même identifiant est remplacé,
/// les autres sont ajoutés. Rien n'est supprimé.
pub fn import(store: &Store, text: &str, password: &str) -> Result<ImportSummary, String> {
    let p = open(text, password)?;
    let summary = ImportSummary {
        servers: p.servers.len(),
        identities: p.identities.len(),
        snippets: p.snippets.len(),
        tunnels: p.tunnels.len(),
        secrets: p.secrets.values().map(BTreeMap::len).sum(),
    };
    store.write(|d| {
        fn merge<T>(into: &mut Vec<T>, from: Vec<T>, id: impl Fn(&T) -> &str) {
            for item in from {
                match into.iter_mut().find(|x| id(x) == id(&item)) {
                    Some(existing) => *existing = item,
                    None => into.push(item),
                }
            }
        }
        merge(&mut d.servers, p.servers, |s| &s.id);
        merge(&mut d.snippets, p.snippets, |s| &s.id);
        merge(&mut d.tunnels, p.tunnels, |t| &t.id);
        merge(&mut d.identities, p.identities, |i| &i.id);
        d.known_hosts.extend(p.known_hosts);
    })?;
    store_secrets(&p.secrets)?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AuthKind;

    fn store_with_server(dir: &std::path::Path) -> Store {
        let s = Store::open(dir);
        s.write(|d| {
            d.servers.push(ServerProfile {
                id: "a".into(),
                name: "VPS".into(),
                host: "h".into(),
                port: 22,
                username: "u".into(),
                auth_kind: AuthKind::Key,
                key_path: Some("C:/cle.ppk".into()),
                color: None,
                group: None,
                ai_access: false,
                jump_id: None,
                identity_id: None,
            });
            d.known_hosts.insert("h:22".into(), "SHA256:x".into());
        })
        .unwrap();
        s
    }

    #[test]
    fn encrypted_round_trip() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let text = export(&store_with_server(a.path()), "mot de passe", false).unwrap();
        assert!(is_encrypted(&text).unwrap());
        assert!(!text.contains("VPS") && !text.contains("cle.ppk"), "rien n'est lisible en clair");
        assert!(import(&Store::open(b.path()), &text, "mauvais").is_err());
        let target = Store::open(b.path());
        assert_eq!(import(&target, &text, "mot de passe").unwrap().servers, 1);
        assert_eq!(target.read(|d| d.known_hosts.get("h:22").cloned()), Some("SHA256:x".into()));
    }

    #[test]
    fn plain_export_and_merge() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let text = export(&store_with_server(a.path()), "", false).unwrap();
        assert!(!is_encrypted(&text).unwrap());
        assert!(export(&store_with_server(a.path()), "", true).is_err(), "secrets interdits en clair");
        let target = store_with_server(b.path());
        import(&target, &text, "").unwrap();
        assert_eq!(target.read(|d| d.servers.len()), 1, "même identifiant : remplacé, pas dupliqué");
        assert!(is_encrypted("{}").is_err());
    }
}
