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
  /** Accessible au serveur MCP (lecture seule). */
  aiAccess?: boolean;
  /** Serveur de rebond (bastion) à traverser pour joindre celui-ci. */
  jumpId?: string | null;
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

export interface F2bJail {
  name: string;
  currentlyFailed: number;
  totalFailed: number;
  currentlyBanned: number;
  totalBanned: number;
  banned: string[];
  bantime: number;
  findtime: number;
  maxretry: number;
  ignoreip: string[];
}

export interface F2bState {
  installed: boolean;
  running: boolean;
  version: string | null;
  jails: F2bJail[];
}

export interface FwRule {
  num: number;
  to: string;
  action: string;
  from: string;
  v6: boolean;
}

export interface FwExposure {
  port: number;
  proto: string;
  address: string;
  owner: string;
  public: boolean;
  docker: boolean;
  status: "open" | "blocked" | "local";
  note: string;
}

export interface FwState {
  kind: "ufw" | "firewalld" | "none";
  active: boolean;
  defaults: string | null;
  rules: FwRule[];
  raw: string | null;
  exposures: FwExposure[];
  sshPorts: number[];
}

export interface AuthorizedKey {
  line: string;
  algorithm: string;
  fingerprint: string;
  comment: string;
  options: string;
  current: boolean;
}

export interface ServerUser {
  name: string;
  uid: number;
  home: string;
  shell: string;
  groups: string[];
  admin: boolean;
  lastLogin: string;
  keys: AuthorizedKey[];
}

export interface CronJob {
  schedule: string;
  user: string | null;
  command: string;
  human: string | null;
}

export interface CronSource {
  id: string;
  label: string;
  editable: boolean;
  raw: string;
  jobs: CronJob[];
}

export interface SystemdTimer {
  unit: string;
  activates: string;
  next: string;
  last: string;
}

export interface Schedule {
  crontabs: CronSource[];
  timers: SystemdTimer[];
  systemd: boolean;
}

export interface DomainInfo {
  domain: string;
  ips: string[];
  dns: "ok" | "elsewhere" | "missing" | "unknown";
  dnsDetail: string;
  registrable: string;
  expires: string | null;
}

export interface DiagnosisCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface Diagnosis {
  checks: DiagnosisCheck[];
  verdict: string;
  advice: string[];
  probablyBanned: boolean;
  publicIp: string | null;
}

