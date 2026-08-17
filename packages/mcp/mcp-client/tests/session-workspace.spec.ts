import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionWorkspaceTracker } from '@deepseek-ai/dsh-mcp-client/src/session-workspace.ts'

/** Mount a bare SessionStore for tracker tests. */
async function mountStore(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

describe('SessionWorkspaceTracker', () => {
  it('stays undefined without a sessions service', () => {
    const ctx = new Context()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    expect(tracker.current).toBeUndefined()
    expect(changed).toEqual([])
    tracker.dispose()
  })

  it('seeds the current workspace from already-live sessions without notifying', async () => {
    const ctx = await mountStore()
    ctx.sessions.create(SessionId('older'), { meta: { cwd: '/older' } })
    ctx.sessions.create(SessionId('newer'), { meta: { cwd: '/newer' } })
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    expect(tracker.current).toBe('/newer')
    // Seeding never notifies: the connection reads `current` for its first spawn.
    expect(changed).toEqual([])
    tracker.dispose()
  })

  it('seeds past cwd-less sessions without tracking them', async () => {
    const ctx = await mountStore()
    ctx.sessions.create(SessionId('no-cwd'))
    ctx.sessions.create(SessionId('main'), { meta: { cwd: '/main' } })
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    expect(tracker.current).toBe('/main')
    expect(changed).toEqual([])
    tracker.dispose()
  })

  it('follows the most recently opened eligible session and notifies on change', async () => {
    const ctx = await mountStore()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    ctx.sessions.create(SessionId('a'), { meta: { cwd: '/a' } })
    expect(tracker.current).toBe('/a')
    ctx.sessions.create(SessionId('b'), { meta: { cwd: '/b' } })
    expect(tracker.current).toBe('/b')
    expect(changed).toEqual(['/a', '/b'])
    tracker.dispose()
  })

  it('ignores cwd-less and subagent sessions', async () => {
    const ctx = await mountStore()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    ctx.sessions.create(SessionId('no-cwd'))
    ctx.sessions.create(SessionId('subagent'), { meta: { cwd: '/hidden', origin: 'subagent' } })
    expect(tracker.current).toBeUndefined()
    expect(changed).toEqual([])
    // An eligible session still lands after the ignored ones.
    ctx.sessions.create(SessionId('main'), { meta: { cwd: '/main' } })
    expect(tracker.current).toBe('/main')
    expect(changed).toEqual(['/main'])
    tracker.dispose()
  })

  it('ignores disposal of a session it never tracked', async () => {
    const ctx = await mountStore()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    // A cwd-less session is live but not tracked; disposing it must not publish.
    const session = ctx.sessions.prepare(SessionId('ghost'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    detach()
    expect(tracker.current).toBeUndefined()
    expect(changed).toEqual([])
    tracker.dispose()
  })

  it('keeps the current workspace when a non-current session is disposed', async () => {
    const ctx = await mountStore()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    const sessionA = ctx.sessions.prepare(SessionId('a'), { meta: { cwd: '/a' } })
    const detachA = ctx.sessions.enter(sessionA)
    ctx.sessions.announce(sessionA)
    const sessionB = ctx.sessions.prepare(SessionId('b'), { meta: { cwd: '/b' } })
    const detachB = ctx.sessions.enter(sessionB)
    ctx.sessions.announce(sessionB)
    expect(tracker.current).toBe('/b')
    changed.length = 0
    // Disposing a (not current) must not change the current workspace.
    detachA()
    expect(tracker.current).toBe('/b')
    expect(changed).toEqual([])
    detachB()
    tracker.dispose()
  })

  it('falls back to the previous workspace when the current session is disposed', async () => {
    const ctx = await mountStore()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    ctx.sessions.create(SessionId('a'), { meta: { cwd: '/a' } })
    ctx.sessions.create(SessionId('b'), { meta: { cwd: '/b' } })
    expect(tracker.current).toBe('/b')
    changed.length = 0

    // Enter a newer session through the explicit lifecycle so we can detach it.
    const session = ctx.sessions.prepare(SessionId('c'), { meta: { cwd: '/c' } })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    expect(tracker.current).toBe('/c')

    // Disposing c falls back to the most recent remaining eligible session.
    detach()
    expect(tracker.current).toBe('/b')
    expect(changed).toEqual(['/c', '/b'])
    tracker.dispose()
  })

  it('clears the workspace when no eligible session remains', async () => {
    const ctx = await mountStore()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    const session = ctx.sessions.prepare(SessionId('solo'), { meta: { cwd: '/solo' } })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    expect(tracker.current).toBe('/solo')
    detach()
    expect(tracker.current).toBeUndefined()
    expect(changed).toEqual(['/solo', undefined])
    tracker.dispose()
  })

  it('dispose() unsubscribes both session listeners', async () => {
    const ctx = await mountStore()
    const changed: (string | undefined)[] = []
    const tracker = new SessionWorkspaceTracker(ctx, (cwd) => { changed.push(cwd) })
    tracker.dispose()
    ctx.sessions.create(SessionId('late'), { meta: { cwd: '/late' } })
    expect(tracker.current).toBeUndefined()
    expect(changed).toEqual([])
  })
})
