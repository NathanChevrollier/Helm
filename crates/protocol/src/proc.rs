//! Parseurs des fichiers `/proc` et de la sortie de `df`.

use serde::{Deserialize, Serialize};

use crate::RawSample;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
}

impl CpuTimes {
    /// Pourcentage d'occupation CPU entre deux relevés.
    pub fn usage_since(&self, prev: &CpuTimes) -> f32 {
        let total = self.total.saturating_sub(prev.total);
        if total == 0 {
            return 0.0;
        }
        let busy = self.busy.saturating_sub(prev.busy);
        (busy as f64 / total as f64 * 100.0).clamp(0.0, 100.0) as f32
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemInfo {
    pub total: u64,
    pub available: u64,
    pub swap_total: u64,
    pub swap_free: u64,
}

impl MemInfo {
    pub fn used(&self) -> u64 {
        self.total.saturating_sub(self.available)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub device: String,
    pub total: u64,
    pub used: u64,
}

/// Première ligne de `/proc/stat` (`cpu  user nice system idle iowait irq softirq steal …`).
pub fn parse_stat(text: &str) -> (CpuTimes, u32) {
    let mut times = CpuTimes::default();
    let mut cores = 0;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("cpu ") {
            let v: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
            // guest et guest_nice sont déjà inclus dans user et nice.
            let total: u64 = v.iter().take(8).sum();
            let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
            times = CpuTimes { busy: total.saturating_sub(idle), total };
        } else if line.starts_with("cpu") && line.as_bytes().get(3).is_some_and(u8::is_ascii_digit) {
            cores += 1;
        }
    }
    (times, cores)
}

/// `/proc/meminfo` (valeurs en kB).
pub fn parse_meminfo(text: &str) -> MemInfo {
    let mut m = MemInfo::default();
    let (mut free, mut buffers, mut cached, mut has_available) = (0, 0, 0, false);
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(key), Some(val)) = (parts.next(), parts.next()) else { continue };
        let bytes = val.parse::<u64>().unwrap_or(0) * 1024;
        match key {
            "MemTotal:" => m.total = bytes,
            "MemAvailable:" => {
                m.available = bytes;
                has_available = true;
            }
            "MemFree:" => free = bytes,
            "Buffers:" => buffers = bytes,
            "Cached:" => cached = bytes,
            "SwapTotal:" => m.swap_total = bytes,
            "SwapFree:" => m.swap_free = bytes,
            _ => {}
        }
    }
    if !has_available {
        // Noyaux très anciens : estimation classique.
        m.available = free + buffers + cached;
    }
    m
}

pub fn parse_loadavg(text: &str) -> [f64; 3] {
    let v: Vec<f64> = text.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
    [v.first().copied().unwrap_or(0.0), v.get(1).copied().unwrap_or(0.0), v.get(2).copied().unwrap_or(0.0)]
}

pub fn parse_uptime(text: &str) -> f64 {
    text.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0)
}

/// `/proc/net/dev` : somme des octets reçus/émis, hors loopback et interfaces virtuelles Docker.
pub fn parse_net_dev(text: &str) -> (u64, u64) {
    let (mut rx, mut tx) = (0, 0);
    for line in text.lines().skip(2) {
        let Some((iface, data)) = line.split_once(':') else { continue };
        let iface = iface.trim();
        if iface == "lo" || iface.starts_with("veth") || iface.starts_with("docker") || iface.starts_with("br-") {
            continue;
        }
        let v: Vec<u64> = data.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        rx += v.first().copied().unwrap_or(0);
        tx += v.get(8).copied().unwrap_or(0);
    }
    (rx, tx)
}

/// Sortie de `df -P -B1` : systèmes de fichiers réels uniquement.
pub fn parse_df(text: &str) -> Vec<Disk> {
    let mut disks = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 {
            continue;
        }
        let device = cols[0];
        let mount = cols[5..].join(" ");
        let pseudo = ["tmpfs", "devtmpfs", "overlay", "shm", "udev", "none", "efivarfs"];
        if pseudo.contains(&device) || mount.starts_with("/snap/") || mount.starts_with("/boot/efi") || mount.starts_with("/etc/") {
            continue;
        }
        let (Ok(total), Ok(used)) = (cols[1].parse::<u64>(), cols[2].parse::<u64>()) else { continue };
        if total == 0 || disks.iter().any(|d: &Disk| d.device == device) {
            continue;
        }
        disks.push(Disk { mount, device: device.to_string(), total, used });
    }
    if disks.is_empty() {
        // Conteneur ou VPS dont la racine est un overlay : on garde au moins `/`.
        if let Some(cols) = text.lines().skip(1).map(|l| l.split_whitespace().collect::<Vec<_>>()).find(|c| c.len() >= 6 && c[5] == "/") {
            if let (Ok(total), Ok(used)) = (cols[1].parse(), cols[2].parse()) {
                disks.push(Disk { mount: "/".into(), device: cols[0].into(), total, used });
            }
        }
    }
    disks
}

