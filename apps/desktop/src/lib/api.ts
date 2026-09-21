import { Channel, invoke } from "@tauri-apps/api/core";

export type AuthKind = "password" | "key" | "agent";

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  keyPath?: string | null;
  color?: string | null;
  group?: string | null;
}

export interface ServerView extends ServerProfile {
  hasPassword: boolean;
  hasPassphrase: boolean;
  hasSudoPassword: boolean;
  connected: boolean;
}

/** `undefined` = inchangé, `""` = supprimé. */
export interface SecretsInput {
  password?: string;
  passphrase?: string;
  sudoPassword?: string;
}

export interface ConnectInfo {
  fingerprint: string;
  hostname: string;
  os: string;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export type TermEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

export type EntryKind = "dir" | "file" | "symlink" | "other";

export interface FsEntry {
  name: string;
  path: string;
  kind: EntryKind;
  targetIsDir: boolean;
  size: number;
  modified: number | null;
  permissions: string;
  mode: number;
  owner: string | null;
  group: string | null;
}

export interface Listing {
  path: string;
  entries: FsEntry[];
}

export interface Progress {
  file: string;
  done: number;
  total: number;
}

export interface Disk {
  mount: string;
  device: string;
  total: number;
  used: number;
}

export interface Metrics {
  timestamp: number;
  cpuPercent: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  load: [number, number, number];
  uptimeSecs: number;
  netRxRate: number;
  netTxRate: number;
  disks: Disk[];
}

export interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  disk: number;
  load: number;
  rx: number;
  tx: number;
}

export interface Process {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  elapsed: number;
  name: string;
  command: string;
}

export interface Service {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string;
}

export type AlertMetric = "cpu" | "memory" | "disk" | "load";

export interface AgentConfig {
  serverName?: string | null;
  sampleIntervalSecs: number;
  rules: { metric: AlertMetric; threshold: number; forSecs: number; enabled: boolean }[];
  httpChecks: { name: string; url: string; enabled: boolean }[];
  httpCheckIntervalSecs: number;
  notifiers: { discordWebhook?: string | null; ntfyUrl?: string | null; webhookUrl?: string | null };
}

export interface ActiveAlert {
  key: string;
  title: string;
  message: string;
  since: number;
}

export interface AlertEvent {
  t: number;
  key: string;
  title: string;
  message: string;
  resolved: boolean;
}

export interface AgentStatus {
  version: string;
  protocol: number;
  startedAt: number;
  hostname: string;
  config: AgentConfig;
  configError: string | null;
  activeAlerts: ActiveAlert[];
  recentEvents: AlertEvent[];
  latest: Metrics | null;
}

export interface AgentInfo {
  installed: boolean;
  running: boolean;
  status: AgentStatus | null;
  error: string | null;
}

export type DockerAccess = "direct" | "sudo" | "unavailable";

export interface PortMapping {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: PortMapping[];
  portsRaw: string;
  createdAt: string;
  composeProject: string | null;
  composeService: string | null;
}

export interface ComposeProject {
  name: string;
  status: string;
  configFiles: string;
}

export interface DockerOverview {
  access: DockerAccess;
  version: string;
  containers: Container[];
  projects: ComposeProject[];
}

export interface ContainerStats {
  id: string;
  cpu: number;
  memPercent: number;
  memUsage: string;
  netIo: string;
  pids: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdSince: string;
  containers: string;
}

export interface DockerDiskUsage {
  kind: string;
  totalCount: string;
  active: string;
  size: string;
  reclaimable: string;
}

function progressChannel(onProgress: (p: Progress) => void) {
  const channel = new Channel<Progress>();
  channel.onmessage = onProgress;
  return channel;
}

