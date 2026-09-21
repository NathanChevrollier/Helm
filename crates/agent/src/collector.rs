//! Relevé des compteurs système en lisant directement `/proc` (et `df` pour les disques).

use helm_protocol::proc as p;
use helm_protocol::RawSample;

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn sample() -> RawSample {
    let (cpu, cpu_count) = p::parse_stat(&read("/proc/stat"));
    let (net_rx_bytes, net_tx_bytes) = p::parse_net_dev(&read("/proc/net/dev"));
    let df = std::process::Command::new("df")
        .args(["-P", "-B1"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    RawSample {
        timestamp: now_ms(),
        cpu,
        cpu_count,
        mem: p::parse_meminfo(&read("/proc/meminfo")),
        load: p::parse_loadavg(&read("/proc/loadavg")),
        uptime_secs: p::parse_uptime(&read("/proc/uptime")),
        net_rx_bytes,
        net_tx_bytes,
        disks: p::parse_df(&df),
    }
}

pub fn hostname() -> String {
    read("/proc/sys/kernel/hostname").trim().to_string()
}
