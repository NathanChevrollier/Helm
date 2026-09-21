//! Historique des métriques : relevés récents à pleine résolution et moyennes par minute sur 30 jours.

use std::collections::VecDeque;
use std::path::Path;

use helm_protocol::{downsample, AlertEvent, HistoryPoint, Metrics};
use serde::{Deserialize, Serialize};

/// Minutes conservées : 30 jours.
pub const MINUTES_KEPT: usize = 30 * 24 * 60;
/// Événements d'alerte conservés.
pub const EVENTS_KEPT: usize = 200;

#[derive(Default)]
pub struct History {
    /// Relevés de la dernière heure environ, à l'intervalle d'échantillonnage.
    pub live: VecDeque<Metrics>,
    live_cap: usize,
    pub minutes: VecDeque<HistoryPoint>,
    pending: Vec<HistoryPoint>,
    current_minute: i64,
    pub events: VecDeque<AlertEvent>,
}

/// Données écrites sur disque.
#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    minutes: Vec<HistoryPoint>,
    events: Vec<AlertEvent>,
}

impl History {
    pub fn new(sample_interval_secs: u64) -> Self {
        Self { live_cap: (3600 / sample_interval_secs.max(1)) as usize, ..Default::default() }
    }

    pub fn push(&mut self, m: Metrics) {
        let minute = m.timestamp / 60_000;
        if minute != self.current_minute && !self.pending.is_empty() {
            if let Some(avg) = HistoryPoint::average(&self.pending) {
                self.minutes.push_back(avg);
                while self.minutes.len() > MINUTES_KEPT {
                    self.minutes.pop_front();
                }
            }
            self.pending.clear();
        }
        self.current_minute = minute;
        self.pending.push(HistoryPoint::from(&m));
        self.live.push_back(m);
        while self.live.len() > self.live_cap.max(1) {
            self.live.pop_front();
        }
    }

    pub fn event(&mut self, e: AlertEvent) {
        self.events.push_back(e);
        while self.events.len() > EVENTS_KEPT {
            self.events.pop_front();
        }
    }

    pub fn latest(&self) -> Option<&Metrics> {
        self.live.back()
    }

    /// Points sur la fenêtre demandée : pleine résolution pour la dernière heure, minutes au-delà.
    pub fn range(&self, now: i64, range_secs: u64, points: usize) -> Vec<HistoryPoint> {
        let from = now - range_secs as i64 * 1000;
        let series: Vec<HistoryPoint> = if range_secs <= 3600 {
            self.live.iter().filter(|m| m.timestamp >= from).map(HistoryPoint::from).collect()
        } else {
            self.minutes.iter().filter(|p| p.t >= from).copied().collect()
        };
        downsample(&series, points)
    }

    pub fn load(&mut self, path: &Path, now: i64) {
        let Ok(bytes) = std::fs::read(path) else { return };
        let Ok(data) = serde_json::from_slice::<Persisted>(&bytes) else { return };
        let oldest = now - MINUTES_KEPT as i64 * 60_000;
        self.minutes = data.minutes.into_iter().filter(|p| p.t >= oldest).collect();
        self.events = data.events.into_iter().collect();
    }

    /// Écriture atomique : fichier temporaire puis renommage.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let data = Persisted { minutes: self.minutes.iter().copied().collect(), events: self.events.iter().cloned().collect() };
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(&data)?)?;
        std::fs::rename(tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metric(t: i64, cpu: f32) -> Metrics {
        Metrics { timestamp: t, cpu_percent: cpu, ..Default::default() }
    }

    #[test]
    fn aggregates_minutes_and_caps_live() {
        let mut h = History::new(1800); // live_cap = 2
        h.push(metric(0, 10.0));
        h.push(metric(30_000, 30.0));
        h.push(metric(60_000, 50.0)); // nouvelle minute : la précédente est agrégée
        assert_eq!(h.minutes.len(), 1);
        assert_eq!(h.minutes[0].cpu, 20.0);
        assert_eq!(h.live.len(), 2);
    }

    #[test]
    fn range_uses_live_for_short_windows() {
        let mut h = History::new(5);
        for i in 0..10 {
            h.push(metric(i * 5_000, i as f32));
        }
        let pts = h.range(45_000, 20, 100);
        assert_eq!(pts.len(), 5);
        assert_eq!(pts[0].cpu, 5.0);
    }

    #[test]
    fn save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.json");
        let mut h = History::new(5);
        h.minutes.push_back(HistoryPoint { t: 1_000, cpu: 1.0, ..Default::default() });
        h.save(&path).unwrap();
        let mut back = History::new(5);
        back.load(&path, 2_000);
        assert_eq!(back.minutes.len(), 1);
    }
}
