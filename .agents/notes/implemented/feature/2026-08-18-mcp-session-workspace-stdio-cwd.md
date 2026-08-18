# Agent Note: mcp-client spawns stdio servers in the session workspace

Status: implemented

English | [中文](2026-08-18-mcp-session-workspace-stdio-cwd.zh.md)

## Problem

`mcp-client` spawns a stdio server's child process once at plugin load with `cwd: config.cwd`, which defaults to `''` — the host process's working directory (the app's launch folder). File-indexing servers (fff is the motivating case) derive their search root from that process cwd at startup and expose no per-call path argument, so they searched the app's launch directory instead of the project folder the user had open. The fix had to control the spawn cwd, and the workspace a tool call belongs to is only known per session (`session.header.cwd`, the same source as the system-prompt `{{cwd}}` and LSP's `sessionCwd`).

## Decision

`mcp-client`'s stdio config gains an opt-in `useSessionWorkspace: boolean` (default `false`). When set, the child is spawned in the harness's currently-open workspace — the cwd of the most recently entered live, non-subagent session that carries one — falling back to `cwd` (or the host cwd) when no session is open.

The child **binds to the first workspace it observes and then stays there**. A single shared server cannot serve sessions in multiple workspaces: migrating it on a session switch made calls from the originating session search the wrong folder. The connection supervisor therefore re-points the child at most once — to that first workspace, closing the current generation (awaiting its close so children never overlap) and spawning a fresh one with that cwd outside the failure backoff and attempt budget — and ignores every later workspace change. The same bound cwd is reused across reconnects.

A new `SessionWorkspaceTracker` (in `mcp-client/src/session-workspace.ts`) observes `ctx.sessions` (an optional service via `ctx.get`) and the global `session/created` / `session/disposed` events. It seeds from already-live sessions on construction (so an HMR reload mid-session keeps the right cwd) and tracks recency by enter order, ignoring cwd-less and subagent-origin sessions. The first observed workspace binds the child; later changes are no-ops.

The browser reports the session it is currently viewing through the `session.activate` RPC; the gateway resolves it and emits the non-logged `session/activated` host event. The tracker treats an activated session exactly like a created one, so the current workspace always reflects the viewed tab — but because the child is already bound, activation does not re-point it.

## Alternatives considered

**Per-call injection of the workspace into the tool arguments** — rejected. fff resolves its base path once at child startup and accepts no path argument, so there is no per-call variable to pass; only the spawn cwd can steer it.

**Following the active tab and re-pointing on every session switch** — rejected. A single shared server cannot serve sessions in different workspaces; re-pointing migrated the server to the newly-viewed session's workspace, so calls from the session it belonged to searched the wrong folder. Binding to the first workspace keeps each server's search root stable.

**Default `useSessionWorkspace` to true for every stdio server** — rejected. Re-spawning on every workspace switch would kill long-lived bridge processes and re-index stateful servers that never asked for it; the opt-in keeps the behavior where it is wanted.

**Reuse the failure-reconnect path for workspace changes** — rejected. It would consume the attempt budget (a workspace switch counts as an outage) and add backoff latency to an intentional user action; the dedicated re-point path restarts immediately and never touches the budget.

**A string sentinel on `cwd` (for example `cwd: '@session'`)** — rejected. A dedicated boolean is explicit in the schema and avoids overloading a path field with a magic value.

## Consequences

- File-indexing stdio MCP servers (fff) now search the user's open project folder, bound to the first workspace they observe, without a hardcoded path in the profile.
- The tracked workspace still reflects the browser's active tab (the browser reports the viewed session via `session.activate`, the gateway re-emits `session/activated`), but the child is already bound and does not re-point. The active-session fact is server-side memory only (never persisted); a reconnect re-reports it.
- A session-workspace-bound server never restarts on a later session switch, so servers that must not restart can safely use the flag.
- The stdio child's cwd is passed through `createTransport(config, cwdOverride)`, so the transport remains a pure function of the resolved spawn cwd.
