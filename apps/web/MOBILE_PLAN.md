# Mobile web plan (`apps/web`)

Goal: ship a second, mobile-native UI inside `apps/web`, selected at runtime, sharing the
transport/session/logic layers with the existing desktop UI but **none of its templates**.
The current desktop UI must render byte-identically after this work.

> **Status: milestones 1–3 are implemented and validated; milestone 4 is outstanding.**
> See §15 for exactly what shipped and what did not.

---

## 1. What exists today (findings)

| Layer | Location | LOC | Reusable? |
| --- | --- | --- | --- |
| Web entry | `apps/web/src/main.tsx` | 10 | Becomes the shell selector |
| Pairing + session state machine + pairing form | `apps/web/src/RemoteWebApp.tsx` | 278 | State machine yes, form no |
| Session persistence (IndexedDB) | `apps/web/src/hosted-connection-store.ts` | 54 | **Yes, as-is** |
| Pairing deep-link parsing | `apps/web/src/remote-pairing-code.ts` | 27 | **Yes, as-is** |
| Remote transport (RPC + WebSocket stream) | `packages/renderer/src/lib/remote-buildwarden-client.ts` | 662 | **Yes, already exported** |
| Client capabilities / context | `packages/renderer/src/lib/buildwarden-client{-core.ts,.tsx}` | 108 | **Yes, already exported** |
| API contract | `packages/shared/src/index.ts` (`DesktopApi`, ~200 methods) | — | **Yes, already a dependency** |
| Desktop UI god-component | `packages/renderer/src/App.tsx` | 4123 | **No** — see below |
| Desktop components | `packages/renderer/src/components/**` | ~30k | **No** (templates) |
| Pure logic modules | `packages/renderer/src/components/app/*.ts`, `src/lib/*.ts` | ~3k | Yes, but not exported today |
| Design tokens | `packages/renderer/src/styles.css` lines ~40–235 | — | Token names yes, component CSS no |

### The one structural problem

`App.tsx` fuses state, side effects, and layout into a single 4123-line component: ~3870 lines of
`useState`/`useEffect`/handlers, then ~250 lines of JSX. There is no seam to reuse its
orchestration without editing it. **Mobile therefore builds its own data layer directly on
`BuildWardenClient`.** This is acceptable because:

- `BuildWardenClient` *is* the full API surface (`DesktopApi` + `capabilities`), already stable and
  already remoted.
- Mobile needs a smaller feature set with different loading/pagination behaviour anyway.
- It guarantees the desktop path is untouched.

### What "shared logic" concretely means here

The thing worth sharing is **the remote transport** (what you called webhook communication):
`createRemoteBuildWardenClient` speaks JSON-RPC over `REMOTE_ACCESS_RPC_PATH` and subscribes to
live run/chat/orchestration/terminal/browser events over `REMOTE_ACCESS_WEBSOCKET_PATH`, applies
scope-based capability gating, and raises `RemoteSessionExpiredError`. It is UI-free and is
**already exported** from `@buildwarden/renderer`. Mobile imports it unchanged — zero new code, zero
protocol drift, one place to fix bugs.

---

## 2. Sharing contract

**Shared (imported, never copied):**

- `@buildwarden/shared` — every type, DTO, provider metadata, settings key, `resolveComposerCommandPrompt`, remote paths/scopes.
- `@buildwarden/renderer` public exports — `createRemoteBuildWardenClient`, `setActiveBuildWardenClient`, `BuildWardenClientProvider`, `useBuildWardenClient`, `RemoteSessionExpiredError`, and the client/capability types.
- `apps/web/src/hosted-connection-store.ts`, `apps/web/src/remote-pairing-code.ts`.
- Pure, presentation-free helpers listed in §3.

**Re-implemented for mobile (no reuse):**

- Every component under `packages/renderer/src/components/**` — including `ui/` primitives (`button`, `input`, `card`, `select`, …). Mobile gets its own primitives sized for touch.
- `App.tsx` navigation/state orchestration.
- `styles.css` component classes.

