# Helm

Logiciel desktop (Windows / macOS / Linux) pour gérer, naviguer et surveiller un VPS :
terminal SSH, fichiers, monitoring, Docker et sites nginx réunis dans une seule app.
Tout passe par SSH : aucun panneau web ni port supplémentaire n'est ouvert sur le serveur.

## Fonctionnalités

| Section | Ce qu'elle fait |
|---|---|
| **Serveurs** | Profils SSH (mot de passe, clé OpenSSH/PuTTY `.ppk`, agent OpenSSH ou Pageant). Secrets dans le coffre-fort de l'OS. Import des sessions PuTTY. Vérification de la clé d'hôte (approbation au premier contact, alerte si elle change). |
| **Terminal** | Onglets, écran divisé, reconnexion par Entrée, copier/coller (Ctrl+Maj+C/V, clic droit comme PuTTY), liens cliquables, snippets. |
| **Fichiers** | Explorateur SFTP : navigation, glisser-déposer depuis Windows, envoi/téléchargement récursif avec progression, renommage, suppression, chmod, « terminal ici ». Édition dans Monaco (l'éditeur de VS Code) avec aperçu des modifications, écriture atomique, repli sudo pour les fichiers système. |
| **Monitoring** | CPU, mémoire, disques, réseau, charge en direct. Processus (tri, arrêt). Services systemd (démarrer, arrêter, redémarrer, journaux). Avec l'agent `helmd` : historique 30 jours, alertes (seuils soutenus, hystérésis) et supervision HTTP des sites, notifiées sur Discord, ntfy ou webhook, même PC éteint. |
| **Docker** | Conteneurs avec stats en direct, logs en direct et shell dans un onglet terminal, inspection, projets compose (up, mise à jour, restart, down, édition du fichier), images et nettoyage. Signale les ports publiés sur toutes les interfaces. |
| **Sites** | Carte de chaque site : domaine → nginx → port → conteneur. Certificats et leurs expirations. Éditeur de vhost sûr. Assistant « Nouveau site » (conteneur + vhost + HTTPS Let's Encrypt + vérification). |

### Sécurité des modifications nginx

Chaque modification suit le même déroulé, exécuté côté serveur par un seul script :

1. sauvegarde complète de `/etc/nginx` dans `/var/backups/helm/nginx/<date>` (30 dernières conservées) ;
2. écriture du fichier ;
3. `nginx -t` ;
4. reload ;
5. en cas d'échec au test ou au reload, restauration exacte des fichiers et des liens.

nginx n'est jamais rechargé avec une configuration invalide, et les autres sites ne sont pas touchés. Les écritures hors de `/etc/nginx` sont refusées.

### Agent `helmd`

- Binaire Linux statique d'environ 2 Mo (x86_64 et arm64), embarqué dans l'app et installé en un clic depuis Monitoring → Agent & alertes.
- Tourne sous un utilisateur système dédié, avec un service systemd durci (`ProtectSystem=strict`, `NoNewPrivileges`, 64 Mo de RAM maximum).
- **N'écoute que sur un socket unix** (`/run/helmd/helmd.sock`) : l'app l'interroge à travers la connexion SSH, aucun port n'est ouvert.
- Configuration : `/etc/helmd/config.json` (root:helmd 0640), rechargée à chaud.

## Structure

| Dossier | Rôle |
|---|---|
| `apps/desktop` | App Tauri 2 : UI React/TypeScript (`src/`) + commandes Rust (`src-tauri/`) |
| `crates/core` | SSH (russh), SFTP, sudo, Docker, nginx, systemd, installation de l'agent |
| `crates/protocol` | Parseurs `/proc`, types et protocole partagés entre l'app et l'agent |
| `crates/agent` | `helmd`, l'agent de monitoring installé sur le VPS |
| `testenv` | Faux VPS Docker (sshd + nginx + sudo + client Docker) pour les tests |

## Développement

Prérequis : Rust stable, Node 24+, pnpm. Sous Windows : WebView2 et MSVC Build Tools.
Pour compiler l'agent : `pip install ziglang`, `cargo install cargo-zigbuild`,
puis `rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl`.

```sh
pnpm install
pnpm build:agent   # binaires helmd, embarqués dans l'app au build suivant
pnpm dev           # app en mode développement
pnpm build         # installeurs dans target/release/bundle/
pnpm test          # tests unitaires Rust
```

L'app compile aussi sans l'agent : le bouton d'installation signale alors que le binaire n'a pas été construit.

### Environnement de test

```sh
pnpm testenv       # démarre le faux VPS sur 127.0.0.1:2222 (root/helm, deploy/deploy)
cargo run -p helm-core --example smoke        # SSH, sudo, SFTP, shell
cargo run -p helm-core --example nginx_smoke  # application sûre nginx (valide, cassée, restauration)
```

⚠ Le faux VPS pilote le démon Docker de la machine hôte : ses actions Docker s'appliquent aux vrais conteneurs de l'hôte.

## CI

GitHub Actions déroule les étapes suivantes : typecheck, `cargo fmt`, `clippy -D warnings` et tests. Il compile ensuite l'agent (zig) et produit les installeurs Windows (MSI/NSIS), macOS (DMG) et Linux (deb, AppImage, rpm).
