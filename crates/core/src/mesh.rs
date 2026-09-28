//! Réseau privé entre serveurs (WireGuard, maillage complet). Le PC orchestre par SSH : chaque
//! serveur génère sa clé (la clé privée ne le quitte jamais), Zenytt pousse la liste des pairs.
//! Zenytt ne touche qu'à ce qui lui appartient : interface `zenytt`, `/etc/wireguard/zenytt.*`.

use std::collections::HashSet;

use serde::Serialize;

pub const IFACE: &str = "zenytt";
pub const CONF: &str = "/etc/wireguard/zenytt.conf";
pub const KEY: &str = "/etc/wireguard/zenytt.key";
pub const DEFAULT_PORT: u16 = 51820;
pub const LAST_PORT: u16 = 51899;
const HEADER: &str = "# zenytt-network:";
/// Remplacé sur le serveur par sa clé privée (voir `APPLY_SCRIPT`).
const KEY_MARKER: &str = "@ZENYTT_KEY@";

/// Membre d'un réseau, vu du PC.
#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    /// Adresse privée, sans masque (`10.77.0.2`).
    pub address: String,
    pub public_key: String,
    /// IP ou nom public ; `None` : derrière un NAT, injoignable de l'extérieur.
    pub endpoint: Option<String>,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Peer {
    pub public_key: String,
    pub allowed_ip: String,
    pub endpoint: Option<String>,
    pub keepalive: bool,
}

/// Configuration d'un membre.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeConfig {
    pub network_id: String,
    pub name: String,
    pub address: String,
    pub prefix: u8,
    pub port: u16,
    pub peers: Vec<Peer>,
}

/// Maillage complet, sauf entre deux membres derrière NAT (aucun ne peut joindre l'autre).
pub fn node_config(network_id: &str, name: &str, cidr: &str, members: &[Member], me: usize) -> NodeConfig {
    let mine = &members[me];
    let peers = members
        .iter()
        .enumerate()
        .filter(|(i, m)| *i != me && (m.endpoint.is_some() || mine.endpoint.is_some()))
        .map(|(_, m)| Peer {
            public_key: m.public_key.clone(),
            allowed_ip: format!("{}/32", m.address),
            endpoint: m.endpoint.as_ref().map(|e| format!("{e}:{}", m.port)),
            // Derrière NAT, c'est à moi d'ouvrir et d'entretenir le passage.
            keepalive: mine.endpoint.is_none() && m.endpoint.is_some(),
        })
        .collect();
    NodeConfig {
        network_id: network_id.into(),
        name: name.into(),
        address: mine.address.clone(),
        prefix: cidr.split('/').nth(1).and_then(|p| p.parse().ok()).unwrap_or(24),
        port: mine.port,
        peers,
    }
}

/// Paires de membres qui ne peuvent pas se joindre directement (tous deux derrière NAT).
pub fn unreachable_pairs(members: &[Member]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for i in 0..members.len() {
        for j in i + 1..members.len() {
            if members[i].endpoint.is_none() && members[j].endpoint.is_none() {
                out.push((i, j));
            }
        }
    }
    out
}

pub fn render_config(c: &NodeConfig) -> String {
    let name: String = c.name.chars().map(|ch| if ch.is_control() { ' ' } else { ch }).collect();
    let mut s = format!(
        "{HEADER} {} {name}\n# Géré par Zenytt (section Réseau privé) : les modifications manuelles seront écrasées.\n[Interface]\nPrivateKey = {KEY_MARKER}\nAddress = {}/{}\nListenPort = {}\n",
        c.network_id, c.address, c.prefix, c.port
    );
    for p in &c.peers {
        s.push_str(&format!("\n[Peer]\nPublicKey = {}\nAllowedIPs = {}\n", p.public_key, p.allowed_ip));
        if let Some(e) = &p.endpoint {
            s.push_str(&format!("Endpoint = {e}\n"));
        }
        if p.keepalive {
            s.push_str("PersistentKeepalive = 25\n");
        }
    }
    s
}

/// `(id, nom)` du réseau Zenytt décrit par une configuration.
pub fn parse_header(conf: &str) -> Option<(String, String)> {
    let rest = conf.lines().next()?.strip_prefix(HEADER)?.trim();
    let (id, name) = rest.split_once(' ').unwrap_or((rest, ""));
    (!id.is_empty()).then(|| (id.to_string(), name.to_string()))
}

