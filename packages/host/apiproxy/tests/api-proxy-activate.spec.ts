/**
 * sessions.activate: the browser's fire-and-forget "currently-viewed session"
 * report. The gateway resolves the live session and emits the non-logged
 * `session/activated` host event for host plugins (mcp-client) to follow; a
 * null or unknown id is accepted without emitting (a benign no-op).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`ar-${String(nextRpc++)}`), payload }
}

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      ctx.agents.register(agent)
      return Promise.resolve({ agent, dispose: () => Promise.resolve() })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

/** Register one live agent over a session in `/proj`. */
function liveAgent(ctx: Context, id: string): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const api = (ctx: Context) => createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

describe('sessions.activate', () => {
  it('accepts a live session id and emits session/activated with the resolved session', async () => {
    const ctx = await composed()
    const session = liveAgent(ctx, 'session-activate')
    const activated: Session[] = []
    ctx.on('session/activated', (s) => { activated.push(s) }, { global: true })

    const response = await api(ctx).sessions.activate(request({ sessionId: session.id }))
    expect(response.result.ok).toBe(true)
    expect(activated).toHaveLength(1)
    expect(activated[0]!.id).toBe(session.id)
    expect(activated[0]!.header.cwd).toBe('/proj')
  })

  it('accepts a null id without emitting', async () => {
    const ctx = await composed()
    const activated: Session[] = []
    ctx.on('session/activated', (s) => { activated.push(s) }, { global: true })

    const response = await api(ctx).sessions.activate(request({ sessionId: null }))
    expect(response.result.ok).toBe(true)
    expect(activated).toHaveLength(0)
  })

  it('accepts an unknown session id without emitting', async () => {
    const ctx = await composed()
    const activated: Session[] = []
    ctx.on('session/activated', (s) => { activated.push(s) }, { global: true })

    const response = await api(ctx).sessions.activate(request({ sessionId: sid('session-ghost') }))
    expect(response.result.ok).toBe(true)
    expect(activated).toHaveLength(0)
  })
})
