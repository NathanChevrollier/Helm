use std::path::PathBuf;

/// Copie les binaires Linux de l'agent (s'ils ont été compilés) dans OUT_DIR pour les embarquer
/// avec `include_bytes!`. Absents, ils sont remplacés par un fichier vide : l'app compile quand même
/// et signale à l'installation que l'agent n'a pas été construit (`pnpm build:agent`).
fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    for arch in ["x86_64", "aarch64"] {
        let src = manifest.join(format!("../../../target/{arch}-unknown-linux-musl/release/helmd"));
        let dst = out.join(format!("helmd-{arch}"));
        if src.exists() {
            std::fs::copy(&src, &dst).expect("copie du binaire helmd");
        } else {
            std::fs::write(&dst, b"").unwrap();
        }
        println!("cargo:rerun-if-changed={}", src.display());
    }
    tauri_build::build()
}
