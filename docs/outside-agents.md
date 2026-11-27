# Outside agents (MCP)

BuildWarden serves an MCP endpoint at `/mcp` on its remote access server, so an agent outside the
app (Claude Code or Codex in a terminal, or any MCP client) can list projects, start runs, follow
them and send follow-ups.

## Connect

1. Turn on **Settings → Network → Remote access**.
2. Under **Connect an outside agent**, choose the access and select **Create agent token**.
   - **Read only**: projects, models, runs and their timelines.
   - **Start runs**: also start, continue and cancel runs.
3. Copy the `claude mcp add` command, or the URL and token for another client:

```sh
claude mcp add --transport http buildwarden http://127.0.0.1:47831/mcp --header "Authorization: Bearer <token>"
```

The URL uses the Tailscale endpoint when it is verified, otherwise loopback. The token is shown
once. It appears under **Paired devices**, where you can revoke it.

On a headless host (`buildwarden serve`), run `buildwarden agent-token` (or `--read-only`) instead;
it prints the URL, the token and the same command.

## Tools

| Tool | Access | What it does |
| --- | --- | --- |
| `list_projects`, `list_models`, `list_runs`, `read_run` | Read only | Read projects, enabled models, a project's runs and a run's timeline (paged) |
| `wait_for_run` | Read only | Wait up to 110 s for a run's turn to end or to ask for approval or input |
| `start_run` | Start runs | Start a run: first enabled model, code mode and an isolated workspace unless given |
| `send_to_run` | Start runs | Send a follow-up to a finished run |
| `cancel_run` | Start runs | Stop a run's current turn |

Every tool runs a remote operation with the token's scopes, so a token cannot do more than a paired
device with the same access. Approvals stay in BuildWarden: commands a run wants to execute wait for
you there, and no token can answer them.
