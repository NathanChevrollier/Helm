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
};

/** Message d'erreur lisible à partir d'une erreur renvoyée par une commande Tauri. */
export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
