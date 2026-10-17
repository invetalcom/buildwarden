<!--
Title: short, imperative, plain English (e.g. "Store prompt restore points outside app settings").
Keep PRs reviewable: if the size bot labels this XL/XXL, consider splitting it.
Delete any section or checklist line that doesn't apply.
-->

## Problem

<!-- What is wrong or missing, and who notices it? Include numbers if you measured something.
Link the issue if there is one: Fixes #123 -->

## Changes

<!-- What changed and why this approach. Name new tables, types, IPC methods, settings keys,
migrations and dependencies so reviewers know where to look. -->

-

**Not in scope:** <!-- deliberate omissions and follow-ups; delete if none -->

## Validation

<!-- Evidence that it works. CI runs typecheck, lint, test and build. List what you checked
beyond that, plus any known/pre-existing failures (e.g. tests that also fail on main on Windows). -->

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` pass locally
- [ ] New or updated tests: <!-- which ones -->
- [ ] Manually verified in: <!-- desktop app / web, OS, provider used -->

## Screenshots

<!-- UI changes only: before/after, dark and light theme. -->

## Checklist

<!-- Tick what applies; delete lines that don't touch your change. -->

- [ ] **IPC / bridge:** `packages/shared`, `main/index.ts`, `app-controller.ts` and `preload/index.ts` updated together
- [ ] **Persisted state:** `packages/shared` and `packages/db` updated together; existing databases migrate cleanly (ideally checked against a copy of a real DB)
- [ ] **Run/chat lifecycle:** checkpoints, resume, orphan/session recovery, worker files and shell approval considered
- [ ] **Git / worktrees:** only BuildWarden-created worktrees and state are touched; the user's repository is never mutated destructively
- [ ] **Secrets:** nothing sensitive written to SQLite, logs, snapshots or IPC payloads
- [ ] **Providers:** provider config (auth, URL, model) stays separate from harness/runtime logic
- [ ] **UI:** compact layout, uses shared `components/ui` primitives, verified in dark and light themes
- [ ] **Performance:** snapshot / IPC payload size and DB row size not noticeably increased
- [ ] **Packaging:** internal packages still bundled, no native-rebuild assumptions; `pnpm build` run if build config changed