/// `a.b.c.d/n` ou `a.b.c.d` (= /32).
fn net(s: &str) -> Option<(u32, u8)> {
    let (ip, prefix) = s.split_once('/').unwrap_or((s, "32"));
    let prefix: u8 = prefix.parse().ok().filter(|p| *p <= 32)?;
    Some((u32::from(ip.parse::<std::net::Ipv4Addr>().ok()?), prefix))
}

fn mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

/// Le réseau `cidr` recouvre-t-il une destination de la table de routage (`ip -4 -o route`) ?
/// Les routes de notre propre interface sont ignorées.
pub fn overlaps(cidr: &str, routes: &str) -> bool {
    let Some((base, prefix)) = net(cidr) else { return true };
    routes
        .lines()
        .filter(|l| !l.split_whitespace().collect::<Vec<_>>().windows(2).any(|w| w == ["dev", IFACE]))
        .filter_map(|l| l.split_whitespace().next())
        .filter_map(net)
        .any(|(b, p)| {
            let m = mask(prefix.min(p));
            base & m == b & m
        })
}

/// Premier `/24` libre de `10.77.0.0/24` à `10.99.0.0/24`.
pub fn pick_subnet(routes: &str) -> Option<String> {
    (77..=99).map(|n| format!("10.{n}.0.0/24")).find(|c| !overlaps(c, routes))
}

pub fn next_address(cidr: &str, used: &[String]) -> Option<String> {
    let (base, _) = net(cidr)?;
    (1..=254u32).map(|i| std::net::Ipv4Addr::from((base & mask(24)) | i).to_string()).find(|a| !used.contains(a))
}

pub fn free_port(busy: &HashSet<u16>) -> Option<u16> {
    (DEFAULT_PORT..=LAST_PORT).find(|p| !busy.contains(p))
}

pub fn is_public_ipv4(ip: &str) -> bool {
    ip.parse::<std::net::Ipv4Addr>().is_ok_and(|a| {
        let [x, y, ..] = a.octets();
        // 100.64.0.0/10 : NAT d'opérateur (et adresses Tailscale), jamais joignable de l'extérieur.
        !(a.is_private() || a.is_loopback() || a.is_link_local() || a.is_unspecified() || (x == 100 && (64..128).contains(&y)))
    })
}

/// IPv4 publiques d'une sortie `ip -4 -o addr show scope global`.
pub fn public_ipv4(addr_output: &str) -> Vec<String> {
    addr_output
        .lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            w.find(|t| *t == "inet")?;
            w.next()?.split('/').next().map(str::to_string)
        })
        .filter(|ip| is_public_ipv4(ip))
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub public_key: String,
    pub endpoint: Option<String>,
    /// Horodatage Unix du dernier échange ; `None` : jamais.
    pub last_handshake: Option<u64>,
    pub rx: u64,
    pub tx: u64,
}

