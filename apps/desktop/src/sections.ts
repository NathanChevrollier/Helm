import {
  Activity,
  Cable,
  CircleHelp,
  Container,
  Database,
  DatabaseBackup,
  FolderTree,
  Globe,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

export type SectionId =
  | "home"
  | "servers"
  | "terminal"
  | "files"
  | "monitoring"
  | "docker"
  | "databases"
  | "sites"
  | "logs"
  | "tunnels"
  | "backups"
  | "security"
  | "help"
  | "settings";

/**
 * Groupes de la barre latérale : « Poste » (ce qui vit sur ton PC ou couvre tous les serveurs),
 * « Serveur » (ce qui agit sur le serveur choisi en haut de la colonne), et le pied de colonne.
 */
export type SectionGroup = "poste" | "serveur" | "pied";

export interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  description: string;
  group: SectionGroup;
  /** Section qui dépend du serveur sélectionné. */
  perServer?: boolean;
}

export const SECTIONS: Section[] = [
  { id: "home", group: "poste", label: "Accueil", icon: LayoutDashboard, description: "Santé de tous tes serveurs d'un coup d'œil." },
  { id: "terminal", group: "poste", label: "Terminal", icon: SquareTerminal, description: "Sessions SSH persistantes en onglets et panneaux, snippets, diffusion." },
  { id: "tunnels", group: "poste", label: "Tunnels", icon: Cable, description: "Accès local à des services du serveur, sans les exposer sur Internet." },
  { id: "servers", group: "poste", label: "Serveurs", icon: Server, description: "Profils de connexion, clés SSH et secrets stockés dans le keyring de l'OS." },
  { id: "monitoring", group: "serveur", label: "Supervision", icon: Activity, perServer: true, description: "CPU, RAM, disque, réseau, processus, services systemd et alertes." },
  { id: "files", group: "serveur", label: "Fichiers", icon: FolderTree, perServer: true, description: "Explorateur SFTP, recherche et grep distants, archives, comparaison, transferts entre serveurs, édition distante." },
  { id: "docker", group: "serveur", label: "Docker", icon: Container, perServer: true, description: "Conteneurs, logs en direct, exec, stats, compose, catalogue d'applications 1-clic, registres privés et nettoyage de disque." },
  { id: "databases", group: "serveur", label: "Bases de données", icon: Database, perServer: true, description: "Bases MySQL/MariaDB, PostgreSQL et SQLite : tables, requêtes SQL, édition en place, export CSV, et explorateur Redis." },
  { id: "sites", group: "serveur", label: "Sites", icon: Globe, perServer: true, description: "Sous-domaines nginx, certificats SSL, sauvegardes de configuration." },
  { id: "logs", group: "serveur", label: "Journaux", icon: ScrollText, perServer: true, description: "Logs Docker, systemd et nginx en direct, fusionnés et filtrables." },
  { id: "backups", group: "serveur", label: "Sauvegardes", icon: DatabaseBackup, perServer: true, description: "Sauvegardes planifiées et chiffrées (restic), restauration." },
  { id: "security", group: "serveur", label: "Sécurité", icon: ShieldCheck, perServer: true, description: "Audit du serveur et corrections guidées." },
  { id: "help", group: "pied", label: "Aide", icon: CircleHelp, description: "Comment marche chaque fonctionnalité et ce qu'elle demande sur le serveur." },
  { id: "settings", group: "pied", label: "Réglages", icon: Settings, description: "Préférences, raccourcis, assistant IA, synchronisation et journal d'actions." },
];
