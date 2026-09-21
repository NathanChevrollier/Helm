//! Évaluation des règles d'alerte : seuil soutenu pendant une durée, avec hystérésis à la résolution.

use std::collections::HashMap;

use helm_protocol::{ActiveAlert, AgentConfig, Metrics};

/// Transition à notifier.
#[derive(Debug, Clone, PartialEq)]
pub enum Transition {
    Fired(ActiveAlert),
    Resolved(ActiveAlert),
}

#[derive(Default)]
pub struct Evaluator {
    /// Depuis quand chaque règle dépasse son seuil (ms).
    exceeded_since: HashMap<String, i64>,
    pub active: HashMap<String, ActiveAlert>,
    /// Relevés consécutifs revenus sous le seuil, pour ne résoudre qu'une baisse durable.
    below_count: HashMap<String, u32>,
    /// Échecs HTTP consécutifs par vérification.
    http_failures: HashMap<String, u32>,
}

/// Marge sous le seuil avant de considérer l'alerte résolue, pour éviter les oscillations.
const HYSTERESIS: f64 = 0.95;
/// Relevés consécutifs sous le seuil avant de déclarer l'alerte résolue.
const SAMPLES_BEFORE_RESOLVE: u32 = 3;
/// Nombre d'échecs HTTP consécutifs avant d'alerter.
const HTTP_FAILURES_BEFORE_ALERT: u32 = 2;

/// Clé stable d'une règle : deux règles sur la même métrique avec des seuils différents restent distinctes.
fn rule_key(rule: &helm_protocol::AlertRule) -> String {
    format!("rule:{:?}:{}", rule.metric, rule.threshold).to_lowercase()
}

fn fmt_value(metric: helm_protocol::AlertMetric, v: f64) -> String {
    match metric {
        helm_protocol::AlertMetric::Load => format!("{v:.2}"),
        _ => format!("{v:.0} %"),
    }
}

impl Evaluator {
    pub fn evaluate(&mut self, cfg: &AgentConfig, m: &Metrics, server: &str) -> Vec<Transition> {
        let mut out = Vec::new();
        let now = m.timestamp;
        for rule in cfg.rules.iter().filter(|r| r.enabled) {
            let key = rule_key(rule);
            let value = rule.metric.value(m);
            if value > rule.threshold {
                self.below_count.remove(&key);
                let since = *self.exceeded_since.entry(key.clone()).or_insert(now);
                if now - since >= rule.for_secs as i64 * 1000 && !self.active.contains_key(&key) {
                    let alert = ActiveAlert {
                        key: key.clone(),
                        title: format!("{server} : {} élevé", rule.metric.label()),
                        message: format!(
                            "{} à {} (seuil {}{})",
                            rule.metric.label(),
                            fmt_value(rule.metric, value),
                            fmt_value(rule.metric, rule.threshold),
                            if rule.for_secs > 0 { format!(" depuis {} min", rule.for_secs.div_ceil(60)) } else { String::new() }
                        ),
                        since: now,
                    };
                    self.active.insert(key.clone(), alert.clone());
                    out.push(Transition::Fired(alert));
                }
            } else {
                self.exceeded_since.remove(&key);
                let below = self.below_count.entry(key.clone()).or_insert(0);
                if value <= rule.threshold * HYSTERESIS {
                    *below += 1;
                } else {
                    *below = 0;
                }
                if *below >= SAMPLES_BEFORE_RESOLVE {
                    if let Some(mut alert) = self.active.remove(&key) {
                        alert.title = format!("{server} : {} revenu à la normale", rule.metric.label());
                        alert.message = format!("{} à {}", rule.metric.label(), fmt_value(rule.metric, value));
                        out.push(Transition::Resolved(alert));
                    }
                }
            }
        }
        // Règles supprimées ou désactivées : on lève silencieusement leurs alertes.
        let live: Vec<String> = cfg.rules.iter().filter(|r| r.enabled).map(rule_key).collect();
        self.active.retain(|k, _| !k.starts_with("rule:") || live.contains(k));
        out
    }

    /// Contrôle du résultat de la dernière sauvegarde Helm (`/var/lib/helm-backup/last.json`).
    /// `last` = (réussie, fin en secondes Unix, message). `None` si les sauvegardes ne sont pas configurées.
    pub fn backup_result(&mut self, last: Option<(bool, i64, String)>, now_secs: i64, server: &str) -> Option<Transition> {
        const KEY: &str = "backup";
        const STALE_SECS: i64 = 36 * 3600;
        let problem = match &last {
            None => None,
            Some((false, _, msg)) => Some(format!("La dernière sauvegarde a échoué : {msg}")),
            Some((true, finished, _)) if now_secs - finished > STALE_SECS => {
                Some(format!("Aucune sauvegarde réussie depuis {} h", (now_secs - finished) / 3600))
            }
            _ => None,
        };
        match problem {
            Some(message) if !self.active.contains_key(KEY) => {
                let alert =
                    ActiveAlert { key: KEY.into(), title: format!("{server} : sauvegardes en échec"), message, since: now_secs * 1000 };
                self.active.insert(KEY.into(), alert.clone());
                Some(Transition::Fired(alert))
            }
            None => self.active.remove(KEY).map(|mut a| {
                a.title = format!("{server} : sauvegardes rétablies");
                a.message = "La dernière sauvegarde s'est bien déroulée.".into();
                Transition::Resolved(a)
            }),
            _ => None,
        }
    }