/** Date de modification (s) et taille d'un fichier distant. */
export interface FileStamp {
  mtime: number;
  size: number;
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
  /** « docker » ou « podman ». */
  engine: string;
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

export interface NginxLocation {
  path: string;
  proxyPass: string | null;
  root: string | null;
  returns: string | null;
}

export interface ServerBlock {
  serverNames: string[];
  listen: string[];
  ssl: boolean;
  root: string | null;
  sslCertificate: string | null;
  returns: string | null;
  locations: NginxLocation[];
  line: number;
  upstreamPorts: number[];
}

export interface SiteFile {
  path: string;
  realPath: string;
  enabled: boolean;
  servers: ServerBlock[];
}

export interface Certificate {
  path: string;
  subject: string;
  domains: string[];
  notAfter: number;
  issuer: string;
}

export interface NginxState {
  installed: boolean;
  version: string;
  running: boolean;
  files: SiteFile[];
  disabled: SiteFile[];
  certificates: Certificate[];
  certbot: boolean;
  /** Autres serveurs web détectés (Caddy, Apache, Traefik…), non gérés par Helm. */
  others: string[];
}

export interface ApplyResult {
  ok: boolean;
  backup: string | null;
  log: string;
}

export interface NewSitePlan {
  freePort: number;
  usedPorts: number[];
  publicIp: string | null;
  docker: boolean;
  certbot: boolean;
}

export interface AppSpec {
  name: string;
  image: string;
  hostPort: number;
  containerPort: number;
  env: [string, string][];
}

export interface TunnelDef {
  id: string;
  serverId: string;
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface TunnelView extends TunnelDef {
  running: boolean;
  activeConnections: number;
  totalConnections: number;
  lastError: string | null;
}

export interface LogSource {
  kind: "docker" | "unit" | "file";
  name: string;
}

export type LogEvent = { type: "lines"; lines: { source: number; text: string }[] } | { type: "ended"; source: number; error: string | null };

export type Severity = "critical" | "high" | "medium" | "low" | "ok";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: string | null;
  fixLabel: string | null;
}

export interface SecurityReport {
  os: string;
  sshPorts: number[];
  findings: Finding[];
}

export interface FixPlan {
  id: string;
  description: string;
  script: string;
  needsVerification: boolean;
}

export type BackupDestination =
  | { kind: "local"; path: string }
  | { kind: "s3"; endpoint: string; bucket: string; prefix: string; accessKeyId: string };

export interface DbSource {
  container: string;
  kind: "mysql" | "postgres";
}

export interface BackupConfig {
  destination: BackupDestination;
  schedule: string;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  paths: string[];
  volumes: string[];
  databases: DbSource[];
}

export interface BackupOverview {
  status: {
    restic: string | null;
    config: BackupConfig | null;
    last: { startedAt: number; finishedAt: number; ok: boolean; message: string } | null;
    nextRun: string | null;
  };
  defaultConfig: BackupConfig;
  volumes: string[];
  databases: DbSource[];
  passwordInKeyring: boolean;
}

export interface Snapshot {
  short_id: string;
  time: string;
  paths: string[];
  hostname: string;
}

export interface SnapshotNode {
  path: string;
  name: string;
  kind: string;
  size: number;
}

export interface DeployKey {
  project: string;
  privateKey: string;
  knownHosts: string;
  user: string;
  workflow: string;
}

export interface McpConfig {
  command: string;
  claudeDesktop: string;
  claudeCode: string;
}

function progressChannel(onProgress: (p: Progress) => void) {
  const channel = new Channel<Progress>();
  channel.onmessage = onProgress;
  return channel;
}

export interface DashboardSummary {
  connected: boolean;
  error: string | null;
  metrics: Metrics | null;
  agent: boolean;
  alerts: ActiveAlert[];
  docker: boolean;
  containersRunning: number;
  containersStopped: number;
  stoppedNames: string[];
  certificates: { domains: string[]; notAfter: number }[];
}

export interface AuditEntry {
  t: number;
  origin: string;
  serverId: string;
  serverName: string;
  action: string;
  detail: string;
  ok: boolean;
  error: string | null;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  created: number;
  windows: number;
  command: string;
}

export const api = {
  version: () => invoke<string>("app_version"),

  uiStateGet: () => invoke<unknown>("ui_state_get"),
  storeWarning: () => invoke<string | null>("store_warning"),
  f2bState: (serverId: string) => invoke<F2bState>("f2b_state", { serverId }),
  f2bUnban: (serverId: string, jail: string, ip: string) => invoke<void>("f2b_unban", { serverId, jail, ip }),
  f2bSetIgnore: (serverId: string, addresses: string[]) => invoke<string>("f2b_set_ignore", { serverId, addresses }),
  myPublicIp: () => invoke<string | null>("my_public_ip"),
  fwState: (serverId: string) => invoke<FwState>("fw_state", { serverId }),
  fwAllow: (serverId: string, port: number, proto: string) => invoke<string>("fw_allow", { serverId, port, proto }),
  fwDelete: (serverId: string, num: number) => invoke<string>("fw_delete", { serverId, num }),
  accessUsers: (serverId: string) => invoke<ServerUser[]>("access_users", { serverId }),
  accessAddKey: (serverId: string, user: string, key: string) => invoke<void>("access_add_key", { serverId, user, key }),
  accessRemoveKey: (serverId: string, user: string, line: string) => invoke<void>("access_remove_key", { serverId, user, line }),
  scheduleList: (serverId: string) => invoke<Schedule>("schedule_list", { serverId }),
  crontabSave: (serverId: string, user: string, content: string) => invoke<void>("crontab_save", { serverId, user, content }),
  timerRun: (serverId: string, service: string) => invoke<void>("timer_run", { serverId, service }),
  domainsCheck: (serverId: string, domains: string[]) => invoke<DomainInfo[]>("domains_check", { serverId, domains }),
  diagnose: (id: string) => invoke<Diagnosis>("ssh_diagnose", { id }),
  settingsExport: (path: string, password: string, includeSecrets: boolean) => invoke<void>("settings_export", { path, password, includeSecrets }),
  settingsImportEncrypted: (path: string) => invoke<boolean>("settings_import_encrypted", { path }),
  settingsImport: (path: string, password: string) =>
    invoke<{ servers: number; snippets: number; tunnels: number; secrets: number }>("settings_import", { path, password }),
  shellHistory: (serverId: string) => invoke<string[]>("shell_history", { serverId }),
  logsOpenDir: () => invoke<void>("logs_open_dir"),
  appIsLocked: () => invoke<boolean>("app_is_locked"),
  appLockEngage: () => invoke<void>("app_lock_engage"),
  appUnlock: (password: string) => invoke<boolean>("app_unlock", { password }),
  appLockGet: () => invoke<string | null>("app_lock_get"),
  /** Chaîne vide : supprime le mot de passe (verrouillage désactivé). */
  appLockSet: (hash: string) => invoke<void>("app_lock_set", { hash }),
  uiStateSet: (state: unknown) => invoke<void>("ui_state_set", { state }),
  auditList: (limit = 500) => invoke<AuditEntry[]>("audit_list", { limit }),
  tmuxCheck: (serverId: string) => invoke<string | null>("tmux_check", { serverId }),
  tmuxInstall: (serverId: string) => invoke<string>("tmux_install", { serverId }),
  tmuxSessions: (serverId: string) => invoke<TmuxSession[]>("tmux_sessions", { serverId }),
  tmuxKill: (serverId: string, name: string) => invoke<void>("tmux_kill", { serverId, name }),

  servers: () => invoke<ServerView[]>("servers_list"),
  saveServer: (profile: ServerProfile, secretsInput: SecretsInput) =>
    invoke<string>("server_save", { profile, secretsInput }),
  deleteServer: (id: string) => invoke<void>("server_delete", { id }),
  trustHost: (id: string, fingerprint: string) => invoke<void>("host_trust", { id, fingerprint }),
  connect: (id: string, userInitiated = false) => invoke<ConnectInfo>("ssh_connect", { id, userInitiated }),
  disconnect: (id: string) => invoke<void>("ssh_disconnect", { id }),
  puttySessions: () => invoke<ServerProfile[]>("putty_sessions"),
  sshConfigSessions: () => invoke<ServerProfile[]>("ssh_config_sessions"),
  setAiAccess: (id: string, enabled: boolean) => invoke<void>("server_set_ai_access", { id, enabled }),

  snippets: () => invoke<Snippet[]>("snippets_list"),
  saveSnippet: (snippet: Snippet) => invoke<void>("snippet_save", { snippet }),
  deleteSnippet: (id: string) => invoke<void>("snippet_delete", { id }),

  termOpen: (
    serverId: string,
    cols: number,
    rows: number,
    onEvent: (e: TermEvent) => void,
    opts: { command?: string; tmuxSession?: string } = {},
  ) => {
    const channel = new Channel<TermEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("term_open", { serverId, cols, rows, command: opts.command, tmuxSession: opts.tmuxSession, onEvent: channel });
  },
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),

