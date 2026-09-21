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
};

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
