# Helm

[![CI](https://github.com/NathanChevrollier/Helm/actions/workflows/ci.yml/badge.svg)](https://github.com/NathanChevrollier/Helm/actions/workflows/ci.yml)
[![Dernière version](https://img.shields.io/github/v/release/NathanChevrollier/Helm?label=version)](https://github.com/NathanChevrollier/Helm/releases/latest)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Application de bureau (Windows, macOS, Linux) pour administrer ses serveurs Linux : terminal SSH,
fichiers, supervision, Docker, bases de données, sites web, sauvegardes et audit de sécurité dans
une seule fenêtre.

**Tout passe par SSH.** Helm n'installe aucun panneau web, n'ouvre aucun port sur le serveur et ne
dépend d'aucun service tiers. Les identifiants restent dans le coffre-fort du système
d'exploitation, et tout ce qui transite par un serveur de relais est chiffré de bout en bout.

## Sommaire

- [Installation](#installation)
- [Premiers pas](#premiers-pas)
- [Fonctionnalités](#fonctionnalités)
- [Assistant IA](#assistant-ia)
- [Partage et synchronisation](#partage-et-synchronisation)
- [Serveur MCP (lecture seule)](#serveur-mcp-lecture-seule)
- [Agent `helmd`](#agent-helmd)
- [Modèle de sécurité](#modèle-de-sécurité)
- [Compatibilité serveur](#compatibilité-serveur)
- [Raccourcis clavier](#raccourcis-clavier)
- [Architecture du dépôt](#architecture-du-dépôt)
- [Développement](#développement)
- [Intégration continue et publication](#intégration-continue-et-publication)
- [Licence](#licence)

## Installation

Les installeurs sont publiés sur la page
[Releases](https://github.com/NathanChevrollier/Helm/releases/latest).

| Système | Fichier |
| --- | --- |
| Windows 10/11 | `Helm_x.y.z_x64-setup.exe` |
| macOS Apple Silicon | `Helm_x.y.z_aarch64.dmg` |
| macOS Intel | `Helm_x.y.z_x64.dmg` |
| Linux | `.AppImage` (mises à jour automatiques), `.deb` ou `.rpm` |

Helm vérifie au démarrage si une nouvelle version existe et propose de l'installer
(Réglages → Préférences → Mises à jour). Les paquets sont signés : une version altérée est refusée.

> **Windows** — l'installeur n'est pas signé par un certificat commercial. SmartScreen affiche
> « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
>
> **macOS** — l'app n'est pas notariée par Apple. Au premier lancement :
> *Réglages Système* → *Confidentialité et sécurité* → *Ouvrir quand même*. Si macOS indique que
> l'app « est endommagée », lancer une fois
> `xattr -dr com.apple.quarantine /Applications/Helm.app`.

## Premiers pas

1. **Ajouter un serveur** — section *Serveurs* → *Nouveau serveur* : hôte, port, utilisateur, puis
   mot de passe, clé OpenSSH, clé PuTTY `.ppk`, agent OpenSSH ou Pageant. Les sessions PuTTY et
   `~/.ssh/config` existantes peuvent être importées d'un clic.
2. **Approuver la clé d'hôte** à la première connexion : son empreinte est mémorisée et toute
   modification ultérieure bloque la connexion.
3. **Travailler** — la colonne de gauche donne les sections, la barre du haut le serveur actif.
   La palette de commandes (**Ctrl+K**) ouvre n'importe quelle action sans quitter le clavier.

Les secrets ne sont jamais écrits dans les fichiers de configuration : ils vont dans le coffre-fort
du système (Windows Credential Manager, Trousseau macOS, Secret Service sous Linux).

## Fonctionnalités

| Section | Ce qu'elle fait |
|---|---|
| **Accueil** | Santé de tous les serveurs d'un coup d'œil : CPU, mémoire, disque, alertes, conteneurs arrêtés, certificats proches de l'expiration. |
| **Serveurs** | Profils SSH, dossiers de rangement, banque d'identifiants réutilisables, serveurs de rebond, import PuTTY et `ssh_config`, vérification de la clé d'hôte, bureau à distance (RDP). |
| **Terminal** | Sessions **tmux persistantes** qui survivent aux coupures et à la fermeture de l'app. Onglets, division horizontale ou verticale réglable, panneau de fichiers qui suit le dossier courant, dépôt de fichiers Windows directement dans le dossier courant, **diffusion de la saisie** à plusieurs serveurs avec confirmation des commandes sensibles, snippets, enregistrement de session (asciicast). |
| **Fichiers** | Explorateur SFTP, **double panneau** pour copier d'un serveur à l'autre, glisser-déposer, transferts annulables, édition distante dans Monaco, repli sudo. |
| **Supervision** | CPU, mémoire, disques, réseau, processus, services systemd. Avec l'agent `helmd` : 30 jours d'historique et alertes (seuils, sites injoignables, sauvegardes en échec) vers Discord, ntfy ou webhook, même PC éteint. |
| **Docker** | Conteneurs, statistiques, logs en direct, shell dans un conteneur, projets compose (création assistée depuis l'interface), images et nettoyage. **Déploiement** (pull → up → vérification → retour arrière automatique), **déploiement depuis GitHub** par clé restreinte, **restriction des ports publiés** à 127.0.0.1, accès local par tunnel. |
| **Bases de données** | MySQL/MariaDB et PostgreSQL, en conteneur ou installés sur l'hôte : bases, tables, éditeur SQL avec exécution (Ctrl+Entrée) et export CSV. |
| **Sites** | Domaine → nginx ou Apache → port → conteneur, certificats TLS, éditeur de vhost sécurisé, assistant « Nouveau site », **historique des configurations** avec comparaison et restauration. |
| **Journaux** | Logs Docker, systemd et fichiers suivis en direct, fusionnés, filtrables (texte, expression régulière, niveau) et exportables. |
| **Tunnels** | Tunnels SSH locaux (127.0.0.1 uniquement) pour joindre une base ou une interface d'administration sans l'exposer. |
| **Sauvegardes** | restic chiffré et dédupliqué : dumps MySQL/PostgreSQL cohérents, volumes, dossiers, vers le serveur ou un stockage S3. Planification, rétention, vérification, restauration (téléchargement, remise en place, réimport d'une base). |
| **Sécurité** | Audit (SSH, pare-feu, fail2ban, mises à jour, ports exposés, comptes UID 0) et corrections guidées ; alertes ignorables puis archivées. Pour SSH et le pare-feu, une connexion de contrôle est maintenue et la modification est annulée automatiquement si elle échoue. |
| **Réglages** | Journal de toutes les actions, accès IA serveur par serveur, synchronisation, verrouillage de l'app, thème clair/sombre, raccourcis. |

## Assistant IA

Panneau latéral (**Ctrl+I**) relié au fournisseur de votre choix :

| Fournisseur | Détail |
|---|---|
| **Claude (Anthropic)** | API Messages, `claude-opus-5` par défaut |
| **Compatible OpenAI** | toute API exposant `/chat/completions` |
| **Local** | Ollama, LM Studio ou équivalent, sans rien envoyer à l'extérieur |

Trois modes d'exécution : **lecture seule** (il explique), **proposition** (chaque commande est
validée par vous, mode par défaut) et **autonome** (il exécute, mais les commandes sensibles
demandent quand même votre accord).

Ce qu'il peut consulter se choisit case par case, serveur par serveur : état, conteneurs, journaux,
sites, processus, fichiers de configuration, audit de sécurité. La clé d'API est rangée dans le
coffre-fort du système et chaque appel apparaît au journal d'actions.

## Partage et synchronisation

- **Terminal partagé** — une invitation `helm-term:…` donne un accès en lecture seule ou avec le
  contrôle à un terminal, sans créer de compte sur le serveur ni ouvrir de port.
- **Partage de configuration** — un code `helm-share:…` transmet un profil de serveur (et, si vous
  le voulez, ses secrets) à une autre installation de Helm.
- **Synchronisation multi-postes** — serveurs, identifiants, clés d'hôte approuvées, snippets et
  tunnels, soit par **fichier** (dossier OneDrive, Dropbox, Syncthing, partage réseau), soit par le
  petit serveur [`sync-server/`](sync-server/) à héberger soi-même.

Dans tous les cas, le contenu est chiffré côté client (AES-256-GCM, clé dérivée de votre phrase de
passe) : le relais ne voit jamais rien en clair et refuse tout contenu non chiffré.

## Serveur MCP (lecture seule)

`Helm --mcp` expose aux assistants compatibles (Claude Code, Claude Desktop…) **14 outils en
lecture seule** : état, historique, alertes, conteneurs, journaux, sites, configuration nginx,
audit, sauvegardes, processus, fichiers de configuration.

- Aucun outil ne peut modifier un serveur ni exécuter une commande libre.
- Seuls les serveurs autorisés dans Réglages → Accès IA sont visibles.
- Les secrets sont masqués et les clés privées refusées.
- Chaque appel est inscrit au journal d'actions.

La configuration à copier se trouve dans Réglages → Accès IA.

## Agent `helmd`

Optionnel : Helm fonctionne sans lui, mais l'agent apporte l'historique et les alertes hors ligne.

- Binaire Linux statique d'environ 2 Mo (x86_64 et arm64), embarqué dans l'app et installé en un
  clic depuis Supervision → Agent & alertes.
- Tourne sous un utilisateur système dédié, avec un service systemd durci (`ProtectSystem=strict`,
  `NoNewPrivileges`, 64 Mo de RAM maximum).
- **N'écoute que sur un socket unix** (`/run/helmd/helmd.sock`) : l'app l'interroge à travers la
  connexion SSH, aucun port n'est ouvert.
- Configuration : `/etc/helmd/config.json` (`root:helmd`, `0640`), rechargée à chaud.

## Modèle de sécurité

- **Un seul canal** : SSH. Pas d'agent obligatoire, pas de port ouvert, pas de service tiers.
- **Secrets dans le coffre-fort de l'OS**, jamais dans les fichiers de configuration ni dans les
  sauvegardes de réglages non chiffrées.
- **Clé d'hôte vérifiée** à chaque connexion ; un changement d'empreinte bloque et prévient.
- **Modifications de configuration réversibles.** Chaque écriture nginx ou Apache suit le même
  déroulé, exécuté côté serveur par un seul script :
  1. sauvegarde complète de la configuration dans `/var/backups/helm/…` (30 dernières conservées) ;
  2. écriture du fichier ;
  3. test de configuration (`nginx -t`, `apachectl configtest`) ;
  4. rechargement ;
  5. en cas d'échec, restauration exacte des fichiers et des liens.

  Le serveur web n'est jamais rechargé avec une configuration invalide et les autres sites ne sont
  pas touchés ; les écritures hors des répertoires de configuration sont refusées.
- **Commandes sensibles confirmées** (suppression, redémarrage, diffusion à plusieurs serveurs).
- **Journal d'actions** local, consultable dans Réglages, alimenté par l'app, le MCP et l'assistant.
- **Verrouillage de l'app** par mot de passe, manuel (Ctrl+Shift+L) ou après inactivité.

## Compatibilité serveur

| Élément | Requis |
|---|---|
| Système | Linux avec `systemd` (Debian, Ubuntu, Rocky, Alma…), accès SSH |
| Terminal persistant | `tmux` (installé depuis l'app si absent) |
| Conteneurs | Docker ou Podman, accès direct ou via `sudo` |
| Sites | nginx ou Apache |
| Bases de données | MySQL/MariaDB, PostgreSQL (hôte ou conteneur) |
| Sauvegardes | restic (installé depuis l'app si absent) |
| Supervision étendue | agent `helmd` (facultatif) |

Les fonctions non disponibles sur un serveur sont signalées dans l'interface plutôt que masquées.

## Raccourcis clavier

Tous modifiables dans Réglages → Préférences.

| Action | Par défaut |
|---|---|
| Palette de commandes | `Ctrl+K` |
| Assistant IA | `Ctrl+I` |
| Verrouiller Helm | `Ctrl+Shift+L` |
| Nouvel onglet de terminal | `Ctrl+Shift+T` |
| Fermer l'onglet | `Ctrl+Shift+W` |
| Onglet suivant / précédent | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Rechercher dans le terminal | `Ctrl+Shift+F` |
| Copier / coller dans le terminal | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| Actualiser la vue | `F5` |

## Architecture du dépôt

Monorepo pnpm + cargo.

| Dossier | Rôle |
|---|---|
| `apps/desktop` | Application Tauri 2 : interface React/TypeScript (`src/`) et commandes Rust (`src-tauri/`) |
| `crates/core` | SSH, SFTP, tmux, Docker, nginx, Apache, bases de données, systemd, audit, sauvegardes, déploiement |
| `crates/protocol` | Analyseurs `/proc`, types et protocole partagés entre l'app et l'agent |
| `crates/agent` | `helmd`, l'agent de supervision installé sur le serveur |
| `crates/profiles` | Profils, secrets (keyring), journal d'actions, export et synchronisation |
| `crates/mcp` | Serveur MCP en lecture seule, intégré à l'app via `--mcp` |
| `crates/ai` | Client des fournisseurs d'IA (Anthropic, compatible OpenAI, local) |
| `sync-server/` | Service à héberger pour la synchronisation et le relais de terminaux (workspace séparé) |
| `testenv/` | Faux VPS Docker (sshd, nginx, sudo, Docker-in-Docker) pour les tests |
| `docs/` | Notes d'architecture, audits et plans de travail |

L'interface ne parle jamais directement à un serveur : elle appelle des commandes Tauri, qui
s'appuient sur `helm-core` pour toute opération distante. Les secrets restent côté Rust.

## Développement

**Prérequis** : Rust stable, Node 24+, pnpm. Sous Windows : WebView2 et les MSVC Build Tools.
Pour compiler l'agent : `pip install ziglang`, `cargo install cargo-zigbuild`, puis
`rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl`.

```sh
pnpm install
pnpm build:agent   # binaires helmd, embarqués dans l'app au build suivant
pnpm dev           # app en mode développement
pnpm build         # installeurs dans target/release/bundle/
pnpm typecheck     # TypeScript
pnpm test          # tests Rust du workspace + tests front
```

L'app se compile sans l'agent : le bouton d'installation signale alors que le binaire n'a pas été
construit.

### Environnement de test

```sh
pnpm testenv       # faux VPS sur 127.0.0.1:2222 (root/helm, deploy/deploy)
cargo run -p helm-core --example smoke        # SSH, sudo, SFTP, shell
cargo run -p helm-core --example nginx_smoke  # écriture nginx sûre (valide, cassée, restauration)
cargo run -p helm-core --example cwd_smoke    # suivi du dossier courant du terminal
```

Le faux VPS a son propre démon Docker (Docker-in-Docker) : il ne voit jamais les conteneurs de la
machine hôte. Il embarque trois applications de démonstration — `demo-app`, `whoami` (port 8082) et
`demo-db` (MariaDB, mot de passe root `demo`). Pour tout supprimer :
`docker compose -f testenv/docker-compose.yml down -v`.

### Conventions

- Interface, commentaires et messages de commit en français.
- Commits au format [Conventional Commits](https://www.conventionalcommits.org/fr/) :
  `type(portée): message`.
- `cargo fmt`, `clippy -D warnings` et `tsc --noEmit` doivent passer avant de proposer un
  changement.

## Intégration continue et publication

À chaque push et pull request, GitHub Actions ([ci.yml](.github/workflows/ci.yml)) exécute :
typecheck, tests front, `cargo fmt`, `clippy -D warnings` (Linux et Windows), tests Rust, audit des
dépendances, tests de bout en bout contre le faux VPS, puis compilation de l'agent (zig).

Pour publier une version :

```sh
pnpm release 0.6.0
```

Le script met la version à jour (Cargo, app, Tauri), crée le commit `chore(release): v0.6.0` et le
tag `v0.5.0`, puis les pousse. Le tag déclenche [release.yml](.github/workflows/release.yml) : CI
complète, brouillon de release avec notes issues des commits, installeurs Windows (NSIS), macOS
(arm64 et Intel) et Linux (AppImage, deb, rpm) signés pour la mise à jour, puis publication avec le
manifeste `latest.json`. Un tag suffixé (`v0.6.0-beta.1`) produit une pré-release, ignorée par les
mises à jour automatiques.

La clé de signature des mises à jour est dans les secrets du dépôt
(`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) ; sa clé publique est dans
`tauri.conf.json`. Si elle est perdue, les versions déjà installées ne pourront plus se mettre à
jour automatiquement.

## Licence

MIT — voir [LICENSE](LICENSE). © 2026 Nathan Chevrollier.