    pub fn http_result(&mut self, name: &str, url: &str, result: Result<u16, String>, now: i64, server: &str) -> Option<Transition> {
        let key = format!("http:{name}");
        match result {
            Ok(code) if code < 400 => {
                self.http_failures.remove(&key);
                self.active.remove(&key).map(|mut a| {
                    a.title = format!("{server} : {name} est de nouveau en ligne");
                    a.message = format!("{url} répond (HTTP {code})");
                    Transition::Resolved(a)
                })
            }
            other => {
                let count = self.http_failures.entry(key.clone()).or_insert(0);
                *count += 1;
                if *count < HTTP_FAILURES_BEFORE_ALERT || self.active.contains_key(&key) {
                    return None;
                }
                let reason = match other {
                    Ok(code) => format!("HTTP {code}"),
                    Err(e) => e,
                };
                let alert = ActiveAlert {
                    key: key.clone(),
                    title: format!("{server} : {name} est injoignable"),
                    message: format!("{url} : {reason}"),
                    since: now,
                };
                self.active.insert(key, alert.clone());
                Some(Transition::Fired(alert))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use helm_protocol::{AlertMetric, AlertRule};

    fn cfg(for_secs: u64) -> AgentConfig {
        AgentConfig { rules: vec![AlertRule { metric: AlertMetric::Cpu, threshold: 80.0, for_secs, enabled: true }], ..Default::default() }
    }

    fn m(t: i64, cpu: f32) -> Metrics {
        Metrics { timestamp: t, cpu_percent: cpu, ..Default::default() }
    }

    #[test]
    fn fires_after_duration_and_resolves_with_hysteresis() {
        let mut e = Evaluator::default();
        let c = cfg(60);
        assert!(e.evaluate(&c, &m(0, 95.0), "vps").is_empty());
        assert!(e.evaluate(&c, &m(30_000, 95.0), "vps").is_empty());
        let t = e.evaluate(&c, &m(60_000, 95.0), "vps");
        assert!(matches!(t.as_slice(), [Transition::Fired(a)] if a.message.contains("95 %")));
        // Pas de doublon tant que l'alerte est active.
        assert!(e.evaluate(&c, &m(90_000, 95.0), "vps").is_empty());
        // 78 % : sous le seuil mais au-dessus de l'hystérésis (76 %) → toujours active.
        assert!(e.evaluate(&c, &m(100_000, 78.0), "vps").is_empty());
        // Il faut trois relevés consécutifs sous 76 % pour résoudre.
        assert!(e.evaluate(&c, &m(110_000, 50.0), "vps").is_empty());
        assert!(e.evaluate(&c, &m(115_000, 50.0), "vps").is_empty());
        let t = e.evaluate(&c, &m(120_000, 50.0), "vps");
        assert!(matches!(t.as_slice(), [Transition::Resolved(_)]));
    }

    #[test]
    fn short_spike_does_not_fire() {
        let mut e = Evaluator::default();
        let c = cfg(60);
        e.evaluate(&c, &m(0, 95.0), "vps");
        e.evaluate(&c, &m(30_000, 10.0), "vps");
        assert!(e.evaluate(&c, &m(70_000, 95.0), "vps").is_empty());
    }

    #[test]
    fn backup_alerts() {
        let mut e = Evaluator::default();
        assert!(e.backup_result(None, 1000, "vps").is_none());
        assert!(matches!(e.backup_result(Some((false, 900, "dump".into())), 1000, "vps"), Some(Transition::Fired(_))));
        assert!(e.backup_result(Some((false, 900, "dump".into())), 1100, "vps").is_none(), "pas de doublon");
        assert!(matches!(e.backup_result(Some((true, 1200, "ok".into())), 1300, "vps"), Some(Transition::Resolved(_))));
        let old = 1300 - 40 * 3600;
        assert!(
            matches!(e.backup_result(Some((true, old, "ok".into())), 1300, "vps"), Some(Transition::Fired(a)) if a.message.contains("40 h"))
        );
    }

    #[test]
    fn http_needs_two_failures() {
        let mut e = Evaluator::default();
        assert!(e.http_result("site", "https://x", Err("timeout".into()), 0, "vps").is_none());
        assert!(matches!(e.http_result("site", "https://x", Ok(502), 1, "vps"), Some(Transition::Fired(_))));
        assert!(e.http_result("site", "https://x", Ok(502), 2, "vps").is_none());
        assert!(matches!(e.http_result("site", "https://x", Ok(200), 3, "vps"), Some(Transition::Resolved(_))));
    }
}