  fsHome: (serverId: string) => invoke<string>("fs_home", { serverId }),
  fsList: (serverId: string, path: string) => invoke<Listing>("fs_list", { serverId, path }),
  fsRead: (serverId: string, path: string, sudo = false) => invoke<string>("fs_read", { serverId, path, sudo }),
  /** Écrit un fichier ; avec `expected`, échoue (erreur `CONFLICT…`) s'il a changé entre-temps. Renvoie son nouvel état. */
  fsWrite: (serverId: string, path: string, content: string, sudo = false, expected: FileStamp | null = null) =>
    invoke<FileStamp | null>("fs_write", { serverId, path, content, sudo, expected }),
  fsStat: (serverId: string, path: string, sudo = false) => invoke<FileStamp | null>("fs_stat", { serverId, path, sudo }),
  fsMkdir: (serverId: string, path: string) => invoke<void>("fs_mkdir", { serverId, path }),
  fsCreate: (serverId: string, path: string) => invoke<void>("fs_create", { serverId, path }),
  fsRename: (serverId: string, from: string, to: string) => invoke<void>("fs_rename", { serverId, from, to }),
  fsRemove: (serverId: string, paths: string[]) => invoke<void>("fs_remove", { serverId, paths }),
  fsChmod: (serverId: string, path: string, mode: number) => invoke<void>("fs_chmod", { serverId, path, mode }),
  fsDownload: (serverId: string, paths: string[], localDir: string | null, transferId: number, onProgress: (p: Progress) => void) =>
    invoke<string>("fs_download", { serverId, paths, localDir, transferId, onProgress: progressChannel(onProgress) }),
  fsUpload: (serverId: string, localPaths: string[], remoteDir: string, transferId: number, onProgress: (p: Progress) => void) =>
    invoke<void>("fs_upload", { serverId, localPaths, remoteDir, transferId, onProgress: progressChannel(onProgress) }),
  fsCopyBetween: (
    srcServer: string,
    paths: string[],
    dstServer: string,
    dstDir: string,
    overwrite: boolean,
    transferId: number,
    onProgress: (p: Progress) => void,
  ) => invoke<void>("fs_copy_between", { srcServer, paths, dstServer, dstDir, overwrite, transferId, onProgress: progressChannel(onProgress) }),
  fsCancel: (transferId: number) => invoke<void>("fs_cancel", { transferId }),
  dashboardSummary: (serverId: string) => invoke<DashboardSummary>("dashboard_summary", { serverId }),

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

