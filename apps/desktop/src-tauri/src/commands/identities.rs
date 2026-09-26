//! Banque d'identifiants : logins (utilisateur + mot de passe ou clé) réutilisables par
//! plusieurs serveurs. Les secrets restent dans le keyring de l'OS.

use helm_profiles::{AuthKind, Identity};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::sessions::Sessions;
use crate::store::{secrets, Store};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityView {
    #[serde(flatten)]
    identity: Identity,
    has_password: bool,
    has_passphrase: bool,
    /// Noms des serveurs qui utilisent cet identifiant.
    used_by: Vec<String>,
}

/// Secrets transmis avec un identifiant : `None` = inchangé, `Some("")` = supprimé.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySecrets {
    password: Option<String>,
    passphrase: Option<String>,
}

#[tauri::command]
pub fn identities_list(store: State<'_, Store>) -> Vec<IdentityView> {
    let (identities, servers) = store.read(|d| (d.identities.clone(), d.servers.clone()));
    identities
        .into_iter()
        .map(|identity| {
            let owner = Identity::secret_owner(&identity.id);
            IdentityView {
                has_password: secrets::has(&owner, "password"),
                has_passphrase: secrets::has(&owner, "passphrase"),
                used_by: servers.iter().filter(|s| s.identity_id.as_deref() == Some(&identity.id)).map(|s| s.name.clone()).collect(),
                identity,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn identity_save(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    mut identity: Identity,
    secrets_input: IdentitySecrets,
) -> Result<String, String> {
    identity.name = identity.name.trim().to_string();
    identity.username = identity.username.trim().to_string();
    if identity.username.is_empty() {
        return Err("l'utilisateur est obligatoire".into());
    }
    if identity.name.is_empty() {
        identity.name = identity.username.clone();
    }
    if identity.auth_kind == AuthKind::Key && identity.key_path.as_deref().unwrap_or("").trim().is_empty() {
        return Err("choisis la clé privée de cet identifiant".into());
    }
    if identity.id.is_empty() {
        identity.id = uuid::Uuid::new_v4().to_string();
    }
    let id = identity.id.clone();
    let owner = Identity::secret_owner(&id);
    for (kind, value) in [("password", &secrets_input.password), ("passphrase", &secrets_input.passphrase)] {
        if let Some(v) = value {
            secrets::set(&owner, kind, v)?;
        }
    }
    let username = identity.username.clone();
    let linked = store.write(|d| {
        match d.identities.iter_mut().find(|i| i.id == id) {
            Some(existing) => *existing = identity,
            None => d.identities.push(identity),
        }
        // Les profils liés affichent l'utilisateur de l'identifiant.
        let mut linked = Vec::new();
        for s in d.servers.iter_mut().filter(|s| s.identity_id.as_deref() == Some(&id)) {
            s.username = username.clone();
            linked.push(s.id.clone());
        }
        linked
    })?;
    // Les serveurs liés se reconnecteront avec les nouveaux paramètres.
    for server in linked {
        sessions.disconnect(&server).await;
        sessions.unblock(&server);
    }
    Ok(id)
}

#[tauri::command]
pub fn identity_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    let users: Vec<String> =
        store.read(|d| d.servers.iter().filter(|s| s.identity_id.as_deref() == Some(&id)).map(|s| s.name.clone()).collect());
    if !users.is_empty() {
        return Err(format!("identifiant utilisé par : {}. Change d'abord l'authentification de ces serveurs.", users.join(", ")));
    }
    store.write(|d| d.identities.retain(|i| i.id != id))?;
    secrets::delete_all(&Identity::secret_owner(&id));
    Ok(())
}
