# Headless host

`buildwarden serve` runs BuildWarden without a desktop, for example on a Linux server. Projects, agents, automations and PR watches run on that machine. You use them from a browser or phone through remote access, with the same interface.

It is the same Electron app and needs no X server or Xvfb. Linux and macOS are supported; the systemd service is Linux only.

## What fits

- Web projects: the run browser renders on the host and is streamed to the client, so a development server on the host's `localhost` works.
- Backends, APIs, libraries, command-line tools and infrastructure.
- Always-on work: scheduled automations, loops, PR watches (see [Automations](#automations)).

Desktop, iOS and other apps that need their own screen are better developed with BuildWarden on that machine. Opening folders, IDEs and the system terminal is not available; the embedded terminal is.

## Set up a Linux server

1. Install the `.deb` package (it brings the required system libraries and the Chromium sandbox), Git, and the provider CLIs you use. Sign in to the CLIs as the user that will run BuildWarden. Do not use root: Chromium refuses to start its sandbox as root.
2. Start the host:

   ```bash
   buildwarden service install             # systemd user service
   sudo loginctl enable-linger "$USER"     # keep it running after logout and start it at boot
   ```

   Or run `buildwarden serve` in a terminal or under your own service manager. `service install` stores your current `PATH`, so provider CLIs installed for your user are found, and `BUILDWARDEN_SECRET_KEY_FILE` when it is set; run it again after changing them.
3. Connect. Choose one:

   - **Tailscale:** install it, allow your user to manage it with `sudo tailscale set --operator=$USER`, then `buildwarden remote expose private` (tailnet only) or `buildwarden remote expose internet` (public, through Funnel).
   - **SSH tunnel:** `ssh -L 47831:127.0.0.1:47831 user@server`. Use the same port on both ends; the host rejects other host names and ports.

4. Pair a browser: `buildwarden pair` prints a one-time code, a link, and a QR code when the host has an HTTPS address. Codes expire after five minutes.
5. Add a provider, models and projects, in the browser or in the terminal:

   ```bash
   buildwarden provider add claude              # uses the signed-in Claude Code CLI
   buildwarden model available "Claude Code"
   buildwarden model add "Claude Code" <model>
   buildwarden project clone git@github.com:me/app.git
   buildwarden project token app set            # for PR review and PR watch
   buildwarden doctor
   ```

## Commands

Commands talk to the running host through a socket that only the same user can open. Put `--user-data-dir=<folder>` before the command to use another data directory, and use the same one for `serve`.

| Command | |
| --- | --- |
| `serve [--port <number>] [--run-missed]` | Run the host in the foreground (default port 47831) |
| `status [--json]` | Address, exposure, paired devices, active work, data and log folders |
| `doctor` | Check the host, Git, agent tools, models, disk and service; exits with 1 when something is broken. Works without a running host |
| `stop` | Stop the host |
| `service install [--port <number>] [--run-missed]`, `service uninstall`, `service print` | Manage the systemd user service |
| `pair [--read-only \| --scopes <a,b>] [--origin <url>]` | Create a pairing code; full control by default. `--origin` pairs the hosted website |
| `remote` | Remote access and Tailscale status |
| `remote expose <private\|internet\|local>` | Change the exposure; exits with 1 when it could not be applied |
| `remote origins [add\|remove <url>]` | Hosted website origins that may connect |
| `sessions`, `sessions revoke <id>`, `sessions revoke --all` | Paired devices |
| `proxy`, `proxy set <url>`, `proxy on`, `proxy off`, `proxy clear` | The outbound proxy from Settings → Network |
| `project`, `project add <folder>`, `project clone <url> [folder]` | List projects, add a folder, or clone a repository and add it. `--name <name>` names it |
| `project token <project> [set\|remove]` | GitHub or GitLab access token; `set` asks for it or reads it with `--stdin` |
| `project remove <project>` | Removes the project, its runs and their worktrees. The folder itself is kept |
| `provider`, `provider detect` | List providers; show which agent tools the host finds on its `PATH` |
| `provider add <type>` | `codex`, `claude`, `cursor`, `acp`, `openai`, `anthropic`, `google`, `xai`, `openai-compatible`, `openrouter` or `azure` |
| `provider check`, `provider set-key`, `provider remove <provider>` | Ask again what it supports; replace its API key; remove it when nothing uses it |
| `model`, `model available <provider>`, `model add <provider> <model>...` | List, look up and add models |
| `model remove <model>` | Removes the model with its runs and chats |
| `run [--all]`, `run cancel <run>` | Active or recent runs |
| `automation`, `automation run\|enable\|disable <automation>` | Scheduled work |
| `cli`, `cli check`, `cli on\|off`, `cli update <codex\|claude\|cursor>` | Updates of the agent command-line tools |
| `storage`, `storage compact` | Database size; give free space back to the disk |
| `storage cleanup --days <number>` | Delete runs, chats, lab threads and loops older than that |
| `backup create <file> [--yes]`, `backup restore <file> [--yes]` | Encrypted backup; restoring restarts the host |

Projects, providers, models, automations and runs can be given by name, id, or the first characters of the id as the lists show it. Commands that delete or replace data say what is affected and ask first; `--yes` skips the question.

Options of `provider add`:

| Type | Options |
| --- | --- |
| all | `--label <name>` |
| `codex`, `claude`, `cursor` | `--binary <path>`; also `--home <folder>` (Codex), `--launch-args <args>` (Claude), `--endpoint <url>` (Cursor). These sign in through their own command-line tool |
| `acp` | `--command <command>`, `--env <KEY=VALUE>` (repeatable), `--config <json>` |
| API-key providers | `--key-stdin`, `--base-url <url>`, `--config <json>` (not Azure), `--api-version <version>` (Azure) |

Passwords, API keys and access tokens are never taken as arguments, which other users of the machine could see. They are asked for without echo, or read from standard input with `--password-stdin`, `--key-stdin` or `--stdin`:

```bash
buildwarden proxy set http://proxy.example:8080 --username me --password-stdin < proxy-password.txt
buildwarden provider add openai --key-stdin < openai-key.txt
buildwarden backup create /srv/backup/buildwarden.bwarden --password-stdin < backup-password.txt
```

Setting a proxy without a password forgets the saved one, so it is never sent to a different proxy.

### Commands inside runs

Agents and run terminals on the host inherit `BUILDWARDEN_HOST_CHILD` and cannot use these commands, so a run does not pair devices or publish the host by accident. This is not a security boundary: an agent with Full Access runs as the same user. Run BuildWarden as a separate user if that matters.

Exit codes: 0 success, 1 failure, 2 wrong usage, 3 the host is not running.

## Automations

Automations run on schedule while the host is running. Nobody is asked about automations that were missed while it was off: they are skipped, except those that came due in the last 15 minutes, which covers restarts and updates. A skipped one-time automation shows as missed. With `--run-missed`, every missed automation starts once.

Automatic cleanup of old data is reviewed in the desktop app and does not run on a headless host; use `storage cleanup`.

## Secrets

Servers rarely have an unlocked keyring, so the headless host encrypts secrets (AES-256-GCM) with `<data directory>/secret.key`. That is the `Data` folder `buildwarden status` shows, not the `data` folder inside it. The file is readable only by its owner and is not part of BuildWarden backups. To keep the key elsewhere, such as in a systemd credential, set `BUILDWARDEN_SECRET_KEY_FILE` to a file with 32 base64-encoded bytes (`openssl rand -base64 32`). A configured file is never created or changed by BuildWarden.

The Linux desktop app uses the same key file when no keyring is available. Secrets that earlier versions stored without encryption in that case are encrypted at the next start. Secrets a desktop session saved through a keyring stay stored but cannot be read by a headless host; enter them again or move them with a backup. Devices paired with the desktop app must then be paired again for the headless host, and work again when the desktop app runs.

## Troubleshooting

- `service install` reports that the host did not start, or `serve` exits: see `journalctl --user -u buildwarden` and the log folder. A port that is already in use is fatal on a headless host.
- `No usable sandbox` or a `chrome-sandbox` message: install the `.deb` package. With the archive, run `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox` in its folder.
- To use a display server anyway, such as Xvfb, pass `--ozone-platform=x11` before `serve`.
- The host and the desktop app cannot use the same data directory at the same time.
