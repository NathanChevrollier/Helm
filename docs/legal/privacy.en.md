# Zenytt privacy policy

*Last updated: September 30, 2026 — the [French version](confidentialite.md) prevails.*

Zenytt is a desktop application that runs **on your computer**. It has no user account, no central
server and **no telemetry**: its publisher receives no usage statistics, crash reports or any
other data about you.

## Data stored on your computer

- Server profiles and settings, including private networks (private addresses and WireGuard public
  keys): `zenytt.json` in the app configuration folder.
- Passwords (including database accounts you save), key passphrases, API keys and tokens: your operating system's credential store
  (Windows Credential Manager, macOS Keychain, Linux Secret Service), never in plain text.
- Approved host key fingerprints, UI state, a local action log, and a technical log (5 rotating
  files of up to 2 MB, no secrets).
- Labels and notes you put on IP addresses (fail2ban), mount point settings and containers marked
  "stopped on purpose": `zenytt.json`.
- If you turn on IP location: the DB-IP Lite databases, in the app data folder (`geo`), used to
  locate addresses **on your computer** without sending them anywhere.

Uninstalling Zenytt and deleting its configuration folder and credential entries removes everything.

## Data sent to your own servers

Zenytt connects over SSH to the servers you configure. The private network (WireGuard) links the
servers you choose: each server generates its own private key, which never leaves it; traffic flows
directly between your servers, encrypted, never through the publisher or a third party. A virtual machine's screen is shown through an SSH tunnel;
its VNC password, if any, is read from the server and kept in memory only for the session. Database
backups made from Zenytt are written on the server, in the SSH user's `~/zenytt-sauvegardes-bdd`
folder, and only leave it if you download them; passwords of database accounts you create or change
travel over the encrypted SSH connection and are not stored by Zenytt. Tools a
feature needs (WireGuard, restic, tmux…) are installed with the server's package manager, which
contacts your distribution's repositories.

## Third-party services (only when you use the feature)

| Feature | Service | Data sent |
|---|---|---|
| Updates | GitHub | Your IP address and installed version, at startup |
| Access diagnostics | api.ipify.org | Your IP address |
| IP location (fail2ban, off by default) | download.db-ip.com (DB-IP) | Your IP address, as for any download. No address from your logs is sent: Zenytt downloads a free database (CC BY 4.0) and looks addresses up on your computer, about once a month |
| Server public IP | api.ipify.org, from the server | The server's IP address |
| Domain expiry | rdap.org and domain registries | Your sites' domain names |
| AI assistant (off until a provider is set) | The provider you choose (Anthropic, OpenAI, Mistral, OpenRouter, or a local model) | Your messages and what the assistant reads on your servers (logs, configs). Detected secrets are masked before sending, without absolute guarantee |
| Alerts | Discord, ntfy or any webhook you configure | Alert text |
| Backups | Storage you configure | Backups encrypted by restic |
| Sync / shared terminal | A folder or a `zenytt-sync` server you host | End-to-end encrypted data (AES-256-GCM); your passphrase never leaves your devices |
| HTTPS certificates | Let's Encrypt, from the server | Domain and the email you enter |

Each service applies its own privacy policy. Some are located outside the EU (notably the US).

## Your rights

Since the publisher collects no data, there is nothing to access, correct or delete on its side:
your data stays under your control. Questions: see the contact in the
[legal notice](mentions-legales.md). You may also contact your data protection authority (in
France, the CNIL).
