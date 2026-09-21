import {
  Activity,
  Container,
  FolderTree,
  Globe,
  Server,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

export type SectionId = "servers" | "terminal" | "files" | "monitoring" | "docker" | "sites";

export interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** Phase de la roadmap qui livre cette section. */
  phase: number;
  description: string;
}

export const SECTIONS: Section[] = [
  { id: "servers", label: "Serveurs", icon: Server, phase: 1, description: "Profils de connexion, clés SSH et secrets stockés dans le keyring de l'OS." },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, phase: 1, description: "Sessions SSH en onglets et panneaux, reconnexion automatique, snippets." },
  { id: "files", label: "Fichiers", icon: FolderTree, phase: 2, description: "Explorateur SFTP, transferts avec progression, édition distante." },
  { id: "monitoring", label: "Monitoring", icon: Activity, phase: 3, description: "CPU, RAM, disque, réseau, processus, services systemd et alertes." },
  { id: "docker", label: "Docker", icon: Container, phase: 4, description: "Conteneurs, logs en direct, exec, stats et docker compose." },
  { id: "sites", label: "Sites", icon: Globe, phase: 5, description: "Sous-domaines nginx, certificats SSL et assistant « Nouveau site »." },
];
