# Helm v2 — plan d'actions

Objectif : ajouter les 13 fonctionnalités suivantes sans dégrader la sécurité ni la stabilité de la v1.
Sessions tmux, restauration de l'espace de travail, diffusion de la saisie, vue multi-serveurs, transferts entre serveurs, palette Ctrl+K, tunnels SSH, journaux centralisés, déploiement GitHub, audit de sécurité, sauvegardes planifiées, historique des sauvegardes nginx, serveur MCP en lecture seule.

## Règles de sécurité (valables pour chaque phase)

1. **Aucun port ouvert sur le VPS.** Tout passe par SSH : pas de webhook entrant, pas d'API exposée.
2. **Toute action qui modifie le serveur** suit le même déroulé : aperçu exact de ce qui va être fait, puis confirmation, sauvegarde, application, vérification, et restauration automatique si la vérification échoue (comme nginx en v1).
3. **Secrets** : côté PC, uniquement dans le coffre de l'OS. Côté serveur, uniquement dans des fichiers root en `0600`. Jamais dans les logs, l'historique, le journal d'actions ni le MCP.
4. **Aucune chaîne libre dans une commande shell** : validation par liste blanche, puis `shell_quote`. Tout nouveau module passe par les validateurs existants ou en ajoute, avec tests.
5. **Journal d'actions local** : qui, quoi, quel serveur, quand, résultat. Il est consultable dans l'app.
6. **Tests destructifs uniquement dans un environnement isolé** (voir phase 6). Plus jamais sur le Docker de l'hôte.

## Définition de « terminé » pour chaque fonctionnalité

- Tests unitaires Rust sur la logique (parseurs, validateurs, génération de scripts).
- Test de fumée contre le faux VPS (`crates/core/examples/*`).
- Scénario e2e Playwright **versionné dans le dépôt** (`tests/e2e/`) : fini le dossier temporaire.
- `cargo fmt`, `clippy -D warnings` (Windows et cible Linux) et `tsc` au vert.
- Un commit Conventional Commits par fonctionnalité, et une mise à jour du README.

---

## Phase 6 — Fondations (à faire en premier)

Ces fondations servent à toutes les phases suivantes.