**Not applicable on mobile:** dual run panes, sidebar resize/drag-reorder, drag-and-drop, native title bar, app menu, command palette (replaced by a search screen), Electron-only surfaces (`setRunBrowserDesktopSurface`, IDE integration, file manager, directory picker).

---

## 3. The only change to `packages/renderer` — and it is additive

Mobile wants these pure modules (no JSX, no DOM, fully tested already):

`components/app/`: `app-model.ts`, `run-display-status.ts`, `run-activity-model.ts`,
`run-activity-tool-model.ts`, `sidebar-run-ordering.ts`, `sidebar-project-context.ts`,
`project-page-tabs.ts`, `project-insight-utils.ts`, `provider-model-labels.ts`,
`git-diff-utils.ts`, `git-diff-whitespace.ts`, `stored-chat-attachment-utils.ts`,
`code-mirror-languages.ts`, `welcome-checks.ts`

`lib/`: `run-plan-progress.ts`, `run-search.ts`, `bookmark-model.ts`,
`context-window-estimate.ts`, `available-provider-models.ts`, `browser-element-attachments.ts`,
`app-build-meta.ts`, `cn.ts`

None are exported today. Proposal:

1. **New file** `packages/renderer/src/shared-logic.ts` that re-exports the modules above.
2. **One line** in `packages/renderer/package.json`: `"./logic": "./src/shared-logic.ts"`.

No existing source file is modified; `index.ts`, `App.tsx`, `styles.css` and every component stay
byte-identical. `package.json` is a manifest, not a template.

> **Decision to confirm before implementation.** If you want literally zero diff inside
> `packages/renderer`, the alternative is copying ~1.5k lines of helpers into `apps/web/src/mobile/lib/`.
> That duplicates run-status, diff-parsing and token-accounting logic in two places and *will* drift.
> Recommendation: take the additive export.

---

## 4. Also shared: the session state machine in `apps/web`

`RemoteWebApp.tsx` currently mixes two things: the pairing/session/disconnect state machine
(~120 lines: fragment handling, existing-session revoke, `GET`/`DELETE` on
`REMOTE_ACCESS_SESSION_PATH`, IndexedDB persistence, client construction, expiry handling) and the
`PairingGate` form template.

Extract the state machine into `apps/web/src/session/use-remote-session.ts`, returning
`{ state, client, pair(code, host), disconnect(changeHost) }`. Both shells consume it and each
renders its own gate UI. `RemoteWebApp.tsx` keeps rendering the exact same `PairingGate` markup —
behaviour preserving, and `apps/web` is not a desktop file.

*(If you'd rather not touch `RemoteWebApp.tsx` at all, mobile gets its own copy of the state machine.
Same trade-off as §3; extraction is the better call because session/token handling is security-relevant
and should not be duplicated.)*

---

## 5. Detection and routing

### Why a single HTML entry, not a `/m` route

`packages/remote-server/src/index.ts:1300` (`serveStaticAsset`) serves real files only and returns
404 for unknown paths — there is **no SPA fallback in embedded/host-served mode**. A path-based
mobile route would work on Vercel (`rewrites` → `index.html`) and break when a phone connects
directly to the desktop host over Tailscale, which is the primary mobile scenario.

So: **one `index.html`, one entry, runtime shell selection, lazy-loaded chunks.**

### Selection logic

`apps/web/src/shell/select-shell.ts` (pure, unit-testable):

```ts
export type ShellKind = "mobile" | "desktop";

const STORAGE_KEY = "buildwarden.web.shell";
export const MOBILE_QUERY = "(max-width: 820px), (pointer: coarse) and (max-width: 1180px)";

// Precedence:
//   1. ?ui=mobile | ?ui=desktop | ?ui=auto   (writes/clears the pin, then strips itself)
//   2. localStorage pin
//   3. MOBILE_QUERY match
//   4. "desktop"
export const selectShell = (win: Window): ShellKind => { /* … */ };
```

Notes:

