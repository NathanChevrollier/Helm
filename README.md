# Helm

Logiciel desktop (Windows / macOS / Linux) pour gérer, naviguer et surveiller un VPS :
terminal SSH, fichiers, monitoring, Docker et sites nginx réunis dans une seule app.
Tout passe par SSH : aucun panneau web ni port supplémentaire n'est ouvert sur le serveur.

## Fonctionnalités

| Section | Ce qu'elle fait |
|---|---|
| **Accueil** | Santé de tous les serveurs d'un coup d'œil : CPU, mémoire, disque, alertes, conteneurs arrêtés, certificats qui expirent bientôt. |
| **Serveurs** | Profils SSH (mot de passe, clé OpenSSH/PuTTY `.ppk`, agent OpenSSH ou Pageant). Secrets dans le coffre-fort de l'OS. Import des sessions PuTTY. Vérification de la clé d'hôte. |
| **Terminal** | Sessions **persistantes tmux** : elles survivent aux coupures et à la fermeture de l'app, avec reconnexion automatique. Onglets et écran divisé restaurés au démarrage. **Diffusion de la saisie** à plusieurs terminaux, avec confirmation des commandes sensibles. Snippets, copier/coller comme PuTTY. |
| **Fichiers** | Explorateur SFTP, **double panneau** pour copier d'un serveur à l'autre (flux via le PC), glisser-déposer, transferts annulables, édition dans Monaco, repli sudo. |
| **Monitoring** | CPU, mémoire, disques, réseau, processus, services systemd. Avec l'agent `helmd` : 30 jours d'historique, alertes (seuils, sites injoignables, sauvegardes en échec) sur Discord, ntfy ou webhook, même PC éteint. |
| **Docker** | Conteneurs et stats, logs et shell en terminal, projets compose, images et nettoyage. **Déploiement** (pull → up → vérification → retour arrière automatique), **déploiement depuis GitHub** par clé restreinte, **restriction des ports exposés** à 127.0.0.1, accès depuis le PC par tunnel. |
| **Sites** | Domaine → nginx → port → conteneur, certificats, éditeur de vhost sûr, assistant « Nouveau site », **historique des configurations** avec diff et restauration. |
| **Journaux** | Logs Docker, systemd et fichiers suivis en direct, fusionnés, filtrables (texte, regex, niveau), exportables. |
| **Tunnels** | Tunnels SSH locaux (127.0.0.1 uniquement) pour accéder à une base ou une interface d'admin sans l'exposer. |
| **Sauvegardes** | restic chiffré et dédupliqué : dumps MySQL/PostgreSQL cohérents, volumes, dossiers, vers le serveur ou un stockage S3. Planification quotidienne, rétention, vérification, restauration (téléchargement, remise en place, réimport d'une base). |
| **Sécurité** | Audit (SSH, pare-feu, fail2ban, mises à jour, ports exposés, comptes UID 0) et corrections guidées. Pour SSH et le pare-feu, une connexion de contrôle est ouverte et la modification annulée automatiquement si elle échoue. |
| **Réglages** | Journal de toutes les actions, accès IA (MCP) serveur par serveur, préférences. |

Palette de commandes : **Ctrl+K**.

### Serveur MCP (lecture seule)

`Helm --mcp` expose aux assistants IA (Claude Code, Claude Desktop…) 14 outils **en lecture seule** : état, historique, alertes, conteneurs, logs, sites, configuration nginx, audit, sauvegardes.

- Aucun outil ne peut modifier un serveur ni exécuter une commande libre.
- Seuls les serveurs autorisés dans Réglages → Accès IA sont visibles.
- Les secrets sont masqués et les clés privées refusées.
- Chaque appel est inscrit au journal d'actions.

La configuration à copier se trouve dans Réglages → Accès IA.

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
| `crates/core` | SSH, SFTP, tmux, Docker, nginx, systemd, audit, sauvegardes, déploiement, agent |
| `crates/protocol` | Parseurs `/proc`, types et protocole partagés entre l'app et l'agent |
| `crates/agent` | `helmd`, l'agent de monitoring installé sur le VPS |
| `crates/profiles` | Profils, secrets (keyring) et journal d'actions, partagés par l'app et le MCP |
| `crates/mcp` | Serveur MCP en lecture seule (aussi intégré à l'app via `--mcp`) |
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

Le faux VPS a son propre démon Docker (Docker-in-Docker) : il ne voit jamais les conteneurs de ta machine. Il embarque 3 applications de démo : `demo-app`, `whoami` (port 8082 exposé) et `demo-db` (MariaDB, mot de passe root `demo`). Pour tout supprimer : `docker compose -f testenv/docker-compose.yml down -v`.

## CI

GitHub Actions déroule les étapes suivantes : typecheck, `cargo fmt`, `clippy -D warnings` et tests. Il compile ensuite l'agent (zig) et produit les installeurs Windows (MSI/NSIS), macOS (DMG) et Linux (deb, AppImage, rpm).
