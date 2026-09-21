//! Agent `helmd` : collecte des métriques et alertes, exposé uniquement sur un socket unix.
//! Implémentation en phase 3.

fn main() {
    println!("helmd {} (protocole v{})", env!("CARGO_PKG_VERSION"), helm_protocol::PROTOCOL_VERSION);
}