- The override lives in the **query string**, not the hash. `pairingDetailsFromFragment()` clears the
  hash but preserves `location.search` (`remote-pairing-code.ts:24`, asserted by the existing test),
  so `?ui=mobile` survives a pairing deep link.
- iPadOS "Request desktop site" reports a desktop UA; the `pointer: coarse` clause plus
  `navigator.maxTouchPoints > 1` catches it. **No user-agent string sniffing** — media queries and
  pointer type only.
- `?ui=desktop` on a phone is the escape hatch; `?ui=auto` clears the pin.

### Mount

`apps/web/src/main.tsx` becomes:

```tsx
const shell = selectShell(window);
const Shell = lazy(shell === "mobile"
  ? () => import("./mobile/MobileWebApp")
  : () => import("./RemoteWebApp").then((m) => ({ default: m.RemoteWebApp })));
```

Two separate chunks — a phone never downloads the desktop bundle (which pulls CodeMirror, xterm,
mermaid, `@pierre/diffs`). Set `document.documentElement.dataset.shell = shell` so CSS can branch.

### Runtime switching

Decide **once per load**. If `MOBILE_QUERY` flips later (rotation, desktop window resize) and no pin
is set, show a dismissible bar: *"Switch to the mobile layout?"* → sets the pin and reloads.
Never hot-swap mid-session; the client and IndexedDB session survive the reload, so the cost is a
re-fetch of the snapshot, not re-pairing.

A "Use desktop site" / "Use mobile site" row goes in mobile Settings → Appearance and in the desktop
remote-session chip.

### Tests

`apps/web/src/shell/select-shell.test.ts` — precedence order, `?ui=` handling, pin persistence,
coarse-pointer + iPadOS cases, and that a pairing hash + `?ui=mobile` still yields mobile.

---

## 6. Mobile information architecture

Modelled on ChatGPT / OpenAI Codex mobile: a **bottom tab bar** for top-level destinations, a
**left drawer** for project switching, **full-screen detail pages** pushed on a stack, and **bottom
sheets** for anything the desktop puts in a dropdown or dialog.

```
┌─────────────────────────────────┐
│ ☰  Project name ▾        ⌕  ⋯  │  top app bar (56px + safe-area)
├─────────────────────────────────┤
│                                 │
│           screen                │
│                                 │
├─────────────────────────────────┤
│  ⌂      ▤       ✦      ⚙       │  bottom tabs (+ safe-area inset)
│ Home   Runs   Chats   More      │
└─────────────────────────────────┘
```

### Tabs

| Tab | Contents | Desktop equivalent |
| --- | --- | --- |
| **Home** | Active runs, pending approvals, recent activity, "New run" CTA | `LandingPage` + `AllRunsPage` |
| **Runs** | Run list, filter chips (active / needs input / done / for-later), search | `AllRunsPage`, `Sidebar` run tree, `ProjectForLaterTab` |
| **Chats** | Chat list + chat detail | `ChatPage`, `ChatDetailPage` |
| **More** | Projects, bookmarks, settings, session/host, about | `Sidebar` sections, `SettingsPage`, `BookmarksPage` |

Project switching lives in the **drawer** (tap the title in the app bar, or swipe from the left edge):
project list → tap a project → its workspace screen. This mirrors ChatGPT's conversation drawer and
keeps the tab bar at four items.

A **FAB** ("New run") sits above the tab bar on Home / Runs / a project screen.

### Approvals — the mobile-critical path

Shell approvals block a run. On desktop they're a toast stack (`AppNotifications`). On mobile:

- A badge on the **Home** tab whenever `shellApprovalQueue.length > 0`.
- A **bottom sheet** that slides up on arrival, showing command + cwd + run, with
  Approve / Approve-for-run / Deny as full-width 48px buttons and the queue count.
- Same for `RunUserInputRequestCard` and `RunPlanDecisionCard`.
- Optional (phase 4): a Web Notification when the PWA is backgrounded.

### Run detail — the hardest screen

Desktop opens up to two panes with seven tiles (activity, agents, diff, terminal, browser, notes,
chat). Mobile:

```
┌─────────────────────────────────┐
│ ←  feat/foo · running     ⋯    │  status pill, token badge, plan progress
├─────────────────────────────────┤
│ Activity │ Diff │ Files │ … │   │  swipeable segmented strip (scrollable)
├─────────────────────────────────┤
│                                 │
│   virtualised timeline          │  @tanstack/react-virtual
│                                 │
├─────────────────────────────────┤
│ [ prompt…              ] [ ↑ ]  │  sticky composer, safe-area + keyboard aware
└─────────────────────────────────┘
```

- Segments: **Activity, Diff, Files, Agents, Notes, Chat, Terminal** — Agents/Terminal/Browser hidden
  when the capability is absent (`client.capabilities`).
- Horizontal swipe moves between segments; the strip scrolls.
- `⋯` opens an action sheet: Commit, Publish branch, Create PR, Continue, Cancel, Undo to last prompt,
  Resume from checkpoint, Bookmark, For later, Delete. Each dialog becomes a full-screen sheet.
- Diff: file list first → tap a file → full-screen diff, unified only (no side-by-side), with
  sticky file header and a comment affordance for the review flow.
- Terminal: xterm at a reduced font size with a custom accessory key row (Esc, Tab, Ctrl, ↑↓, ^C).
  Gated behind capability + an explicit "Open terminal" tap so xterm isn't loaded eagerly.
- Browser: view screenshots + navigate; no coordinate-precise input on phone.

### Project screen

Desktop has ten tabs. Mobile uses a **scrollable segmented strip** with the same order, minus what
doesn't fit:

Keep: Overview, Tasks, Runs, Branches, Reviews (PR/MR), Loops, Activity, Insights history, For later, Settings.
Demote to "Advanced" (accessible, low priority): Lab, Graphs (mermaid, pinch-zoom viewer),
Codebase mood, Curiosity mode, Narrative branching, Repo historian.

### Settings

iOS-style grouped list → sub-pages: Appearance, Provider & models, Git & workspace, Network,
Skills, Orchestration, Session & host, About. Same underlying `setAppSetting` calls; entirely new markup.

---

## 7. Feature parity matrix

| Desktop feature | Mobile | Notes |
| --- | --- | --- |
| Landing / all runs / run tree | ✅ | Home + Runs tabs |
| Create run (project, model, mode, workspace type, effort, YOLO, delegation) | ✅ | Full-screen composer sheet, collapsible "Options" |
| Run activity timeline, tool rows, subagent cards | ✅ | Virtualised, denser cards |
| Follow-up / continue / cancel / undo / resume | ✅ | |
| Shell approvals, user-input requests, plan decisions | ✅ | Bottom sheets + tab badge |
| Worktree diff + AI diff review | ✅ | Unified only |
| Workspace file viewer (CodeMirror) | ✅ | Read-only, lazy chunk |
| Commit / publish branch / create PR / suggest message | ✅ | Full-screen sheets |
| PR/MR review (fetch, comment, reply, resolve) | ✅ | Thread list → thread detail |
| Chats + attachments + bookmarks | ✅ | |
| Orchestration (agents panel, adoption, task messages) | ✅ | Task list → task detail |
| Project tasks, loops, insights, activity explorer | ✅ | |
| Branch management (create/rename/delete/pull/push/checkout) | ✅ | |
| Embedded terminal | ⚠️ | Capability-gated, accessory key row |
| Run browser | ⚠️ | View + navigate; no fine input |
| Graphs / mermaid | ⚠️ | Pinch-zoom viewer, "Advanced" |
| Add project | ⚠️ | Host directory browser only (`hostDirectoryBrowser` scope); no local picker |
| Dual run panes, pane drag/drop | ❌ | Desktop-only |
| Sidebar resize / project drag-reorder | ❌ | Reorder via long-press in drawer (phase 4) |
| Command palette | ❌ | Replaced by search screen |
| Native title bar / app menu / IDE / file manager | ❌ | Electron-only |
| Keyboard shortcuts | ❌ | Not meaningful on touch |