/// Lignes de pairs de `wg show zenytt dump` (sans la première ligne, qui contient la clé privée).
pub fn parse_peers(dump: &str) -> Vec<Link> {
    dump.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() >= 8).then(|| Link {
                public_key: f[0].to_string(),
                endpoint: (f[2] != "(none)").then(|| f[2].to_string()),
                last_handshake: f[4].parse().ok().filter(|t| *t > 0),
                rx: f[5].parse().unwrap_or(0),
                tx: f[6].parse().unwrap_or(0),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(address: &str, key: &str, endpoint: Option<&str>) -> Member {
        Member { address: address.into(), public_key: key.into(), endpoint: endpoint.map(Into::into), port: 51820 }
    }

    #[test]
    fn full_mesh_between_public_members() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", Some("95.0.0.2")), m("10.77.0.3", "KC", Some("5.0.0.3"))];
        let c = node_config("net1", "Prod", "10.77.0.0/24", &members, 0);
        assert_eq!(c.address, "10.77.0.1");
        assert_eq!(c.prefix, 24);
        assert_eq!(c.peers.len(), 2);
        assert_eq!(c.peers[0], Peer { public_key: "KB".into(), allowed_ip: "10.77.0.2/32".into(), endpoint: Some("95.0.0.2:51820".into()), keepalive: false });
    }

    #[test]
    fn nat_member_gets_keepalive() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", None)];
        let nat = node_config("n", "N", "10.77.0.0/24", &members, 1);
        assert!(nat.peers[0].keepalive, "le membre derrière NAT entretient le lien");
        let public = node_config("n", "N", "10.77.0.0/24", &members, 0);
        assert_eq!(public.peers[0].endpoint, None, "pas d'adresse connue pour un membre derrière NAT");
        assert!(!public.peers[0].keepalive);
    }

    #[test]
    fn two_nat_members_are_unreachable() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", None), m("10.77.0.3", "KC", None)];
        assert_eq!(unreachable_pairs(&members), vec![(1, 2)]);
        let c = node_config("n", "N", "10.77.0.0/24", &members, 1);
        assert_eq!(c.peers.len(), 1, "KC n'est pas listé : aucun des deux ne peut joindre l'autre");
    }

    #[test]
    fn render_keeps_private_key_on_server() {
        let members = [m("10.77.0.1", "KA", Some("51.0.0.1")), m("10.77.0.2", "KB", None)];
        let text = render_config(&node_config("abc", "Prod\nX", "10.77.0.0/24", &members, 1));
        assert!(text.starts_with("# zenytt-network: abc Prod X\n"), "{text}");
        assert!(text.contains("PrivateKey = @ZENYTT_KEY@\n"));
        assert!(text.contains("Address = 10.77.0.2/24\n"));
        assert!(text.contains("ListenPort = 51820\n"));
        assert!(text.contains("PersistentKeepalive = 25\n"));
        assert!(!text.contains("0.0.0.0/0"), "jamais de sortie Internet par le réseau privé");
        assert_eq!(parse_header(&text), Some(("abc".into(), "Prod X".into())));
    }

    #[test]
    fn pick_subnet_skips_used_routes() {
        let routes = "default via 172.31.1.1 dev eth0\n10.77.0.0/16 dev br-1234 proto kernel scope link src 10.77.0.1\n172.17.0.0/16 dev docker0\n";
        assert_eq!(pick_subnet(routes), Some("10.78.0.0/24".into()));
        assert_eq!(pick_subnet(""), Some("10.77.0.0/24".into()));
        assert!(overlaps("10.77.0.0/24", routes));
        assert!(!overlaps("10.78.0.0/24", routes));
    }

    #[test]
    fn pick_subnet_none_when_all_used() {
        assert_eq!(pick_subnet("10.0.0.0/8 dev eth1\n"), None);
    }

    #[test]
    fn routes_of_our_interface_are_ignored() {
        assert!(!overlaps("10.77.0.0/24", "10.77.0.0/24 dev zenytt proto kernel scope link src 10.77.0.1\n"));
    }

    #[test]
    fn addresses_and_ports() {
        assert_eq!(next_address("10.77.0.0/24", &[]), Some("10.77.0.1".into()));
        assert_eq!(next_address("10.77.0.0/24", &["10.77.0.1".into(), "10.77.0.3".into()]), Some("10.77.0.2".into()));
        let busy: HashSet<u16> = [51820, 51821].into();
        assert_eq!(free_port(&busy), Some(51822));
        let all: HashSet<u16> = (DEFAULT_PORT..=LAST_PORT).collect();
        assert_eq!(free_port(&all), None);
    }

    #[test]
    fn public_addresses() {
        let out = "2: eth0    inet 51.89.1.2/32 brd 51.89.1.2 scope global eth0\\       valid_lft forever\n\
                   3: eth1    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth1\n\
                   4: docker0    inet 172.17.0.1/16 scope global docker0\n\
                   5: tailscale0    inet 100.101.2.3/32 scope global tailscale0\n";
        assert_eq!(public_ipv4(out), vec!["51.89.1.2".to_string()]);
        assert!(is_public_ipv4("8.8.8.8"));
        assert!(!is_public_ipv4("192.168.1.10"));
        assert!(!is_public_ipv4("vps.example.com"));
    }

    #[test]
    fn parse_wg_dump_peers() {
        // `wg show zenytt dump | tail -n +2` : clé publique, clé partagée, adresse, IP autorisées, dernier échange, reçu, envoyé, keepalive.
        let dump = "KB=\t(none)\t95.0.0.2:51820\t10.77.0.2/32\t1790000000\t1200\t3400\toff\nKC=\t(none)\t(none)\t10.77.0.3/32\t0\t0\t0\t25\n";
        let links = parse_peers(dump);
        assert_eq!(links[0], Link { public_key: "KB=".into(), endpoint: Some("95.0.0.2:51820".into()), last_handshake: Some(1790000000), rx: 1200, tx: 3400 });
        assert_eq!(links[1].endpoint, None);
        assert_eq!(links[1].last_handshake, None, "0 = jamais d'échange");
    }
}
