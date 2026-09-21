//! Types échangés entre l'app desktop et l'agent `helmd`.

use serde::{Deserialize, Serialize};

/// Version du protocole, vérifiée à la connexion pour détecter un agent obsolète.
pub const PROTOCOL_VERSION: u32 = 1;

/// Instantané des métriques système.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metrics {
    pub timestamp: i64,
    pub cpu_percent: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    pub load_avg: [f64; 3],
}
