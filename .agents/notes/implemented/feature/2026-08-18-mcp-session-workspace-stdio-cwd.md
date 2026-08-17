# Agent Note: mcp-client spawns stdio servers in the session workspace

Status: implemented

English | [中文](2026-08-18-mcp-session-workspace-stdio-cwd.zh.md)

## Problem

`mcp-client` spawns a stdio server's child process once at plugin load with `cwd: config.cwd`, which defaults to `''` — the host process's working directory (the app's launch folder). File-indexing servers (fff is the motivating case) derive their search root from that process cwd at startup and expose no per-call path argument, so they searched the app's launch directory instead of the project folder the user had open. The fix had to control the spawn cwd, and the workspace a tool call belongs to is only known per session (`session.header.cwd`, the same source as the system-prompt `{{cwd}}` and LSP's `sessionCwd`).

## Decision

`mcp-client`'s stdio config gains an opt-in `useSessionWorkspace: boolean` (default `false`). When set, the child is spawned in the harness's currently-open workspace — the cwd of the most recently entered live, non-subagent session that carries one — falling back to `cwd` (or the host cwd) when no session is open. When the tracked workspace changes, the connection supervisor re-points the child: it closes the current generation (awaiting its close so children never overlap) and spawns a fresh one with the new cwd, outside the failure backoff and attempt budget.

A new `SessionWorkspaceTracker` (in `mcp-client/src/session-workspace.ts`) observes `ctx.sessions` (an optional service via `ctx.get`) and the global `session/created` / `session/disposed` events. It seeds from already-live sessions on construction (so an HMR reload mid-session keeps the right cwd) and tracks recency by enter order, ignoring cwd-less and subagent-origin sessions. The re-point serializes on a promise chain and cancels any armed failure-retry timer, so a re-point and a retry can never spawn overlapping children. Same-cwd changes are no-ops.

The opt-in flag is deliberate: re-pointing restarts the child. That is correct for a stateless indexer like fff, but disruptive for long-lived GUI bridges (for example StudioMCP), which therefore stay off the feature.

## Alternatives considered

**Per-call injection of the workspace into the tool arguments** — rejected. fff resolves its base path once at child startup and accepts no path argument, so there is no per-call variable to pass; only the spawn cwd can steer it.

**Default `useSessionWorkspace` to true for every stdio server** — rejected. Re-spawning on every workspace switch would kill long-lived bridge processes and re-index stateful servers that never asked for it; the opt-in keeps the behavior where it is wanted.

**Reuse the failure-reconnect path for workspace changes** — rejected. It would consume the attempt budget (a workspace switch counts as an outage) and add backoff latency to an intentional user action; the dedicated re-point path restarts immediately and never touches the budget.

**A string sentinel on `cwd` (for example `cwd: '@session'`)** — rejected. A dedicated boolean is explicit in the schema and avoids overloading a path field with a magic value.

## Consequences

- File-indexing stdio MCP servers (fff) now search the user's open project folder, re-pointing when the user opens a different workspace, without a hardcoded path in the profile.
- The tracked value is a server-side proxy for "the currently-open workspace": the most recently entered eligible live session. Switching between two already-open sessions in different workspaces without creating a new session does not re-point (the browser's current-session tab is not reported to the server); the dominant flows — opening a workspace and New Session — both create a session and re-point correctly. Making it exact would require a new browser-to-host "active session" RPC, out of scope.
- A session-workspace-bound server re-points (restarts) on workspace change by design; servers that must not restart leave the flag unset.
- The stdio child's cwd is passed through `createTransport(config, cwdOverride)`, so the transport remains a pure function of the resolved spawn cwd.
