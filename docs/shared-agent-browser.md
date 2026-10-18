# Shared run browser

Codex, Claude Code, and Cursor runs receive `buildwarden_browser` automatically, independently of delegation settings. The tool uses the same run-scoped host browser as the existing Browser panel, including its project browser profile and element picker. External browser integrations such as `cua_repl` remain separate; their MCP activity can be displayed, but their browser windows are not embedded.

Open **Browser** from the run activity view (desktop/web), or the **Browser** tab (mobile). The page is hosted on the BuildWarden computer, so localhost URLs refer to that computer. Web/mobile clients need the existing `browser:operate` remote scope. No separate browser installation or exposed debugging port is required.

The tool supports status, open/navigate, accessibility snapshots, screenshots, click, type, scroll, and bounded waits. Use `nodeId` plus `snapshotId` from a recent snapshot; navigation invalidates old targets. Coordinates provide a fallback for content without an accessible target, including embedded frames. `type` inserts text into the selected field. Screenshots are returned as image content to all three providers. Element selections include both Markdown context and their screenshot; Claude receives images through structured SDK user messages.

**Take control** or selecting a page element gives the user control. Agent mutations then fail with an actionable message until **Release to agent**. Taking control invalidates in-flight action continuations. Read-only snapshots/screenshots remain available. Mobile supports tap, swipe to scroll, an explicit keyboard button, and element attachments in the follow-up composer. Sending selected context releases control back to the agent.

The host pins browser sessions while a run is active, even if the panel is closed. Completing or cancelling the run releases that pin; the existing idle cleanup policy applies when there are no viewers. Ownership is transient and is not restored after an app restart. A hidden compositor keeps the same page alive when it moves between the native desktop panel and remote viewers.

Tool transports remain provider-specific: Codex app-server dynamic tools, Claude's in-process SDK MCP server, and Cursor's authenticated loopback MCP bridge. Worker host requests bind browser access to the executing run; the model cannot supply another run ID. All UI controls continue through the existing preload/remote browser contracts.

MCP start/result events correlate by call ID. Compact expandable rows show the tool identity, intentional display title where available, input, output, error, and bounded screenshot previews. Optional fields live in the existing step metadata JSON, so no SQLite schema migration is needed. Old generic status rows do not contain enough data to reconstruct the original MCP calls and are left unchanged.

Validation covers provider event parsing and transport responses, browser lifetime/control, stale targets, remote coordinate scaling, and mobile selection-to-follow-up. Native smoke checks also exercise real Electron navigation, click/type, screenshot capture, and switching between automation and the picker. These checks do not launch paid model turns or authenticate to third-party sites.
