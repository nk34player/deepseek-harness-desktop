# Agent Note: mcp-client spawns stdio servers in the session workspace

Status: implemented

English | [中文](2026-08-18-mcp-session-workspace-stdio-cwd.zh.md)

## Problem

`mcp-client` spawns a stdio server's child process with `cwd: config.cwd`, which defaults to `''` — the host process's working directory (the app's launch folder). File-indexing servers (fff is the motivating case) derive their search root from that process cwd at startup and expose no per-call path argument, so a single shared child would search one fixed folder. When the user has multiple sessions/tabs open in different workspaces, the child's folder must match the session that calls it — but a shared child cannot, and migrating it on a session switch makes calls from the originating session search the wrong folder.

## Decision

`mcp-client`'s stdio config gains an opt-in `useSessionWorkspace: boolean` (default `false`). When set, the plugin runs **one supervised child per live session**, each rooted in that session's workspace (`header.cwd`) and registering its tools **scoped to that session's agent** (via `agent.ctx.tools.register`), so no tool name collides and a session's model only ever sees its own session's tools. A session's child spawns on `agent/created` and tears down on `agent/disposed`; already-live agents are seeded at plugin load (HMR-safe). Subagent and cwd-less sessions are skipped (a subagent inherits its parent's cwd).

This is the per-workspace-instance model used by Cursor's project-scope MCP and other multi-workspace tools: each workspace gets its own server, so there is never a wrong-workspace window, a restart-on-switch, or cross-session contamination. It requires the `agents` service; absent it, the server falls back to the configured `cwd` (logged).

The opt-in is deliberate: one child per session is correct for a stateless indexer like fff, but heavy for long-lived GUI bridges (e.g. StudioMCP), which therefore stay off the feature.

## Alternatives considered

**Per-call injection of the workspace into the tool arguments** — rejected. fff resolves its base path once at child startup and accepts no path argument, so there is no per-call variable to pass; only the spawn cwd can steer it.

**One shared child that follows the currently-viewed session and re-points on switch** — rejected. A single shared server cannot serve sessions in different workspaces; re-pointing migrated the child to the newly-viewed session's workspace, so calls from the session it belonged to searched the wrong folder. Per-session children keep every workspace's server stable and correct.

**Default `useSessionWorkspace` to true for every stdio server** — rejected. One child per session is heavy for long-lived bridges; the opt-in keeps it where it is wanted.

**Reuse the failure-reconnect path for workspace changes** — rejected. There is no workspace change under the per-session model; each per-session child owns its own reconnect budget independently.

**A string sentinel on `cwd` (for example `cwd: '@session'`)** — rejected. A dedicated boolean is explicit in the schema and avoids overloading a path field with a magic value.

## Consequences

- File-indexing stdio MCP servers (fff) now search the session they are used in, rooted in that session's workspace, without a hardcoded path in the profile.
- Each session's tools are scoped to that session's agent, so two sessions in different workspaces never see or return each other's files.
- A session-workspace-bound server never re-points or restarts on a session switch; it spawns and tears down with its session.
- The stdio child's cwd is passed through `createTransport(config, cwdOverride)`, so the transport remains a pure function of the resolved spawn cwd.