export const api = {
  version: () => invoke<string>("app_version"),

  servers: () => invoke<ServerView[]>("servers_list"),
  saveServer: (profile: ServerProfile, secretsInput: SecretsInput) =>
    invoke<string>("server_save", { profile, secretsInput }),
  deleteServer: (id: string) => invoke<void>("server_delete", { id }),
  trustHost: (id: string, fingerprint: string) => invoke<void>("host_trust", { id, fingerprint }),
  connect: (id: string) => invoke<ConnectInfo>("ssh_connect", { id }),
  disconnect: (id: string) => invoke<void>("ssh_disconnect", { id }),
  puttySessions: () => invoke<ServerProfile[]>("putty_sessions"),

  snippets: () => invoke<Snippet[]>("snippets_list"),
  saveSnippet: (snippet: Snippet) => invoke<void>("snippet_save", { snippet }),
  deleteSnippet: (id: string) => invoke<void>("snippet_delete", { id }),

  termOpen: (serverId: string, cols: number, rows: number, onEvent: (e: TermEvent) => void, command?: string) => {
    const channel = new Channel<TermEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("term_open", { serverId, cols, rows, command, onEvent: channel });
  },
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),

  fsHome: (serverId: string) => invoke<string>("fs_home", { serverId }),
  fsList: (serverId: string, path: string) => invoke<Listing>("fs_list", { serverId, path }),
  fsRead: (serverId: string, path: string, sudo = false) => invoke<string>("fs_read", { serverId, path, sudo }),
  fsWrite: (serverId: string, path: string, content: string, sudo = false) =>
    invoke<void>("fs_write", { serverId, path, content, sudo }),
  fsMkdir: (serverId: string, path: string) => invoke<void>("fs_mkdir", { serverId, path }),
  fsCreate: (serverId: string, path: string) => invoke<void>("fs_create", { serverId, path }),
  fsRename: (serverId: string, from: string, to: string) => invoke<void>("fs_rename", { serverId, from, to }),
  fsRemove: (serverId: string, paths: string[]) => invoke<void>("fs_remove", { serverId, paths }),
  fsChmod: (serverId: string, path: string, mode: number) => invoke<void>("fs_chmod", { serverId, path, mode }),
  fsDownload: (serverId: string, paths: string[], localDir: string | null, onProgress: (p: Progress) => void) =>
    invoke<string>("fs_download", { serverId, paths, localDir, onProgress: progressChannel(onProgress) }),
  fsUpload: (serverId: string, localPaths: string[], remoteDir: string, onProgress: (p: Progress) => void) =>
    invoke<void>("fs_upload", { serverId, localPaths, remoteDir, onProgress: progressChannel(onProgress) }),

  metrics: (serverId: string) => invoke<Metrics>("mon_metrics", { serverId }),
  processes: (serverId: string) => invoke<Process[]>("mon_processes", { serverId }),
  kill: (serverId: string, pid: number, force: boolean) => invoke<void>("mon_kill", { serverId, pid, force }),
  services: (serverId: string) => invoke<Service[] | null>("mon_services", { serverId }),
  serviceAction: (serverId: string, unit: string, action: string) => invoke<void>("mon_service_action", { serverId, unit, action }),
  serviceLogs: (serverId: string, unit: string, lines = 300) => invoke<string>("mon_service_logs", { serverId, unit, lines }),
  agentInfo: (serverId: string) => invoke<AgentInfo>("agent_info", { serverId }),
  agentHistory: (serverId: string, rangeSecs: number, points = 400) =>
    invoke<HistoryPoint[]>("agent_history", { serverId, rangeSecs, points }),
  agentInstall: (serverId: string) => invoke<string>("agent_install", { serverId }),
  agentUninstall: (serverId: string) => invoke<void>("agent_uninstall", { serverId }),
  agentSaveConfig: (serverId: string, config: AgentConfig) => invoke<void>("agent_save_config", { serverId, config }),
  agentTestNotify: (serverId: string) => invoke<string>("agent_test_notify", { serverId }),

  dockerOverview: (serverId: string) => invoke<DockerOverview>("docker_overview", { serverId }),
  dockerStats: (serverId: string) => invoke<ContainerStats[]>("docker_stats", { serverId }),
  dockerAction: (serverId: string, id: string, action: string) => invoke<void>("docker_container_action", { serverId, id, action }),
  dockerInspect: (serverId: string, id: string) => invoke<string>("docker_inspect", { serverId, id }),
  dockerLogs: (serverId: string, id: string, tail = 500) => invoke<string>("docker_logs", { serverId, id, tail }),
  composeAction: (serverId: string, project: ComposeProject, action: string) =>
    invoke<string>("docker_compose_action", { serverId, project, action }),
  composeCommand: (project: ComposeProject, sub: string) => invoke<string>("docker_compose_command", { project, sub }),
  dockerStorage: (serverId: string) => invoke<{ images: DockerImage[]; usage: DockerDiskUsage[] }>("docker_storage", { serverId }),
  dockerRemoveImage: (serverId: string, id: string) => invoke<void>("docker_remove_image", { serverId, id }),
  dockerPrune: (serverId: string, what: string) => invoke<string>("docker_prune", { serverId, what }),
};

export function formatDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Message d'erreur lisible à partir d'une erreur renvoyée par une commande Tauri. */
export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
