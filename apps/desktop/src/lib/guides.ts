// Fiches d'aide affichées dans la section « Aide » et depuis le « ? » de chaque page.
//
// Chaque fiche répond à trois questions dans cet ordre : à quoi ça sert, ce qu'il faut sur le
// serveur, comment le relier à Helm. Les commandes sont prêtes à coller ; celles marquées `sudo`
// sont préfixées à l'affichage. Quand Helm sait installer la chose lui-même, la fiche le dit et
// les commandes ne servent que de recours.
import type { SectionId } from "../sections";

export type GuideId =
  | "terminal"
  | "sessions"
  | "files"
  | "docker"
  | "compose"
  | "databases"
  | "sites"
  | "agent"
  | "backups"
  | "tunnels"
  | "security"
  | "share"
  | "sync"
  | "ai"
  | "rdp";

export interface GuideStep {
  /** Ce que fait cette étape, en une phrase. */
  text: string;
  /** Commande à coller dans un terminal du serveur. */
  command?: string;
  /** La commande a besoin des droits root. */
  sudo?: boolean;
}

export interface Guide {
  id: GuideId;
  title: string;
  /** Ce que la fonctionnalité apporte, sans jargon. */
  summary: string;
  /** Section de l'app concernée, pour le bouton « Ouvrir ». */
  section?: SectionId;
  /** Ce que Helm fait tout seul : évite de lancer des commandes pour rien. */
  automatic?: string;
  /** Ce qui doit exister sur le serveur. */
  requirements: string[];
  steps: GuideStep[];
  /** Pièges constatés, limites, cas particuliers. */
  notes?: string[];
}

/** Installation d'un paquet, dans l'ordre des gestionnaires reconnus par Helm. */
const install = (paquet: string): GuideStep[] => [
  { text: "Debian, Ubuntu, Raspberry Pi OS", command: `apt-get update && apt-get install -y ${paquet}`, sudo: true },
  { text: "Fedora, Rocky, Alma, CentOS", command: `dnf install -y ${paquet}`, sudo: true },
  { text: "Arch, Manjaro", command: `pacman -S --noconfirm --needed ${paquet}`, sudo: true },
  { text: "Alpine", command: `apk add ${paquet}`, sudo: true },
];