/// Commande shell qui produit toutes les sections nécessaires à un relevé, en un seul aller-retour SSH.
pub const COLLECT_SCRIPT: &str = "echo @@stat; cat /proc/stat; echo @@mem; cat /proc/meminfo; \
echo @@load; cat /proc/loadavg; echo @@uptime; cat /proc/uptime; echo @@net; cat /proc/net/dev; \
echo @@df; df -P -B1 2>/dev/null";

/// Analyse la sortie de [`COLLECT_SCRIPT`].
pub fn parse_collect(output: &str, timestamp: i64) -> RawSample {
    let mut sample = RawSample { timestamp, ..Default::default() };
    for section in output.split("@@").skip(1) {
        let (name, body) = section.split_once('\n').unwrap_or((section, ""));
        match name.trim() {
            "stat" => (sample.cpu, sample.cpu_count) = parse_stat(body),
            "mem" => sample.mem = parse_meminfo(body),
            "load" => sample.load = parse_loadavg(body),
            "uptime" => sample.uptime_secs = parse_uptime(body),
            "net" => (sample.net_rx_bytes, sample.net_tx_bytes) = parse_net_dev(body),
            "df" => sample.disks = parse_df(body),
            _ => {}
        }
    }
    sample
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT: &str = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\ncpu1 50 0 25 400 25 0 0 0 0 0\nintr 1\n";

    #[test]
    fn stat_and_usage() {
        let (t, cores) = parse_stat(STAT);
        assert_eq!(cores, 2);
        assert_eq!(t, CpuTimes { busy: 150, total: 1000 });
        let later = CpuTimes { busy: 250, total: 1200 };
        assert_eq!(later.usage_since(&t), 50.0);
    }

    #[test]
    fn meminfo() {
        let m = parse_meminfo("MemTotal:  1000 kB\nMemFree: 100 kB\nMemAvailable:  400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
        assert_eq!(m.total, 1_024_000);
        assert_eq!(m.used(), 600 * 1024);
    }

    #[test]
    fn net_dev_skips_virtual() {
        let text = "Inter-|   Receive\n face |bytes\n    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 2000 5 0 0 0 0 0 0\nveth12: 7 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0\n";
        assert_eq!(parse_net_dev(text), (1000, 2000));
    }

    #[test]
    fn df_filters_pseudo() {
        let text = "Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\ntmpfs 10 0 10 0% /run\noverlay 1000 400 600 40% /var/lib/docker/overlay2/x/merged\n/dev/sdb1 2000 1000 1000 50% /data disk\n";
        let d = parse_df(text);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].mount, "/");
        assert_eq!(d[1].mount, "/data disk");
    }

    #[test]
    fn df_keeps_overlay_root_as_fallback() {
        let d = parse_df("h\noverlay 1000 400 600 40% /\ntmpfs 10 0 10 0% /dev\n");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].device, "overlay");
    }

    #[test]
    fn collect_sections() {
        let out = format!("@@stat\n{STAT}@@mem\nMemTotal: 10 kB\nMemAvailable: 5 kB\n@@load\n0.5 0.4 0.3 1/100 42\n@@uptime\n123.4 50\n@@net\na\nb\n eth0: 1 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\n@@df\nh\n/dev/vda1 100 50 50 50% /\n");
        let s = parse_collect(&out, 7);
        assert_eq!(s.cpu_count, 2);
        assert_eq!(s.load, [0.5, 0.4, 0.3]);
        assert_eq!(s.uptime_secs, 123.4);
        assert_eq!((s.net_rx_bytes, s.net_tx_bytes), (1, 2));
        assert_eq!(s.disks.len(), 1);
        assert_eq!(s.mem.used(), 5 * 1024);
    }
}
