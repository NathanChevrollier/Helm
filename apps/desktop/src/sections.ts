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

export interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Section qui dépend du serveur sélectionné. */
  perServer?: boolean;
}

export const SECTIONS: Section[] = [
  { id: "home", label: "Accueil", icon: LayoutDashboard, description: "Santé de tous tes serveurs d'un coup d'œil." },
  { id: "servers", label: "Serveurs", icon: Server, description: "Profils de connexion, clés SSH et secrets stockés dans le keyring de l'OS." },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, description: "Sessions SSH persistantes en onglets et panneaux, snippets, diffusion." },
  { id: "files", label: "Fichiers", icon: FolderTree, perServer: true, description: "Explorateur SFTP, transferts entre serveurs, édition distante." },
  { id: "monitoring", label: "Monitoring", icon: Activity, perServer: true, description: "CPU, RAM, disque, réseau, processus, services systemd et alertes." },
  { id: "docker", label: "Docker", icon: Container, perServer: true, description: "Conteneurs, logs en direct, exec, stats, compose et déploiement." },
  { id: "databases", label: "Bases de données", icon: Database, perServer: true, description: "Bases MySQL/MariaDB et PostgreSQL : tables, requêtes SQL, export CSV." },
  { id: "sites", label: "Sites", icon: Globe, perServer: true, description: "Sous-domaines nginx, certificats SSL, sauvegardes de configuration." },
  { id: "logs", label: "Journaux", icon: ScrollText, perServer: true, description: "Logs Docker, systemd et nginx en direct, fusionnés et filtrables." },
  { id: "tunnels", label: "Tunnels", icon: Cable, description: "Accès local à des services du serveur, sans les exposer sur Internet." },
  { id: "backups", label: "Sauvegardes", icon: DatabaseBackup, perServer: true, description: "Sauvegardes planifiées et chiffrées (restic), restauration." },
  { id: "security", label: "Sécurité", icon: ShieldCheck, perServer: true, description: "Audit du serveur et corrections guidées." },
  { id: "help", label: "Aide", icon: CircleHelp, description: "Comment marche chaque fonctionnalité et ce qu'elle demande sur le serveur." },
  { id: "settings", label: "Réglages", icon: Settings, description: "Journal d'actions, accès IA (MCP) et préférences." },
];