export const GUIDES: Guide[] = [
  {
    id: "sessions",
    title: "Sessions persistantes (tmux)",
    section: "terminal",
    summary:
      "Un terminal qui survit à une coupure réseau, à la mise en veille du PC et à la fermeture de Helm : le programme continue de tourner sur le serveur et l'onglet se rebranche dessus.",
    automatic:
      "Helm installe tmux lui-même : Terminal → Sessions → Installer tmux. Les commandes ci-dessous ne servent que si l'installation automatique échoue.",
    requirements: ["tmux sur le serveur", "un compte qui peut installer des paquets (sudo), seulement pour l'installation"],
    steps: [
      { text: "Vérifier si tmux est déjà là", command: "command -v tmux || echo 'tmux absent'" },
      ...install("tmux"),
      { text: "Unraid n'a pas de gestionnaire de paquets : passer par le plugin « un-get »", command: "un-get update && un-get install tmux" },
      { text: "Vérifier après installation", command: "tmux -V" },
      { text: "Lister les sessions ouvertes par Helm (préfixées « helm- »)", command: "tmux ls" },
    ],
    notes: [
      "Sans tmux, les terminaux fonctionnent normalement : ils ne survivent simplement pas à une coupure.",
      "Helm force « mouse off » sur ses sessions, sinon tmux capte la sélection et la molette à la place du terminal de l'app.",
      "Une session laissée ouverte continue de consommer les ressources de ses programmes : Terminal → Sessions permet de la reprendre ou de la fermer.",
    ],
  },
  {
    id: "terminal",
    title: "Terminal, fichiers et dépôt de fichiers",
    section: "terminal",
    summary:
      "Le panneau Fichiers du terminal suit le dossier courant du shell : un « cd » et la liste se recale. Un fichier glissé depuis Windows est envoyé dans ce dossier.",
    requirements: ["un shell POSIX (bash, zsh, sh)", "/proc monté, c'est-à-dire un Linux classique"],
    steps: [
      { text: "Vérifier que le suivi de dossier peut fonctionner", command: "readlink /proc/$$/cwd" },
      { text: "Si la commande ci-dessus ne répond rien, le serveur n'expose pas /proc : le panneau restera sur le dossier de connexion" },
    ],
    notes: [
      "Le suivi est automatique (relevé toutes les 2,5 s). Le bouton en forme de viseur sert à le couper pour naviguer à la main.",
      "Le bouton « Ouvrir ce dossier » vide la ligne en cours avant d'envoyer le « cd », pour ne pas coller la commande à une saisie en cours.",
    ],
  },
  {
    id: "files",
    title: "Fichiers et transferts",
    section: "files",
    summary: "Explorateur SFTP, copie d'un serveur à l'autre en double panneau, édition distante, repli sudo pour les fichiers protégés.",
    requirements: ["le sous-système SFTP activé dans sshd (cas par défaut)"],
    steps: [
      { text: "Vérifier que SFTP est activé côté serveur", command: "grep -i sftp /etc/ssh/sshd_config" },
      { text: "L'activer s'il manque, puis recharger sshd", command: "printf 'Subsystem sftp internal-sftp\\n' >> /etc/ssh/sshd_config && systemctl reload ssh", sudo: true },
    ],
    notes: ["Un fichier appartenant à root est lu et écrit via sudo si le profil a un mot de passe sudo enregistré."],
  },
  {
    id: "docker",
    title: "Docker : connecter Helm au démon",
    section: "docker",
    summary: "Conteneurs, statistiques, journaux en direct, shell dans un conteneur, images et nettoyage.",
    automatic: "Helm détecte tout seul s'il peut parler à Docker directement, sinon il passe par sudo.",
    requirements: ["Docker ou Podman installé", "l'utilisateur dans le groupe docker, ou un mot de passe sudo enregistré dans le profil"],
    steps: [
      { text: "Vérifier que Docker répond", command: "docker version --format '{{.Server.Version}}'" },
      { text: "Installer Docker (script officiel)", command: "curl -fsSL https://get.docker.com | sh", sudo: true },
      { text: "Autoriser l'utilisateur à parler à Docker sans sudo", command: "usermod -aG docker $USER", sudo: true },
      { text: "Refermer puis rouvrir la session SSH pour que le groupe soit pris en compte, et vérifier", command: "docker ps" },
    ],
    notes: [
      "Mettre un utilisateur dans le groupe docker revient à lui donner les droits root sur la machine : à réserver à un compte d'administration.",
      "Sans ce groupe, Helm fonctionne quand même si le profil a un mot de passe sudo.",
    ],
  },
  {
    id: "compose",
    title: "Projets Docker Compose et déploiement",
    section: "docker",
    summary:
      "Créer un projet compose depuis l'interface, le déployer (pull → up → vérification → retour arrière si l'app ne répond plus), ou le déployer depuis un dépôt GitHub privé.",
    requirements: ["le plugin Docker Compose v2", "un dossier de projet sur le serveur, par exemple /opt/<projet>", "git, seulement pour le déploiement depuis GitHub"],
    steps: [
      { text: "Vérifier que Compose v2 est présent", command: "docker compose version" },
      { text: "L'installer sur Debian/Ubuntu s'il manque", command: "apt-get install -y docker-compose-plugin", sudo: true },
      { text: "Préparer un dossier de projet accessible à ton utilisateur", command: "install -d -o $USER -g $USER /opt/mon-projet", sudo: true },
      { text: "Depuis Helm : Docker → Projets → Nouveau projet compose, choisir ce dossier, écrire le compose.yml, puis Déployer" },
      { text: "Pour un dépôt GitHub privé : Helm génère une clé de déploiement à coller dans Settings → Deploy keys du dépôt, puis vérifier depuis le serveur", command: "ssh -T git@github.com" },
    ],
    notes: [
      "Le déploiement garde l'état précédent : si les conteneurs ne redémarrent pas correctement, Helm remet la version d'avant.",
      "« Restreindre les ports » réécrit les ports publiés en 127.0.0.1 pour qu'un service ne soit plus joignable depuis Internet ; on y accède ensuite par un tunnel.",
    ],
  },
  {
    id: "databases",
    title: "Bases de données",
    section: "databases",
    summary: "Parcourir les bases et les tables de MySQL/MariaDB et PostgreSQL, exécuter du SQL (Ctrl+Entrée), exporter en CSV.",
    requirements: [
      "une instance en conteneur, ou installée sur l'hôte",
      "le client en ligne de commande accessible (mysql / mariadb / psql), dans le conteneur ou sur l'hôte",
      "les identifiants : variables d'environnement du conteneur, ou authentification par socket pour un service local",
    ],
    steps: [
      { text: "Repérer une instance en conteneur", command: "docker ps --filter ancestor=mysql --filter ancestor=mariadb --filter ancestor=postgres" },
      { text: "Vérifier le client dans le conteneur", command: "docker exec <conteneur> sh -c 'command -v mysql || command -v mariadb || command -v psql'" },
      { text: "Pour une instance installée sur l'hôte, vérifier qu'elle tourne", command: "systemctl status mariadb postgresql --no-pager" },
    ],
    notes: [
      "Helm lit le mot de passe root dans les variables d'environnement du conteneur ; s'il n'y est pas, l'instance reste listée et l'erreur apparaît à la première requête.",
      "Pour joindre la base depuis un outil de ton PC sans l'exposer : Tunnels.",
    ],
  },
  {
    id: "sites",
    title: "Sites, nginx ou Apache, certificats",
    section: "sites",
    summary: "Relier un sous-domaine à un conteneur ou à un port local, éditer le vhost sans risque, suivre les certificats et restaurer une configuration précédente.",
    requirements: ["nginx ou Apache installé", "un mot de passe sudo dans le profil (l'écriture et le rechargement en ont besoin)", "certbot pour les certificats Let's Encrypt"],
    steps: [
      { text: "Vérifier le serveur web", command: "nginx -v || apachectl -v" },
      { text: "Installer nginx", command: "apt-get install -y nginx", sudo: true },
      { text: "Installer certbot", command: "apt-get install -y certbot python3-certbot-nginx", sudo: true },
      { text: "Vérifier à la main que la configuration est valide (Helm le fait à chaque écriture)", command: "nginx -t", sudo: true },
      { text: "Voir les sauvegardes prises par Helm avant chaque modification", command: "ls -1 /var/backups/helm/nginx", sudo: true },
    ],
    notes: [
      "Chaque écriture suit le même déroulé : sauvegarde complète, écriture, test, rechargement, et restauration exacte si le test ou le rechargement échoue.",
      "Les 30 dernières sauvegardes sont conservées ; les écritures hors du dossier de configuration sont refusées.",
    ],
  },
  {
    id: "agent",
    title: "Agent helmd : historique et alertes hors ligne",
    section: "monitoring",
    summary:
      "Sans agent, Helm affiche l'état en direct quand il est ouvert. Avec l'agent, le serveur garde 30 jours d'historique et envoie les alertes même PC éteint.",
    automatic: "Installation en un clic : Supervision → Agent & alertes → Installer. Helm envoie le binaire par SSH et crée le service.",
    requirements: ["systemd", "un mot de passe sudo dans le profil", "Linux x86_64 ou arm64"],
    steps: [
      { text: "Vérifier le service après installation", command: "systemctl status helmd --no-pager" },
      { text: "Voir ses journaux", command: "journalctl -u helmd -n 50 --no-pager", sudo: true },
      { text: "Configuration (seuils, destinations d'alerte) — modifiable depuis Helm", command: "cat /etc/helmd/config.json", sudo: true },
      { text: "Redémarrer après une modification à la main", command: "systemctl restart helmd", sudo: true },
    ],
    notes: [
      "L'agent n'ouvre aucun port : il écoute sur un socket unix (/run/helmd/helmd.sock) et Helm l'interroge à travers SSH.",
      "Il tourne sous un utilisateur dédié, avec un service durci et 64 Mo de mémoire au maximum.",
      "Les alertes partent vers Discord, ntfy ou un webhook de ton choix.",
    ],
  },
  {
    id: "backups",
    title: "Sauvegardes (restic)",
    section: "backups",
    summary: "Sauvegardes chiffrées et dédupliquées : dumps de bases cohérents, volumes Docker, dossiers ; vers le serveur lui-même ou un stockage S3.",
    automatic: "Helm installe restic et prépare /etc/helm-backup lors de la première configuration.",
    requirements: ["restic", "un mot de passe sudo dans le profil", "de la place sur le disque, ou un accès S3 (identifiants et bucket)"],
    steps: [
      { text: "Vérifier restic", command: "restic version" },
      ...install("restic").slice(0, 2),
      { text: "Lancer une sauvegarde à la main (Helm crée ce script)", command: "/etc/helm-backup/run.sh", sudo: true },
      { text: "Vérifier la planification", command: "systemctl list-timers 'helm-backup*' --no-pager" },
    ],
    notes: [
      "La phrase de passe du dépôt restic est indispensable pour restaurer : Helm la garde dans le coffre-fort de ton système, garde-la aussi ailleurs.",
      "Une sauvegarde sur le même disque que les données ne protège pas d'une panne de disque : prévoir S3 ou un autre serveur.",
    ],
  },
  {
    id: "tunnels",
    title: "Tunnels : joindre un service sans l'exposer",
    section: "tunnels",
    summary:
      "Un port du serveur devient accessible sur ton PC en 127.0.0.1, à travers la connexion SSH. La base ou l'interface d'administration reste invisible depuis Internet.",
    requirements: ["rien de plus : le tunnel passe par la connexion SSH existante"],
    steps: [
      { text: "Depuis Helm : Tunnels → Nouveau tunnel, choisir le port distant (3306, 5432, 8080…) et le port local" },
      { text: "Équivalent en ligne de commande, pour comparaison", command: "ssh -N -L 13306:127.0.0.1:3306 utilisateur@serveur" },
      { text: "Vérifier côté serveur ce qui écoute", command: "ss -lntp" },
    ],
    notes: ["Helm n'écoute que sur 127.0.0.1 côté PC : le tunnel n'est pas partagé avec le réseau local."],
  },
  {
    id: "security",
    title: "Audit de sécurité et corrections",
    section: "security",
    summary: "État de SSH, du pare-feu, de fail2ban, des mises à jour, des ports exposés et des comptes privilégiés, avec des corrections guidées.",
    requirements: ["un mot de passe sudo dans le profil pour appliquer les corrections", "ufw ou firewalld pour le pare-feu, fail2ban pour le bannissement"],
    steps: [
      { text: "Installer le pare-feu et fail2ban", command: "apt-get install -y ufw fail2ban", sudo: true },
      { text: "Voir l'état du pare-feu", command: "ufw status verbose", sudo: true },
      { text: "Voir les prisons fail2ban actives", command: "fail2ban-client status", sudo: true },
    ],
    notes: [
      "Avant de modifier SSH ou le pare-feu, Helm garde une connexion de contrôle ouverte : si la modification coupe l'accès, elle est annulée automatiquement.",
      "Une alerte qui ne te concerne pas peut être ignorée : elle passe alors dans les alertes archivées.",
    ],
  },
  {
    id: "share",
    title: "Partager un terminal ou une configuration",
    summary:
      "Montrer un terminal à quelqu'un, en lecture seule ou avec le contrôle, et transmettre un profil de serveur à une autre installation de Helm.",
    requirements: ["un serveur de relais (sync-server) joignable par les deux personnes"],
    steps: [
      { text: "Sur ton VPS : récupérer le dossier sync-server du dépôt, puis le lancer", command: "docker compose up -d" },
      { text: "Le publier derrière nginx avec HTTPS : le dépôt fournit nginx.conf.example (il gère la montée en WebSocket)" },
      { text: "Dans Helm : Réglages → Synchronisation, renseigner l'adresse du serveur et la phrase de passe" },
      { text: "Terminal → Partager : Helm copie une invitation « helm-term:… » à transmettre. Le destinataire la colle dans Terminal → Rejoindre." },
    ],
    notes: [
      "Le relais ne voit rien : tout est chiffré côté client (AES-256-GCM) avec une clé qui n'est que dans l'invitation.",
      "« Avec le contrôle » donne à la personne tes droits sur le serveur : à réserver à quelqu'un de confiance. Le partage s'arrête quand tu le décides ou à la fermeture de l'onglet.",
    ],
  },
  {
    id: "sync",
    title: "Synchroniser plusieurs postes",
    section: "settings",
    summary: "Retrouver ses serveurs, identifiants, clés d'hôte, fragments et tunnels sur un autre PC.",
    requirements: ["soit un dossier déjà synchronisé (OneDrive, Dropbox, Syncthing, partage réseau), soit un sync-server"],
    steps: [
      { text: "Le plus simple : Réglages → Synchronisation → Fichier, et choisir un dossier synchronisé par un autre outil" },
      { text: "Sinon, héberger le relais sur le VPS", command: "docker compose up -d" },
      { text: "Vérifier qu'il répond", command: "curl -fsS https://sync.mondomaine.fr/health" },
    ],
    notes: [
      "La phrase de passe ne quitte jamais tes PC : si tu la perds, les données synchronisées sont irrécupérables.",
      "Les secrets ne sont inclus que si tu coches l'option ; sinon seuls les profils sont synchronisés.",
    ],
  },
  {
    id: "ai",
    title: "Assistant IA",
    summary: "Poser une question sur une erreur, un journal ou une configuration, sans copier-coller vers un autre outil.",
    requirements: ["une clé d'API (Claude ou service compatible OpenAI), ou un modèle local (Ollama, LM Studio)"],
    steps: [
      { text: "Réglages → Assistant IA : choisir le fournisseur et coller la clé (elle va dans le coffre-fort du système)" },
      { text: "Pour un modèle local, vérifier qu'il répond", command: "curl -fsS http://localhost:11434/api/tags" },
      { text: "Choisir ce que l'assistant peut consulter, serveur par serveur, puis ouvrir le panneau avec Ctrl+I" },
    ],
    notes: [
      "Trois modes : lecture seule, proposition (chaque commande est validée par toi, mode par défaut) et autonome.",
      "Même en mode autonome, les commandes sensibles demandent ton accord. Chaque appel est inscrit au journal d'actions.",
    ],
  },
  {
    id: "rdp",
    title: "Bureau à distance (RDP)",
    section: "servers",
    summary: "Ouvrir une session graphique sur une machine Windows ou sur un Linux équipé d'un serveur RDP, depuis la fiche du serveur.",
    requirements: ["un client RDP sur ton PC : mstsc sous Windows, xfreerdp sous Linux", "un serveur RDP sur la machine cible (xrdp pour Linux)"],
    steps: [
      { text: "Installer xrdp sur un serveur Linux", command: "apt-get install -y xrdp && systemctl enable --now xrdp", sudo: true },
      { text: "Vérifier qu'il écoute", command: "ss -lntp | grep 3389" },
      { text: "Ne pas exposer 3389 sur Internet : passer par un tunnel Helm, puis se connecter sur 127.0.0.1" },
    ],
  },
];

export const guideOf = (id: GuideId): Guide | undefined => GUIDES.find((g) => g.id === id);

/** Fiche correspondant à une section, pour le « ? » du bandeau de page. */
export const guideForSection = (section: SectionId): Guide | undefined => GUIDES.find((g) => g.section === section);
