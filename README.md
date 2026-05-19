# easycode

Easycode is an Electron desktop app for running coding-agent workflows against local repositories. It combines a React renderer, Electron main-process orchestration, local persistence, secure secret storage, Git worktrees, chat and run history, and a provider layer that supports OpenAI, OpenAI-compatible backends, Codex CLI, and Claude Code.

## What It Does

- Add and manage multiple Git projects
- Start agent runs against a project in either a dedicated worktree or the local repository
- Keep one run workspace per run and preserve reviewable Git diffs
- Run standalone chats alongside code-editing runs
- Bookmark both runs and chats for later review
- Stream run and chat events into the UI
- Preview diffs, inspect step history, and open run workspaces in an IDE
- Use an embedded terminal for run worktrees
- Store provider secrets locally through Electron secure storage
- Support shell approvals and shell allowlists for agent execution
- Resume or recover interrupted sessions where supported by persisted checkpoint state

## Architecture

- `apps/desktop`
  - Electron main process, IPC wiring, app controller, workers, terminal support, secret store
  - Preload bridge exposed as `window.easycode`
  - React renderer for landing, sidebar, project, run, chat, bookmark, and settings screens
- `packages/shared`
  - Shared types, IPC contracts, provider metadata, run/chat DTOs, settings keys
- `packages/db`
  - Local persisted state using `sql.js`
  - Projects, runs, chats, bookmarks, settings, steps, snapshots, resume checkpoints
- `packages/git-service`
  - Repo validation, worktree creation/release, branch helpers
- `packages/agent-runtime`
  - Runtime execution and event streaming helpers
- `packages/provider-ai-sdk`
  - Unified AI SDK provider adapter and OpenAI-compatible provider helpers
- `packages/provider-azure-legacy`
  - Azure Legacy Provider client and harness helpers
- `packages/provider-codex-cli`
  - Codex CLI provider adapter
- `packages/provider-claude-code`
  - Claude Code provider adapter using the local `claude` CLI

## Providers

Easycode currently supports these provider types:

- `openai`
- `openai-compatible`
- `azure-legacy` (Azure Legacy Provider)
- `codex-cli`
- `claude-code`

The provider layer is intentionally separate from the runtime/harness layer so auth/config logic can evolve independently from run execution and streaming behavior.

## Development

From the repo root:

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @easycode/desktop build
```

Packaging shortcuts:

```bash
pnpm build:win
pnpm build:linux
pnpm build:mac
```

## Notes

- Secrets are stored locally through Electron secure storage and must not be persisted as plaintext in the DB.
- Runs may use dedicated worktrees or the local repository, depending on the selected workspace mode.
- The embedded terminal uses `node-pty`, which is a native dependency.
- `electron-builder` is configured with `npmRebuild: false` to avoid requiring native rebuilds during packaging.
- The app persists run/chat history, bookmarks, settings, and recovery metadata locally through `sql.js`.

## Contributing

When changing shared app behavior, keep the main process, preload bridge, shared types, DB snapshot shape, and renderer consumers in sync. For UI work, preserve the app's dense, developer-tool style and favor compact layouts over tall decorative ones.
