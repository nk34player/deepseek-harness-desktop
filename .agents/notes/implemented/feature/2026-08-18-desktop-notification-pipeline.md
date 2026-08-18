# Agent Note: native notifications from the web GUI to the OS

Status: implemented

English | [中文](2026-08-18-desktop-notification-pipeline.zh.md)

## Problem

The desktop shell raised native notifications only for harness supervisor events (crash, repeated restart, recovery). Everything the Web GUI knew about — approval requests, update availability — stayed inside the window, so a user looking at another app got no alert at all. There was no renderer-to-main notification channel: `window.dshDesktop` exposed window controls, preferences, deep links, and updates, but no way to show a notification.

## Decision

Add a narrow renderer-to-main notification channel:

- The preload bridge gains `notify({ title, body })`, backed by a `dsh:notification-show` IPC handler in the shell. The handler validates the payload at the trust boundary (a malformed payload is dropped, never thrown), honors the notifications preference and `Notification.isSupported()`, and shows an Electron `Notification` with the app icon.
- Two triggers raise it from the Web GUI (both desktop-only and silent no-ops without the bridge):
  - The session manager's `approval/requested` frame handling raises 「`<toolName>`」需要审批 — once per NEW approval; a replayed still-pending request is idempotent and must not re-alert.
  - The ui-update status source raises 发现新版本 `<version>` on the transition into the `available` phase (same-version re-pushes do not re-alert).

Notification copy is English. The runtime keeps only the minimal bridge surface it calls (`notify?: { title, body }`), and the shell revalidates, so the object layer never trusts the renderer payload.

## Alternatives considered

**Dedicated notification service with plugin config for which events notify** — rejected. The two highest-value events (approval needed, update available) cover the current need; a configurable policy is deferred until more notification sources exist.

**Notify from the approval panel component (ui-conversation)** — rejected. The panel renders only for the viewed session, so a background session's approval would never alert the user; the frame handler sees every session.

## Consequences

- A user working in another app is alerted when an agent asks for approval and when a new version is available; crash/restart/recovery notifications remain shell-owned.
- The notification preference (系统通知开关) now gates all renderer-raised notifications, not just the shell's own.
- The channel is desktop-only: plain `dsh web` runs have no bridge, and every call site is a guarded no-op.