---

## 8. Directory layout

```
apps/web/src/
  main.tsx                       # shell selector (rewritten, ~25 lines)
  shell/
    select-shell.ts
    select-shell.test.ts
  session/
    use-remote-session.ts        # extracted from RemoteWebApp.tsx
    use-remote-session.test.ts
  hosted-connection-store.ts     # unchanged
  remote-pairing-code.ts         # unchanged
  RemoteWebApp.tsx               # desktop shell — template untouched
  mobile/
    MobileWebApp.tsx             # default export, lazy entry
    PairingScreen.tsx            # mobile pairing UI (own markup)
    nav/
      mobile-router.ts           # history-stack router + tests
      TabBar.tsx  AppBar.tsx  Drawer.tsx  Sheet.tsx  ActionSheet.tsx
    data/
      use-snapshot.ts            # getSnapshot + onRunEvent/onChatEvent reconciliation
      use-run-detail.ts
      use-chat-detail.ts
      use-approval-queue.ts
      use-orchestration.ts
      use-capabilities.ts
    screens/
      HomeScreen.tsx  RunsScreen.tsx  RunDetailScreen.tsx  ChatsScreen.tsx
      ChatDetailScreen.tsx  ProjectScreen.tsx  ProjectsDrawer.tsx
      BookmarksScreen.tsx  SettingsScreen.tsx  SearchScreen.tsx
    components/                  # touch-sized primitives (own, not renderer/ui)
    styles/
      mobile.css                 # @import "tailwindcss"; @source "../**/*.tsx";
      tokens.css                 # --ec-* copy, guarded by a sync test
```

Everything mobile lives under `apps/web/src/mobile/`. An ESLint `no-restricted-imports` rule blocks
`@buildwarden/renderer/src/components/**` from that directory, so the "no templates" rule is
enforced by CI, not by discipline.

---

## 9. Mobile navigation state

Desktop navigation is a bag of booleans inside `App.tsx` (`landingSelected`, `allRunsSelected`,
`bookmarksSelected`, `chatsSelected`, `settingsOpen`, `selectedRunId`, `projectPageTab`, …).
Mobile needs a real back stack instead. `mobile/nav/mobile-router.ts`:

```ts
type Route =
  | { name: "home" } | { name: "runs" } | { name: "chats" } | { name: "more" }
  | { name: "run"; runId: string; segment: RunSegment }
  | { name: "chat"; chatId: string }
  | { name: "project"; projectId: string; tab: ProjectPageTab }
  | { name: "bookmark"; kind: "run" | "chat"; id: string }
  | { name: "settings"; section?: SettingsSection }
  | { name: "search" };
```

Backed by `history.pushState` so the Android back button and iOS back-swipe work, plus the current
route serialised to `sessionStorage` for reload restoration. Tab switches replace the stack root;
detail pages push. No `react-router` dependency — the route union is ~10 cases.

---

## 10. Mobile data layer

Thin hooks over the injected `BuildWardenClient`, each independently testable with a fake client:

- `useSnapshot()` — `getSnapshot()` on mount, then reconcile from `onRunEvent` / `onChatEvent` /
  `onProjectTaskChanged` / `onProjectLoopChanged` / `onOrchestrationChanged`; debounced
  `refreshSnapshot()` on reconnect and on `visibilitychange` (phones suspend sockets aggressively —
  **this is the single most important mobile-specific behaviour**).
