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

use crate::{secrets, Identity, IgnoredFinding, RemoteDesktop, ServerProfile, Snippet, Store, TunnelDef};

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
    /// Bureaux à distance (absents des exports antérieurs).
    #[serde(default)]
    pub desktops: Vec<RemoteDesktop>,
    /// Constats d'audit ignorés.
    #[serde(default)]
    pub ignored_findings: Vec<IgnoredFinding>,
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
        desktops: d.desktops.clone(),
        ignored_findings: d.ignored_findings.clone(),
        secrets: BTreeMap::new(),
    });
    if include_secrets {
        let owners: Vec<String> = payload
            .servers
            .iter()
            .map(|s| s.id.clone())
            .chain(payload.identities.iter().map(|i| Identity::secret_owner(&i.id)))
            .chain(payload.desktops.iter().map(|r| RemoteDesktop::secret_owner(&r.id)))
            .collect();
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

/// Préfixe d'un partage transmis sous forme de texte (à coller dans une conversation).
pub const SHARE_PREFIX: &str = "helm-share:";

/// Partage d'une sélection de serveurs : leurs identifiants de la banque, les clés d'hôte
/// approuvées correspondantes et, si demandé, leurs secrets. Toujours chiffré.
pub fn share(store: &Store, ids: &[String], password: &str, include_secrets: bool) -> Result<String, String> {
    if password.is_empty() {
        return Err("choisis un mot de passe : un partage est toujours chiffré".into());
    }
    let full = snapshot(store, include_secrets);
    // Les serveurs de rebond d'un serveur partagé le suivent, sinon il serait inutilisable.
    let mut wanted: Vec<String> = ids.to_vec();
    let mut i = 0;
    while i < wanted.len() {
        if let Ok(chain) = store.jump_chain(&wanted[i]) {
            for j in chain {
                if !wanted.contains(&j) {
                    wanted.push(j);
                }
            }
        }
        i += 1;
    }
    let servers: Vec<ServerProfile> = full.servers.into_iter().filter(|s| wanted.contains(&s.id)).collect();
    if servers.is_empty() {
        return Err("aucun serveur à partager".into());
    }
    let hosts: Vec<String> = servers.iter().map(|s| format!("{}:{}", s.host, s.port)).collect();
    let identity_ids: Vec<String> = servers.iter().filter_map(|s| s.identity_id.clone()).collect();
    let owners: Vec<String> = servers.iter().map(|s| s.id.clone()).chain(identity_ids.iter().map(|i| Identity::secret_owner(i))).collect();
    let payload = Payload {
        known_hosts: full.known_hosts.into_iter().filter(|(k, _)| hosts.contains(k)).collect(),
        identities: full.identities.into_iter().filter(|i| identity_ids.contains(&i.id)).collect(),
        secrets: full.secrets.into_iter().filter(|(owner, _)| owners.contains(owner)).collect(),
        servers,
        snippets: vec![],
        tunnels: vec![],
        desktops: vec![],
        ignored_findings: vec![],
    };
    seal(&payload, password)
}

/// Partage sous forme de code d'une seule ligne, à coller dans une conversation.
pub fn to_code(text: &str) -> String {
    format!("{SHARE_PREFIX}{}", B64.encode(text.as_bytes()))
}

/// Texte d'un partage reçu : code d'une ligne ou contenu de fichier, indifféremment.
pub fn from_code(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let Some(code) = trimmed.strip_prefix(SHARE_PREFIX) else {
        return Ok(trimmed.to_string());
    };
    let bytes = B64.decode(code.trim().as_bytes()).map_err(|_| "ce code de partage est incomplet ou abîmé".to_string())?;
    String::from_utf8(bytes).map_err(|_| "ce code de partage est illisible".into())
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
        merge(&mut d.desktops, p.desktops, |r| &r.id);
        for item in p.ignored_findings {
            if !d.ignored_findings.iter().any(|x| x.server_id == item.server_id && x.finding_id == item.finding_id) {
                d.ignored_findings.push(item);
            }
        }
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
    fn share_selection_and_code() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = store_with_server(a.path());
        source
            .write(|d| {
                let mut other = d.servers[0].clone();
                other.id = "b".into();
                other.name = "Autre".into();
                other.host = "autre".into();
                d.servers.push(other);
                d.snippets.push(Snippet { id: "s".into(), name: "n".into(), command: "ls".into() });
            })
            .unwrap();
        assert!(share(&source, &[], "mot de passe long", false).is_err(), "sélection vide");
        assert!(share(&source, &["a".into()], "", false).is_err(), "mot de passe obligatoire");
        let code = to_code(&share(&source, &["a".into()], "mot de passe long", false).unwrap());
        assert!(code.starts_with(SHARE_PREFIX) && !code.contains('\n'), "une seule ligne à coller");

        let target = Store::open(b.path());
        let summary = import(&target, &from_code(&code).unwrap(), "mot de passe long").unwrap();
        assert_eq!((summary.servers, summary.snippets), (1, 0), "seul le serveur choisi est partagé");
        assert_eq!(target.read(|d| d.servers[0].name.clone()), "VPS");
        assert_eq!(target.read(|d| d.known_hosts.len()), 1);
        assert!(from_code("helm-share:pas du base64 !").is_err());
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