| # | Tâche | Détail |
|---|---|---|
| 6.1 | **Faux VPS isolé** | Refonte de `testenv` : image Ubuntu **avec systemd**, un démon **Docker-in-Docker** dédié (le faux VPS ne voit plus les conteneurs de l'hôte), un serveur ACME **Pebble** pour tester certbot de bout en bout, et un 2ᵉ faux VPS pour le multi-serveurs. Comble aussi les trous de la v1 : onglet Services, installation systemd de l'agent, certbot. |
| 6.2 | **Tests e2e dans le dépôt** | `tests/e2e/` : Playwright via CDP, un script `pnpm e2e` qui lance le faux VPS, l'app et les scénarios. Garde-fou : un scénario refuse de tourner si le démon Docker visé n'est pas celui du faux VPS. |
| 6.3 | **Journal d'actions** | Module Rust `audit` : fichier JSON-lines local avec rotation. Chaque commande qui modifie un serveur y écrit une ligne. Écran « Journal » dans l'app. |
| 6.4 | **Registre d'actions** | Chaque module déclare ses actions (id, libellé, serveur, niveau de risque, fonction). Il alimentera la palette Ctrl+K (phase 9) et les confirmations uniformes. |
| 6.5 | **État d'interface persistant** | Store Zustand sérialisé (onglets, écrans divisés, dossiers ouverts, section) dans `helm.json`, avec une version de schéma pour les migrations. |

## Phase 7 — Terminal

| # | Tâche | Conception | Sécurité / robustesse |
|---|---|---|---|
| 7.1 | **Sessions persistantes tmux** | Chaque onglet s'attache à une session `helm-<id>` (`tmux new -A -s …`). Si tmux est absent, l'app propose de l'installer ; sinon, repli sur un shell simple. Reconnexion automatique avec backoff exponentiel après une coupure réseau. Écran « Sessions » : sessions orphelines, rattacher ou fermer. | Noms de session validés. Config tmux minimale injectée (souris, scrollback) sans toucher au `.tmux.conf` de l'utilisateur. |
| 7.2 | **Restauration de l'espace de travail** | Au démarrage, les onglets sont recréés et se rattachent à leur session tmux, s'ils l'avaient. Les dossiers de l'explorateur et la section active sont rétablis. | Aucune connexion automatique à un serveur dont la clé d'hôte a changé : l'approbation reste manuelle. |
| 7.3 | **Diffusion de la saisie** | Mode activé explicitement sur une sélection d'onglets, avec un bandeau rouge « Saisie diffusée à N terminaux » sur chacun. | Il se désactive tout seul quand on change de section. Une commande dangereuse (`rm -rf`, `reboot`, `mkfs`, `dd`, `shutdown`…) déclenche une confirmation avant l'envoi. |

## Phase 8 — Multi-serveurs

| # | Tâche | Conception | Sécurité / robustesse |
|---|---|---|---|
| 8.1 | **Vue d'ensemble** | Nouvelle section « Accueil » : une carte par serveur avec CPU, RAM, disque, alertes actives, conteneurs arrêtés, certificats à moins de 21 jours, agent installé ou non. Les données viennent de l'agent si possible (1 requête), sinon d'un relevé direct. | Pas plus de 4 serveurs interrogés en parallèle, timeout de 10 s par serveur, un serveur injoignable n'est pas bloquant. Rafraîchissement toutes les 30 s, seulement quand la vue est affichée. |
| 8.2 | **Transferts entre serveurs** | Explorateur à deux panneaux, chacun sur un serveur au choix. Glisser d'un panneau à l'autre copie en flux SFTP A → PC → B (mémoire bornée, par blocs de 256 Ko), avec progression, annulation et fichiers ou dossiers. | Aucune clé privée copiée sur les serveurs, pas d'agent forwarding. Écrasement uniquement après confirmation. |

## Phase 9 — Productivité

| # | Tâche | Conception | Sécurité / robustesse |
|---|---|---|---|
| 9.1 | **Palette Ctrl+K** | Recherche floue dans le registre d'actions (6.4) : aller à une section, ouvrir un chemin, redémarrer un conteneur, suivre les logs de X, ouvrir un tunnel, lancer un snippet. Les actions récentes remontent en tête. | Une action risquée passe par la même confirmation que depuis l'interface. |
| 9.2 | **Tunnels SSH** | Redirections locales (`direct-tcpip` de russh), écoute **uniquement sur 127.0.0.1**, port local libre vérifié. Tunnels enregistrés par profil, avec démarrage auto optionnel et reconnexion. Raccourci « Accéder depuis mon PC » sur chaque conteneur ou port. | Jamais d'écoute sur 0.0.0.0. Pas de redirection distante (`-R`), qui exposerait le PC. |
| 9.3 | **Refermer un port exposé** | Suite des tunnels : sur un conteneur publié sur `0.0.0.0`, une correction guidée réécrit le mapping en `127.0.0.1:` dans le fichier compose puis relance le projet. Tu passes ensuite par un tunnel. | Aperçu du diff du fichier compose, sauvegarde, `docker compose config` pour valider avant de l'appliquer, restauration si le conteneur ne redémarre pas. |
| 9.4 | **Journaux centralisés** | Nouvelle section « Journaux » : plusieurs sources suivies en même temps (`docker logs -f`, `journalctl -fu`, `tail -F` des logs nginx), fusionnées dans l'ordre, chacune avec son étiquette de couleur. Filtre texte ou regex, niveau, pause, export. | Chaque source a son propre canal SSH, fermé quand on quitte la vue. Tampon limité à 20 000 lignes. Chemins de logs en liste blanche. |

## Phase 10 — Sécurité et fiabilité

| # | Tâche | Conception | Sécurité / robustesse |
|---|---|---|---|
| 10.1 | **Historique des sauvegardes nginx** | Liste des sauvegardes de `/var/backups/helm/nginx`, avec le diff par rapport à la config actuelle, puis **Restaurer**. La restauration réutilise `APPLY_SCRIPT` : elle est elle-même sauvegardée, testée par `nginx -t`, et annulée si elle échoue. | Chemins validés, uniquement sous `/var/backups/helm/nginx`. |
| 10.2 | **Audit de sécurité** | Contrôles **en lecture seule** : SSH (`PermitRootLogin`, `PasswordAuthentication`), pare-feu ufw, fail2ban, mises à jour en attente, ports exposés (`ss` et Docker), certificats, utilisateurs avec UID 0. Chaque constat a une gravité et une explication. | Chaque correction est un script montré avant exécution. **SSH** : `sshd -t`, puis application, puis ouverture d'une **2ᵉ connexion de contrôle** ; si elle échoue, restauration automatique de `sshd_config` alors que la connexion d'origine est encore ouverte. **ufw** : le port SSH réel est toujours autorisé avant d'activer le pare-feu. |
| 10.3 | **Sauvegardes planifiées** | Sur le serveur, **restic** (chiffré, dédupliqué, rétention) lancé par un timer systemd `helm-backup.timer` en root. Sources : volumes Docker, dumps MySQL/PostgreSQL faits par `docker exec` (dump cohérent, sans arrêter la base), `/etc/nginx`, `/opt/sites`. Destinations : stockage S3 compatible (Backblaze, Scaleway, OVH…) et/ou téléchargement vers le PC. Écran avec historique des sauvegardes, test de restauration, et restauration fichier par fichier ou totale. | Mot de passe restic et clés S3 dans `/etc/helm-backup/` en root `0600`. Le mot de passe restic est aussi gardé dans le coffre du PC, car sans lui les sauvegardes sont illisibles. Chaque sauvegarde est vérifiée (`restic check`) ; l'agent envoie une alerte en cas d'échec. Une restauration se fait vers un dossier temporaire, puis bascule après confirmation. |

## Phase 11 — Déploiement depuis GitHub

| # | Tâche | Conception | Sécurité / robustesse |
|---|---|---|---|
| 11.1 | **Bouton « Déployer »** | Sur un projet compose : pull, puis `up -d`, puis vérification HTTP du site. **Si la vérification échoue, retour automatique à l'image précédente**, identifiée par son digest noté avant le pull. | Chaque déploiement est inscrit au journal d'actions. |
| 11.2 | **Déploiement automatique au push** | Pas de webhook, pour ne pas ouvrir de port. Helm génère une **clé de déploiement dédiée**, restreinte dans `authorized_keys` par `command="helm-deploy <projet>"`, `restrict` et `from=` (optionnel). Il fournit aussi le workflow GitHub Actions prêt à coller et le secret à créer. `helm-deploy` est un script root qui ne peut déployer **que** ce projet. | La clé ne peut rien faire d'autre : pas de shell, pas de redirection. Révocation en un clic. |

## Phase 12 — Serveur MCP en lecture seule

| # | Tâche | Conception |
|---|---|---|
| 12.1 | **Crate `crates/mcp`** | Binaire `helm-mcp` en stdio (SDK `rmcp`), qui réutilise `helm-core`, les profils, le coffre et les clés d'hôte approuvées. |
| 12.2 | **Outils** | `list_servers`, `server_status`, `metrics_history`, `alerts`, `list_containers`, `container_logs`, `compose_projects`, `list_sites`, `nginx_config`, `service_logs`, `list_processes`, `read_file`, `audit_report`, `backup_status`. **Aucun outil d'écriture ni d'exécution libre.** |
| 12.3 | **Garde-fous** | Accès IA à activer serveur par serveur (désactivé par défaut). Secrets masqués (variables `*PASSWORD*`/`*TOKEN*`/`*SECRET*`/`*KEY*`, `.env`, clés privées). `read_file` limité à une liste blanche, avec liste noire forcée (`/etc/shadow`, `~/.ssh`, `privkey*`). Réponses tronquées à une taille maximale. Chaque appel est inscrit au journal d'actions. |
| 12.4 | **Intégration** | Réglage « IA / MCP » dans l'app : interrupteurs, journal des accès, bouton « Copier la config » pour Claude Code et Claude Desktop. |

---

## Ordre et estimation

| Phase | Contenu | Effort estimé |
|---|---|---|
| 6 | Fondations (faux VPS isolé, e2e, journal, registre, état persistant) | ~1 j |
| 7 | tmux, restauration, diffusion | ~1 j |
| 8 | Vue d'ensemble, transferts entre serveurs | ~1 j |
| 9 | Palette, tunnels, ports exposés, journaux centralisés | ~1,5 j |
| 10 | Historique nginx, audit, sauvegardes | ~2 j |
| 11 | Déploiement | ~0,5 j |
| 12 | MCP | ~1 j |

Chaque phase se termine par un commit par fonctionnalité, CI au vert, et une version installable.

## Choix par défaut (modifiables)

- **tmux** : proposé à l'installation s'il est absent. Jamais installé sans confirmation.
- **Sauvegardes** : restic + stockage S3 compatible, avec un **dossier local du VPS comme destination de repli** tant qu'aucun stockage n'est configuré. Rétention : 7 quotidiennes, 4 hebdomadaires, 6 mensuelles. Planification quotidienne à 3 h.
- **Déploiement** : clé dédiée + commande forcée, **pas de webhook**.
- **MCP** : lecture seule stricte. Aucun serveur exposé par défaut.

## Ce qui nécessitera ton intervention

- Identifiants du stockage S3 (et création du bucket) pour les sauvegardes distantes.
- Création du secret et du workflow dans ton dépôt GitHub pour le déploiement automatique.
- Validation, sur ton vrai VPS, des corrections de l'audit touchant SSH ou le pare-feu : l'app les propose, tu décides.