  sitesState: (serverId: string) => invoke<NginxState>("sites_state", { serverId }),
  sitesRead: (serverId: string, path: string) => invoke<string>("sites_read", { serverId, path }),
  sitesWrite: (serverId: string, path: string, content: string, enableLink?: string) =>
    invoke<ApplyResult>("sites_write", { serverId, path, content, enableLink }),
  sitesSetEnabled: (serverId: string, available: string, link: string, enabled: boolean) =>
    invoke<ApplyResult>("sites_set_enabled", { serverId, available, link, enabled }),
  sitesDelete: (serverId: string, available: string, link: string) => invoke<ApplyResult>("sites_delete", { serverId, available, link }),
  sitesTest: (serverId: string) => invoke<{ ok: boolean; output: string }>("sites_test", { serverId }),
  sitesReload: (serverId: string) => invoke<string>("sites_reload", { serverId }),
  sitesPlan: (serverId: string) => invoke<NewSitePlan>("sites_plan", { serverId }),
  sitesResolve: (serverId: string, domain: string) => invoke<string | null>("sites_resolve", { serverId, domain }),
  sitesCreateApp: (serverId: string, spec: AppSpec) => invoke<string>("sites_create_app", { serverId, spec }),
  sitesCertbot: (serverId: string, domain: string, email: string) => invoke<string>("sites_certbot", { serverId, domain, email }),
  sitesRenew: (serverId: string) => invoke<string>("sites_renew", { serverId }),
  sitesCheck: (serverId: string, domain: string) => invoke<string>("sites_check", { serverId, domain }),
  sitesPreview: (domain: string, hostPort: number, app?: AppSpec) =>
    invoke<{ vhost: string; compose: string | null }>("sites_preview", { domain, hostPort, app }),
  tunnels: () => invoke<TunnelView[]>("tunnels_list"),
  tunnelSave: (def: TunnelDef) => invoke<string>("tunnel_save", { def }),
  tunnelDelete: (id: string) => invoke<void>("tunnel_delete", { id }),
  tunnelStart: (id: string) => invoke<void>("tunnel_start", { id }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
  tunnelFreePort: (start: number) => invoke<number>("tunnel_free_port", { start }),

  logSources: (serverId: string) => invoke<{ containers: string[]; units: string[]; files: string[] }>("logs_sources", { serverId }),
  logsStart: (serverId: string, sources: LogSource[], lines: number, onEvent: (e: LogEvent) => void) => {
    const channel = new Channel<LogEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("logs_start", { serverId, sources, lines, onEvent: channel });
  },
  logsStop: (id: number) => invoke<void>("logs_stop", { id }),

  restrictPreview: (serverId: string, project: ComposeProject, hostPort: number) =>
    invoke<{ file: string; before: string; after: string }>("docker_restrict_preview", { serverId, project, hostPort }),
  restrictApply: (serverId: string, project: ComposeProject, hostPort: number) =>
    invoke<string>("docker_restrict_apply", { serverId, project, hostPort }),

  nginxBackups: (serverId: string) => invoke<string[]>("nginx_backups", { serverId }),
  nginxBackupDiff: (serverId: string, name: string) => invoke<string>("nginx_backup_diff", { serverId, name }),
  nginxBackupRestore: (serverId: string, name: string) => invoke<ApplyResult>("nginx_backup_restore", { serverId, name }),

  securityAudit: (serverId: string) => invoke<SecurityReport>("security_audit", { serverId }),
  securityFixPlan: (id: string) => invoke<FixPlan>("security_fix_plan", { id }),
  securityFixApply: (serverId: string, id: string) =>
    invoke<{ ok: boolean; output: string; rollback: string | null }>("security_fix_apply", { serverId, id }),

  backupOverview: (serverId: string) => invoke<BackupOverview>("backup_overview", { serverId }),
  backupSave: (serverId: string, config: BackupConfig, resticPassword?: string, s3Secret?: string) =>
    invoke<{ log: string; generatedPassword: string | null }>("backup_save", { serverId, config, resticPassword, s3Secret }),
  backupSnapshots: (serverId: string) => invoke<Snapshot[]>("backup_snapshots", { serverId }),
  backupList: (serverId: string, snapshot: string, path: string) => invoke<SnapshotNode[]>("backup_list", { serverId, snapshot, path }),
  backupRestore: (serverId: string, snapshot: string, path: string) => invoke<string>("backup_restore", { serverId, snapshot, path }),
  backupPutBack: (serverId: string, restored: string, original: string) => invoke<string>("backup_put_back", { serverId, restored, original }),
  backupImportDump: (serverId: string, dump: string, database: DbSource) => invoke<string>("backup_import_dump", { serverId, dump, database }),
  backupStageDownload: (serverId: string, restored: string) => invoke<string>("backup_stage_download", { serverId, restored }),
  backupCheck: (serverId: string) => invoke<string>("backup_check", { serverId }),

  deploySuggestHost: (serverId: string, project: string) => invoke<string | null>("deploy_suggest_host", { serverId, project }),
  deployPrepare: (serverId: string, project: ComposeProject, checkHost: string | null) =>
    invoke<string>("deploy_prepare", { serverId, project, checkHost }),
  deployKeys: (serverId: string) => invoke<string[]>("deploy_keys", { serverId }),
  deployKeyCreate: (serverId: string, project: ComposeProject, checkHost: string | null) =>
    invoke<DeployKey>("deploy_key_create", { serverId, project, checkHost }),
  deployKeyRevoke: (serverId: string, project: string) => invoke<void>("deploy_key_revoke", { serverId, project }),

  mcpConfig: () => invoke<McpConfig>("mcp_config"),
  saveTextFile: (path: string, content: string) => invoke<void>("save_text_file", { path, content }),
};

export function formatDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (secs < 60) return `${Math.max(0, Math.round(secs))} s`;
  return `${m} min`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} o`;
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
