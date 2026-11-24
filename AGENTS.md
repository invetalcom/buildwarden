# AGENTS.md

## Purpose

This repository is an Electron desktop app for coding-agent workflows. Optimize for small, correct, reviewable changes that preserve the app's project/worktree/run/chat model and keep local state, Git state, and UI state aligned.

## Stack

- `pnpm` workspace
- Electron + Vite
- React 19 + TypeScript
- Tailwind CSS v4 renderer UI
- Electron's built-in `node:sqlite` for local persisted app state
- `simple-git` for repository and worktree operations
- `node-pty` for the embedded run terminal
- OpenAI-first provider/harness architecture with support for OpenAI-compatible, Codex CLI, Claude Code, and Cursor Agent providers
- Vitest + ESLint + TypeScript for validation

## Workspace Layout

- `apps/desktop`
  - `src/main`: Electron main process, app controller, IPC handlers, workers, secrets, terminal IPC, run/chat orchestration
  - `src/main/services`: what the app controller does, one service per area (see Main-Process Services)
  - `src/preload`: safe renderer bridge exposed on `window.buildwarden`
  - `src/renderer/src`: thin Electron entry for the shared renderer
- `apps/web`: hosted/embedded browser entry, connection persistence, Vite and Vercel configuration
- `packages/renderer`: shared React UI, styles, assets, client adapters, and renderer tests
- `packages/shared`: shared types, DTOs, provider metadata, IPC contract shapes, settings keys, run/chat types
- `packages/db`: persisted app state, snapshots, bookmarks, chats, settings, run history, checkpoint persistence
- `packages/git-service`: Git repo validation, worktree lifecycle, branch/worktree helpers
- `packages/agent-runtime`: shared process execution helpers for CLI text generation
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

- Prefer extracting focused renderer components instead of growing `packages/renderer/src/App.tsx`
- Reuse shared UI primitives in `packages/renderer/src/components/ui`
- Keep TypeScript strict; do not introduce `any` unless unavoidable
- Preserve existing selection/state restoration behavior for project, run, chat, bookmark, and settings navigation
- When changing shared data shape, update both:
  - `packages/shared/src/index.ts`
  - `packages/db/src/index.ts`
- When adding or changing renderer actions, update all relevant layers:
  - `packages/shared/src/index.ts`
  - `apps/desktop/src/main/index.ts`
  - the service in `apps/desktop/src/main/services` and its forwarding method in `apps/desktop/src/main/app-controller.ts`
  - `apps/desktop/src/preload/index.ts`
- When changing run/chat execution flows, check whether worker files, checkpoint handling, shell approval logic, and persisted event metadata also need updates
- Do not move privileged filesystem, Git, or secret-store behavior into the renderer

## Main-Process Services

- `AppController` is only the app's API. Every method forwards to a service; put no logic or state in it
- A service extends `AppService<"a" | "b">` and names the sibling services it calls. Reach them as `this.services.a`, never from a constructor or field initializer
- Register a new service in `services/app-services.ts` and `services/create-app-services.ts`. Import other services as types only, so modules stay free of cycles
- Keep a service below 600 lines (`pnpm analyze:classes` reports larger classes); split it by responsibility before it grows past that
- To act when a run's turn ends, implement `RunEndedListener` and add the service to the list in `create-app-services.ts`. Do not call it from the worker code
- Tests reach internals with `internalsOf(controller)` from `controller-test-internals.ts`. Put mocks and spies on it, not on the controller: services call each other directly, so a spy on the controller never sees those calls

## UI Guidance

- Preserve the existing app structure: sidebar navigation, landing page, project page, run detail page, chat detail page, bookmarks, settings
- Favor denser layouts over tall decorative ones
- Keep primary actions visible without excessive scrolling
- Use stronger contrast and readable spacing, but do not spend vertical space freely
- When introducing new controls, consider whether they can fit inline, in a split layout, or in an existing card instead of creating another tall section
- Respect dark mode and bright mode; avoid hacks that make native controls or embedded surfaces unreadable

## Design System

The renderer has one visual language. New UI must reuse it instead of adding one-off borders, pills, shadows or font sizes.

