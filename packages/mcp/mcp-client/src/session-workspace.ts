/**
 * Track the harness's "currently-open workspace": the cwd of the most recently
 * entered or activated live, non-subagent session that carries one. A plain
 * creation arrives as `session/created`; a browser tab switch between
 * already-open sessions arrives as `session/activated` and is treated the same
 * way, so the current value always reflects the tab the user is viewing.
 * mcp-client reads this value once to bind a `useSessionWorkspace` stdio server
 * to the first workspace it observes; the server then stays there and does not
 * follow later tab switches.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: declaration-merges `ctx.sessions` and the session
// events onto Context, so `ctx.get('sessions')` and `ctx.on('session/created')`
// resolve to their service and event types.
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'

/** One eligible live session's workspace with its enter-order rank. */
interface TrackedEntry {
  cwd: string
  /** Monotonic enter order; a larger rank is more recently opened. */
  seq: number
}

/** The workspace of a session eligible to be "currently open", or undefined. */
function eligibleCwd(session: Session): string | undefined {
  // A subagent session does not represent the user's open workspace (and
  // inherits its parent's cwd anyway), so tracking it would only add churn.
  if (session.header.origin === 'subagent') return undefined
  return session.header.cwd
}

/**
 * Track the currently-open workspace and notify on change.
 *
 * The current value is the cwd of the most recently entered eligible live
 * session; it becomes `undefined` when no eligible session remains. The
 * `sessions` service is optional: a deployment without it keeps the current
 * workspace undefined and never notifies.
 *
 * @param ctx - context observing the `sessions` service and its global session events.
 * @param onChanged - called with the new current workspace on each live change.
 */
export class SessionWorkspaceTracker {
  private readonly live = new Map<SessionId, TrackedEntry>()
  private nextSeq = 0
  private best: TrackedEntry | undefined
  private readonly offCreated: () => void
  private readonly offDisposed: () => void
  private readonly offActivated: () => void

  /**
   * The currently-open workspace cwd, or `undefined` when no eligible session
   * is live. Seeded from already-live sessions; updated by live session events.
   */
  get current(): string | undefined {
    return this.best?.cwd
  }

  constructor(ctx: Context, private readonly onChanged: (cwd: string | undefined) => void) {
    // Seed from already-live sessions (an HMR reload of this plugin lands
    // mid-session), newest first by creation time. Seeding never notifies: the
    // connection reads `current` directly for its first spawn, and only live
    // changes need to re-point an already-connected server.
    const seeds = (ctx.get('sessions')?.list() ?? [])
      .map(session => ({ session, cwd: eligibleCwd(session) }))
      .filter((entry): entry is { session: Session; cwd: string } => entry.cwd !== undefined)
      .sort((a, b) => a.session.header.createdAt - b.session.header.createdAt)
    for (const { session, cwd } of seeds) this.enter(session.id, cwd, false)

    this.offCreated = ctx.on('session/created', (session) => {
      const cwd = eligibleCwd(session)
      if (cwd === undefined) return
      this.enter(session.id, cwd, true)
    }, { global: true })

    this.offDisposed = ctx.on('session/disposed', (session) => {
      this.leave(session.id)
    }, { global: true })

    // A browser tab switch activates a session without creating one; treating
    // the activated session as the current workspace is what re-points the
    // server when the user views an already-open session. `enter` bumps the
    // monotonic seq, so the activated session becomes the most recent.
    this.offActivated = ctx.on('session/activated', (session) => {
      const cwd = eligibleCwd(session)
      if (cwd === undefined) return
      this.enter(session.id, cwd, true)
    }, { global: true })
  }

  /** Unsubscribe all session listeners. */
  dispose(): void {
    this.offCreated()
    this.offDisposed()
    this.offActivated()
  }

  private enter(id: SessionId, cwd: string, notify: boolean): void {
    const entry: TrackedEntry = { cwd, seq: ++this.nextSeq }
    this.live.set(id, entry)
    // The counter is monotonic, so every entry is the most recent: it always
    // becomes the current workspace.
    this.best = entry
    if (notify) this.publish()
  }

  private leave(id: SessionId): void {
    const entry = this.live.get(id)
    if (entry === undefined) return
    this.live.delete(id)
    if (entry !== this.best) return
    let next: TrackedEntry | undefined
    for (const candidate of this.live.values()) {
      // Enter order assigns monotonically increasing seqs and Map preserves
      // insertion order, so every later candidate outranks the running max;
      // the else path is unreachable.
      /* v8 ignore next -- unreachable: monotonic seq + insertion order */
      if (next === undefined || candidate.seq > next.seq) next = candidate
    }
    this.best = next
    this.publish()
  }

  private publish(): void {
    this.onChanged(this.best?.cwd)
  }
}
