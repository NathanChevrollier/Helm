//! Audit de sécurité et corrections guidées, avec vérification par une nouvelle connexion.

use std::time::Duration;

use helm_core::security::{self, FixOutcome, FixPlan, Report};
use helm_core::Connection;
use helm_profiles::AuthKind;
use tauri::State;

use crate::commands::{admin, track};
use crate::sessions::Sessions;
use crate::store::{AuditLog, Store};

fn err(e: impl ToString) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn security_audit(store: State<'_, Store>, sessions: State<'_, Sessions>, server_id: String) -> Result<Report, String> {
    let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
    security::audit(&conn, sudo.as_deref()).await.map_err(err)
}

#[tauri::command]
pub fn security_fix_plan(id: String) -> Result<FixPlan, String> {
    security::fix_plan(&id).map_err(err)
}

/// Refuse d'avance les corrections qui couperaient l'accès de Helm lui-même.
fn guard(store: &Store, server_id: &str, fix: &str) -> Result<(), String> {
    let p = store.server(server_id)?;
    let by_password = p.auth_kind == AuthKind::Password;
    if fix == "disable-password-auth" && by_password {
        return Err(
            "Helm se connecte à ce serveur par mot de passe : configure d'abord une clé SSH dans le profil, sinon tu serais bloqué dehors."
                .into(),
        );
    }
    if fix == "root-prohibit-password" && by_password && p.username == "root" {
        return Err(
            "Tu te connectes en root par mot de passe : configure d'abord une clé SSH dans le profil, sinon tu serais bloqué dehors."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn security_fix_apply(
    audit: State<'_, AuditLog>,
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    server_id: String,
    id: String,
) -> Result<FixOutcome, String> {
    let r: Result<FixOutcome, String> = async {
        guard(&store, &server_id, &id)?;
        let plan = security::fix_plan(&id).map_err(err)?;
        let (conn, sudo) = admin(&store, &sessions, &server_id).await?;
        let mut outcome = security::apply_fix(&conn, sudo.as_deref(), &id).await.map_err(err)?;
        if !outcome.ok || !plan.needs_verification {
            return Ok(outcome);
        }
        // Connexion de contrôle, entièrement nouvelle, pendant que la connexion d'origine reste ouverte.
        let params = store.connect_params(&server_id)?;
        let check = tokio::time::timeout(Duration::from_secs(20), async {
            let c = Connection::connect(params).await.map_err(err)?;
            c.run("true").await.map_err(err)?;
            c.disconnect().await;
            Ok::<_, String>(())
        })
        .await
        .unwrap_or_else(|_| Err("délai dépassé".into()));
        if let Err(e) = check {
            let undo = match &outcome.rollback {
                Some(token) => security::rollback(&conn, sudo.as_deref(), token).await.map_err(err)?,
                None => String::new(),
            };
            outcome.ok = false;
            outcome.output = format!(
                "{}\n\nLa connexion de contrôle a échoué ({e}) : la modification a été annulée automatiquement.\n{undo}",
                outcome.output
            );
        } else {
            outcome.output.push_str("\n\nConnexion de contrôle réussie : la modification est conservée.");
        }
        Ok(outcome)
    }
    .await;
    let r = match r {
        Ok(o) if !o.ok => {
            // Journalisé comme échec, mais renvoyé tel quel pour afficher la sortie.
            let name = store.server(&server_id).map(|s| s.name).unwrap_or_default();
            audit.record(&server_id, &name, "security.fix", &id, Err("échec ou annulé"));
            return Ok(o);
        }
        other => other,
    };
    track(&audit, &store, &server_id, "security.fix", &id, r)
}
