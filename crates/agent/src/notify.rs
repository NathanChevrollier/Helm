//! Envoi des notifications : Discord, ntfy et webhook générique.

use std::time::Duration;

use helm_protocol::Notifiers;

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .user_agent(concat!("helmd/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn check(res: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<(), String> {
    match res {
        Ok(r) if r.status().as_u16() < 300 => Ok(()),
        Ok(r) => Err(format!("HTTP {}", r.status().as_u16())),
        Err(e) => Err(e.to_string()),
    }
}

/// Envoie la notification sur tous les canaux configurés. Renvoie les erreurs par canal.
pub fn send(n: &Notifiers, title: &str, message: &str, resolved: bool) -> Vec<String> {
    let a = agent();
    let mut errors = Vec::new();
    let nonempty = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    if let Some(url) = nonempty(&n.discord_webhook) {
        let body = serde_json::json!({
            "username": "Helm",
            "embeds": [{
                "title": title,
                "description": message,
                "color": if resolved { 0x3fb950 } else { 0xf85149 },
            }]
        });
        if let Err(e) = check(a.post(&url).header("Content-Type", "application/json").send(body.to_string())) {
            errors.push(format!("Discord : {e}"));
        }
    }
    if let Some(url) = nonempty(&n.ntfy_url) {
        let res = a
            .post(&url)
            .header("Title", title)
            .header("Priority", if resolved { "default" } else { "high" })
            .header("Tags", if resolved { "white_check_mark" } else { "rotating_light" })
            .send(message);
        if let Err(e) = check(res) {
            errors.push(format!("ntfy : {e}"));
        }
    }
    if let Some(url) = nonempty(&n.webhook_url) {
        let body = serde_json::json!({
            "title": title,
            "message": message,
            "severity": if resolved { "resolved" } else { "critical" },
        });
        if let Err(e) = check(a.post(&url).header("Content-Type", "application/json").send(body.to_string())) {
            errors.push(format!("Webhook : {e}"));
        }
    }
    errors
}

/// Code HTTP renvoyé par une URL, pour la supervision de disponibilité.
pub fn probe(url: &str) -> Result<u16, String> {
    agent().get(url).call().map(|r| r.status().as_u16()).map_err(|e| e.to_string())
}

pub fn any_configured(n: &Notifiers) -> bool {
    [&n.discord_webhook, &n.ntfy_url, &n.webhook_url]
        .iter()
        .any(|s| s.as_deref().is_some_and(|s| !s.trim().is_empty()))
}
