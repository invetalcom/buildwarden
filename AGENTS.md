# AGENTS.md

## Purpose

This repository is an Electron desktop app for coding-agent workflows. Optimize for small, correct, reviewable changes that preserve the app's project/worktree/run/chat model and keep local state, Git state, and UI state aligned.

## Stack

- `pnpm` workspace
- Electron + Vite
- React 19 + TypeScript
- Tailwind CSS v4 renderer UI
- `sql.js` for local persisted app state
- `simple-git` for repository and worktree operations
- `node-pty` for the embedded run terminal
- OpenAI-first provider/harness architecture with support for OpenAI-compatible, Codex CLI, Claude Code, and Cursor Agent providers
- Vitest + ESLint + TypeScript for validation

## Workspace Layout

- `apps/desktop`
  - `src/main`: Electron main process, app controller, IPC handlers, workers, secrets, terminal IPC, run/chat orchestration
  - `src/preload`: safe renderer bridge exposed on `window.buildwarden`
  - `src/renderer/src`: React UI for landing, sidebar, project, run, chat, bookmark, and settings flows
- `packages/shared`: shared types, DTOs, provider metadata, IPC contract shapes, settings keys, run/chat types
- `packages/db`: persisted app state, snapshots, bookmarks, chats, settings, run history, checkpoint persistence
- `packages/git-service`: Git repo validation, worktree lifecycle, branch/worktree helpers
- `packages/agent-runtime`: runtime orchestration primitives and event streaming
- `packages/provider-openai`: OpenAI Responses / harness implementation and related helpers
- `packages/provider-ai-sdk`: unified AI SDK provider adapter and OpenAI-compatible provider helpers
- `packages/provider-azure-legacy`: Azure Legacy Provider client and harness helpers
- `packages/provider-codex-cli`: Codex CLI provider adapter and related commit-message helpers
- `packages/provider-claude-code`: Claude Code provider adapter and related local CLI helpers
- `packages/provider-cursor-agent`: Cursor Agent provider adapter and related local CLI helpers

## Product Concepts

- A project points at a user repository and must never be destructively confused with a BuildWarden-created worktree
- A run may use a dedicated worktree or the local repository, depending on `workspaceType`
- Chats are first-class alongside runs and have their own history, bookmarks, attachments, and status
- Bookmarks exist for both runs and chats
- Runs and chats stream step/event history into the DB and renderer
- Shell execution is approval-aware and uses allowlists plus per-run / per-command decisions
- Interrupted runs may resume from checkpoints; do not break checkpoint persistence lightly

## Agent Priorities

1. Preserve the Electron boundary
   - Renderer code must go through `window.buildwarden`
   - Main-process-only logic belongs in `apps/desktop/src/main`
   - When changing bridge methods or payloads, update shared types, main IPC wiring, and preload exposure together
2. Keep project/worktree semantics correct
   - One agent run maps cleanly to one workspace context
   - Deleting runs/projects must clean up only app-created state and worktrees
   - Never delete or mutate the user's original repository in a destructive way when removing a BuildWarden project
3. Keep persisted state and snapshot shape in sync
   - If a record shape changes, update `packages/shared` and `packages/db` together
   - Preserve compatibility for reopened runs/chats/bookmarks/settings where practical
4. Keep provider and harness concerns separate
   - Provider = auth, base URL, model/provider config, environment specifics
   - Harness/runtime = run lifecycle, tool orchestration, streaming, logging, checkpointing
5. Prefer compact, information-dense UI
   - Favor using as little vertical space as possible
   - Avoid tall headers, oversized paddings, and stacked controls when a denser layout would remain clear
   - LLM-designed UIs should optimize for compactness first, especially on run, project, chat, and settings screens

## Editing Rules

- Prefer extracting focused renderer components instead of growing `apps/desktop/src/renderer/src/App.tsx`
- Reuse shared UI primitives in `apps/desktop/src/renderer/src/components/ui`
- Keep TypeScript strict; do not introduce `any` unless unavoidable
- Preserve existing selection/state restoration behavior for project, run, chat, bookmark, and settings navigation
- When changing shared data shape, update both:
  - `packages/shared/src/index.ts`
  - `packages/db/src/index.ts`
- When adding or changing renderer actions, update all relevant layers:
  - `packages/shared/src/index.ts`
  - `apps/desktop/src/main/index.ts`
  - `apps/desktop/src/main/app-controller.ts`
  - `apps/desktop/src/preload/index.ts`
- When changing run/chat execution flows, check whether worker files, checkpoint handling, shell approval logic, and persisted event metadata also need updates
- Do not move privileged filesystem, Git, or secret-store behavior into the renderer

## UI Guidance

- Preserve the existing app structure: sidebar navigation, landing page, project page, run detail page, chat detail page, bookmarks, settings
- Favor denser layouts over tall decorative ones
- Keep primary actions visible without excessive scrolling
- Use stronger contrast and readable spacing, but do not spend vertical space freely
- When introducing new controls, consider whether they can fit inline, in a split layout, or in an existing card instead of creating another tall section
- Respect dark mode and bright mode; avoid hacks that make native controls or embedded surfaces unreadable

## Validation

Run from repo root:

```bash
pnpm typecheck
```

When touching renderer behavior, runtime flows, IPC, providers, tests, or build config, also run:

```bash
pnpm lint
```

Useful additional commands:

```bash
pnpm test
pnpm --filter @buildwarden/desktop build
```

## Known Important Constraints

- Do not import raw workspace `.ts` files at runtime outside the Vite/Electron bundle path
- Keep internal `@buildwarden/*` packages bundled for Electron main/preload
- Secrets must not be written to SQLite as plaintext; use the Electron secret store flow
- Build artifacts and installers should stay out of Git
- The embedded run terminal uses `node-pty` and has native-module constraints during local setup and packaging
- `electron-builder` is configured with `npmRebuild: false`; do not accidentally reintroduce packaging requirements that assume native rebuilds during build
- Some run/chat state survives app restarts via DB rows and checkpoints; if you change status transitions, also think about orphan/session-recovery behavior
- Diff loading, terminal sessions, and worker-based operations may be asynchronous or delayed; do not assume all run detail data is available immediately

## Good Change Patterns

For new features:

1. Update shared contracts and settings keys
2. Update DB/controller/runtime behavior
3. Extend main/preload IPC as needed
4. Implement renderer UI
5. Run validation

For run/chat workflow changes:

1. Update shared request/response types
2. Update DB persistence and snapshots
3. Update app-controller and worker/runtime code
4. Update preload/renderer consumers
5. Run typecheck and lint

For UI refactors:

1. Extract presentational components
2. Keep state and side effects centralized
3. Preserve current navigation and selection behavior
4. Favor tighter vertical layouts
5. Verify both dark and bright themes