- `useRunDetail(runId)` — `getRunDetail` + incremental step append from `onRunEvent`; `getRunWorktreeDiff`
  deferred until the Diff segment is opened (it's the slow call).
- `useApprovalQueue()` — derives pending shell approvals / user-input requests across all runs.
- `useCapabilities()` — `client.capabilities`, so every screen can hide unavailable actions rather
  than failing an RPC.

Reuse the existing pure reducers from `@buildwarden/renderer/logic` (`run-activity-model`,
`run-display-status`, `run-plan-progress`, `latestRunTokenUsage`, …) so status/token/plan semantics
stay identical to desktop.

---

## 11. Styling and platform integration

- `mobile.css` declares `@import "tailwindcss"` + `@source "../**/*.tsx"` — mobile-only class scanning,
  no desktop CSS in the mobile bundle.
- `tokens.css` copies the `--ec-*` blocks (dark + light) from `styles.css`. A vitest guard parses both
  files and asserts identical variable name sets, so drift fails CI. Mobile may override *values*
  (larger radii, more opaque surfaces for outdoor readability) but not names.
- `index.html`: add `viewport-fit=cover, interactive-widget=resizes-content` to the viewport meta,
  plus `<meta name="theme-color">` for both schemes. (This is a web file, not desktop.)
- Safe areas via `env(safe-area-inset-*)` on the app bar, tab bar and composer.
- `100dvh`/`100svh` for the shell; `overscroll-behavior: none` on scroll containers to kill
  pull-to-refresh fighting the timeline.
- Minimum 44×44px touch targets; no hover-only affordances — every desktop hover action becomes a
  long-press or an item in the `⋯` action sheet.
- PWA: `manifest.webmanifest` + maskable icons + `display: standalone` so it installs to the home
  screen. No service worker in phase 1 (the app is useless offline — the host is authoritative).

### CSP

`apps/web/vercel.json` already allows `connect-src 'self' https://*.ts.net wss://*.ts.net`, which
covers the mobile client unchanged. Adding the manifest needs `manifest-src 'self'`.

---

## 12. Build and config

- No new Vite entry, no new package. `vite.config.ts` gains nothing; code-splitting comes from the
  dynamic imports in `main.tsx`. Optionally add `build.rollupOptions.output.manualChunks` to keep
  xterm / CodeMirror / mermaid out of the mobile initial chunk.
- Both `--mode hosted` (Vercel) and `--mode embedded` (`apps/desktop/out/web`) get the mobile shell
  for free, so a phone on the tailnet hitting the desktop host directly gets it too.
- `apps/web/package.json` gains the markdown pipeline (`react-markdown`, `remark-gfm`,
  `rehype-raw`, `rehype-sanitize`) so agent output renders as Markdown rather than raw text.
  All four are already in the lockfile via `@buildwarden/renderer`, so no new package enters the
  repo. Sanitisation is duplicated in `mobile/lib/markdown-sanitize.ts` rather than imported,
  because the desktop schema lives inside a component file that must not be modified;
  `markdown-sanitize.test.ts` fails the build if the two allow-lists diverge.

---

## 13. Milestones

1. **Foundation** — `select-shell.ts` + tests, `main.tsx` split, `use-remote-session.ts` extraction,
   mobile pairing screen, tokens + `mobile.css`, empty shell (app bar / tab bar / drawer / sheet),
   `mobile-router.ts`, ESLint import guard. *Desktop verified unchanged.*
2. **Read-only parity** — `useSnapshot`, Home, Runs, run detail Activity + Diff + Files, Chats list
   and transcript, project overview. Enough to monitor work from a phone.
3. **Write parity** — composer, new run, follow-up, cancel, approvals sheet, user-input requests,
   bookmarks, for-later, commit/publish/PR sheets.
4. **Full parity** — orchestration, PR/MR review, tasks, loops, branches, insights, settings
   sub-pages, terminal, browser view, PWA manifest, notifications.

Each milestone ends with `pnpm typecheck`, `pnpm lint`, `pnpm test`, and a manual desktop-regression
pass at `?ui=desktop`.

---

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Mobile data layer drifts from `App.tsx` semantics | Share the pure reducers via `@buildwarden/renderer/logic`; keep only fetch/subscribe logic mobile-side |
| Token duplication in `tokens.css` drifts | CI test asserting identical `--ec-*` name sets |
| Mobile bundle bloats via an accidental renderer component import | ESLint `no-restricted-imports` on `apps/web/src/mobile/**` |
| WebSocket drops on phone backgrounding leave stale state | `visibilitychange` → reconnect + `refreshSnapshot()`; explicit "reconnecting" banner |
| Long timelines janky on low-end phones | Virtualise from day one; cap live-event buffer |
| Scope-limited sessions hide actions confusingly | Every screen reads `client.capabilities` and shows a "read-only session" explanation rather than a disabled button |

---

## 15. Implementation status

### Shipped

Milestones 1–3 plus parts of 4. `pnpm typecheck`, `pnpm lint` and `pnpm test` are clean across the
workspace (581 tests), and both `pnpm --filter @buildwarden/web build` and `build:embedded` succeed.

- **Shell selection** — `shell/select-shell.ts` + `shell/shell-entries.ts`, lazy chunks. Verified in a
  browser at 375px and 320px: `?ui=mobile` mounts the mobile shell and persists the pin, `?ui=desktop`
  mounts the untouched desktop gate.
- **Session** — `session/use-remote-session.ts`; the desktop `PairingGate` JSX is byte-identical
  (`git diff` shows only logic moving out).
- **Design system** — `mobile/styles/{tokens,mobile}.css` with the `--ec-*` sync test; touch
  primitives; app bar, tab bar, drawer, bottom sheet, action sheet, confirm sheet.
- **Router** — hash-backed stack with hardware-back support, 20 unit tests.
- **Data layer** — `use-snapshot` (with `visibilitychange`/`online` re-fetch and the polling
  fallback), `use-run-detail` (deferred diff), `use-chat-detail`, `use-approval-queue`, `use-action`.
- **Markdown** — run activity and chat transcripts render through `react-markdown` + GFM +
  sanitised raw HTML, matching the desktop pipeline. Mobile-specific: code blocks and tables scroll
  inside their own boxes so the page never scrolls sideways, and workspace-relative file references
  render as text rather than links that a browser cannot follow.
- **Screens** — Home, Runs, Run detail (Activity / Diff / Files / Agents / Notes / Chat), Chats,
  Chat detail, Projects, Project (Overview / Runs / Tasks / Branches / For later), Bookmarks,
  Search, Settings (5 sub-pages), New run, Pairing.
- **Actions** — follow-up, cancel, bookmark, for-later, delete, undo, resume from checkpoint,
  commit (+ AI suggestion), publish branch, pull request (+ AI description), run notes CRUD,
  shell approvals, blocking user-input answers, orchestration pause/resume/cancel.
- **Platform** — viewport/theme-color meta, safe-area insets, PWA manifest + icon, CSP
  `manifest-src`, ESLint `no-restricted-imports` guard on `src/mobile/**`.

Measured: mobile chunk 98.8 kB JS + 30.6 kB CSS; desktop chunk unchanged and not loaded on mobile.
The built mobile CSS contains no desktop class names.

### Not shipped (milestone 4 remainder)

- **Embedded terminal** and **run browser** segments — capability plumbing is in place
  (`RUN_SEGMENTS` already lists them) but no panel is rendered.
- **PR/MR review threads**, **project loops**, **AI insight generation**, **Lab / Graphs /
  Codebase mood / Curiosity / Narrative / Repo historian** tabs.
- **Project task creation / editing** (the list is read-only) and **branch create/rename/delete**
  (fetch, pull and listing work).
- **Chat attachments**.
- **Web notifications** for approvals while backgrounded.
- **Long-timeline virtualisation** — currently a trailing window with an explicit "Load earlier"
  control, which is adequate up to a few thousand steps.

### Verified by hand, and what was not

A temporary harness mounted `MobileShell` against a stubbed client to walk every screen: all
navigation, sheets, the drawer and both themes render with no console errors, no horizontal
overflow at 320px, and every interactive target ≥44px. The harness was deleted afterwards.

**Not exercised against a real host.** Pairing needs a running desktop app, so live RPC, the
WebSocket event stream, and every mutation path (create run, commit, PR, approvals) are covered by
types and by the shared transport only — not by an end-to-end run. That is the first thing to try
on a real device.
