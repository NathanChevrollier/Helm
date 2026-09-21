# Helm

Logiciel desktop (Windows / macOS / Linux) pour gérer, naviguer et surveiller un VPS :
terminal SSH, fichiers SFTP, monitoring, Docker et sites nginx réunis dans une seule app.

## Structure

| Dossier | Rôle |
|---|---|
| `apps/desktop` | App Tauri 2 : UI React/TypeScript (`src/`) + commandes Rust (`src-tauri/`) |
| `crates/core` | SSH, SFTP, tunnels, client Docker, parseur nginx |
| `crates/protocol` | Types partagés entre l'app et l'agent |
| `crates/agent` | `helmd`, l'agent de monitoring installé sur le VPS (socket unix uniquement, aucun port ouvert) |

## Développement

Prérequis : Rust stable, Node 24+, pnpm, et sous Windows WebView2 + MSVC Build Tools.

```sh
pnpm install
pnpm dev        # lance l'app en mode développement
pnpm build      # produit l'installeur dans target/release/bundle/
cargo test --workspace
```

Compiler l'agent pour le VPS (binaire statique Linux) :

```sh
cargo install cargo-zigbuild
rustup target add x86_64-unknown-linux-musl
cargo zigbuild -p helmd --release --target x86_64-unknown-linux-musl
```

## Roadmap

- [x] Phase 0 : fondations (monorepo, Tauri, CI, layout)
- [ ] Phase 1 : connexion et terminal SSH
- [ ] Phase 2 : explorateur SFTP
- [ ] Phase 3 : monitoring et agent `helmd`
- [ ] Phase 4 : Docker
- [ ] Phase 5 : nginx et sites