- Three surface tiers, defined in `packages/renderer/src/styles.css`:
  1. Window backdrop: the title bar, sidebar and status bar sit on it without fills or borders
  2. Content sheet (`[data-ui="content"]`): holds the open page. It is transparent by default, so pages sit on the backdrop; a theme can give it an opacity
  3. Cards and controls: neutral tints (`--ec-panel`, `--ec-control`), no border and no shadow
- Only floating surfaces (menus, popovers, dialogs) cast a shadow
- Separate regions by tone and spacing first; use a hairline (`border-[var(--ec-border)]`) only between rows of a dense list
- Colors come from the `--ec-*` tokens that `packages/renderer/src/lib/design-scheme.ts` derives from the active design scheme. Never hard-code a color
- Status is a small dot or a neutral badge plus text. Reserve the accent color for the primary action, focus rings and live activity
- No uppercase letterspaced eyebrow labels, gradient washes, glows or decorative accent rails
- Primitives in `packages/renderer/src/components/ui`:
  - `Button`, `Card`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `SegmentedControl`
  - `TabList` / `TabPanel` for tabs: the active tab is joined to its panel. When the tabs switch a whole page, put `data-tab-page` on the page root: the title and tabs then sit on the window backdrop, and the panel goes inside a `data-ui="page-sheet"` wrapper that paints the sheet. The panel itself stays a transparent layer that themes may fill, so the page shows two tones (sheet and cards) by default
  - Keep a page to two background tones plus controls. When a layer would add a third, keep the element and its hook but make it transparent, so themes can still style it
  - `ModalDialog` (native dialog) and `DialogSurface` / `DialogOverlay` for every dialog: icon tile, title, one-line description, inset panels (`.app-inset`), right-aligned Cancel plus one primary action
  - `StatusBarItem` / `StatusBarPortal` for status bar segments. Run- or session-scoped facts (branch, plan, tokens, context) belong in the status bar, not in page headers
  - `Spinner`, `StatusDot`, `LiveDot` and `LoadingBar` (`components/ui/motion.tsx`) for everything that shows activity. Never spin or pulse an element of your own: a theme's indicator look, speed and reduced-motion setting only reach these components. For a glyph that spins only while busy, use `<Spinner icon={RefreshCw} spinning={busy} />`. `design-motion.test.ts` fails when a file uses `animate-spin` itself
- Theming hooks: the `data-ui="..."` attributes listed in `packages/shared/src/design-theme.ts` are a public contract for user themes and for agents (`buildwarden_theme_read` / `buildwarden_theme_set`). Do not rename or remove one; add new hooks to that list. `packages/renderer/src/lib/design-theme.test.ts` fails when a listed hook leaves the source
- Custom theme CSS must never load files; keep `designCssLoadsFiles` strict when touching it
- Theme options are declared in `packages/shared/src/design-theme.ts`: element colors (`DESIGN_ELEMENTS`), color sets for code tokens, the terminal palette, diff lines, run states and charts (`DESIGN_COLOR_GROUPS`), and shape, glass, fonts and layout. Add a new option there, not as a one-off setting
- A new theme option must leave the stock themes exactly as they were: read it through a CSS variable whose fallback is the old value, or gate its rule on an attribute the default does not set. `design-theme.test.ts` checks the defaults of every stock theme
- Give an element's default color in `packages/renderer/src/lib/design-element-defaults.ts` when you add an element type, so the editor can show it
- Motion: the looks of the activity indicators are declared in `packages/shared/src/design-motion.ts` (`DESIGN_INDICATORS`; the first style of each is the app's own look). Their CSS is in `packages/renderer/src/components/ui/motion.css`, where every alternative is gated on a `data-ind-*` root attribute that only a theme's choice sets. Keep it that way: `design-motion.test.ts` fails on an ungated rule. The file is loaded with the indicator components, so the phone layout of the web version gets it too
- Theme images (`assets`) are small, usually animated images stored inside the scheme itself, so they travel with exported themes and work in the web version. Use them only as CSS images (`var(--bw-asset-<name>)`) or in an `<img>`; never put an SVG asset into the DOM as markup

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
3. Update the services in `apps/desktop/src/main/services` and worker/runtime code
4. Update preload/renderer consumers
5. Run typecheck and lint

For UI refactors:

1. Extract presentational components
2. Keep state and side effects centralized
3. Preserve current navigation and selection behavior
4. Favor tighter vertical layouts
5. Verify both dark and bright themes
