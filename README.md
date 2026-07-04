# BuildWarden

BuildWarden is yet another GUI for coding agents. In comparison to most others, it also focuses on project management, not just agent runs. Also separated are standalone chats without any linked repository. BuildWarden keeps projects, runs, chats, worktrees, branches, review activity, provider configuration, and local app state coordinated through a typed Electron main/preload/renderer boundary.

## What It Does

- Add and manage multiple local Git projects.
- Start agent runs in `code`, `plan`, or `ask` mode against either a dedicated Git worktree or the local repository.
- Keep one workspace context per run, stream agent activity into the UI, and preserve reviewable diffs.
- Continue runs, undo a run to the last prompt, resume from saved checkpoints, and recover interrupted provider sessions where supported.
- Review run changes with activity, diff, terminal, in-app browser, and notes panels.
- Commit run worktree changes, publish branches, create local branches, and create GitHub pull requests or GitLab merge requests.
- Run standalone chats with history, follow-ups, file attachments, and generated file attachments from supported providers.
- Bookmark both runs and chats, and move runs into a project-level "For Later" view.
- Manage project branches, project task prompts, AI-generated project insights, and Project Lab implementation/RFC threads.
- Inspect and review GitHub pull requests or GitLab merge requests from a project, including diffs, activity, review comments, replies, approvals, and thread resolution.
- Configure integrated skills globally and per project.
- Store provider keys, PR/MR tokens, and proxy passwords through Electron secure storage.
- Support shell approvals, user-input requests, shell allowlists, per-run token accounting, and optional provider request/response logging.

## Architecture

- `apps/desktop`
  - Electron main process, IPC handlers, app controller, run/chat orchestration, workers, terminal IPC, notifications, and secret-store integration.
  - Preload bridge exposed as `window.buildwarden`; renderer code should use this bridge for privileged operations.
  - React renderer for landing, sidebar, project, run, chat, bookmark, settings, branch, PR/MR review, Project Lab, and insight views.
- `packages/shared`
  - Shared types, DTOs, IPC contract shapes, provider metadata, settings keys, run/chat/event contracts, project insight types, and integrated skill metadata.
- `packages/db`
  - Local persisted state using `sql.js`.
  - Projects, provider accounts, models, runs, run steps, run notes, worktrees, bookmarks, chats, chat steps, chat bookmarks, project tasks, project insights, Project Lab threads/events, provider session runtime, settings, snapshots, and checkpoint metadata.
- `packages/git-service`
  - Repository validation, worktree lifecycle, branch management, diff computation, GitHub/GitLab remote parsing, PR/MR diff fetching, branch publishing, and pull/merge request creation helpers.
- `packages/agent-runtime`
  - Runtime execution primitives, run registry, event normalization, status persistence, and streaming adapter glue.
- `packages/provider-ai-sdk`
  - Unified AI SDK provider and harness for OpenAI, Anthropic, Google, xAI, and OpenAI-compatible endpoints.
- `packages/provider-azure-legacy`
  - Azure Legacy Provider client and harness for Azure/OpenAI-style Chat Completions flows.
- `packages/provider-codex-cli`
  - Codex CLI app-server provider and harness, including local session resume, shell approval/user-input bridging, and Codex-oriented model helpers.
- `packages/provider-claude-code`
  - Claude Code provider and harness using the local `claude` CLI.
- `packages/provider-cursor-agent`
  - Cursor Agent provider and harness using the local `agent acp` CLI flow.

## Providers

BuildWarden currently models provider accounts with these provider types:

- `ai-sdk`
- `azure-legacy`
- `codex-cli`
- `claude-code`
- `cursor-agent`

The AI SDK provider can be configured for OpenAI, Anthropic, Google, xAI, or OpenAI-compatible endpoints. Codex CLI, Claude Code, and Cursor Agent use local CLI installations and local session state. Provider configuration and auth stay separate from runtime execution so the app can share run/chat orchestration while keeping provider-specific behavior isolated.

## Git, Worktrees, And Review

- Project repositories are user-owned and must not be confused with BuildWarden-created worktrees.
- A run can use a dedicated worktree branch or operate in the local repository, depending on `workspaceType`.
- Worktree diffs include staged, unstaged, and untracked changes where possible.
- Run workspaces can be opened in configured IDEs, an embedded terminal, a system terminal, or the file manager.
- Branch management supports fetch, checkout, create, rename, delete, pull, and push operations.
- Pull/merge request publishing uses `gh` or `glab` when available, with provider web draft URLs as a fallback.
- Project PR/MR review supports GitHub and GitLab remotes with project-scoped API tokens stored in the secret store.

## Development

From the repo root:

```bash
pnpm install
pnpm dev
```

Useful validation commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @buildwarden/desktop build
```

Packaging shortcuts:

```bash
pnpm build:win
pnpm build:win:portable
pnpm build:linux
pnpm build:linux:appimage
pnpm build:linux:deb
pnpm build:mac
pnpm build:all
```

## Notes

- The workspace is a `pnpm` monorepo with packages under `apps/*` and `packages/*`.
- Secrets are stored through Electron `safeStorage` when available and must not be written to SQLite as plaintext.
- The embedded terminal uses `node-pty`; if it is unavailable, terminal support is disabled with a user-facing setup hint.
- `electron-builder` is configured with `npmRebuild: false`; native module setup should be handled during dependency installation, not during packaging.
- `pnpm lint` runs the desktop ESLint task and the desktop Vitest suite through the root script.
- Some run/chat state survives app restarts through DB rows, checkpoints, and provider session runtime records.
- Renderer code must go through `window.buildwarden`; privileged filesystem, Git, shell, and secret-store logic belongs in the Electron main process.

## Contributing

Keep changes small, typed, and aligned across the Electron boundary. When changing shared app behavior, update shared contracts, DB snapshot/persistence shape, main IPC/controller logic, preload exposure, and renderer consumers together. For UI work, preserve BuildWarden's dense developer-tool layout and avoid spending vertical space without a clear workflow benefit.
