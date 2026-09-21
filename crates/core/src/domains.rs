//! Vérifications des domaines des sites, depuis le PC : où pointe le DNS (bien vers ce VPS ?) et
//! date d'expiration de l'enregistrement du domaine (RDAP, l'annuaire public qui remplace whois).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DomainInfo {
    pub domain: String,
    pub ips: Vec<String>,
    /// `ok` (pointe vers ce serveur), `elsewhere` (ailleurs : autre serveur ou proxy type Cloudflare),
    /// `missing` (aucun enregistrement), `unknown` (IP du serveur inconnue).
    pub dns: String,
    pub dns_detail: String,
    /// Domaine enregistré (`exemple.fr` pour `app.exemple.fr`).
    pub registrable: String,
    /// Date d'expiration de l'enregistrement (ISO 8601), si l'annuaire la publie.
    pub expires: Option<String>,
}

/// Suffixes publics à deux niveaux les plus courants (`co.uk`, `com.au`…).
const TWO_LEVEL: &[&str] = &[
    "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br", "com.cn", "co.in", "gouv.fr",
    "asso.fr", "com.fr", "co.za", "com.mx", "com.tr",
];

pub fn registrable(domain: &str) -> String {
    let labels: Vec<&str> = domain.trim_end_matches('.').split('.').collect();
    if labels.len() <= 2 {
        return domain.to_string();
    }
    let last_two = labels[labels.len() - 2..].join(".");
    let keep = if TWO_LEVEL.contains(&last_two.as_str()) { 3 } else { 2 };
    labels[labels.len().saturating_sub(keep)..].join(".")
}

/// Date d'expiration dans une réponse RDAP (`events[].eventAction == "expiration"`).
pub fn rdap_expiration(json: &serde_json::Value) -> Option<String> {
    json.get("events")?
        .as_array()?
        .iter()
        .find(|e| e.get("eventAction").and_then(|a| a.as_str()) == Some("expiration"))?
        .get("eventDate")?
        .as_str()
        .map(str::to_string)
}

/// Expiration par domaine, avec l'heure de la requête (les annuaires limitent le nombre d'appels).
type RdapCache = HashMap<String, (Instant, Option<String>)>;
static RDAP_CACHE: Mutex<Option<RdapCache>> = Mutex::new(None);
const RDAP_TTL: Duration = Duration::from_secs(12 * 3600);

async fn expiration(domain: &str) -> Option<String> {
    if let Some((at, v)) = RDAP_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(domain) {
        if at.elapsed() < RDAP_TTL {
            return v.clone();
        }
    }
    let url = format!("https://rdap.org/domain/{domain}");
    let value = tokio::task::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().into();
        let body = agent.get(&url).header("Accept", "application/rdap+json").call().ok()?.body_mut().read_to_string().ok()?;
        rdap_expiration(&serde_json::from_str(&body).ok()?)
    })
    .await
    .ok()
    .flatten();
    RDAP_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(domain.to_string(), (Instant::now(), value.clone()));
    value
}

pub async fn check(domains: &[String], server_ips: &[IpAddr]) -> Vec<DomainInfo> {
    let mut out = Vec::new();
    let mut expiries: HashMap<String, Option<String>> = HashMap::new();
    for d in domains {
        let reg = registrable(d);
        if !expiries.contains_key(&reg) {
            let e = expiration(&reg).await;
            expiries.insert(reg.clone(), e);
        }
        let resolved: Vec<IpAddr> = match tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((d.as_str(), 443))).await {
            Ok(Ok(addrs)) => {
                let mut v: Vec<IpAddr> = addrs.map(|a| a.ip()).collect();
                v.dedup();
                v
            }
            _ => vec![],
        };
        let (dns, detail) = if resolved.is_empty() {
            ("missing", "aucune adresse : le sous-domaine n'existe pas (ou pas encore) dans le DNS".to_string())
        } else if server_ips.is_empty() {
            ("unknown", "adresse du serveur inconnue".to_string())
        } else if resolved.iter().any(|ip| server_ips.contains(ip)) {
            ("ok", "pointe vers ce serveur".to_string())
        } else {
            ("elsewhere", "pointe ailleurs : autre serveur, ancien enregistrement, ou proxy (Cloudflare…)".to_string())
        };
        out.push(DomainInfo {
            domain: d.clone(),
            ips: resolved.iter().map(IpAddr::to_string).collect(),
            dns: dns.into(),
            dns_detail: detail,
            expires: expiries.get(&reg).cloned().flatten(),
            registrable: reg,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrable_domains() {
        assert_eq!(registrable("app.exemple.fr"), "exemple.fr");
        assert_eq!(registrable("exemple.fr"), "exemple.fr");
        assert_eq!(registrable("a.b.site.co.uk"), "site.co.uk");
    }

    #[test]
    fn rdap() {
        let j: serde_json::Value = serde_json::from_str(r#"{"events":[{"eventAction":"registration","eventDate":"2020-01-01T00:00:00Z"},{"eventAction":"expiration","eventDate":"2027-02-24T10:00:00Z"}]}"#).unwrap();
        assert_eq!(rdap_expiration(&j).as_deref(), Some("2027-02-24T10:00:00Z"));
    }
}
