//! Localisation des adresses IP (fail2ban), entièrement sur le PC.
//!
//! Aucune adresse n'est envoyée à un service tiers : Zenytt télécharge, à la demande de
//! l'utilisateur, les bases libres « IP to Country Lite » et « IP to ASN Lite » de DB-IP
//! (licence CC BY 4.0, attribution affichée dans l'interface), puis les consulte localement.
//! Le seul échange réseau est ce téléchargement, depuis download.db-ip.com, environ une fois par mois.

use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use maxminddb::{geoip2, Reader};
use serde::Serialize;
use tauri::{Manager, State};
use tokio::sync::Mutex;

const COUNTRY_FILE: &str = "dbip-country-lite.mmdb";
const ASN_FILE: &str = "dbip-asn-lite.mmdb";
/// Les bases sont republiées chaque mois ; au-delà, on propose de les rafraîchir.
const STALE_AFTER: Duration = Duration::from_secs(40 * 86400);

#[derive(Default)]
pub struct Geo(Mutex<Option<Bases>>);

struct Bases {
    country: Reader<Vec<u8>>,
    asn: Option<Reader<Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoStatus {
    installed: bool,
    /// Date du fichier (secondes Unix).
    updated_at: Option<u64>,
    stale: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeoInfo {
    country_code: Option<String>,
    country: Option<String>,
    asn: Option<u32>,
    /// Opérateur du réseau (hébergeur, FAI…).
    org: Option<String>,
}

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("geo"))
}

fn open(dir: &std::path::Path) -> Option<Bases> {
    let country = Reader::from_source(std::fs::read(dir.join(COUNTRY_FILE)).ok()?).ok()?;
    let asn = std::fs::read(dir.join(ASN_FILE)).ok().and_then(|b| Reader::from_source(b).ok());
    Some(Bases { country, asn })
}

#[tauri::command]
pub fn geo_status(app: tauri::AppHandle) -> Result<GeoStatus, String> {
    let path = dir(&app)?.join(COUNTRY_FILE);
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let age = modified.and_then(|m| SystemTime::now().duration_since(m).ok());
    Ok(GeoStatus {
        installed: modified.is_some(),
        updated_at: modified.and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
        stale: age.is_some_and(|a| a > STALE_AFTER),
    })
}

/// Mois publiés à essayer : le mois courant, puis le précédent (la base du mois paraît dans ses
/// premiers jours).
fn months() -> [String; 2] {
    let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (y, m) = year_month(secs / 86400);
    let (py, pm) = if m == 1 { (y - 1, 12) } else { (y, m - 1) };
    [format!("{y:04}-{m:02}"), format!("{py:04}-{pm:02}")]
}

/// Année et mois d'un nombre de jours depuis 1970 (calendrier civil, algorithme de H. Hinnant).
fn year_month(days: i64) -> (i64, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m)
}

fn download(kind: &str) -> Result<Vec<u8>, String> {
    let agent: ureq::Agent =
        ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(120))).http_status_as_error(false).build().into();
    let mut last = String::new();
    for month in months() {
        let url = format!("https://download.db-ip.com/free/dbip-{kind}-lite-{month}.mmdb.gz");
        let mut res = agent.get(&url).call().map_err(|e| format!("téléchargement impossible : {e}"))?;
        if res.status() != 200 {
            last = format!("{url} : HTTP {}", res.status());
            continue;
        }
        let gz = res.body_mut().with_config().limit(128 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut out).map_err(|e| format!("archive illisible : {e}"))?;
        // Vérifie que c'est bien une base lisible avant de remplacer l'ancienne.
        Reader::from_source(out.clone()).map_err(|e| format!("base illisible : {e}"))?;
        return Ok(out);
    }
    Err(format!("base introuvable ({last})"))
}

/// Télécharge (ou rafraîchit) les bases DB-IP Lite dans le dossier de l'app.
#[tauri::command]
pub async fn geo_install(app: tauri::AppHandle, geo: State<'_, Geo>) -> Result<GeoStatus, String> {
    let dir = dir(&app)?;
    let target = dir.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let country = download("country")?;
        // L'opérateur est un plus : son absence n'empêche pas la localisation par pays.
        let asn = download("asn").ok();
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        std::fs::write(target.join(COUNTRY_FILE), country).map_err(|e| e.to_string())?;
        if let Some(asn) = asn {
            std::fs::write(target.join(ASN_FILE), asn).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    *geo.0.lock().await = open(&dir);
    geo_status(app)
}

/// Pays et opérateur de chaque adresse (celles qu'on ne sait pas situer sont absentes).
#[tauri::command]
pub async fn geo_lookup(app: tauri::AppHandle, geo: State<'_, Geo>, ips: Vec<String>) -> Result<HashMap<String, GeoInfo>, String> {
    let mut guard = geo.0.lock().await;
    if guard.is_none() {
        *guard = open(&dir(&app)?);
    }
    let Some(bases) = guard.as_ref() else { return Ok(HashMap::new()) };
    let mut out = HashMap::new();
    for ip in ips {
        let Ok(addr) = ip.parse::<IpAddr>() else { continue };
        let mut info = GeoInfo::default();
        if let Ok(Some(c)) = bases.country.lookup(addr).and_then(|r| r.decode::<geoip2::Country>()) {
            info.country_code = c.country.iso_code.map(str::to_string);
            info.country = c.country.names.french.or(c.country.names.english).map(str::to_string);
        }
        if let Some(Ok(Some(a))) = bases.asn.as_ref().map(|r| r.lookup(addr).and_then(|r| r.decode::<geoip2::Asn>())) {
            info.asn = a.autonomous_system_number;
            info.org = a.autonomous_system_organization.map(str::to_string);
        }
        if info.country_code.is_some() || info.asn.is_some() {
            out.insert(ip, info);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar() {
        assert_eq!(year_month(0), (1970, 1));
        // 30 septembre 2026 = 20 726 jours après le 1er janvier 1970.
        assert_eq!(year_month(20_726), (2026, 9));
        assert_eq!(year_month(20_727), (2026, 10));
        assert_eq!(year_month(19_782), (2024, 2), "29 février 2024");
    }
}
